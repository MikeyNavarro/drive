#!/usr/bin/env node
import { build, loadConfigFromFile } from 'vite';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Package the real application and its authentic cached road graph into a file
// that can be opened directly. External tiles remain optional and retain TLS.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('Usage: npm run build:standalone -- [--output /path/to/simulator.html]');
}
const destination = resolve(args[1] ?? resolve(root, 'dist-standalone/Fremont-Patrol-Simulator.html'));
const temporary = await mkdtemp(resolve(tmpdir(), 'fremont-standalone-'));
try {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load the application build configuration.');
  const config = loaded.config;
  config.configFile = false;
  config.root = root;
  config.base = './';
  config.build = {
    ...config.build,
    outDir: temporary,
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      ...config.build?.rollupOptions,
      output: { inlineDynamicImports: true },
    },
  };
  await build(config);
  const index = await readFile(resolve(temporary, 'index.html'), 'utf8');
  const scriptPath = index.match(/<script[^>]+src="([^"]+)"/)?.[1];
  const cssPath = index.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/)?.[1];
  if (!scriptPath || !cssPath) throw new Error('Build did not produce a single script and stylesheet.');
  const [javascript, css, rawGraph, icon] = await Promise.all([
    readFile(resolve(temporary, scriptPath), 'utf8'),
    readFile(resolve(temporary, cssPath), 'utf8'),
    readFile(resolve(root, 'public/data/fremont-roads.json'), 'utf8'),
    readFile(resolve(root, 'public/favicon.svg')),
  ]);
  const graph = JSON.parse(rawGraph);
  if (graph.metadata?.source !== 'OpenStreetMap' || !graph.edges?.length) {
    throw new Error('A genuine imported OpenStreetMap road snapshot is required.');
  }
  const snapshot = JSON.stringify(graph).replace(/</g, '\\u003c');
  const bootstrap = `
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function (input, options) {
      if (input === '/data/fremont-roads.json') {
        return Promise.resolve(new Response(document.getElementById('fremont-road-snapshot').textContent,
          {status: 200, headers: {'Content-Type': 'application/json'}}));
      }
      return nativeFetch(input, options);
    };
    document.addEventListener('click', event => {
      if (event.target.closest?.('a.brand[href="/"]')) {
        event.preventDefault();
        window.scrollTo({top: 0, behavior: 'smooth'});
      }
    });
  `;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#151b19">
<title>Fremont Patrol Simulator</title>
<link rel="icon" href="data:image/svg+xml;base64,${icon.toString('base64')}">
<style>${css.replace(/<\/style/gi, '<\\/style')}</style>
</head><body><div id="root"></div>
<script id="fremont-road-snapshot" type="application/json">${snapshot}</script>
<script>${bootstrap}</script>
<script type="module">${javascript.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, html);
  console.log(`Standalone simulator: ${destination} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB)`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
