// Static build: one folder of files (dist/) servable by any static host, relative URLs (works under a sub-path).
// DEMO=true at build time turns on the simulated data source and the "Demo" label; otherwise the demo code is dropped.
import { defineConfig } from 'vite'

const demo = process.env.DEMO === 'true'
export default defineConfig({
  base: './',
  define: { __DEMO__: JSON.stringify(demo) },
  // no source maps in the shipped build: they embed third-party source comments (e.g. viem's docs mention RPC providers),
  // which the key scan (scripts/scan-keys.mjs) must not have to whitelist. The build is reproducible from the repository.
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0, chunkSizeWarningLimit: 400 },
  server: { host: '127.0.0.1' },
})
