# Data attribution

`public/data/fremont-roads.json` is a derived road database from OpenStreetMap. © OpenStreetMap contributors. It is made available under the Open Database License (ODbL) 1.0:

- https://www.openstreetmap.org/copyright
- https://opendatacommons.org/licenses/odbl/1-0/

The source snapshot timestamp, bounding box, endpoint, transformation assumptions, conservative exclusions, and query are recorded in the graph metadata and importer. Run `npm run data:import` to reproduce the source acquisition and database transformation. A cache is saved under `data/cache/` for exact source geometry verification.

Attribution must remain visible on the map. If redistributing an adapted road database, comply with applicable ODbL attribution, share-alike, and source/database access requirements. This document does not license third-party software or basemap assets; those retain their respective licenses.

OpenFreeMap supplies the default hosted vector map, including OpenStreetMap/OpenMapTiles and Natural Earth source attribution. Keep tile-source attribution provided by MapLibre's attribution control. The bundled driving graph remains available when the external basemap is unavailable.
