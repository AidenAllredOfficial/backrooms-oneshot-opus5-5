// tools/viteTileCache.ts — Vite plugin behind the worker result cache of tool runs (src/workers/tileCache.ts).
// - Hashes the worker's source import graph (every relative import reachable from src/workers/chunk.worker.ts, plus
//   the versions of any packages it imports) and injects it as __BR_TILE_CACHE__; '' when disabled.
// - Serves GET / PUT /__tilecache/<40-hex key> from BACKROOMS_TILE_CACHE_DIR (default ~/.cache/backrooms-tilecache),
//   evicting the least recently used files beyond BACKROOMS_TILE_CACHE_MB (default 8192: the full QA suite is ~85
//   world shots of ~50 MB).
// Enabled for tool runs (BACKROOMS_TOOL=1: tools/shoot.mjs, tools/qa.mjs) unless BACKROOMS_TILE_CACHE=0; never in
// `npm run dev` / builds, so the game never depends on it.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';

// group 1: `type` of an erased type-only import/export; group 2: specifier; group 3: dynamic import specifier
const IMPORT_RE = /(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** SHA-1 over the contents of every module reachable from `entry` (relative imports) and the versions of the
 * packages it imports. `import type` / `export type` statements are erased at compile time and are not followed
 * (inline `{ type X }` specifiers are: the statement may import values too). */
export function workerCodeHash(root: string, entry = 'src/workers/chunk.worker.ts'): string {
  const h = createHash('sha1');
  const seen = new Set<string>();
  const pkgs = new Set<string>();
  const stack = [path.resolve(root, entry)];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f) || !existsSync(f)) continue; // a match inside a comment may name no file
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      if (m[1]) continue;
      const spec = m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith('.')) stack.push(path.resolve(path.dirname(f), spec));
      else pkgs.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  for (const f of [...seen].sort()) h.update(path.relative(root, f)).update('\0').update(readFileSync(f)).update('\0');
  for (const p of [...pkgs].sort()) {
    const pj = path.join(root, 'node_modules', p, 'package.json');
    h.update(p).update('@').update(existsSync(pj) ? String(JSON.parse(readFileSync(pj, 'utf8')).version) : '?');
  }
  return h.digest('hex');
}

export function tileCachePlugin(enabled: boolean): Plugin {
  const dir = process.env.BACKROOMS_TILE_CACHE_DIR ?? path.join(homedir(), '.cache', 'backrooms-tilecache');
  const capBytes = Number(process.env.BACKROOMS_TILE_CACHE_MB ?? 8192) * 1048576;
  let root = process.cwd();
  return {
    name: 'backrooms-tile-cache',
    config(cfg) {
      root = cfg.root ? path.resolve(cfg.root) : process.cwd();
      return { define: { __BR_TILE_CACHE__: JSON.stringify(enabled ? workerCodeHash(root) : '') } };
    },
    configureServer(server) {
      if (!enabled) return;
      mkdirSync(dir, { recursive: true });
      // size index for the LRU cap (mtime = last use)
      const files = new Map<string, { size: number; t: number }>();
      let total = 0;
      for (const n of readdirSync(dir)) {
        if (!/^[0-9a-f]{40}$/.test(n)) continue;
        const s = statSync(path.join(dir, n));
        files.set(n, { size: s.size, t: s.mtimeMs });
        total += s.size;
      }
      const evict = (): void => {
        if (total <= capBytes) return;
        for (const [n, e] of [...files].sort((a, b) => a[1].t - b[1].t)) {
          try { unlinkSync(path.join(dir, n)); } catch { /* already gone */ }
          files.delete(n);
          total -= e.size;
          if (total <= capBytes * 0.9) break;
        }
      };
      server.middlewares.use('/__tilecache/', (req, res) => {
        const key = (req.url ?? '').replace(/^\//, '');
        if (!/^[0-9a-f]{40}$/.test(key)) { res.statusCode = 400; res.end(); return; }
        const file = path.join(dir, key);
        if (req.method === 'GET') {
          if (!files.has(key)) { res.statusCode = 404; res.end(); return; }
          try {
            const body = readFileSync(file);
            const now = new Date();
            utimesSync(file, now, now);
            (files.get(key) as { t: number }).t = now.getTime();
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(body);
          } catch { files.delete(key); res.statusCode = 404; res.end(); }
          return;
        }
        if (req.method === 'PUT') {
          const parts: Buffer[] = [];
          req.on('data', (c: Buffer) => parts.push(c));
          req.on('end', () => {
            const body = Buffer.concat(parts);
            try {
              const tmp = `${file}.${process.pid}.tmp`;
              writeFileSync(tmp, body);
              renameSync(tmp, file);
              const prev = files.get(key);
              if (prev) total -= prev.size;
              files.set(key, { size: body.length, t: Date.now() });
              total += body.length;
              evict();
              res.statusCode = 204;
            } catch { res.statusCode = 500; }
            res.end();
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}
