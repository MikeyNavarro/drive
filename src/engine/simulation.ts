import { poseOnEdge, prepareGraph } from './graph';
import type { DriveInput, ManeuverOption, ManeuverType, RoadEdge, RoadGraph, TurnRestriction, VehicleState } from './types';

export const DEFAULT_MAX_SPEED_MPS = 15.6464; // 35 mph
const ACCELERATION_MPS2 = 2.6;
const BRAKING_MPS2 = 6.5;
const COASTING_MPS2 = 0.85;
const JUNCTION_BRAKING_MPS2 = 4;
const END_EPSILON_M = 0.001;
const MAX_JUNCTION_LOOKAHEAD_M = 750;
const maneuverCaches = new WeakMap<RoadGraph, { immediate: Map<string, ManeuverOption[]>; upcoming: Map<string, ManeuverOption[]> }>();

function maneuverCache(graph: RoadGraph) {
  let cached = maneuverCaches.get(graph);
  if (!cached) {
    cached = { immediate: new Map(), upcoming: new Map() };
    maneuverCaches.set(graph, cached);
  }
  return cached;
}

export function signedTurnAngle(fromBearing: number, toBearing: number): number {
  return ((toBearing - fromBearing + 540) % 360) - 180;
}

export function classifyTurn(angle: number): ManeuverType {
  if (Math.abs(angle) >= 150) return 'uturn';
  if (Math.abs(angle) <= 35) return 'straight';
  return angle < 0 ? 'left' : 'right';
}

function targetsMovement(restriction: TurnRestriction, exit: RoadEdge, incoming: RoadEdge, outlets: RoadEdge[]): boolean {
  if (exit.wayId !== restriction.toWay) return false;
  // A single OSM way can supply both a straight exit and its reverse edge.
  // In particular, no_u_turn must never ban its straight continuation.
  const suffix = restriction.type.replace(/^(no|only)_/, '');
  const fitsOrientation = (candidate: RoadEdge) => {
    const angle = signedTurnAngle(incoming.bearingEnd, candidate.bearingStart);
    if (suffix === 'u_turn') return Math.abs(angle) >= 150;
    // Restriction semantics do not use the UI's 35-degree straight tolerance:
    // even a shallow 20-degree right fork may carry a no_right_turn relation.
    if (suffix === 'left_turn') return angle < -1 && angle > -150;
    if (suffix === 'right_turn') return angle > 1 && angle < 150;
    if (suffix === 'straight_on') return Math.abs(angle) < 90;
    return true;
  };
  if (fitsOrientation(exit)) return true;
  const targetOutlets = outlets.filter(candidate => candidate.wayId === restriction.toWay);
  // Inconsistent bearings must never make a prohibited target way legal.
  // An only_* rule with no plausible outlet instead permits nothing.
  return suffix !== 'u_turn' && restriction.type.startsWith('no_')
    && !targetOutlets.some(fitsOrientation);
}

function restrictionAllows(restrictions: TurnRestriction[], exit: RoadEdge, incoming: RoadEdge, outlets: RoadEdge[]): boolean {
  const only = restrictions.filter(item => item.type.startsWith('only_'));
  if (only.length && !only.some(item => targetsMovement(item, exit, incoming, outlets))) return false;
  return !restrictions.some(item => item.type.startsWith('no_') && targetsMovement(item, exit, incoming, outlets));
}

function immediateManeuvers(graph: RoadGraph, edgeId: string): ManeuverOption[] {
  const cached = maneuverCache(graph).immediate.get(edgeId);
  if (cached) return cached;
  const index = prepareGraph(graph);
  const incoming = index.edgeById.get(edgeId);
  if (!incoming) return [];
  const restrictions = (index.restrictionsByVia.get(incoming.to) ?? []).filter(item => item.fromWay === incoming.wayId);
  const outlets = index.outgoing.get(incoming.to) ?? [];
  const options = outlets.flatMap(exit => {
    const turnAngle = signedTurnAngle(incoming.bearingEnd, exit.bearingStart);
    const type = classifyTurn(turnAngle);
    if (!restrictionAllows(restrictions, exit, incoming, outlets)) return [];
    return [{ edgeId: exit.id, type, turnAngle, name: exit.name,
      label: `${type === 'uturn' ? 'U-turn' : type[0].toUpperCase() + type.slice(1)} · ${exit.name || 'Unnamed road'}` }];
  });
  const hasOtherExit = options.some(option => option.type !== 'uturn');
  const uTurnExplicitlyAllowed = graph.nodes[incoming.to]?.uTurnAllowed || incoming.uTurnAllowed
    || restrictions.some(item => item.type === 'only_u_turn');
  const order: Record<ManeuverType, number> = { straight: 0, left: 1, right: 2, uturn: 3 };
  const legal = options.filter(option => option.type !== 'uturn' || !hasOtherExit || uTurnExplicitlyAllowed)
    .sort((a, b) => order[a.type] - order[b.type] || a.turnAngle - b.turnAngle || a.edgeId.localeCompare(b.edgeId));
  maneuverCache(graph).immediate.set(edgeId, legal);
  return legal;
}

function sameRoad(incoming: RoadEdge, outgoing: RoadEdge): boolean {
  if (incoming.wayId === outgoing.wayId) return true;
  const name = incoming.name.trim().toLowerCase();
  return !!name && name !== 'unnamed road' && name === outgoing.name.trim().toLowerCase();
}

function automaticExit(graph: RoadGraph, incoming: RoadEdge, options: ManeuverOption[]): string | null {
  const forward = options.filter(option => option.type !== 'uturn');
  if (forward.length === 1) {
    const option = forward[0];
    const exit = prepareGraph(graph).edgeById.get(option.edgeId)!;
    return option.type === 'straight' || sameRoad(incoming, exit) ? option.edgeId : null;
  }
  const straight = forward.filter(option => option.type === 'straight');
  return straight.length === 1 ? straight[0].edgeId : null;
}

/** Legal immediate directed transitions, including restrictions, without lookahead. */
export function legalExits(graph: RoadGraph, state: Pick<VehicleState, 'edgeId'>): ManeuverOption[] {
  return immediateManeuvers(graph, state.edgeId);
}

/**
 * Legal exits at the next decision, available before reaching it. Same-street
 * way boundaries with a sole continuation are skipped (at most 750 meters).
 * This does not skip a junction with any additional legal choice.
 */
export function legalManeuvers(graph: RoadGraph, state: Pick<VehicleState, 'edgeId'>): ManeuverOption[] {
  const cache = maneuverCache(graph).upcoming;
  const cached = cache.get(state.edgeId);
  if (cached) return cached;
  const index = prepareGraph(graph);
  const visited = new Set<string>();
  let incoming = index.edgeById.get(state.edgeId);
  let distance = 0;
  let options: ManeuverOption[] = [];
  while (incoming && !visited.has(incoming.id)) {
    visited.add(incoming.id);
    options = immediateManeuvers(graph, incoming.id);
    if (options.length !== 1 || options[0].type === 'uturn') break;
    const next = index.edgeById.get(options[0].edgeId)!;
    if (!sameRoad(incoming, next) || distance + next.length > MAX_JUNCTION_LOOKAHEAD_M) break;
    distance += next.length;
    incoming = next;
  }
  cache.set(state.edgeId, options);
  return options;
}

function selectedExit(graph: RoadGraph, state: VehicleState): string | null {
  const incoming = prepareGraph(graph).edgeById.get(state.edgeId)!;
  const options = immediateManeuvers(graph, state.edgeId);
  if (state.queuedEdgeId && options.some(option => option.edgeId === state.queuedEdgeId)) return state.queuedEdgeId;
  return automaticExit(graph, incoming, options);
}

export function getVehiclePose(graph: RoadGraph, state: Pick<VehicleState, 'edgeId' | 'distanceM'>) {
  const edge = prepareGraph(graph).edgeById.get(state.edgeId);
  if (!edge) throw new Error(`Vehicle references unknown edge ${state.edgeId}.`);
  return poseOnEdge(graph, edge, state.distanceM);
}

export function createVehicle(graph: RoadGraph, edgeId?: string): VehicleState {
  const index = prepareGraph(graph);
  const edge = edgeId === undefined ? graph.edges[0] : index.edgeById.get(edgeId);
  if (!edge) throw new Error(edgeId ? `Cannot spawn on unknown edge ${edgeId}.` : 'Cannot spawn a vehicle: the graph has no roads.');
  return {
    edgeId: edge.id, distanceM: 0, speedMps: 0, queuedEdgeId: null,
    stoppedAtJunction: false, ...poseOnEdge(graph, edge, 0),
  };
}

function applySelection(graph: RoadGraph, state: VehicleState, input: DriveInput): void {
  if (input.maneuver === undefined) return;
  if (input.maneuver === null) { state.queuedEdgeId = null; return; }
  const options = legalManeuvers(graph, state);
  const exact = options.find(option => option.edgeId === input.maneuver);
  const directional = options.filter(option => option.type === input.maneuver);
  state.queuedEdgeId = exact?.edgeId ?? (directional.length === 1 ? directional[0].edgeId : null);
}

function enterNextEdge(graph: RoadGraph, state: VehicleState): boolean {
  const index = prepareGraph(graph);
  const incoming = index.edgeById.get(state.edgeId)!;
  const nextId = selectedExit(graph, state);
  const next = nextId ? index.edgeById.get(nextId) : undefined;
  // This adjacency check is intentional even though legalManeuvers already checks it.
  // A stale or hand-edited serializable state can never cause a disconnected jump.
  if (!next || next.from !== incoming.to) {
    state.distanceM = incoming.length;
    state.speedMps = 0;
    state.stoppedAtJunction = true;
    state.queuedEdgeId = null;
    return false;
  }
  state.edgeId = next.id;
  state.distanceM = 0;
  if (state.queuedEdgeId === next.id) state.queuedEdgeId = null;
  state.stoppedAtJunction = false;
  return true;
}

/**
 * Return a new serializable state. All motion follows directed edge geometry.
 * S/brake decelerates to zero; it never reverses a vehicle onto a one-way road.
 * Explicit choices stay queued until the next junction. Unambiguous continuation
 * is automatic, but an uncertain intersection or a U-turn requires a choice.
 */
export function advance(graph: RoadGraph, previous: VehicleState, deltaSeconds: number, input: DriveInput = {}): VehicleState {
  const state: VehicleState = { ...previous, position: [...previous.position] };
  const index = prepareGraph(graph);
  let edge = index.edgeById.get(state.edgeId);
  if (!edge) throw new Error(`Vehicle references unknown edge ${state.edgeId}.`);
  state.distanceM = Math.max(0, Math.min(edge.length, Number.isFinite(state.distanceM) ? state.distanceM : 0));
  state.speedMps = Math.max(0, Number.isFinite(state.speedMps) ? state.speedMps : 0);
  applySelection(graph, state, input);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return { ...state, ...getVehiclePose(graph, state) };
  // Substeps make braking independent of rendering rate. Ignore elapsed time
  // beyond one minute (e.g. a suspended browser tab) to bound a single frame.
  const seconds = Math.min(deltaSeconds, 60);
  const count = Math.ceil(seconds / 0.05);
  const dt = seconds / count;
  const maxSpeed = typeof input.maxSpeedMps === 'number' && Number.isFinite(input.maxSpeedMps)
    ? Math.max(0, input.maxSpeedMps) : DEFAULT_MAX_SPEED_MPS;
  for (let step = 0; step < count; step++) {
    edge = index.edgeById.get(state.edgeId)!;
    if (edge.length - state.distanceM <= END_EPSILON_M && !enterNextEdge(graph, state)) break;
    edge = index.edgeById.get(state.edgeId)!;
    state.stoppedAtJunction = false;
    const oldSpeed = state.speedMps;
    const acceleration = input.brake ? -BRAKING_MPS2 : input.throttle ? ACCELERATION_MPS2 : -COASTING_MPS2;
    let newSpeed = Math.max(0, Math.min(maxSpeed, oldSpeed + acceleration * dt));
    const remaining = edge.length - state.distanceM;
    const mustStop = !selectedExit(graph, state);
    if (mustStop) newSpeed = Math.min(newSpeed, Math.sqrt(2 * JUNCTION_BRAKING_MPS2 * remaining));
    const movingTime = acceleration < 0 && oldSpeed + acceleration * dt < 0 ? oldSpeed / -acceleration : dt;
    let travel = (oldSpeed + newSpeed) / 2 * movingTime;
    state.speedMps = newSpeed;
    // A step can span several very short road pieces. Every crossing goes
    // through adjacency, direction, and turn-restriction checks.
    for (let crossed = 0; crossed < 128; crossed++) {
      edge = index.edgeById.get(state.edgeId)!;
      const toEnd = edge.length - state.distanceM;
      if (travel < toEnd - END_EPSILON_M) {
        state.distanceM += travel;
        break;
      }
      state.distanceM = edge.length;
      travel = Math.max(0, travel - toEnd);
      if (!enterNextEdge(graph, state)) break;
      if (travel <= 0) break;
    }
    if (state.stoppedAtJunction) break;
  }
  return { ...state, ...getVehiclePose(graph, state) };
}
