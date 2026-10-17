import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import https from 'node:https'
export default defineConfig({
  plugins:[react(),tailwindcss()],
  server:{proxy:{'/basemap':{
    target:'https://tiles.openfreemap.org',
    changeOrigin:true,
    secure:true,
    agent:https.globalAgent,
    rewrite:path=>path.replace(/^\/basemap/,''),
  }}},
  build:{rollupOptions:{output:{manualChunks:{maplibre:['maplibre-gl']}}}},
  test:{include:['src/**/*.test.ts','tests/**/*.test.ts']},
})
