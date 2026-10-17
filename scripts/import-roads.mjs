#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOverpassQuery, buildRoadGraph, DEFAULT_BBOX, validateBBox, validateImportedGraph } from './osm-graph.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args) {
  const options = { bbox: DEFAULT_BBOX, input: null, output: resolve(root, 'public/data/fremont-roads.json'), offline: false, refresh: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--offline') options.offline = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--help') options.help = true;
    else if (['--bbox', '--input', '--output'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--bbox') options.bbox = validateBBox(value.split(',').map(Number));
      else options[arg.slice(2)] = resolve(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.offline && options.refresh) throw new Error('--offline and --refresh cannot be combined.');
  return options;
}

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Import verified OpenStreetMap surface roads for central Fremont.\n\nUsage: node scripts/import-roads.mjs [--offline | --refresh] [--input snapshot.json] [--output graph.json] [--bbox west,south,east,north]\n\nReuses data/cache/fremont-overpass.json unless --refresh is set.\nOVERPASS_URL selects an HTTPS Overpass endpoint. No network is used during gameplay.');
    return;
  }
  const cache = resolve(root, 'data/cache/fremont-overpass.json');
  const cacheInfo = `${cache}.meta.json`;
  let sourceUrl = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
  const query = buildOverpassQuery(options.bbox);
  let raw;
  let inputOrigin = options.input;
  if (options.input) raw = await readFile(options.input, 'utf8');
  else if (!options.refresh) {
    try {
      const cached = await readFile(cache, 'utf8');
      const saved = JSON.parse(await readFile(cacheInfo, 'utf8'));
      if (saved.query !== query) throw new Error('Cached snapshot uses a different bbox/query. Use --refresh or --input.');
      raw = cached;
      sourceUrl = saved.sourceUrl ?? sourceUrl;
      inputOrigin = cache;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (options.offline) throw new Error('No matching cached OSM snapshot. Import an authentic snapshot with --input, or allow the configured Overpass endpoint and run without --offline.');
    }
  }
  if (!raw) {
    const endpoint = new URL(sourceUrl);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
      throw new Error('OVERPASS_URL must use HTTPS (HTTP is allowed only for a local test endpoint).');
    }
    if (endpoint.username || endpoint.password) throw new Error('Do not embed credentials in OVERPASS_URL.');
    console.log(`Downloading an OSM snapshot for bbox ${options.bbox.join(',')}…`);
    const response = await fetch(endpoint, {
      method: 'POST', body: new URLSearchParams({ data: query }),
      headers: { Accept: 'application/json', 'User-Agent': 'FremontPatrolSimulator/0.1 (development road data import)' },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`Overpass request failed: HTTP ${response.status}. Check environment network access and endpoint availability; the importer does not bypass restrictions.`);
    raw = await response.text();
    // Reject HTML/errors or partial Overpass data before writing either cache or graph.
    const parsed = JSON.parse(raw);
    if (parsed.remark || !Array.isArray(parsed.elements)) throw new Error(`Overpass did not return a complete snapshot: ${parsed.remark ?? 'missing elements'}`);
    await writeAtomic(cache, raw);
    await writeAtomic(cacheInfo, JSON.stringify({ query, bbox: options.bbox, sourceUrl, downloadedAt: new Date().toISOString() }, null, 2));
    inputOrigin = cache;
  }
  const osm = JSON.parse(raw);
  const graph = buildRoadGraph(osm, { bbox: options.bbox, sourceUrl });
  const report = validateImportedGraph(graph);
  if (!report.valid) throw new Error(`Road graph validation failed; existing output was preserved.\n${report.errors.join('\n')}`);
  graph.metadata.validation = report;
  await writeAtomic(options.output, `${JSON.stringify(graph)}\n`);
  console.log(`Source snapshot: ${graph.metadata.sourceTimestamp}`);
  console.log(`Read ${inputOrigin}; saved ${options.output}.`);
  console.log(`${report.nodes} junction/end nodes, ${report.directedEdges} directed segments, ${report.restrictions} turn restrictions.`);
  console.log(`Verified core intersections: ${report.verifiedCoreIntersections.length}; connected core component(s): ${report.commonComponents.join(', ')}.`);
  for (const street of report.streetCoverage) console.log(`${street.requested}: ${street.matchedNames.join(', ')}`);
  if (report.warnings.length) console.log(`${report.warnings.length} conservative exclusions; review metadata.warnings and docs/data.md.`);
}

main().catch((error) => {
  console.error(`Road import failed: ${error.message}`);
  process.exitCode = 1;
});
