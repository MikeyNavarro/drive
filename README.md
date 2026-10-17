# Fremont Patrol Simulator

A browser-based, top-down geography trainer for Fremont, California. The first two milestones provide an interactive map and manual driving on a real, locally cached OpenStreetMap road graph. Free Drive has no destinations, timer, score, or account.

## Play without installing software

Download this repository as a ZIP and extract it. Double-click **PLAY.html** in the extracted folder to open the ready-to-play simulator in your browser. Hold **W** to drive, **S** to brake, **A/D** to select turns, and **Space** to pause. No Node.js, VS Code, or server is required for this file. It includes the real central Fremont road graph and can render the roads even without online basemap tiles.

`PLAY.html` is a prebuilt snapshot. Developers can refresh it with `npm run build:standalone -- --output PLAY.html` after changing the application. Software notices are in `THIRD-PARTY-NOTICES.txt`; road data attribution and source information are in `docs/data-license.md` and `scripts/`.

## Run locally

On a Mac with VS Code and Node.js 24.5+ installed, put the project folder on your Desktop and open `Fremont Patrol Simulator.code-workspace`. Press **Command + Shift + B** to run the default **Start simulator** task. It installs this machine's dependencies, starts the development server, and opens your browser. Keep the VS Code terminal running; press **Control + C** there to stop the server. No road-data download is required.

For a version that needs no terminal or installation, build a self-contained file with `npm run build:standalone`. Download/open `dist-standalone/Fremont-Patrol-Simulator.html` in Chrome, Edge, or Firefox. The file contains the application and the real road snapshot; the optional basemap uses the Internet and cached road geometry works without it. Keep the HTML file to launch again. This standalone package is separate from the cloud environment's development server.

Requires **Node.js 24.5+** and npm. From this repository:

```sh
npm ci
npm run data:validate
npm run dev
```

Open the address printed by Vite in your local browser. The authentic processed road snapshot is included at `public/data/fremont-roads.json`, so gameplay does not query Overpass. To import/refresh the source snapshot:

```sh
npm run data:import          # download once, then reuse raw cache
npm run data:import -- --offline
npm run data:import -- --refresh # intentional refresh only
```

The first online import also retains the raw source in ignored `data/cache/` for exact provenance checks. See [data import and limitations](docs/data.md).

## Try a drive

1. Select a starting intersection in the driving panel. Starts are derived from actual shared OSM node IDs, not assumed road-name pairs.
2. Hold **W / Up** to accelerate. Release to coast; hold **S / Down** to brake to a stop. Reverse is deliberately disabled to prevent wrong-way travel.
3. Press **A / Left** or **D / Right** to queue a legal maneuver. Use the named road buttons when a junction has multiple options in the same direction. The car shows a selected-turn arrow.
4. The car follows connected road geometry. It continues straight when unambiguous, follows a single same-street curve, and stops at an undecided junction. It never teleports to the selected road.
5. **Space** pauses/resumes; **R** resets the selected drive. Keyboard commands work after clicking driving controls. Native focused form controls retain their own keyboard behavior.
6. Pan to inspect the map and use the crosshair to recenter. Zoom, north-up/heading-up, speed, street labels, and independent priority highlighting are available. Preferences persist in this browser.

## Architecture

- React + TypeScript + Vite; Tailwind CSS and custom responsive dashboard styles.
- MapLibre GL JS renders OpenFreeMap's Positron vector basemap and the exact local driving geometry. The patrol marker, camera, and map rendering do not own vehicle motion.
- `scripts/osm-graph.mjs` imports OSM ways as directed edges. Shared node IDs establish adjacency; interior curve points remain geometry. Geometric crossings never establish graph connections.
- `src/engine/` validates topology, indexes the graph once, interpolates meter distances, limits acceleration/braking, checks directed legal exits and restrictions, and carries a queued turn through non-decision same-street boundaries.
- `src/config/map.ts` keeps the public style URL and initial map settings separate. Optional `VITE_MAP_STYLE_URL` overrides the style; do not put secret credentials in a Vite variable (client variables are public).
- The development server proxies only the fixed OpenFreeMap origin. This permits browsers in proxy-managed cloud machines to use the platform's trusted TLS route without disabling certificate checks. Built production files request the provider directly. If tiles fail, the map renders local real-road geometry and labels with system fonts.

## Validation

```sh
npm test                 # engine, preferences, importer, real-source integrations
npm run data:validate    # all 5 core streets + real graph coverage report
npm run build            # TypeScript and production bundle
npm run test:browser      # keyboard driving, camera, labels, preferences, responsive UI
```

Browser tests use Chromium at `/usr/bin/chromium` in the cloud environment. For another machine set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a browser executable or install Playwright Chromium with `npx playwright install chromium`. No browser tests ignore TLS errors. Source-provenance tests explicitly report a skip when the ignored raw cache is absent; `npm run data:import` restores it. The committed real-road graph tests still run.

## Scope and geographic limitations

Implemented: central Fremont map, verified starting points, road-constrained movement, legal intersection choices, one-way and supported node-via restrictions, smooth camera tracking, heading/speed/current-street display, label controls, and cached-road fallback.

The local surface-road snapshot includes all five requested starter streets: Fremont Boulevard, Mowry Avenue, Stevenson Boulevard, Paseo Padre Parkway, and Walnut Avenue. Basemap tiles and the imported graph may have different update dates; the exact local driving overlay is authoritative. Coverage is the documented central Fremont box with complete ways retained near the boundary; this is **not citywide coverage**. The 38 study entries are preserved with separate aliases and study groups. Coverage badges mean matched names in this snapshot, not an assertion that every entry has been geographically reviewed. Lake Arrowhead and Gable Dr are flagged for manual review, without substitutions.

Unsupported conditional/via-way restrictions and restricted access are conservatively excluded and reported in snapshot metadata. OSM can be incomplete or out of date; the simulator enforces imported restrictions, not every possible traffic rule. No lanes, turn lanes, traffic signals, road closures, or physical vehicle dynamics are simulated. U-turns require an explicit choice and are offered only at dead ends or with explicit permission, subject to imported restrictions. The graph does not support freeway/ramp navigation.

Guided study, in-app list editing, dispatch, recognition quizzes, graded progress, full-city expansion, freeways, and touch driving are later milestones. They are not represented as completed modes. Verify the basic driving experience before expanding scope.

This is a geography-learning simulation, not official dispatch, emergency-response, or operational navigation software.

## Attribution and usage

Road data and derived graph: **© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)**. Retain attribution and comply with ODbL share-alike/source requirements when distributing the database or a derived database. The importer makes the source and transformation reproducible. See [data licensing](docs/data-license.md).

Default hosted vector basemap: [OpenFreeMap](https://openfreemap.org/), using OpenStreetMap/OpenMapTiles and Natural Earth. Keep the provider's source attribution visible. Follow the provider's current usage terms; availability is external to this app. Do not use the standard OSM raster tile service as a bulk-download backend. No API key or paid map account is required for the default configuration.
