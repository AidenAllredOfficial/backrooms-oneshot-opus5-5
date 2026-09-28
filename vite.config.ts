import path from 'node:path';
import { defineConfig } from 'vite';
import { tileCachePlugin } from './tools/viteTileCache.ts';

// Tool runs (tools/shoot.mjs, tools/qa.mjs set BACKROOMS_TOOL=1): no HMR and no file watching, so edits made while a
// capture runs cannot reload the page mid-eval. Pre-bundle the dependencies up front so the first cold page load is
// not reloaded by a lazy "new dependencies optimized" pass.
const TOOL = process.env.BACKROOMS_TOOL === '1';
// Production builds contain the game only. The harness pages (materials / chunk / post / index) are dev-server
// pages for QA (served by `vite` whatever this says); BACKROOMS_HARNESS=1 adds them to a build (R2 B9).
const HARNESS = process.env.BACKROOMS_HARNESS === '1';
// Tool runs reuse worker results (layouts, builds, bakes) across shots and runs: tools/viteTileCache.ts.
const TILE_CACHE = TOOL && process.env.BACKROOMS_TILE_CACHE !== '0';

export default defineConfig({
  // relative asset URLs: the build runs from any sub-path (itch.io, GitHub Pages project sites, file shares)
  base: './',
  // per-tree dependency cache: worktrees and staged trees share one node_modules (symlinked), and a shared
  // node_modules/.vite would be re-optimized by every tree (its hash includes the root) and could swap under a
  // running server
  cacheDir: path.join(import.meta.dirname, '.vite'),
  plugins: [tileCachePlugin(TILE_CACHE)],
  server: TOOL ? { port: 5173, strictPort: false, hmr: false, watch: null } : { port: 5173, strictPort: false },
  optimizeDeps: { include: ['three', 'three/examples/jsm/lights/RectAreaLightUniformsLib.js', 'postprocessing'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // maps are written for crash triage but not referenced from the shipped bundles
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: HARNESS
        ? {
            main: 'index.html',
            materials: 'harness/materials.html',
            chunk: 'harness/chunk.html',
            post: 'harness/post.html',
            harness: 'harness/index.html',
          }
        : { main: 'index.html' },
    },
  },
  // maxWorkers: many agents run vitest concurrently on a 14 GB machine; keep each run to 2 forks.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', maxWorkers: 2 },
} as any);
