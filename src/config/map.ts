// OpenFreeMap is a public OSM vector basemap, with no API key. No secrets belong here.
export const MAP_CONFIG = {
  styleUrl: import.meta.env.VITE_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/positron',
  center: [-121.982, 37.548] as [number, number],
  zoom: 14.4,
}
