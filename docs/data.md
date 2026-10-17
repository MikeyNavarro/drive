# Road data and attribution

The drivable graph must come from an authentic OpenStreetMap snapshot. There is no generated substitute network. If `public/data/fremont-roads.json` is absent or fails validation, driving remains unavailable until an import succeeds.

OpenStreetMap data is © OpenStreetMap contributors and is available under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). Keep this attribution visible on the map and with redistributed data. The imported graph retains the source, license, bounding box, Overpass snapshot timestamp, validation results, and any conservative exclusions. Basemap tiles have separate provider requirements; consult the application's map-provider configuration and README.

## Reproducible import

From the repository root, with Node.js 24 (the cloud runtime):

```sh
npm run data:import
npm run data:validate
```

The importer sends one HTTPS request to `https://overpass-api.de/api/interpreter`. `OVERPASS_URL` may select another authorized Overpass endpoint. The npm command uses Node's `--use-env-proxy` flag so injected `HTTPS_PROXY` settings are honored. Direct invocations must include this flag in environments that use an HTTP(S) proxy. The importer never disables TLS verification and never queries Overpass during gameplay. The cloud environment must allow the selected endpoint; a blocked request requires a network-setting change, not a workaround.

The default box is `[west, south, east, north] = [-122.025, 37.526, -121.945, 37.574]`, a central Fremont starting area. Full OSM ways touching this box are retained, so road geometry can extend beyond the box. Edges terminate at real OSM way endpoints, shared nodes, and turn-restriction nodes. Roads are never clipped and joined at arbitrary bounding-box coordinates.

Raw data is cached locally at `data/cache/fremont-overpass.json`, with its query and provenance beside it. The processed graph is `public/data/fremont-roads.json` and can be checked into source control. The raw cache should remain ignored. A matching local cache is reused by default.

```sh
# Rebuild without any network access from a matching local cache.
npm run data:import -- --offline

# Explicitly fetch a fresh snapshot (do this sparingly on public services).
npm run data:import -- --refresh

# Process a separately acquired, authentic Overpass JSON snapshot.
npm run data:import -- --input /path/to/overpass-snapshot.json

# Change the query scope; a new scope needs a matching snapshot.
npm run data:import -- --refresh --bbox '-122.025,37.526,-121.945,37.574'
```

All five initial street names must be present and share a connected component: Fremont Boulevard, Mowry Avenue, Stevenson Boulevard, Paseo Padre Parkway, and Walnut Avenue. The validator reports actual shared OSM intersection nodes. It does not assume every pair intersects. A failed import preserves the existing processed graph.

## Topology, access, and turn legality

- Coordinates are copied from OSM nodes. Connectivity uses node IDs, never coordinate proximity or visual line crossings. A bridge and road below it remain disconnected when OSM uses different node IDs.
- Curves keep their interior geometry. Shared nodes split ways into directed segments; shape points do not become artificial choice points.
- Distances are meters and bearings are clockwise degrees from north. Reverse edges reverse the complete geometry. `oneway=yes`, `oneway=-1`, motor-vehicle-specific one-way tags, directional vehicle-access restrictions, and roundabout direction are respected.
- Freeways (`motorway` and `motorway_link`), motorroads, construction, non-vehicle paths, private roads, destination-only access, parking aisles, and driveways are excluded. OSM `trunk` classification alone does not mean a freeway; public surface trunk roads remain eligible unless marked `motorroad=yes`.
- Conditional access and reversible/alternating directions require time-dependent rules, so affected ways are excluded. Restricted barrier/access nodes close the affected junction instead of granting unverified access.
- Supported ordinary motorcar restrictions are node-via `no_left_turn`, `no_right_turn`, `no_straight_on`, `no_u_turn`, `no_entry`, `no_exit`, and their `only_*` turn variants. Motorcar/motor-vehicle/vehicle-specific tags and applicable exception tags take precedence over generic restrictions. The driving engine must evaluate these against the incoming edge before offering a turn.
- Conditional, via-way, unknown, and incomplete restrictions are not treated as legal turns. The importer closes the affected via-node junction, excludes via ways, or excludes referenced roads when the junction cannot be identified. It records relation IDs and actions in `metadata.unsupportedRestrictions` and `metadata.warnings`. This conservative coverage reduction needs review before expanding support.
- Roads touching the query boundary can lead into incomplete coverage. A graph endpoint is a stopping point; it never implies a new connection to a nearby visible basemap road.

The Overpass snapshot and independently updated basemap can differ in date and detail. The graph overlay shows the actual driveable network. Source metadata documents its timestamp; refresh intentionally when needed. Data validation checks topology consistency and core coverage, but cannot guarantee that OSM is complete or current. This simulator is a geography learning tool, not operational navigation.

## Validation and unresolved coverage

`scripts/osm-graph.mjs` exports `buildOverpassQuery`, `buildRoadGraph`, and `validateImportedGraph` for direct tests. The validation command checks endpoint IDs and coordinates, nonempty geometry, computed segment lengths, bearings, unique edge IDs, supported restriction references, source timestamp/license, required street matches, shared connected coverage, and actual core intersections.

Run importer tests with `node --test scripts/osm-graph.test.mjs`. Unit fixtures use explicitly artificial coordinates solely to test topology, access, one-way handling, and conservative restriction behavior; they are never shipped as driving data. Separate real-snapshot tests check the imported Fremont geography and, when the raw cache is available, prove every processed segment is an exact continuous subsequence of its original OSM way with original endpoint coordinates. These tests report explicit skips when the required authentic snapshots are unavailable.

Connected-component coverage is an undirected structural check. It does not assert every destination is reachable under turn restrictions. The driving engine must perform directional/restriction-aware reachability checks before offering dispatch destinations.

The 38 study entries extend beyond this starting box. A missing name in this snapshot is not proof that a street does not exist. Ambiguous names such as Lake Arrowhead and Gable Drive require independent review; the importer never substitutes a different street. Freeway and ramp navigation, citywide data, time-dependent restrictions, and via-way restriction traversal are later milestones.
