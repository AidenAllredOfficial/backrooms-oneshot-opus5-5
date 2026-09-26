import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PURE_DIRS = ['src/core', 'src/world', 'src/mesh', 'src/props', 'src/bake', 'src/workers', 'src/audio/dsp'];
const PURE_FILES = ['src/player/controller.ts', 'src/player/collision.ts', 'src/player/collisionBuild.ts', 'src/player/headBob.ts',
  'src/audio/propagation.ts', 'src/audio/roomProbe.ts', 'src/app/urlParams.ts'];
const TYPE_ONLY_THREE_ALLOWED = new Set(['src/core/runtime.ts']);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const files = [...PURE_DIRS.flatMap((d) => walk(d)), ...PURE_FILES.filter(existsSync)];

describe('architecture rules', () => {
  it('pure modules do not import three/postprocessing or touch the DOM', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const importsThree = /from\s+['"](three|postprocessing)(\/[^'"]*)?['"]/.test(src);
      const typeOnly = /import\s+type\s[^;]*from\s+['"]three['"]/.test(src) && !/import\s+(?!type)[^;]*from\s+['"]three['"]/.test(src);
      if (importsThree && !(TYPE_ONLY_THREE_ALLOWED.has(f) && typeOnly)) bad.push(`${f}: imports three/postprocessing`);
      if (/\b(window|document|localStorage|requestAnimationFrame)\s*[.(]/.test(src)) bad.push(`${f}: DOM access`);
      if (/Math\.random\s*\(|Date\.now\s*\(|new Date\s*\(|performance\.now\s*\(/.test(src) && !f.startsWith('src/workers') && !f.includes('bake/index')) bad.push(`${f}: nondeterminism`);
    }
    expect(bad).toEqual([]);
  });
  it('relative imports use .ts extensions (node type stripping)', () => {
    const bad: string[] = [];
    for (const f of walk('src')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) if (!/\.(ts|css|json|glsl)$/.test(m[1]) && !m[1].includes('?')) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
