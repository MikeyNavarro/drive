import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as LibreMap, type StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import type { RoadGraph, VehicleState } from '../engine';
import { legalManeuvers, prepareGraph } from '../engine';
import { MAP_CONFIG } from '../config/map';

type LabelMode = 'all' | 'priority' | 'none';

interface MapViewProps {
  graph: RoadGraph | null;
  vehicle: VehicleState | null;
  labelMode: LabelMode;
  highlightPriority: boolean;
  orientation: 'north' | 'heading';
  follow: boolean;
  onFollowChange: (value: boolean) => void;
  priorityNames: string[];
  selectedRoad?: string | null;
  onMapReady?: (map: LibreMap) => void;
}

const ROADS = 'patrol-roads';
const LABELS = 'patrol-road-labels';
const ACTIVE = 'patrol-active-road';
const EMPTY: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
const originalVisibility = new WeakMap<LibreMap, globalThis.Map<string, unknown>>();

// A tile-independent map still shows the real, locally cached OSM road geometry.
// Omitting a glyph URL lets MapLibre 5 render text with local system fonts;
// no routing or map service is involved in moving the patrol vehicle.
const LOCAL_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'patrol-background', type: 'background', paint: { 'background-color': '#e8ece7' } }],
};

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[.]/g, '').replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bavenue\b/g, 'ave').replace(/\bparkway\b/g, 'pkwy')
    .replace(/\broad\b/g, 'rd').replace(/\bstreet\b/g, 'st')
    .replace(/\bdrive\b/g, 'dr').replace(/\bhighway\b/g, 'hwy')
    .replace(/\s+/g, ' ').trim();
}

function roadData(graph: RoadGraph | null, priorities: string[], selected?: string | null): FeatureCollection<LineString> {
  if (!graph) return EMPTY;
  const names = new Set(priorities.map(normalizedName));
  const selectedName = selected ? normalizedName(selected) : null;
  const seen = new Set<string>();
  return {
    type: 'FeatureCollection',
    features: graph.edges.flatMap(edge => {
      // Directed graph edges share a physical road. Draw/label it only once.
      const key = `${edge.wayId}:${[edge.from, edge.to].sort().join(':')}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const name = normalizedName(edge.name);
      return [{
        type: 'Feature' as const,
        properties: {
          name: edge.name,
          highway: edge.highway,
          priority: names.has(name),
          selected: selectedName !== null && name === selectedName,
        },
        geometry: { type: 'LineString' as const, coordinates: edge.geometry },
      }];
    }),
  };
}

function activeData(graph: RoadGraph | null, vehicle: VehicleState | null): FeatureCollection<LineString> {
  const edge = graph && vehicle ? prepareGraph(graph).edgeById.get(vehicle.edgeId) : null;
  return edge ? {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: edge.geometry } }],
  } : EMPTY;
}

function addRoadLayers(map: LibreMap): void {
  if (map.getSource(ROADS)) return;
  originalVisibility.set(map, new globalThis.Map((map.getStyle().layers ?? [])
    .filter(layer => layer.type === 'symbol')
    .map(layer => [layer.id, layer.layout?.visibility ?? 'visible'])));
  map.addSource(ROADS, { type: 'geojson', data: EMPTY });
  map.addSource(ACTIVE, { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'patrol-road-outline', type: 'line', source: ROADS,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#c3cbc4', 'line-opacity': 0.75,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 14, 6, 18, 18] },
  });
  map.addLayer({
    id: 'patrol-road-fill', type: 'line', source: ROADS,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.95,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 14, 4.2, 18, 15] },
  });
  map.addLayer({
    id: 'patrol-priority-roads', type: 'line', source: ROADS,
    filter: ['==', ['get', 'priority'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#b7d87e', 'line-opacity': 0.53,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 14, 5, 18, 15] },
  });
  map.addLayer({
    id: 'patrol-selected-road', type: 'line', source: ROADS,
    filter: ['==', ['get', 'selected'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#91b84f', 'line-opacity': 0.7,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 7, 18, 20] },
  });
  map.addLayer({
    id: 'patrol-active-line', type: 'line', source: ACTIVE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#719a92', 'line-opacity': 0.38,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 14, 4, 18, 10] },
  });
  map.addLayer({
    id: LABELS, type: 'symbol', source: ROADS, minzoom: 12,
    filter: ['!=', ['get', 'name'], ''],
    layout: {
      'symbol-placement': 'line', 'symbol-spacing': 310,
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 15, 12.5, 18, 14],
      'text-max-angle': 35, 'text-letter-spacing': 0.025,
      'text-padding': 6, 'text-rotation-alignment': 'map',
    },
    paint: { 'text-color': '#58605c', 'text-halo-color': '#fffef8', 'text-halo-width': 1.7 },
  });
}

function applyLabelMode(map: LibreMap, mode: LabelMode, highlight: boolean, hasGraph: boolean): void {
  const layers = map.getStyle()?.layers ?? [];
  for (const layer of layers) {
    if (layer.id.startsWith('patrol-') || layer.type !== 'symbol') continue;
    const hasText = layer.layout && 'text-field' in layer.layout;
    if (!hasText) continue;
    const descriptor = `${layer.id} ${'source-layer' in layer ? layer['source-layer'] : ''}`;
    const isRoad = /road|highway|street|transportation|motorway|tunnel|bridge|ferry/i.test(descriptor)
      || layer.layout?.['symbol-placement'] === 'line';
    // With a graph, replace provider road labels with verified graph labels.
    // Without one, keep the provider's street names in the default all mode.
    // Training modes still suppress them, preventing street-name leakage.
    map.setLayoutProperty(layer.id, 'visibility', mode === 'none' || (isRoad && (hasGraph || mode === 'priority'))
      ? 'none' : originalVisibility.get(map)?.get(layer.id) ?? 'visible');
  }
  if (map.getLayer(LABELS)) {
    map.setLayoutProperty(LABELS, 'visibility', mode === 'none' ? 'none' : 'visible');
    map.setFilter(LABELS, mode === 'priority'
      ? ['all', ['!=', ['get', 'name'], ''], ['==', ['get', 'priority'], true]]
      : ['!=', ['get', 'name'], '']);
  }
  if (map.getLayer('patrol-priority-roads')) {
    map.setLayoutProperty('patrol-priority-roads', 'visibility', highlight ? 'visible' : 'none');
  }
}

function createPatrolElement(): HTMLDivElement {
  const marker = document.createElement('div');
  marker.className = 'patrol-marker';
  marker.setAttribute('role', 'group');
  marker.setAttribute('aria-label', 'Patrol vehicle');
  marker.style.cssText = 'width:52px;height:88px;cursor:default;filter:drop-shadow(0 3px 5px #182d3844);';
  marker.innerHTML = `<svg width="52" height="88" viewBox="0 0 52 88" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M26 0L39 22H13L26 0Z" fill="#6e9474" fill-opacity=".18"/>
    <path d="M26 4L30.5 12H21.5L26 4Z" fill="#395e51"/>
    <ellipse cx="26" cy="44" rx="22" ry="26" fill="#b9d87b" fill-opacity=".19"/>
    <rect x="13.5" y="23" width="25" height="43" rx="8" fill="#f8faf6" stroke="#20312e" stroke-width="2"/>
    <rect x="12" y="31" width="3" height="9" rx="1" fill="#1e2927"/>
    <rect x="37" y="31" width="3" height="9" rx="1" fill="#1e2927"/>
    <rect x="12" y="52" width="3" height="8" rx="1" fill="#1e2927"/>
    <rect x="37" y="52" width="3" height="8" rx="1" fill="#1e2927"/>
    <path d="M17.5 28Q26 25 34.5 28L33 36H19L17.5 28Z" fill="#263c3b"/>
    <rect x="17" y="38" width="18" height="15" rx="2" fill="#20312e"/>
    <rect x="17" y="40" width="9" height="3" rx="1" fill="#74b4e8"/>
    <rect x="26" y="40" width="9" height="3" rx="1" fill="#e77b75"/>
    <path d="M19 56H33L34 61H18L19 56Z" fill="#425c56"/>
    <rect x="16" y="24" width="5" height="2" rx="1" fill="#fffbd4"/>
    <rect x="31" y="24" width="5" height="2" rx="1" fill="#fffbd4"/>
    <g data-selected-turn transform="translate(40 18)" style="display:none">
      <circle r="10.5" fill="#e9f2d8" stroke="#6c8c54" stroke-width="1"/>
      <path data-selected-turn-path fill="none" stroke="#35552c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg><span data-maneuver-status role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0"></span>`;
  return marker;
}

const TURN_PATHS = {
  straight: 'M0 6V-5M-4 -1L0 -5L4 -1',
  left: 'M3 5V-2H-5M-1 -6L-5 -2L-1 2',
  right: 'M-3 5V-2H5M1 -6L5 -2L1 2',
  uturn: 'M-4 5V-1A4 4 0 0 1 4 -1V5M1 2L4 5L7 2',
};

function updateManeuverIndicator(element: HTMLElement, graph: RoadGraph | null, vehicle: VehicleState): void {
  const edges = graph ? prepareGraph(graph).edgeById : null;
  const incoming = edges?.get(vehicle.edgeId);
  const exit = vehicle.queuedEdgeId ? edges?.get(vehicle.queuedEdgeId) : null;
  const maneuver = graph && exit ? legalManeuvers(graph, vehicle).find(option => option.edgeId === exit.id) : null;
  const indicator = element.querySelector<SVGGElement>('[data-selected-turn]');
  const path = element.querySelector<SVGPathElement>('[data-selected-turn-path]');
  const status = element.querySelector<HTMLElement>('[data-maneuver-status]');
  let description = 'No turn selected.';
  if (exit && maneuver) {
    const turn = maneuver.type;
    const action = { straight: 'Continue straight', left: 'Turn left', right: 'Turn right', uturn: 'Make a U-turn' }[turn];
    description = `${action}${exit.name ? ` onto ${exit.name}` : ''} selected.`;
    indicator?.style.setProperty('display', '');
    path?.setAttribute('d', TURN_PATHS[turn]);
    element.dataset.queuedManeuver = turn;
  } else {
    indicator?.style.setProperty('display', 'none');
    delete element.dataset.queuedManeuver;
  }
  element.setAttribute('aria-label', `Patrol vehicle${incoming?.name ? ` on ${incoming.name}` : ''}. ${description}`);
  if (status) status.textContent = description;
}

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [warning, setWarning] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [roadsReady, setRoadsReady] = useState(false);
  const [fatal, setFatal] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    let map: LibreMap;
    let fallback = false;
    let sourceErrors = 0;
    let animation = 0;
    let loaded = false;
    let disposed = false;
    const useLocalMap = () => {
      if (fallback || disposed) return;
      fallback = true;
      setWarning('Basemap unavailable · loading cached OpenStreetMap streets…');
      setRoadsReady(false);
      map.setStyle(LOCAL_STYLE);
    };
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: MAP_CONFIG.styleUrl || LOCAL_STYLE,
        center: MAP_CONFIG.center as [number, number],
        zoom: MAP_CONFIG.zoom,
        pitch: 0,
        maxPitch: 0,
        minZoom: 10,
        maxZoom: 19,
        attributionControl: false,
        dragRotate: false,
        touchPitch: false,
        fadeDuration: 150,
        renderWorldCopies: false,
        transformRequest: (url) => ({
          url: import.meta.env.DEV && url.startsWith('https://tiles.openfreemap.org/')
            ? new URL(`/basemap/${url.slice('https://tiles.openfreemap.org/'.length)}`, window.location.origin).href : url,
        }),
      });
    } catch {
      setFatal(true);
      setWarning('This browser could not start the map. Enable WebGL and hardware acceleration, then reload.');
      return;
    }
    mapRef.current = map;
    if (import.meta.env.DEV) {
      Object.defineProperty(map.getContainer(), '__patrolMap', { value: map, configurable: true });
    }
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Road graph © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
    }), 'bottom-right');
    map.touchZoomRotate.disableRotation();
    map.on('style.load', () => {
      loaded = true;
      sourceErrors = 0;
      addRoadLayers(map);
      const current = latest.current;
      (map.getSource(ROADS) as GeoJSONSource).setData(roadData(current.graph, current.priorityNames, current.selectedRoad));
      (map.getSource(ACTIVE) as GeoJSONSource).setData(activeData(current.graph, current.vehicle));
      applyLabelMode(map, current.labelMode, current.highlightPriority, Boolean(current.graph?.edges.length));
      setReady(true);
      current.onMapReady?.(map);
    });
    map.on('sourcedata', event => {
      if (event.sourceId !== ROADS || !event.isSourceLoaded || !map.getSource(ROADS) || !map.isSourceLoaded(ROADS)) return;
      setRoadsReady(true);
      if (fallback) setWarning('Basemap unavailable · cached OpenStreetMap streets are shown');
    });
    map.on('error', event => {
      if (import.meta.env.DEV) console.warn('Fremont map rendering:', event.error?.message ?? event.error);
      if (fallback) return;
      sourceErrors += 1;
      const message = event.error?.message ?? '';
      if (!loaded || sourceErrors >= 6 || /failed to fetch.*style|style.*failed/i.test(message)) useLocalMap();
    });
    map.on('webglcontextlost', () => setWarning('Map rendering paused. Waiting for the browser to restore WebGL.'));
    map.on('webglcontextrestored', () => setWarning(fallback ? 'Basemap unavailable · cached OpenStreetMap streets are shown' : null));
    const onManualMove = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent && latest.current.follow) latest.current.onFollowChange(false);
    };
    map.on('dragstart', onManualMove);
    map.on('zoomstart', onManualMove);
    const styleTimeout = window.setTimeout(() => { if (!loaded) useLocalMap(); }, 10000);

    // The simulation owns world position. Rendering and following are separate,
    // so inspecting the map cannot change the vehicle or its legal road edge.
    let previousTime = 0;
    let previousGraph: RoadGraph | null = null;
    let previousManeuverKey: string | null = null;
    const renderVehicle = (time: number) => {
      const current = latest.current;
      const vehicle = current.vehicle;
      if (vehicle) {
        if (!markerRef.current) {
          markerRef.current = new maplibregl.Marker({
            element: createPatrolElement(), anchor: 'center',
            rotationAlignment: 'map', pitchAlignment: 'map',
            subpixelPositioning: true,
          }).setLngLat(vehicle.position).addTo(map);
        }
        markerRef.current.setLngLat(vehicle.position).setRotation(vehicle.bearing);
        const maneuverKey = `${vehicle.edgeId}:${vehicle.queuedEdgeId ?? ''}`;
        if (maneuverKey !== previousManeuverKey || current.graph !== previousGraph) {
          updateManeuverIndicator(markerRef.current.getElement(), current.graph, vehicle);
          previousManeuverKey = maneuverKey;
          previousGraph = current.graph;
        }
        if (current.follow && loaded) {
          const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.1) : 0.016;
          const center = map.getCenter();
          const factor = 1 - Math.exp(-dt * 13);
          // Use the short angular path when crossing north.
          const targetBearing = current.orientation === 'heading' ? vehicle.bearing : 0;
          const angleDelta = ((targetBearing - map.getBearing() + 540) % 360) - 180;
          // A stationary patrol car must not trigger a new WebGL frame forever.
          if (Math.abs(vehicle.position[0] - center.lng) > 1e-8
            || Math.abs(vehicle.position[1] - center.lat) > 1e-8 || Math.abs(angleDelta) > 0.02) {
            map.jumpTo({
              center: [center.lng + (vehicle.position[0] - center.lng) * factor,
                center.lat + (vehicle.position[1] - center.lat) * factor],
              bearing: map.getBearing() + angleDelta * factor,
            });
          }
        }
      } else if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
        previousManeuverKey = null;
      }
      previousTime = time;
      animation = requestAnimationFrame(renderVehicle);
    };
    animation = requestAnimationFrame(renderVehicle);
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      disposed = true;
      window.clearTimeout(styleTimeout);
      cancelAnimationFrame(animation);
      resize.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource(ROADS)) return;
    setRoadsReady(false);
    (map.getSource(ROADS) as GeoJSONSource).setData(roadData(props.graph, props.priorityNames, props.selectedRoad));
  }, [props.graph, props.priorityNames, props.selectedRoad, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource(ACTIVE)) return;
    (map.getSource(ACTIVE) as GeoJSONSource).setData(activeData(props.graph, props.vehicle));
  }, [props.graph, props.vehicle?.edgeId, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer(LABELS)) applyLabelMode(map, props.labelMode, props.highlightPriority, Boolean(props.graph?.edges.length));
  }, [props.labelMode, props.highlightPriority, props.graph, ready]);

  useEffect(() => {
    if (props.orientation === 'north' && !props.follow) mapRef.current?.easeTo({ bearing: 0, duration: 300 });
  }, [props.orientation, props.follow]);

  return <div className="map-view" style={{ position: 'absolute', inset: 0, background: '#e8ece7' }}>
    <div ref={container} className="map-canvas" style={{ position: 'absolute', inset: 0 }} aria-label="Interactive map of Fremont, California" />
    {(!ready || Boolean(props.graph?.edges.length) && !roadsReady) && !fatal && <div className="map-loading" role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#53625a', pointerEvents: 'none' }}>
      <span style={{ background: '#f8faf5e8', border: '1px solid #cdd6cb', padding: '12px 18px', borderRadius: 10, fontSize: 13 }}>{ready ? 'Drawing verified Fremont streets…' : 'Loading Fremont map…'}</span>
    </div>}
    {warning && <div className="map-warning" role="status" style={{ position: 'absolute', top: 58, bottom: 'auto', left: 16, right: 70, width: 'fit-content', maxWidth: 'calc(100% - 86px)', background: '#1d2b29ed', color: '#e5eddf', border: '1px solid #526155', borderRadius: 7, padding: '8px 11px', fontSize: 11, lineHeight: 1.5 }}>{warning}</div>}
  </div>;
}

export default MapView;
