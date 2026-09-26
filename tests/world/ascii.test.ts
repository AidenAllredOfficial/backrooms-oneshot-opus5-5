// WP1 — ASCII rendering / parsing round trip, marks, multi-chunk maps and the map tool.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHUNK_CELLS, CHUNK_SIZE } from '../../src/core/constants.ts';
import { fixtureId } from '../../src/core/layout.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, FixtureKind, LightState } from '../../src/core/ids.ts';
import { asciiMapFromLayouts, layoutFromAscii, layoutToAscii } from '../../src/world/ascii.ts';
import { testSceneChunk } from '../../src/world/testScenes.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

const N = CHUNK_CELLS;
const key = { s: 0 as const, cx: 0, cz: 0 };

describe('ascii', () => {
  it('round-trip of the grid scene is identical', () => {
    const grid = testSceneChunk('grid', key, 1);
    const a = layoutToAscii(grid);
    const lines = a.split('\n');
    expect(lines.length).toBe(2 * N + 1);
    expect(lines.every((r) => r.length === 2 * N + 1)).toBe(true);
    const back = layoutFromAscii(key, a);
    expect(layoutToAscii(back)).toBe(a);
    // structure survives: edges, flags, lights
    expect(Array.from(back.ex.kind)).toEqual(Array.from(grid.ex.kind));
    expect(Array.from(back.ez.kind)).toEqual(Array.from(grid.ez.kind));
    expect(Array.from(back.flags).map((f) => f & CellFlag.SOLID)).toEqual(Array.from(grid.flags).map((f) => f & CellFlag.SOLID));
    expect(back.fixtures.length).toBe(grid.fixtures.length);
  });

  it('parses edges, cell glyphs and lights; unknown glyphs are ignored', () => {
    const text = [
      '+-+-+-+-+',
      '|. L f|#|',
      '+ +d+h+ +',
      '|~ y l:?|',
      '+-+-+-+-+',
    ].join('\n');
    const l = layoutFromAscii(key, text);
    expect(l.ex.kind[exIdx(0, 0)]).toBe(EdgeKind.WALL);
    expect(l.ex.kind[exIdx(3, 0)]).toBe(EdgeKind.WALL);
    expect(l.ex.kind[exIdx(3, 1)]).toBe(EdgeKind.PARTITION);
    expect(l.ez.kind[ezIdx(1, 1)]).toBe(EdgeKind.DOORWAY);
    expect(l.ez.kind[ezIdx(2, 1)]).toBe(EdgeKind.HEADER);
    expect(l.ez.kind[ezIdx(0, 1)]).toBe(EdgeKind.OPEN);
    expect(l.flags[cellIdx(3, 0)] & CellFlag.SOLID).toBeTruthy();
    expect(l.flags[cellIdx(0, 0)] & CellFlag.SOLID).toBe(0);
    expect(l.flags[cellIdx(3, 1)] & CellFlag.SOLID).toBe(0); // '?' unknown -> plain floor
    expect(l.flags[cellIdx(10, 10)] & CellFlag.SOLID).toBeTruthy(); // outside the text
    expect(l.waterCm[cellIdx(0, 1)]).toBe(20);
    const states = l.fixtures.map((f) => [f.state, f.dynamic]);
    expect(states).toEqual([[LightState.ON, false], [LightState.FLICKER, true], [LightState.DYING, false], [LightState.OFF, false]]);
    expect(l.fixtures.every((f) => f.kind === FixtureKind.TROFFER_2x4)).toBe(true);
    expect(new Set(l.fixtures.map((f) => f.id)).size).toBe(4);
    // ids use the core lattice rule: the 0.6 m tile containing the fixture centre
    for (const f of l.fixtures) {
      expect(f.id).toBe(fixtureId(0, key.s, Math.floor((key.cx * CHUNK_SIZE + f.px) / 0.6 + 1e-9), Math.floor((key.cz * CHUNK_SIZE + f.pz) / 0.6 + 1e-9), f.kind));
    }
    // the parsed layout renders back to the same glyphs
    const back = layoutToAscii(l).split('\n');
    expect(back[1].slice(0, 9)).toBe('|. L f|#|');
    expect(back[3].slice(0, 9)).toBe('|~ y l:.|');
  });

  it('marks override cell glyphs; multi-chunk maps share border lines', () => {
    const grid = testSceneChunk('grid', key, 1);
    const a = layoutToAscii(grid, [{ li: 2, lj: 5, ch: '@' }]);
    expect(a.split('\n')[2 * 5 + 1][2 * 2 + 1]).toBe('@');
    const g = createWorldGen({ seed: 1, seedText: '1', forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });
    const ls = [g.generateChunk({ s: 0, cx: 0, cz: 0 }), g.generateChunk({ s: 0, cx: 1, cz: 0 })];
    const m = asciiMapFromLayouts(ls, 2, 1).split('\n');
    expect(m.length).toBe(2 * N + 1);
    expect(m[0].length).toBe(4 * N + 1);
    // the shared line (column 2N) equals both single-chunk renderings' border columns
    const left = layoutToAscii(ls[0]).split('\n'), right = layoutToAscii(ls[1]).split('\n');
    for (let y = 1; y < 2 * N; y += 2) {
      expect(m[y][2 * N]).toBe(left[y][2 * N]);
      expect(m[y][2 * N]).toBe(right[y][0]);
    }
    expect(g.asciiMap(0, 0, 0, 1, 0)).toBe(m.join('\n'));
  });

  it('tools/map.ts renders 5x5 chunks (ASCII + PNG) in < 2 s', () => {
    const out = join(tmpdir(), `wp1-map-${process.pid}.png`);
    const t0 = Date.now();
    const text = execFileSync(process.execPath, ['tools/map.ts', '--seed', '1', '--s', '0', '--cx0', '-2', '--cz0', '-2', '--cx1', '2', '--cz1', '2', '--png', out], {
      encoding: 'utf8', env: { ...process.env, WORLD_VALIDATE: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000);
    const rows = text.split('\n');
    expect(rows[0].length).toBe(2 * 5 * N + 1);
    expect(existsSync(out)).toBe(true);
    const png = readFileSync(out);
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(5 * N * 4 + 1); // IHDR width
    rmSync(out);
  }, 20_000);
});
