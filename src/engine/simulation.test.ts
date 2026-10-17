import { describe, expect, it } from 'vitest';
import { advance, compassBearing, createVehicle, distanceMeters, getVehiclePose, legalManeuvers, validateGraph } from './index';
import type { Coordinate, RoadEdge, RoadGraph } from './types';

/** Small invented coordinates test topology and physics, never map coverage. */
function syntheticGraph(points: Record<string, Coordinate>, roads: Array<[string, string, string, string?]>, restrictions: RoadGraph['restrictions'] = []): RoadGraph {
  const nodes = Object.fromEntries(Object.entries(points).map(([id, [lon, lat]]) => [id, { id, lon, lat }]));
  const edges: RoadEdge[] = roads.map(([id, from, to, wayId]) => ({
    id, from, to, wayId: wayId ?? id, name: `${id} Road`, highway: 'residential',
    geometry: [points[from], points[to]], length: distanceMeters(points[from], points[to]),
    bearingStart: compassBearing(points[from], points[to]), bearingEnd: compassBearing(points[from], points[to]),
  }));
  return {
    metadata: { bbox: [-1, -1, 1, 1], generatedAt: '2026-01-01T00:00:00Z', source: 'Synthetic unit-test fixture' },
    nodes, edges, restrictions,
  };
}

const crossPoints: Record<string, Coordinate> = {
  a: [0, -0.001], j: [0, 0], n: [0, 0.001], e: [0.001, 0], w: [-0.001, 0],
};
const crossRoads: Array<[string, string, string, string?]> = [
  ['approach', 'a', 'j', 'main'], ['reverse', 'j', 'a', 'main'],
  ['north', 'j', 'n', 'main'], ['east', 'j', 'e', 'cross'], ['west', 'j', 'w', 'cross'],
];

describe('directed road movement', () => {
  it('accelerates, coasts, and brakes without reversing or mutating the old state', () => {
    const graph = syntheticGraph({ a: [0, 0], b: [0, 0.1] }, [['ab', 'a', 'b']]);
    const original = createVehicle(graph);
    const accelerating = advance(graph, original, 3, { throttle: true });
    expect(accelerating.speedMps).toBeGreaterThan(7);
    expect(accelerating.distanceM).toBeGreaterThan(10);
    expect(original.distanceM).toBe(0);
    const coasting = advance(graph, accelerating, 1);
    expect(coasting.speedMps).toBeLessThan(accelerating.speedMps);
    const stopped = advance(graph, coasting, 5, { brake: true });
    const held = advance(graph, stopped, 5, { brake: true });
    expect(stopped.speedMps).toBe(0);
    expect(held.distanceM).toBeCloseTo(stopped.distanceM, 8);
    expect(held.distanceM).toBeGreaterThan(accelerating.distanceM);
    expect(held.edgeId).toBe('ab');
  });

  it('has approximately the same motion at different rendering frame rates', () => {
    const graph = syntheticGraph({ a: [0, 0], b: [0, 0.1] }, [['ab', 'a', 'b']]);
    const whole = advance(graph, createVehicle(graph), 2, { throttle: true });
    let frames = createVehicle(graph);
    for (let i = 0; i < 120; i++) frames = advance(graph, frames, 1 / 60, { throttle: true });
    expect(frames.speedMps).toBeCloseTo(whole.speedMps, 8);
    expect(frames.distanceM).toBeCloseTo(whole.distanceM, 8);
  });

  it('uses each geometry segment instead of cutting across a curved road', () => {
    const graph = syntheticGraph({ a: [0, 0], b: [0.001, 0.001] }, [['curve', 'a', 'b']]);
    const edge = graph.edges[0];
    edge.geometry = [[0, 0], [0, 0.001], [0.001, 0.001]];
    edge.length = distanceMeters(edge.geometry[0], edge.geometry[1]) + distanceMeters(edge.geometry[1], edge.geometry[2]);
    edge.bearingStart = 0;
    edge.bearingEnd = 90;
    const first = getVehiclePose(graph, { edgeId: 'curve', distanceM: edge.length / 4 });
    const last = getVehiclePose(graph, { edgeId: 'curve', distanceM: edge.length * 3 / 4 });
    expect(first.position[0]).toBe(0);
    expect(first.position[1]).toBeCloseTo(0.0005);
    expect(first.bearing).toBeCloseTo(0);
    expect(last.position[1]).toBe(0.001);
    expect(last.position[0]).toBeCloseTo(0.0005);
    expect(last.bearing).toBeCloseTo(90);
  });

  it('stops at a one-way endpoint and cannot jump to a disconnected edge', () => {
    const graph = syntheticGraph({ a: [0, 0], b: [0, 0.001], x: [0.1, 0], y: [0.1, 0.001] }, [['ab', 'a', 'b'], ['xy', 'x', 'y']]);
    const vehicle = { ...createVehicle(graph), distanceM: graph.edges[0].length - 2, speedMps: 10, queuedEdgeId: 'xy' };
    const stopped = advance(graph, vehicle, 2, { throttle: true });
    expect(stopped.edgeId).toBe('ab');
    expect(stopped.distanceM).toBe(graph.edges[0].length);
    expect(stopped.position).toEqual([0, 0.001]);
    expect(stopped.speedMps).toBe(0);
    expect(stopped.stoppedAtJunction).toBe(true);
    expect(legalManeuvers(graph, stopped)).toEqual([]);
  });
});

describe('junction choices', () => {
  it('queues an explicit turn before arrival and consumes the queue on crossing', () => {
    const graph = syntheticGraph(crossPoints, crossRoads);
    const vehicle = { ...createVehicle(graph, 'approach'), distanceM: 90, speedMps: 10 };
    const queued = advance(graph, vehicle, 0, { maneuver: 'right' });
    expect(queued.queuedEdgeId).toBe('east');
    const next = advance(graph, queued, 2.5, { throttle: true });
    expect(next.edgeId).toBe('east');
    expect(next.distanceM).toBeGreaterThan(0);
    expect(next.queuedEdgeId).toBeNull();
    expect(next.position[1]).toBe(0);
    expect(next.position[0]).toBeGreaterThan(0);
  });

  it('continues straight automatically at an intersection', () => {
    const graph = syntheticGraph(crossPoints, crossRoads);
    const vehicle = { ...createVehicle(graph), distanceM: 105, speedMps: 10 };
    const next = advance(graph, vehicle, 1, { throttle: true });
    expect(next.edgeId).toBe('north');
  });

  it('follows a sole curved continuation without treating it as an uncertain junction', () => {
    const graph = syntheticGraph(crossPoints, [['aj', 'a', 'j', 'curvingRoad'], ['je', 'j', 'e', 'curvingRoad']]);
    const vehicle = { ...createVehicle(graph), distanceM: 105, speedMps: 10 };
    const next = advance(graph, vehicle, 1, { throttle: true });
    expect(next.edgeId).toBe('je');
  });

  it('requires a choice for a sole nonstraight exit onto a different road', () => {
    const graph = syntheticGraph(crossPoints, [['aj', 'a', 'j'], ['je', 'j', 'e']]);
    const vehicle = { ...createVehicle(graph), distanceM: 105, speedMps: 8 };
    const stopped = advance(graph, vehicle, 3, { throttle: true });
    expect(stopped.edgeId).toBe('aj');
    expect(stopped.stoppedAtJunction).toBe(true);
    const next = advance(graph, stopped, 1, { throttle: true, maneuver: 'right' });
    expect(next.edgeId).toBe('je');
  });

  it('looks ahead through same-name way boundaries and preserves a queued future turn', () => {
    const graph = syntheticGraph({ a: [0, -0.002], b: [0, -0.001], j: [0, 0], e: [0.001, 0], w: [-0.001, 0] }, [
      ['ab', 'a', 'b', 'way1'], ['bj', 'b', 'j', 'way2'], ['je', 'j', 'e'], ['jw', 'j', 'w'],
    ]);
    graph.edges[0].name = 'Continuous Avenue';
    graph.edges[1].name = 'Continuous Avenue';
    const original = { ...createVehicle(graph), distanceM: 105, speedMps: 10 };
    expect(legalManeuvers(graph, original).map(option => option.edgeId).sort()).toEqual(['je', 'jw']);
    const queued = advance(graph, original, 1, { throttle: true, maneuver: 'je' });
    expect(queued.edgeId).toBe('bj');
    expect(queued.queuedEdgeId).toBe('je');
    const turned = advance(graph, queued, 10, { throttle: true });
    expect(turned.edgeId).toBe('je');
    expect(turned.queuedEdgeId).toBeNull();
  });

  it('stops at an uncertain junction, then resumes after a legal explicit choice', () => {
    const graph = syntheticGraph(crossPoints, [['aj', 'a', 'j'], ['je', 'j', 'e'], ['jw', 'j', 'w']]);
    const vehicle = { ...createVehicle(graph), distanceM: 102, speedMps: 8 };
    const stopped = advance(graph, vehicle, 4, { throttle: true });
    expect(stopped.edgeId).toBe('aj');
    expect(stopped.stoppedAtJunction).toBe(true);
    expect(stopped.speedMps).toBe(0);
    const resumed = advance(graph, stopped, 1, { throttle: true, maneuver: 'left' });
    expect(resumed.edgeId).toBe('jw');
    expect(resumed.distanceM).toBeGreaterThan(0);
  });

  it('requires an edge id when more than one exit shares a maneuver category', () => {
    const graph = syntheticGraph({ ...crossPoints, ne: [0.001, 0.001] }, [['aj', 'a', 'j'], ['je', 'j', 'e'], ['jne', 'j', 'ne']]);
    const vehicle = { ...createVehicle(graph), distanceM: 105, speedMps: 8 };
    const ambiguous = advance(graph, vehicle, 0, { maneuver: 'right' });
    expect(ambiguous.queuedEdgeId).toBeNull();
    expect(legalManeuvers(graph, vehicle).filter(option => option.type === 'right')).toHaveLength(2);
    const selected = advance(graph, vehicle, 2, { maneuver: 'jne', throttle: true });
    expect(selected.edgeId).toBe('jne');
  });

  it('never automatically chooses a U-turn, and only offers it at a dead end or when allowed', () => {
    const cross = syntheticGraph(crossPoints, crossRoads);
    expect(legalManeuvers(cross, createVehicle(cross)).some(option => option.type === 'uturn')).toBe(false);
    const deadEnd = syntheticGraph(crossPoints, [['aj', 'a', 'j', 'main'], ['ja', 'j', 'a', 'main']]);
    const vehicle = { ...createVehicle(deadEnd), distanceM: 105, speedMps: 8 };
    const stopped = advance(deadEnd, vehicle, 3, { throttle: true });
    expect(stopped.edgeId).toBe('aj');
    expect(stopped.stoppedAtJunction).toBe(true);
    expect(legalManeuvers(deadEnd, stopped)[0].type).toBe('uturn');
    const turned = advance(deadEnd, stopped, 1, { throttle: true, maneuver: 'uturn' });
    expect(turned.edgeId).toBe('ja');
  });
});

describe('turn restrictions and graph validation', () => {
  it('distinguishes opposite branches on the same OSM way for no/only turn restrictions', () => {
    const noRight = syntheticGraph(crossPoints, crossRoads, [{ via: 'j', fromWay: 'main', toWay: 'cross', type: 'no_right_turn' }]);
    expect(legalManeuvers(noRight, createVehicle(noRight)).map(option => option.edgeId)).toEqual(['north', 'west']);
    const onlyRight = syntheticGraph(crossPoints, crossRoads, [{ via: 'j', fromWay: 'main', toWay: 'cross', type: 'only_right_turn' }]);
    expect(legalManeuvers(onlyRight, createVehicle(onlyRight)).map(option => option.edgeId)).toEqual(['east']);
  });

  it('blocks no_u_turn without accidentally blocking the straight portion of the same way', () => {
    const graph = syntheticGraph(crossPoints, crossRoads, [{ via: 'j', fromWay: 'main', toWay: 'main', type: 'no_u_turn' }]);
    expect(legalManeuvers(graph, createVehicle(graph)).map(option => option.edgeId)).toContain('north');
    expect(legalManeuvers(graph, createVehicle(graph)).map(option => option.edgeId)).not.toContain('reverse');
  });

  it('enforces a turn restriction at a shallow fork even inside the straight display tolerance', () => {
    const graph = syntheticGraph({ a: [0, -0.001], j: [0, 0], n: [0, 0.001], ne: [0.0003, 0.001] }, [
      ['approach', 'a', 'j', 'main'], ['north', 'j', 'n', 'northRoad'], ['fork', 'j', 'ne', 'forkWay'],
    ], [{ via: 'j', fromWay: 'main', toWay: 'forkWay', type: 'no_right_turn' }]);
    expect(legalManeuvers(graph, createVehicle(graph)).map(option => option.edgeId)).toEqual(['north']);
  });

  it('never connects a visual crossing whose OSM node ids are different', () => {
    const graph = syntheticGraph({ a: [0, -0.001], j: [0, 0], overpass: [0, 0], e: [0.001, 0] }, [
      ['aj', 'a', 'j'], ['bridge', 'overpass', 'e'],
    ]);
    expect(validateGraph(graph).errors).toEqual([]);
    expect(legalManeuvers(graph, createVehicle(graph))).toEqual([]);
    const vehicle = { ...createVehicle(graph), distanceM: 105, speedMps: 10, queuedEdgeId: 'bridge' };
    const stopped = advance(graph, vehicle, 2, { throttle: true });
    expect(stopped.edgeId).toBe('aj');
    expect(stopped.stoppedAtJunction).toBe(true);
  });

  it('supports explicitly permitted U-turns while preserving a prohibition at a dead end', () => {
    const allowed = syntheticGraph(crossPoints, crossRoads);
    allowed.nodes.j.uTurnAllowed = true;
    expect(legalManeuvers(allowed, createVehicle(allowed)).some(option => option.type === 'uturn')).toBe(true);
    const forbidden = syntheticGraph(crossPoints, [['aj', 'a', 'j', 'main'], ['ja', 'j', 'a', 'main']], [
      { via: 'j', fromWay: 'main', toWay: 'main', type: 'no_u_turn' },
    ]);
    expect(legalManeuvers(forbidden, createVehicle(forbidden))).toEqual([]);
    const only = syntheticGraph(crossPoints, crossRoads, [
      { via: 'j', fromWay: 'main', toWay: 'main', type: 'only_u_turn' },
    ]);
    expect(legalManeuvers(only, createVehicle(only)).map(option => option.edgeId)).toEqual(['reverse']);
  });

  it('accepts a coherent graph and rejects disconnected geometry and missing endpoints', () => {
    const graph = syntheticGraph(crossPoints, crossRoads);
    expect(validateGraph(graph).errors).toEqual([]);
    graph.edges[0].geometry[0] = [0.5, 0.5];
    graph.edges[1].to = 'missing';
    const result = validateGraph(graph);
    expect(result.errors.some(message => message.includes('does not begin'))).toBe(true);
    expect(result.errors.some(message => message.includes('missing to node'))).toBe(true);
    expect(validateGraph({}).errors.length).toBeGreaterThan(0);
  });
});
