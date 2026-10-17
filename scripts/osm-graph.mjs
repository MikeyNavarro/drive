/** OpenStreetMap surface-road processing. No coordinate snapping or invented links. */
export const DEFAULT_BBOX = [-122.025, 37.526, -121.945, 37.574];
export const REQUIRED_STREETS = [
  'Fremont Boulevard', 'Mowry Avenue', 'Stevenson Boulevard',
  'Paseo Padre Parkway', 'Walnut Avenue',
];

const ROAD_CLASSES = new Set([
  'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service',
]);
const ALLOWED_ACCESS = new Set(['yes', 'permissive', 'designated', 'official']);
const SUPPORTED_RESTRICTIONS = new Set([
  'no_left_turn', 'no_right_turn', 'no_straight_on', 'no_u_turn', 'no_entry', 'no_exit',
  'only_left_turn', 'only_right_turn', 'only_straight_on', 'only_u_turn',
]);
const EARTH_RADIUS = 6371008.8;
const radians = (degrees) => degrees * Math.PI / 180;

export function validateBBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n)) ||
      bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || bbox[0] < -180 || bbox[2] > 180 ||
      bbox[1] < -90 || bbox[3] > 90) {
    throw new Error('bbox must be [west,south,east,north] with valid increasing coordinates.');
  }
  return bbox;
}

export function buildOverpassQuery(bbox = DEFAULT_BBOX) {
  const [west, south, east, north] = validateBBox(bbox);
  // Complete ways and all restriction members are returned. Geometry is never clipped.
  return `[out:json][timeout:90];\nway["highway"](${south},${west},${north},${east})->.roads;\nrel(bw.roads)["type"="restriction"]->.restrictions;\n(.roads;.restrictions;);\n(._;>;);\nout meta;\n`;
}

export function distance(a, b) {
  const p1 = radians(a[1]);
  const p2 = radians(b[1]);
  const dp = p2 - p1;
  const dl = radians(b[0] - a[0]);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function bearing(a, b) {
  const p1 = radians(a[1]);
  const p2 = radians(b[1]);
  const dl = radians(b[0] - a[0]);
  return (Math.atan2(Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}

function drivable(tags) {
  if (!ROAD_CLASSES.has(tags.highway) || tags.area === 'yes' || tags.junction === 'construction' ||
      tags.construction || tags.proposed || tags.motorroad === 'yes') return false;
  if (tags.highway === 'service' && ['driveway', 'parking_aisle', 'emergency_access'].includes(tags.service)) return false;
  const access = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  // Exclude private, destination-only, delivery-only, permit-only and unknown access.
  return access === undefined || ALLOWED_ACCESS.has(access);
}

function direction(tags) {
  const value = tags['oneway:motorcar'] ?? tags['oneway:motor_vehicle'] ?? tags.oneway;
  if (value === '-1' || value === 'reverse') return -1;
  if (['yes', 'true', '1'].includes(value)) return 1;
  if (['no', 'false', '0'].includes(value)) return 0;
  if (value !== undefined) return null; // Reversible/alternating directions need real-time controls.
  return tags.junction === 'roundabout' ? 1 : 0;
}

function directionalAccess(tags, suffix) {
  // Resolve conservatively: an explicit negative access tag for this direction
  // excludes the edge even when another, more general tag grants access.
  return ['motorcar', 'motor_vehicle', 'vehicle', 'access'].every((key) => {
    const value = tags[`${key}:${suffix}`];
    return value === undefined || ALLOWED_ACCESS.has(value);
  });
}

function inBBox(node, bbox) {
  return node.lon >= bbox[0] && node.lon <= bbox[2] && node.lat >= bbox[1] && node.lat <= bbox[3];
}

function restrictedBarrier(node) {
  const tags = node.tags ?? {};
  const access = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  if (access !== undefined && !ALLOWED_ACCESS.has(access)) return true;
  if (!tags.barrier || ['no', 'entrance', 'cattle_grid', 'toll_booth', 'border_control'].includes(tags.barrier)) return false;
  // A car may pass a gate only when a positive motorcar/motor_vehicle/vehicle/access tag says so.
  return access === undefined;
}

function canonicalName(name) {
  return name.toLowerCase().replace(/\bblvd\.?\b/g, 'boulevard')
    .replace(/\bave\.?\b/g, 'avenue').replace(/\bpkwy\.?\b/g, 'parkway')
    .replace(/\brd\.?\b/g, 'road').replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
}

/** Build directed segments using shared OSM node IDs, never visual intersections. */
export function buildRoadGraph(osm, options = {}) {
  const bbox = validateBBox(options.bbox ?? DEFAULT_BBOX);
  if (osm?.remark) throw new Error(`Overpass returned an incomplete/error response: ${osm.remark}`);
  if (!Array.isArray(osm?.elements)) throw new Error('Input is not an Overpass JSON elements response.');
  const allNodes = new Map(osm.elements.filter((e) => e.type === 'node').map((n) => [String(n.id), n]));
  const allWays = new Map(osm.elements.filter((e) => e.type === 'way').map((w) => [String(w.id), w]));
  const excluded = { nonSurfaceOrRestricted: 0, outsideCoverage: 0, unsupportedDirection: 0, barriers: 0, unsupportedRestrictions: 0 };
  const warnings = [];
  const ways = [];
  for (const way of allWays.values()) {
    const tags = way.tags ?? {};
    if (!drivable(tags)) { excluded.nonSurfaceOrRestricted++; continue; }
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) continue;
    const missing = way.nodes.find((id) => !allNodes.has(String(id)));
    if (missing !== undefined) throw new Error(`OSM way ${way.id} is incomplete: node ${missing} is missing.`);
    if (!way.nodes.some((id) => inBBox(allNodes.get(String(id)), bbox))) { excluded.outsideCoverage++; continue; }
    const travel = direction(tags);
    if (travel === null || Object.keys(tags).some((k) => /^oneway(?::motorcar|:motor_vehicle)?:conditional$/.test(k)) ||
        Object.keys(tags).some((k) => /^(access|vehicle|motor_vehicle|motorcar)(?::forward|:backward)?:conditional$/.test(k))) {
      excluded.unsupportedDirection++;
      warnings.push(`Excluded way ${way.id}: conditional access or unsupported travel direction.`);
      continue;
    }
    ways.push({ ...way, travel, nodeIds: way.nodes.map(String) });
  }
  if (!ways.length) throw new Error('No drivable surface roads found in the requested bounding box.');
  const acceptedWayIds = new Set(ways.map((w) => String(w.id)));
  const junctions = new Set();
  const nodeOwners = new Map();
  const blockedNodes = new Set();
  const blockedWays = new Set();
  for (const way of ways) {
    junctions.add(way.nodeIds[0]);
    junctions.add(way.nodeIds.at(-1));
    const seen = new Set();
    for (const id of way.nodeIds) {
      const owner = nodeOwners.get(id);
      if ((owner !== undefined && owner !== String(way.id)) || seen.has(id)) junctions.add(id);
      nodeOwners.set(id, String(way.id));
      seen.add(id);
      if (restrictedBarrier(allNodes.get(id))) {
        blockedNodes.add(id);
        junctions.add(id);
      }
    }
  }
  excluded.barriers = blockedNodes.size;
  const restrictions = [];
  const restrictionReports = [];
  for (const relation of osm.elements.filter((e) => e.type === 'relation' && e.tags?.type === 'restriction')) {
    const tags = relation.tags;
    const except = (tags.except ?? '').split(/[;,]/).map((s) => s.trim());
    if (except.some((s) => ['motorcar', 'motor_vehicle', 'vehicle'].includes(s))) continue;
    const type = tags['restriction:motorcar'] ?? tags['restriction:motor_vehicle'] ?? tags['restriction:vehicle'] ?? tags.restriction;
    const conditional = Object.keys(tags).some((key) => /^restriction(?::motorcar|:motor_vehicle|:vehicle)?:conditional$/.test(key));
    if (!type && !conditional) continue; // e.g. an HGV-only restriction.
    const members = relation.members ?? [];
    const from = members.filter((m) => m.role === 'from' && m.type === 'way').map((m) => String(m.ref));
    const to = members.filter((m) => m.role === 'to' && m.type === 'way').map((m) => String(m.ref));
    const via = members.filter((m) => m.role === 'via');
    if (!from.some((id) => acceptedWayIds.has(id)) && !to.some((id) => acceptedWayIds.has(id)) &&
        !via.some((m) => m.type === 'way' && acceptedWayIds.has(String(m.ref)))) continue;
    const viaNode = via.length === 1 && via[0].type === 'node' ? String(via[0].ref) : null;
    if (viaNode) junctions.add(viaNode);
    const supported = !conditional && SUPPORTED_RESTRICTIONS.has(type) && viaNode && from.length > 0 && to.length > 0 &&
      (from.length === 1 || type === 'no_entry') && (to.length === 1 || type === 'no_exit') &&
      from.every((id) => allWays.get(id)?.nodes?.some((n) => String(n) === viaNode)) &&
      to.every((id) => allWays.get(id)?.nodes?.some((n) => String(n) === viaNode));
    if (supported) {
      for (const fromWay of from) for (const toWay of to) {
        if (acceptedWayIds.has(fromWay) && acceptedWayIds.has(toWay)) restrictions.push({ via: viaNode, fromWay, toWay, type });
        else if (acceptedWayIds.has(fromWay) && type.startsWith('only_')) blockedNodes.add(viaNode);
      }
    } else {
      const viaWays = via.filter((m) => m.type === 'way').map((m) => String(m.ref));
      if (viaNode) blockedNodes.add(viaNode);
      else if (viaWays.length) viaWays.forEach((id) => blockedWays.add(id));
      else [...from, ...to].forEach((id) => blockedWays.add(id));
      const action = viaNode ? `closed junction node ${viaNode}` : `excluded affected ways ${[...(viaWays.length ? viaWays : [...from, ...to])].join(', ')}`;
      const message = `Restriction ${relation.id} (${conditional ? 'conditional' : type ?? 'missing type'}): ${action}; legality requires review.`;
      warnings.push(message);
      restrictionReports.push({ relationId: String(relation.id), type: type ?? null, action, reason: conditional ? 'conditional' : 'unsupported or incomplete restriction' });
      excluded.unsupportedRestrictions++;
    }
  }
  const nodes = {};
  const edges = [];
  function addEdge(way, ids, segment, reversed) {
    const from = ids[0];
    const to = ids.at(-1);
    if (blockedNodes.has(from) || blockedNodes.has(to) || blockedWays.has(String(way.id))) return;
    const raw = ids.map((id) => { const n = allNodes.get(id); return [n.lon, n.lat]; });
    const geometry = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]);
    if (geometry.length < 2) return;
    let length = 0;
    for (let i = 1; i < geometry.length; i++) length += distance(geometry[i - 1], geometry[i]);
    if (length < 0.01) return;
    for (const id of [from, to]) {
      const n = allNodes.get(id);
      nodes[id] = { id, lon: n.lon, lat: n.lat };
    }
    edges.push({
      id: `${way.id}:${segment}:${reversed ? 'r' : 'f'}`, wayId: String(way.id), from, to,
      name: way.tags?.name ?? way.tags?.['name:en'] ?? '', highway: way.tags.highway,
      geometry, length, bearingStart: bearing(geometry[0], geometry[1]),
      bearingEnd: bearing(geometry.at(-2), geometry.at(-1)),
    });
  }
  for (const way of ways) {
    let start = 0;
    let segment = 0;
    for (let i = 1; i < way.nodeIds.length; i++) {
      if (!junctions.has(way.nodeIds[i])) continue;
      const ids = way.nodeIds.slice(start, i + 1);
      if (way.travel !== -1 && directionalAccess(way.tags, 'forward')) addEdge(way, ids, segment, false);
      if (way.travel !== 1 && directionalAccess(way.tags, 'backward')) addEdge(way, [...ids].reverse(), segment, true);
      start = i;
      segment++;
    }
  }
  // An only_* relation whose sole permitted outlet was excluded must not silently
  // become an unrestricted junction. Close it, and repeat if closures remove an
  // adjacent only_* outlet. Ordinary no_* rules need no record for absent roads.
  let closuresChanged = true;
  while (closuresChanged) {
    closuresChanged = false;
    for (const r of restrictions) {
      if (!r.type.startsWith('only_') || blockedNodes.has(r.via)) continue;
      const incoming = edges.some((e) => e.to === r.via && e.wayId === r.fromWay && !blockedNodes.has(e.from));
      const outgoing = edges.some((e) => e.from === r.via && e.wayId === r.toWay && !blockedNodes.has(e.to));
      if (incoming && !outgoing) {
        blockedNodes.add(r.via);
        warnings.push(`Closed junction ${r.via}: only_* restriction outlet was excluded.`);
        closuresChanged = true;
      }
    }
  }
  for (let i = edges.length - 1; i >= 0; i--) {
    if (blockedNodes.has(edges[i].from) || blockedNodes.has(edges[i].to)) edges.splice(i, 1);
  }
  const usedNodes = new Set(edges.flatMap((e) => [e.from, e.to]));
  for (const id of Object.keys(nodes)) if (!usedNodes.has(id)) delete nodes[id];
  const retainedRestrictions = restrictions.filter((r) =>
    edges.some((e) => e.to === r.via && e.wayId === r.fromWay) &&
    edges.some((e) => e.from === r.via && e.wayId === r.toWay));
  return {
    metadata: {
      schemaVersion: 1,
      bbox: [...bbox], generatedAt: options.generatedAt ?? new Date().toISOString(),
      source: 'OpenStreetMap', sourceUrl: options.sourceUrl ?? 'https://overpass-api.de/api/interpreter',
      sourceTimestamp: osm.osm3s?.timestamp_osm_base ?? null,
      license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
      licenseUrl: 'https://www.openstreetmap.org/copyright',
      coverage: 'Complete surface-road ways touching the query box; freeways and ramps excluded.',
      excluded, blockedViaNodes: [...blockedNodes].sort(), blockedWayIds: [...blockedWays].sort(),
      unsupportedRestrictions: restrictionReports, warnings,
    },
    nodes, edges, restrictions: retainedRestrictions,
  };
}

/** Validation and factual coverage report; no nearest-road coordinate matching. */
export function validateImportedGraph(graph, { requireCoreStreets = true } = {}) {
  const errors = [];
  try { validateBBox(graph?.metadata?.bbox); } catch (error) { errors.push(error.message); }
  if (!graph?.nodes || !Array.isArray(graph.edges) || !Array.isArray(graph.restrictions)) {
    return { valid: false, errors: [...errors, 'Missing graph nodes, edges or restrictions.'] };
  }
  if (!graph.metadata.sourceTimestamp) errors.push('Missing source snapshot timestamp; import an authoritative Overpass snapshot.');
  if (graph.metadata.license !== 'ODbL-1.0' || !graph.metadata.attribution) errors.push('Missing OpenStreetMap license/attribution.');
  const ids = new Set();
  const neighbors = new Map();
  const namesAtNode = new Map();
  const wayNames = new Map();
  const wayIds = new Set();
  for (const edge of graph.edges) {
    if (ids.has(edge.id)) errors.push(`Duplicate edge ${edge.id}.`);
    ids.add(edge.id);
    wayIds.add(edge.wayId);
    if (!graph.nodes[edge.from] || !graph.nodes[edge.to]) { errors.push(`Edge ${edge.id} has a missing endpoint.`); continue; }
    if (!Number.isFinite(edge.length) || edge.length <= 0 || !Array.isArray(edge.geometry) || edge.geometry.length < 2) {
      errors.push(`Edge ${edge.id} has invalid length or geometry.`); continue;
    }
    for (const coordinate of edge.geometry) {
      if (!Array.isArray(coordinate) || coordinate.length !== 2 || coordinate.some((n) => !Number.isFinite(n)) ||
          Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) errors.push(`Edge ${edge.id} has an invalid coordinate.`);
    }
    for (const [nodeId, coordinate] of [[edge.from, edge.geometry[0]], [edge.to, edge.geometry.at(-1)]]) {
      const node = graph.nodes[nodeId];
      if (coordinate[0] !== node.lon || coordinate[1] !== node.lat) errors.push(`Edge ${edge.id} endpoint does not match OSM node ${nodeId}.`);
    }
    let measuredLength = 0;
    for (let i = 1; i < edge.geometry.length; i++) measuredLength += distance(edge.geometry[i - 1], edge.geometry[i]);
    if (Math.abs(measuredLength - edge.length) > 0.1) errors.push(`Edge ${edge.id} has an incorrect length.`);
    for (const heading of [edge.bearingStart, edge.bearingEnd]) {
      if (!Number.isFinite(heading) || heading < 0 || heading >= 360) errors.push(`Edge ${edge.id} has an invalid bearing.`);
    }
    for (const [a, b] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      neighbors.get(a).add(b);
      if (!namesAtNode.has(a)) namesAtNode.set(a, new Set());
      namesAtNode.get(a).add(edge.name);
    }
    if (!wayNames.has(edge.name)) wayNames.set(edge.name, new Set());
    wayNames.get(edge.name).add(edge.from);
    wayNames.get(edge.name).add(edge.to);
  }
  for (const r of graph.restrictions) {
    if (!graph.nodes[r.via] || !wayIds.has(r.fromWay) || !wayIds.has(r.toWay) || !SUPPORTED_RESTRICTIONS.has(r.type)) {
      errors.push(`Restriction at ${r.via} references missing geometry or unsupported type ${r.type}.`);
    }
  }
  if (!graph.edges.length) errors.push('The graph has no drivable edges.');
  const components = [];
  const visited = new Set();
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    const members = [];
    const queue = [start];
    visited.add(start);
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      members.push(node);
      for (const next of neighbors.get(node) ?? []) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    components.push(members);
  }
  components.sort((a, b) => b.length - a.length);
  const componentForNode = new Map();
  components.forEach((members, index) => members.forEach((id) => componentForNode.set(id, index)));
  const streetCoverage = REQUIRED_STREETS.map((requested) => {
    const matchedNames = [...wayNames.keys()].filter((name) => canonicalName(name) === canonicalName(requested));
    const componentIds = [...new Set(matchedNames.flatMap((name) => [...wayNames.get(name)].map((id) => componentForNode.get(id))))].sort((a, b) => a - b);
    if (requireCoreStreets && !matchedNames.length) errors.push(`Required street missing: ${requested}.`);
    return { requested, matchedNames, componentIds };
  });
  const commonComponents = components.map((_, index) => index).filter((id) => streetCoverage.every((s) => s.componentIds.includes(id)));
  if (requireCoreStreets && !commonComponents.length) errors.push('The five required streets do not share a connected component.');
  const coreNames = new Set(streetCoverage.flatMap((s) => s.matchedNames));
  const verifiedCoreIntersections = [...namesAtNode].filter(([, names]) => [...names].filter((name) => coreNames.has(name)).length > 1)
    .map(([nodeId, names]) => ({ nodeId, lon: graph.nodes[nodeId].lon, lat: graph.nodes[nodeId].lat, streets: [...names].filter((name) => coreNames.has(name)).sort() }));
  return {
    valid: errors.length === 0, errors, nodes: Object.keys(graph.nodes).length, directedEdges: graph.edges.length,
    restrictions: graph.restrictions.length, componentSizes: components.map((c) => c.length),
    streetCoverage, commonComponents, verifiedCoreIntersections,
    warnings: graph.metadata.warnings ?? [],
  };
}
