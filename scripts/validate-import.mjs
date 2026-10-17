#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateImportedGraph } from './osm-graph.mjs';

const defaultPath = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/fremont-roads.json');
try {
  const path = resolve(process.argv[2] ?? defaultPath);
  const graph = JSON.parse(await readFile(path, 'utf8'));
  const report = validateImportedGraph(graph);
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
} catch (error) {
  console.error(`Road graph validation failed: ${error.message}`);
  process.exitCode = 1;
}
