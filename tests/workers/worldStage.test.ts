// tests/workers/worldStage.test.ts — the world-stage split of the tool cache keys (src/workers/worldStage.ts).
// Layout / spawn / find entries are keyed by the bundle hash of worldStage.ts alone. That is sound only if everything
// the handler's init / layout / spawn / find branches run is reachable from that module, so handler.ts must take
// the world-stage symbols from worldStage.ts and never import world generation, collision or layout code around it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as stage from '../../src/workers/worldStage.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const src = (f: string): string => readFileSync(path.join(REPO, f), 'utf8');

/** Value imports of a module: [specifier, imported names] (type-only statements and inline type specifiers dropped). */
function valueImports(code: string): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const m of code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const names = m[2].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type ')).map((s) => s.split(/\s+as\s+/)[0]);
    if (names.length) out.push([m[3], names]);
  }
  for (const m of code.matchAll(/import\s+\*\s+as\s+\w+\s+from\s*['"]([^'"]+)['"]/g)) out.push([m[1], ['*']]);
  return out;
}

describe('world stage', () => {
  const STAGE = ['createWorldGen', 'getLayout', 'buildChunkCollision', 'cloneLayout', 'layoutTransferables'];

  it('re-exports exactly what the init / layout / spawn / find branches use', () => {
    expect(Object.keys(stage).sort()).toEqual([...STAGE].sort());
  });

  it('handler.ts imports the world-stage symbols only from worldStage.ts, and no world code around it', () => {
    const imports = valueImports(src('src/workers/handler.ts'));
    const fromStage = imports.filter(([s]) => s === './worldStage.ts').flatMap(([, n]) => n);
    expect(fromStage.sort()).toEqual([...STAGE].sort());
    const bad: string[] = [];
    for (const [spec, names] of imports) {
      if (spec === './worldStage.ts') continue;
      for (const n of names) if (STAGE.includes(n) || n === '*') bad.push(`${n} from ${spec}`);
      // world generation, collision and layout code may enter the handler only through the stage
      if (/\/world\/|collisionBuild|\/core\/layout\.ts$/.test(spec)) bad.push(`value import from ${spec}`);
    }
    expect(bad).toEqual([]);
  });
});
