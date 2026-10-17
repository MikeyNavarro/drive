/** Longitude, latitude in WGS84 degrees. */
export type Coordinate = [number, number];

export interface RoadNode {
  id: string;
  lon: number;
  lat: number;
  /** Only set when the source or a deliberate local configuration permits this. */
  uTurnAllowed?: boolean;
}

/** Each edge is a permitted direction of travel, never an undirected road. */
export interface RoadEdge {
  id: string;
  wayId: string;
  from: string;
  to: string;
  name: string;
  highway: string;
  geometry: Coordinate[];
  length: number;
  bearingStart: number;
  bearingEnd: number;
  uTurnAllowed?: boolean;
  [key: string]: unknown;
}

export interface TurnRestriction {
  via: string;
  fromWay: string;
  toWay: string;
  type: `no_${string}` | `only_${string}`;
}

export interface RoadGraph {
  metadata: {
    bbox: [number, number, number, number];
    generatedAt: string;
    source: string;
    [key: string]: unknown;
  };
  nodes: Record<string, RoadNode>;
  edges: RoadEdge[];
  restrictions: TurnRestriction[];
}

export type Graph = RoadGraph;
export type ManeuverType = 'straight' | 'left' | 'right' | 'uturn';

export interface ManeuverOption {
  edgeId: string;
  type: ManeuverType;
  label: string;
  name: string;
  /** Clockwise change from the approach bearing, in [-180, 180]. */
  turnAngle: number;
}

export interface VehicleState {
  edgeId: string;
  /** Meters along the current directed edge. */
  distanceM: number;
  speedMps: number;
  queuedEdgeId: string | null;
  stoppedAtJunction: boolean;
  position: Coordinate;
  /** Compass bearing, clockwise from north. */
  bearing: number;
}

export interface DriveInput {
  throttle?: boolean;
  /** Braking only. Reverse travel is deliberately unsupported. */
  brake?: boolean;
  /** An edge id is unambiguous. A direction queues only a unique matching exit. */
  maneuver?: string | null;
  maxSpeedMps?: number;
}

export interface GraphValidation {
  errors: string[];
  warnings: string[];
}
