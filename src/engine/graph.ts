import type { Coordinate, GraphValidation, RoadEdge, RoadGraph, TurnRestriction } from './types';

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => degrees * Math.PI / 180;

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const p = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, p)));
}

export function compassBearing(a: Coordinate, b: Coordinate): number {
  const lon = radians(b[0] - a[0]);
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  return (Math.atan2(Math.sin(lon) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon)) * 180 / Math.PI + 360) % 360;
}

export interface PreparedGraph {
  edgeById: Map<string, RoadEdge>;
  outgoing: Map<string, RoadEdge[]>;
  incoming: Map<string, RoadEdge[]>;
  restrictionsByVia: Map<string, TurnRestriction[]>;
  geometryDistances: Map<string, number[]>;
}

const preparedGraphs = new WeakMap<RoadGraph, PreparedGraph>();

/** Graphs are treated as immutable; preprocessing runs once per graph object. */
export function prepareGraph(graph: RoadGraph): PreparedGraph {
  const cached = preparedGraphs.get(graph);
  if (cached) return cached;
  const result: PreparedGraph = {
    edgeById: new Map(), outgoing: new Map(), incoming: new Map(),
    restrictionsByVia: new Map(), geometryDistances: new Map(),
  };
  for (const edge of graph.edges) {
    result.edgeById.set(edge.id, edge);
    result.outgoing.set(edge.from, [...(result.outgoing.get(edge.from) ?? []), edge]);
    result.incoming.set(edge.to, [...(result.incoming.get(edge.to) ?? []), edge]);
    const cumulative = [0];
    for (let i = 1; i < edge.geometry.length; i++) {
      cumulative.push(cumulative[i - 1] + distanceMeters(edge.geometry[i - 1], edge.geometry[i]));
    }
    result.geometryDistances.set(edge.id, cumulative);
  }
  for (const restriction of graph.restrictions) {
    result.restrictionsByVia.set(restriction.via, [...(result.restrictionsByVia.get(restriction.via) ?? []), restriction]);
  }
  preparedGraphs.set(graph, result);
  return result;
}

export function poseOnEdge(graph: RoadGraph, edge: RoadEdge, distanceM: number): { position: Coordinate; bearing: number } {
  const cumulative = prepareGraph(graph).geometryDistances.get(edge.id)!;
  const total = cumulative[cumulative.length - 1];
  const fraction = Math.max(0, Math.min(1, distanceM / edge.length));
  const geometryDistance = fraction * total;
  let lo = 1;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cumulative[mid] < geometryDistance) lo = mid + 1;
    else hi = mid;
  }
  const segment = Math.max(1, lo);
  const a = edge.geometry[segment - 1];
  const b = edge.geometry[segment];
  const length = cumulative[segment] - cumulative[segment - 1];
  const t = length > 0 ? Math.max(0, Math.min(1, (geometryDistance - cumulative[segment - 1]) / length)) : 0;
  return {
    position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    bearing: length > 0 ? compassBearing(a, b) : edge.bearingStart,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const coordinate = (value: unknown): value is Coordinate => Array.isArray(value) && value.length === 2
  && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;

/** Validate downloaded data before running the simulator. Does not mutate it. */
export function validateGraph(value: unknown): GraphValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) return { errors: ['Graph must be an object.'], warnings };
  const metadata = value.metadata;
  if (!isRecord(metadata)) errors.push('Graph metadata is missing.');
  else {
    const box = metadata.bbox;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
      || box[0] >= box[2] || box[1] >= box[3] || box[0] < -180 || box[2] > 180
      || box[1] < -90 || box[3] > 90) errors.push('Metadata bbox must be valid [west, south, east, north] coordinates.');
    if (typeof metadata.source !== 'string' || !metadata.source.trim()) errors.push('Metadata source is missing.');
    if (typeof metadata.generatedAt !== 'string' || !Number.isFinite(Date.parse(metadata.generatedAt))) errors.push('Metadata generatedAt must be a valid date.');
  }
  if (!isRecord(value.nodes)) errors.push('Graph nodes must be keyed by node id.');
  if (!Array.isArray(value.edges) || value.edges.length === 0) errors.push('Graph must contain directed road edges.');
  if (!Array.isArray(value.restrictions)) errors.push('Graph restrictions must be an array.');
  if (!isRecord(value.nodes) || !Array.isArray(value.edges)) return { errors, warnings };
  const nodes = value.nodes;
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRecord(node) || node.id !== id || !coordinate([node.lon, node.lat])) errors.push(`Node ${id} has an invalid id or coordinate.`);
  }
  const ids = new Set<string>();
  const ways = new Set<string>();
  const connected = new Set<string>();
  let inconsistentLengths = 0;
  for (const raw of value.edges) {
    if (!isRecord(raw) || typeof raw.id !== 'string') { errors.push('An edge has no string id.'); continue; }
    const edge = raw;
    const id = edge.id as string;
    if (ids.has(id)) errors.push(`Duplicate edge id ${id}.`);
    ids.add(id);
    if (typeof edge.wayId !== 'string') errors.push(`Edge ${id} has no source way id.`);
    else ways.add(edge.wayId);
    if (typeof edge.from !== 'string' || !nodes[edge.from]) errors.push(`Edge ${id} has a missing from node.`);
    if (typeof edge.to !== 'string' || !nodes[edge.to]) errors.push(`Edge ${id} has a missing to node.`);
    if (typeof edge.from === 'string') connected.add(edge.from);
    if (typeof edge.to === 'string') connected.add(edge.to);
    if (typeof edge.name !== 'string' || typeof edge.highway !== 'string') errors.push(`Edge ${id} is missing road labels.`);
    if (typeof edge.length !== 'number' || !Number.isFinite(edge.length) || edge.length <= 0) errors.push(`Edge ${id} length must be positive meters.`);
    for (const field of ['bearingStart', 'bearingEnd']) {
      const bearing = edge[field];
      if (typeof bearing !== 'number' || !Number.isFinite(bearing) || bearing < 0 || bearing >= 360) errors.push(`Edge ${id} has invalid ${field}.`);
    }
    if (!Array.isArray(edge.geometry) || edge.geometry.length < 2 || !edge.geometry.every(coordinate)) {
      errors.push(`Edge ${id} must have at least two valid geometry coordinates.`);
      continue;
    }
    const line = edge.geometry as Coordinate[];
    const startNode = nodes[String(edge.from)];
    const endNode = nodes[String(edge.to)];
    if (isRecord(startNode) && coordinate([startNode.lon, startNode.lat])
      && distanceMeters(line[0], [startNode.lon as number, startNode.lat as number]) > 2) errors.push(`Edge ${id} geometry does not begin at its from node.`);
    if (isRecord(endNode) && coordinate([endNode.lon, endNode.lat])
      && distanceMeters(line[line.length - 1], [endNode.lon as number, endNode.lat as number]) > 2) errors.push(`Edge ${id} geometry does not end at its to node.`);
    let measured = 0;
    for (let i = 1; i < line.length; i++) measured += distanceMeters(line[i - 1], line[i]);
    if (measured === 0) errors.push(`Edge ${id} has zero-length geometry.`);
    if (typeof edge.length === 'number' && Math.abs(measured - edge.length) > Math.max(5, measured * 0.1)) inconsistentLengths++;
  }
  if (inconsistentLengths) warnings.push(`${inconsistentLengths} edge lengths differ from their geometry by more than 10%.`);
  const unused = Object.keys(nodes).filter(id => !connected.has(id)).length;
  if (unused) warnings.push(`${unused} nodes have no drivable edges.`);
  if (Array.isArray(value.restrictions)) for (const raw of value.restrictions) {
    if (!isRecord(raw) || typeof raw.via !== 'string' || typeof raw.fromWay !== 'string' || typeof raw.toWay !== 'string'
      || typeof raw.type !== 'string' || !/^(no|only)_/.test(raw.type)) {
      errors.push('A turn restriction has an invalid shape.');
      continue;
    }
    if (!nodes[raw.via]) warnings.push(`Restriction via ${raw.via} lies outside the drivable graph.`);
    if (!ways.has(raw.fromWay) || !ways.has(raw.toWay)) warnings.push(`Restriction at ${raw.via} refers to an omitted way.`);
  }
  return { errors, warnings };
}

export function graphToGeoJSON(graph: RoadGraph) {
  return {
    type: 'FeatureCollection' as const,
    features: graph.edges.map(edge => ({
      type: 'Feature' as const,
      id: edge.id,
      properties: { id: edge.id, wayId: edge.wayId, name: edge.name, highway: edge.highway, from: edge.from, to: edge.to },
      geometry: { type: 'LineString' as const, coordinates: edge.geometry },
    })),
  };
}
