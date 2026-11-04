// Static build: one folder of files (dist/) servable by any static host, relative URLs (works under a sub-path).
// DEMO=true at build time turns on the simulated data source and the "Demo" label; otherwise the demo code is dropped.
import { defineConfig, type Plugin } from 'vite'

// Preload of the Geist Mono weights the first screen uses (400 body, 500 amounts, 600 labels and buttons, D-57): the fetch
// starts with the HTML instead of after the CSS. fetchpriority=low: on Fast 3G three high-priority preloads (72 kB) delayed
// the book from 1.8 to 2.4 s (web-perf P3); at low priority they still start early but yield to the bundle and /books, and
// the metric-matched fallbacks keep the layout still until they arrive. Links point at this build's hashed assets.
const PRELOAD = /^GeistMono-(Regular|Medium|SemiBold)-latin-.*\.woff2$/
function preloadFonts(): Plugin {
  return {
    name: 'fondaco-preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => PRELOAD.test(f.split('/').pop() ?? '')).sort()
        return files.map((f) => ({ tag: 'link', injectTo: 'head' as const, attrs: { rel: 'preload', href: './' + f, as: 'font', type: 'font/woff2', crossorigin: 'anonymous', fetchpriority: 'low' } }))
      },
    },
  }
}

const demo = process.env.DEMO === 'true'
export default defineConfig({
  base: './',
  plugins: [preloadFonts()],
  define: { __DEMO__: JSON.stringify(demo) },
  // one copy of viem in the bundle even when pnpm resolves two (peer variants): smaller, and error classes compare equal
  resolve: { dedupe: ['viem'] },
  // no source maps in the shipped build: they embed third-party source comments (e.g. viem's docs mention RPC providers),
  // which the key scan (scripts/scan-keys.mjs) must not have to whitelist. The build is reproducible from the repository.
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0, chunkSizeWarningLimit: 400 },
  server: { host: '127.0.0.1' },
})
