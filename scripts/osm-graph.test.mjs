import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildOverpassQuery, buildRoadGraph, distance, validateBBox, validateImportedGraph,
} from './osm-graph.mjs';

// Artificial coordinates are exclusively unit-test fixtures, never app data.
// Geography integration below uses the real processed snapshot when available.
const node = (id, lon, lat, tags) => ({ type: 'node', id, lon, lat, ...(tags ? { tags } : {}) });
const way = (id, nodes, tags = {}) => ({ type: 'way', id, nodes, tags: { highway: 'residential', name: `Test road ${id}`, ...tags } });
const relation = (id, from, via, to, tags = {}) => ({
  type: 'relation', id, tags: { type: 'restriction', restriction: 'no_left_turn', ...tags },
  members: [
    { type: 'way', ref: from, role: 'from' },
    { type: 'node', ref: via, role: 'via' },
    { type: 'way', ref: to, role: 'to' },
  ],
});
const snapshot = (elements) => ({ osm3s: { timestamp_osm_base: '2000-01-01T00:00:00Z' }, elements });
const build = (elements) => buildRoadGraph(snapshot(elements), {
  bbox: [-1, -1, 1, 1], generatedAt: '2000-01-02T00:00:00Z',
});
const junction = () => [
  node(1, -.02, 0), node(2, 0, 0), node(3, .02, 0), node(4, 0, .02),
  way(11, [1, 2]), way(12, [2, 3]), way(13, [2, 4]),
];

test('query retains restriction members and complete OSM geometry; bbox order is explicit', () => {
  const query = buildOverpassQuery([-122.025, 37.526, -121.945, 37.574]);
  assert.match(query, /way\["highway"\]\(37\.526,-122\.025,37\.574,-121\.945\)/);
  assert.match(query, /rel\(bw\.roads\)\["type"="restriction"\]/);
  assert.match(query, /\(\._;>;\)/);
  assert.match(query, /out meta/);
  assert.throws(() => validateBBox([1, 0, -1, 1]), /bbox/);
});

test('true shared node splits ways; interior curve coordinates remain intact', () => {
  const graph = build([
    node(1, -.03, 0), node(2, -.02, .002), node(3, 0, 0), node(4, .02, 0), node(5, 0, .02),
    way(11, [1, 2, 3, 4]), way(12, [3, 5]),
  ]);
  assert.equal(graph.edges.length, 6);
  assert.ok(graph.nodes['3']);
  assert.equal(graph.nodes['2'], undefined);
  const edge = graph.edges.find((e) => e.from === '1' && e.to === '3');
  assert.deepEqual(edge.geometry, [[-.03, 0], [-.02, .002], [0, 0]]);
  assert.ok(Math.abs(edge.length - distance(edge.geometry[0], edge.geometry[1]) - distance(edge.geometry[1], edge.geometry[2])) < 1e-6);
  assert.equal(validateImportedGraph(graph, { requireCoreStreets: false }).valid, true);
});

test('crossing roads at identical coordinates but separate OSM IDs remain disconnected', () => {
  const graph = build([
    node(1, -.02, 0), node(2, .02, 0), node(3, 0, -.02), node(4, 0, .02),
    node(5, 0, 0), node(6, 0, 0),
    way(11, [1, 5, 2], { bridge: 'yes', layer: '1' }), way(12, [3, 6, 4]),
  ]);
  assert.equal(graph.edges.length, 4);
  assert.deepEqual(validateImportedGraph(graph, { requireCoreStreets: false }).componentSizes, [2, 2]);
  assert.ok(graph.edges.every((e) => (['1', '2'].includes(e.from) && ['1', '2'].includes(e.to)) ||
    (['3', '4'].includes(e.from) && ['3', '4'].includes(e.to))));
});

test('oneway=-1 reverses the entire curved geometry and bearings', () => {
  const graph = build([node(1, 0, 0), node(2, .01, .01), node(3, .02, .01), way(11, [1, 2, 3], { oneway: '-1' })]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].from, '3');
  assert.equal(graph.edges[0].to, '1');
  assert.deepEqual(graph.edges[0].geometry, [[.02, .01], [.01, .01], [0, 0]]);
  assert.ok(Math.abs(graph.edges[0].bearingStart - 270) < .001);
});

test('roundabouts imply one-way, while junction=circular alone does not', () => {
  const elements = [node(1, 0, 0), node(2, .01, 0), node(3, .01, .01)];
  assert.equal(build([...elements, way(11, [1, 2, 3, 1], { junction: 'roundabout' })]).edges.length, 1);
  assert.equal(build([...elements, way(11, [1, 2, 3, 1], { junction: 'circular' })]).edges.length, 2);
});

test('private access, construction, driveways and motorways do not become drivable roads', () => {
  const graph = build([
    node(1, -.01, 0), node(2, 0, 0),
    way(11, [1, 2]), way(12, [1, 2], { access: 'private' }),
    way(13, [1, 2], { highway: 'motorway' }), way(14, [1, 2], { construction: 'primary' }),
    way(15, [1, 2], { highway: 'service', service: 'driveway' }),
    way(16, [1, 2], { motor_vehicle: 'destination' }),
  ]);
  assert.ok(graph.edges.every((e) => e.wayId === '11'));
  assert.equal(graph.metadata.excluded.nonSurfaceOrRestricted, 5);
});

test('conditional access and reversible traffic are excluded with explicit reports', () => {
  const graph = build([
    node(1, -.01, 0), node(2, 0, 0), way(11, [1, 2]),
    way(12, [1, 2], { oneway: 'reversible' }),
    way(13, [1, 2], { 'motor_vehicle:conditional': 'no @ (Mo-Fr 08:00-09:00)' }),
  ]);
  assert.ok(graph.edges.every((e) => e.wayId === '11'));
  assert.equal(graph.metadata.excluded.unsupportedDirection, 2);
  assert.equal(graph.metadata.warnings.length, 2);
});

test('directional motor-vehicle access removes only the forbidden edge', () => {
  const graph = build([node(1, 0, 0), node(2, .01, 0), way(11, [1, 2], { 'motor_vehicle:forward': 'no' })]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].from, '2');
  assert.equal(graph.edges[0].to, '1');
});

test('unnamed OSM ways keep empty names rather than inventing a map label', () => {
  const unnamed = way(11, [1, 2]);
  delete unnamed.tags.name;
  const graph = build([node(1, 0, 0), node(2, .01, 0), unnamed]);
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every((edge) => edge.name === ''));
  assert.equal(validateImportedGraph(graph, { requireCoreStreets: false }).valid, true);
});

test('supported node-via turn restriction retains exact OSM way/node identities', () => {
  const graph = build([...junction(), relation(90, 11, 2, 13)]);
  assert.deepEqual(graph.restrictions, [{ via: '2', fromWay: '11', toWay: '13', type: 'no_left_turn' }]);
  assert.equal(graph.edges.length, 6);
});

test('motorcar exception disables an otherwise applicable generic restriction', () => {
  const graph = build([...junction(), relation(90, 11, 2, 13, { except: 'bicycle;motorcar' })]);
  assert.deepEqual(graph.restrictions, []);
  assert.equal(graph.edges.length, 6);
});

test('conditional restrictions close the affected junction rather than asserting legality', () => {
  const graph = build([...junction(), relation(90, 11, 2, 13, { 'restriction:conditional': 'no_left_turn @ (Mo-Fr)' })]);
  assert.deepEqual(graph.metadata.blockedViaNodes, ['2']);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.metadata.unsupportedRestrictions[0].relationId, '90');
  assert.match(graph.metadata.warnings[0], /legality requires review/);
});

test('unsupported via-way restrictions exclude the actual via way', () => {
  const restriction = relation(90, 11, 2, 13);
  restriction.members[1] = { type: 'way', ref: 12, role: 'via' };
  const graph = build([
    node(1, -.02, 0), node(2, -.01, 0), node(3, 0, 0), node(4, .01, 0),
    way(11, [1, 2]), way(12, [2, 3]), way(13, [3, 4]), restriction,
  ]);
  assert.deepEqual(graph.metadata.blockedWayIds, ['12']);
  assert.ok(graph.edges.every((e) => e.wayId !== '12'));
  assert.deepEqual(validateImportedGraph(graph, { requireCoreStreets: false }).componentSizes, [2, 2]);
});

test('only_* restriction with excluded sole outlet closes the junction', () => {
  const elements = junction();
  elements.find((e) => e.type === 'way' && e.id === 13).tags.access = 'private';
  const graph = build([...elements, relation(90, 11, 2, 13, { restriction: 'only_left_turn' })]);
  assert.deepEqual(graph.metadata.blockedViaNodes, ['2']);
  assert.equal(graph.edges.length, 0);
});

test('restricted barrier node cannot become a through connection', () => {
  const elements = junction();
  elements.find((e) => e.type === 'node' && e.id === 2).tags = { barrier: 'bollard' };
  const graph = build(elements);
  assert.deepEqual(graph.metadata.blockedViaNodes, ['2']);
  assert.equal(graph.edges.length, 0);
});

test('incomplete or failed Overpass responses are rejected rather than patched with coordinates', () => {
  assert.throws(() => build([node(1, 0, 0), way(11, [1, 2])]), /node 2 is missing/);
  assert.throws(() => buildRoadGraph({ remark: 'runtime error: Query timed out', elements: [] }), /incomplete\/error/);
  assert.throws(() => buildRoadGraph({ elements: [] }), /No drivable/);
});

test('missing core streets and absent source timestamp fail validation', () => {
  const graph = build([node(1, 0, 0), node(2, .01, 0), way(11, [1, 2])]);
  graph.metadata.sourceTimestamp = null;
  const result = validateImportedGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('snapshot timestamp')));
  assert.equal(result.streetCoverage.filter((s) => s.matchedNames.length === 0).length, 5);
});

const realGraphPath = fileURLToPath(new URL('../public/data/fremont-roads.json', import.meta.url));
test('actual imported Fremont snapshot has all five named roads and real shared intersections', {
  skip: existsSync(realGraphPath) ? false : 'No authentic OSM snapshot has been imported; geography verification is blocked.',
}, async () => {
  const graph = JSON.parse(await readFile(realGraphPath, 'utf8'));
  const result = validateImportedGraph(graph);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.streetCoverage.length, 5);
  assert.ok(result.streetCoverage.every((s) => s.matchedNames.length > 0));
  assert.ok(result.commonComponents.length > 0);
  assert.ok(result.verifiedCoreIntersections.length > 0);
  assert.ok(graph.metadata.bbox[0] < -121.9 && graph.metadata.bbox[2] > -122.1);
  assert.ok(graph.metadata.bbox[1] < 37.6 && graph.metadata.bbox[3] > 37.5);
  assert.ok(graph.edges.every((e) => !['motorway', 'motorway_link'].includes(e.highway)));
});

const realSourcePath = fileURLToPath(new URL('../data/cache/fremont-overpass.json', import.meta.url));
test('every real processed segment follows an exact contiguous source OSM way', {
  skip: existsSync(realGraphPath) && existsSync(realSourcePath) ? false : 'Authentic graph and raw OSM cache are required for source-integrity verification.',
}, async () => {
  const graph = JSON.parse(await readFile(realGraphPath, 'utf8'));
  const source = JSON.parse(await readFile(realSourcePath, 'utf8'));
  const sourceNodes = new Map(source.elements.filter((e) => e.type === 'node').map((n) => [String(n.id), n]));
  const sourceWays = new Map(source.elements.filter((e) => e.type === 'way').map((w) => [String(w.id), w]));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  for (const edge of graph.edges) {
    const sourceWay = sourceWays.get(edge.wayId);
    assert.ok(sourceWay, `Missing original OSM way for edge ${edge.id}`);
    for (const id of [edge.from, edge.to]) {
      assert.ok(sourceWay.nodes.some((n) => String(n) === id), `Endpoint ${id} is not part of OSM way ${sourceWay.id}`);
      const n = sourceNodes.get(id);
      assert.deepEqual([graph.nodes[id].lon, graph.nodes[id].lat], [n.lon, n.lat]);
    }
    let coordinates = sourceWay.nodes.map((id) => {
      const n = sourceNodes.get(String(id));
      return [n.lon, n.lat];
    });
    if (edge.id.endsWith(':r')) coordinates.reverse();
    coordinates = coordinates.filter((p, i) => i === 0 || !same(p, coordinates[i - 1]));
    const matchesSource = coordinates.some((point, i) => same(point, edge.geometry[0]) &&
      edge.geometry.every((p, j) => coordinates[i + j] && same(p, coordinates[i + j])));
    assert.ok(matchesSource, `Geometry ${edge.id} is not a continuous original OSM subsequence`);
  }
});
