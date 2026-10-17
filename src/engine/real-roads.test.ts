import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { advance, classifyTurn, createVehicle, distanceMeters, legalExits, prepareGraph, signedTurnAngle, validateGraph } from './index';
import type { Coordinate, RoadGraph } from './types';

const snapshotPath = fileURLToPath(new URL('../../public/data/fremont-roads.json', import.meta.url));
const hasSnapshot = existsSync(snapshotPath);
const graph: RoadGraph | null = hasSnapshot ? JSON.parse(readFileSync(snapshotPath, 'utf8')) as RoadGraph : null;
const CORE_STREETS = ['Fremont Boulevard', 'Mowry Avenue', 'Stevenson Boulevard', 'Paseo Padre Parkway', 'Walnut Avenue'];

function distanceToGeometry(point: Coordinate, geometry: Coordinate[]): number {
  let closest = Infinity;
  // Local tangent-plane projection is accurate at the scale of one road segment.
  const metersPerDegree = 111_195;
  const lonScale = metersPerDegree * Math.cos(point[1] * Math.PI / 180);
  for (let i = 1; i < geometry.length; i++) {
    const a = [(geometry[i - 1][0] - point[0]) * lonScale, (geometry[i - 1][1] - point[1]) * metersPerDegree];
    const b = [(geometry[i][0] - point[0]) * lonScale, (geometry[i][1] - point[1]) * metersPerDegree];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy || 1)));
    closest = Math.min(closest, Math.hypot(a[0] + t * dx, a[1] + t * dy));
  }
  return closest;
}

/** These tests use the actual checked-in OSM snapshot, never invented geometry. */
describe.skipIf(!hasSnapshot)('actual Fremont road snapshot', () => {
  it('has coherent directed geometry, source provenance, and all five initial streets', () => {
    expect(graph).not.toBeNull();
    expect(graph!.metadata.source).toBe('OpenStreetMap');
    expect(graph!.metadata.sourceTimestamp).toBeTruthy();
    expect(graph!.metadata.license).toBe('ODbL-1.0');
    expect(validateGraph(graph!).errors).toEqual([]);
    const names = new Set(graph!.edges.map(edge => edge.name));
    expect(CORE_STREETS.every(name => names.has(name))).toBe(true);
  });

  it('keeps sampled moving vehicles on the imported geometry without snapping across roads', () => {
    const longEdges = graph!.edges.filter(edge => edge.length > 30);
    const stride = Math.max(1, Math.floor(longEdges.length / 128));
    let checked = 0;
    for (let i = 0; i < longEdges.length; i += stride) {
      const edge = longEdges[i];
      const state = { ...createVehicle(graph!, edge.id), distanceM: edge.length / 2, speedMps: 7 };
      const moved = advance(graph!, state, 0.25, { throttle: true });
      expect(moved.edgeId).toBe(edge.id);
      expect(moved.distanceM).toBeGreaterThan(state.distanceM);
      expect(distanceToGeometry(moved.position, edge.geometry)).toBeLessThan(0.01);
      expect(distanceMeters(createVehicle(graph!, edge.id).position, edge.geometry[0])).toBeLessThan(0.001);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(100);
  });

  it('traverses actual legal shared-node junctions continuously', () => {
    const index = prepareGraph(graph!);
    let checked = 0;
    for (const edge of graph!.edges) {
      const options = legalExits(graph!, { edgeId: edge.id });
      if (edge.length < 10 || options.length < 2) continue;
      const option = options.find(exit => index.edgeById.get(exit.edgeId)!.length > 10 && exit.type !== 'uturn');
      if (!option) continue;
      const nextEdge = index.edgeById.get(option.edgeId)!;
      expect(nextEdge.from).toBe(edge.to);
      expect(distanceMeters(edge.geometry.at(-1)!, nextEdge.geometry[0])).toBeLessThan(0.001);
      const state = { ...createVehicle(graph!, edge.id), distanceM: edge.length - 1, speedMps: 10 };
      const moved = advance(graph!, state, 0.2, { throttle: true, maneuver: option.edgeId });
      expect(moved.edgeId).toBe(nextEdge.id);
      expect(distanceToGeometry(moved.position, nextEdge.geometry)).toBeLessThan(0.01);
      if (++checked >= 32) break;
    }
    expect(checked).toBe(32);
  });

  it('enforces actual no_u_turn relations and cannot invent a missing one-way reverse edge', () => {
    const index = prepareGraph(graph!);
    let checkedRestrictions = 0;
    for (const restriction of graph!.restrictions.filter(item => item.type === 'no_u_turn')) {
      for (const incoming of index.incoming.get(restriction.via) ?? []) {
        if (incoming.wayId !== restriction.fromWay) continue;
        for (const option of legalExits(graph!, { edgeId: incoming.id })) {
          const outgoing = index.edgeById.get(option.edgeId)!;
          if (outgoing.wayId === restriction.toWay) {
            expect(classifyTurn(signedTurnAngle(incoming.bearingEnd, outgoing.bearingStart))).not.toBe('uturn');
          }
        }
        checkedRestrictions++;
      }
    }
    expect(checkedRestrictions).toBeGreaterThan(0);
    const oneWay = graph!.edges.find(edge => CORE_STREETS.includes(edge.name)
      && !(index.outgoing.get(edge.to) ?? []).some(exit => exit.to === edge.from && exit.wayId === edge.wayId));
    expect(oneWay).toBeDefined();
    const options = legalExits(graph!, { edgeId: oneWay!.id });
    expect(options.every(option => index.edgeById.get(option.edgeId)!.from === oneWay!.to)).toBe(true);
    expect(options.some(option => {
      const outgoing = index.edgeById.get(option.edgeId)!;
      return outgoing.to === oneWay!.from && outgoing.wayId === oneWay!.wayId;
    })).toBe(false);
  });

  it('connects representative starts on all five streets in both directions through legal turns', () => {
    const index = prepareGraph(graph!);
    // Incoming directed edges are the search states, so turn restrictions are
    // included; undirected visual connectivity is insufficient for this check.
    const transitions = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();
    for (const edge of graph!.edges) {
      const destinations = legalExits(graph!, { edgeId: edge.id }).map(option => option.edgeId);
      transitions.set(edge.id, destinations);
      for (const destination of destinations) {
        const parents = reverse.get(destination) ?? [];
        parents.push(edge.id);
        reverse.set(destination, parents);
      }
    }
    const reachable = (start: string, adjacency: Map<string, string[]>) => {
      const found = new Set([start]);
      const queue = [start];
      for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]) ?? []) {
        if (!found.has(next)) { found.add(next); queue.push(next); }
      }
      return found;
    };
    // Prefer a real junction shared by two initial streets, as the UI does.
    const starter = graph!.edges.find(edge => edge.name === 'Fremont Boulevard'
      && (index.outgoing.get(edge.from) ?? []).some(exit => exit.name === 'Mowry Avenue'))
      ?? graph!.edges.find(edge => edge.name === 'Fremont Boulevard');
    expect(starter).toBeDefined();
    const forwards = reachable(starter!.id, transitions);
    const backwards = reachable(starter!.id, reverse);
    const mutual = new Set([...forwards].filter(id => backwards.has(id)));
    const representatives = CORE_STREETS.map(name => graph!.edges.find(edge => edge.name === name && mutual.has(edge.id)));
    expect(representatives.every(Boolean)).toBe(true);
    expect(mutual.size).toBeGreaterThan(100);
    for (const edge of representatives) {
      expect(forwards.has(edge!.id)).toBe(true);
      expect(backwards.has(edge!.id)).toBe(true);
    }
  });
});
