// Pure pieces of the app shell: clock, frame statistics, perf recorder, auto quality, speed mapping, debug views.
import { describe, expect, it } from 'vitest';
import { createClock, MAX_REAL_DT } from '../../src/app/clock.ts';
import { createFrameStats, createPerfRecorder, percentileSorted } from '../../src/app/perf.ts';
import { classifyRenderer, isIntegratedRenderer, isResolutionOnlyChange } from '../../src/app/qualityAuto.ts';
import { QUALITY } from '../../src/core/quality.ts';
import { speedToInput } from '../../src/app/autowalk.ts';
import { DEFAULT_CONTROLLER } from '../../src/player/controller.ts';
import { asciiAround, cellInfoAt, EDGE_KIND_NAMES } from '../../src/app/worldDebug.ts';
import { CellFlag, EdgeKind, Mood, Zone } from '../../src/core/ids.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { createEmptyLayout } from '../../src/core/layout.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import type { WorldQuery } from '../../src/core/runtime.ts';

describe('clock', () => {
  it('advances by real dt, clamps long frames, freezes and pauses', () => {
    const c = createClock();
    c.tick(1000); // first tick: 1/60
    expect(c.t).toBeCloseTo(1 / 60, 9);
    c.tick(1016);
    expect(c.dt).toBeCloseTo(0.016, 9);
    c.tick(5000); // 4 s hitch -> clamped
    expect(c.realDt).toBe(MAX_REAL_DT);
    c.set(10);
    expect(c.frozen).toBe(true);
    c.tick(5016);
    expect(c.t).toBe(10);
    expect(c.dt).toBe(0);
    expect(c.realDt).toBeCloseTo(0.016, 9);
    c.set(null);
    c.tick(5032);
    expect(c.t).toBeCloseTo(10.016, 9);
    c.paused = true;
    c.tick(5048);
    expect(c.t).toBeCloseTo(10.016, 9);
    expect(c.frozen).toBe(false);
    c.paused = false;
    c.freezeNow();
    const t = c.t;
    c.tick(5064);
    expect(c.t).toBe(t);
  });
});

describe('frame statistics', () => {
  it('invalid capacities and summary windows still produce finite frame statistics', () => {
    for (const capacity of [0, -1, NaN, 2.5]) {
      const fs = createFrameStats(capacity);
      fs.push(16, 2, 1000);
      for (const window of [0, -1, NaN, 0.5]) {
        expect(fs.summary(window)).toMatchObject({ avg: 16, p95: 16, max: 16, cpuMs: 2 });
      }
    }
  });
  it('avg / p95 / max / max5s / fps', () => {
    const fs = createFrameStats(1024);
    let now = 0;
    for (let i = 0; i < 300; i++) { now += 16; fs.push(16, 2, now); }
    now += 40; fs.push(40, 3, now); // one hitch
    const s = fs.summary(120);
    expect(s.max).toBe(40);
    expect(s.max5s).toBe(40);
    expect(s.p95).toBe(16);
    expect(s.avg).toBeCloseTo((119 * 16 + 40) / 120, 9);
    expect(s.fps).toBeGreaterThan(55);
    expect(s.fps).toBeLessThan(66);
    for (let i = 0; i < 400; i++) { now += 16; fs.push(16, 2, now); } // > 5 s later
    expect(fs.summary().max5s).toBe(16);
    expect(fs.maxSince(0)).toBe(40);
  });
  it('wraps its ring without allocation errors', () => {
    const fs = createFrameStats(8);
    for (let i = 0; i < 50; i++) fs.push(i, 0, i * 10);
    expect(fs.count).toBe(8);
    expect(fs.summary(8).max).toBe(49);
  });
  it('percentileSorted (nearest rank)', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileSorted(a, 10, 0)).toBe(1);
    expect(percentileSorted(a, 10, 0.5)).toBe(6);
    expect(percentileSorted(a, 10, 1)).toBe(10);
    expect(percentileSorted(a, 0, 0.5)).toBe(0);
  });
  it('perf recorder stops after the requested seconds', () => {
    const r = createPerfRecorder(1);
    let frames = 0;
    while (!r.frame(10, 100, 5000, null)) frames++;
    const rep = r.report();
    expect(frames + 1).toBe(100);
    expect(rep.frames).toBe(100);
    expect(rep.seconds).toBeCloseTo(1, 6);
    expect(rep.fps).toBeCloseTo(100, 6);
    expect(rep.frameMs).toEqual({ avg: 10, p50: 10, p95: 10, p99: 10, max: 10 });
    expect(rep.drawCalls).toBe(100);
    expect(rep.triangles).toBe(5000);
    expect(rep.gpuMs).toBeNull();
  });
  it('records every frame above its initial sample allocation', () => {
    const r = createPerfRecorder(0.1);
    let frames = 0;
    while (!r.frame(0.125, 100, 5000, 1)) frames++;
    const rep = r.report();
    expect(frames + 1).toBe(800);
    expect(rep).toMatchObject({ frames: 800, seconds: 0.1, fps: 8000, drawCalls: 100, triangles: 5000, gpuMs: 1 });
    expect(rep.frameMs.avg).toBe(0.125);
  });
});

describe('auto quality', () => {
  it('classifies renderer strings', () => {
    expect(classifyRenderer('Google SwiftShader')).toBe('low');
    expect(classifyRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('low');
    expect(classifyRenderer('llvmpipe (LLVM 17.0.6, 256 bits)')).toBe('low');
    expect(classifyRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('low');
    // hybrid laptop iGPUs (this dev machine's Radeon 610M: 2 CUs; ~47 ms/frame at 1080p low before R3)
    expect(classifyRenderer('ANGLE (AMD, AMD Radeon 610M (radeonsi raphael_mendocino LLVM 20.1.2), OpenGL ES 3.2)')).toBe('low');
    expect(classifyRenderer('ANGLE (AMD, Vulkan 1.4.318 (AMD Radeon 610M (RADV RAPHAEL_MENDOCINO) (0x0000164E)), radv)')).toBe('low');
    expect(classifyRenderer('ANGLE (AMD, AMD Radeon(TM) 780M Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(classifyRenderer('ANGLE (AMD, AMD Radeon 680M (radeonsi rembrandt LLVM 18.1.8), OpenGL ES 3.2)')).toBe('medium');
    expect(classifyRenderer('ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(isIntegratedRenderer('ANGLE (AMD, AMD Radeon 610M (radeonsi raphael_mendocino LLVM 20.1.2), OpenGL ES 3.2)')).toBe(true);
    expect(isIntegratedRenderer('ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 5070 Ti Laptop GPU (0x00002F58)), NVIDIA)')).toBe(false);
    expect(isIntegratedRenderer('ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(isIntegratedRenderer('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(isIntegratedRenderer('Google SwiftShader')).toBe(false);
    expect(classifyRenderer('Mali-G78')).toBe('medium');
    expect(classifyRenderer('Adreno (TM) 740')).toBe('medium');
    expect(classifyRenderer('Apple M2')).toBe('medium');
    expect(classifyRenderer('ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Laptop GPU (0x00002F58) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(classifyRenderer('ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(classifyRenderer('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(classifyRenderer('')).toBe('high');
    // entry-level / old discrete NVIDIA (2-4 GB VRAM) start at medium (R2 B9)
    expect(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce MX450 (0x00001F9D) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce MX 250 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(classifyRenderer('NVIDIA GeForce GT 1030/PCIe/SSE2')).toBe('medium');
    expect(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(classifyRenderer('NVIDIA GeForce GTX 970/PCIe/SSE2')).toBe('medium');
    expect(classifyRenderer('ANGLE (NVIDIA, Quadro P620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(classifyRenderer('ANGLE (NVIDIA, Quadro RTX 4000 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
  });
  it('resolution-only quality changes (settings sliders) skip warmup and the ready gate', () => {
    const h = QUALITY.high;
    expect(isResolutionOnlyChange(h, { ...h })).toBe(true);
    expect(isResolutionOnlyChange(h, { ...h, renderScale: 0.6, dynamicResolution: false, maxDpr: 2, propDistance: 20 })).toBe(true);
    expect(isResolutionOnlyChange(h, { ...h, streamRadius: 3 })).toBe(false);
    expect(isResolutionOnlyChange(h, { ...h, ao: 'High' })).toBe(false);
    expect(isResolutionOnlyChange(h, QUALITY.medium)).toBe(false);
    expect(isResolutionOnlyChange(QUALITY.medium, { ...QUALITY.medium, name: 'high' })).toBe(false);
  });
});

describe('speedToInput', () => {
  it('walk, sprint and time-scaled speeds', () => {
    const { walk, sprint } = DEFAULT_CONTROLLER; // the controller's paces (tuned by the player batch)
    expect(speedToInput(walk)).toEqual({ mag: 1, sprint: false, timeScale: 1 });
    expect(speedToInput(walk / 2).mag).toBeCloseTo(0.5, 9);
    const s = speedToInput(sprint);
    expect(s).toEqual({ mag: 1, sprint: true, timeScale: 1 });
    const f = speedToInput(sprint * 2);
    expect(f.sprint).toBe(true);
    expect(f.timeScale).toBeCloseTo(2, 9);
    expect(speedToInput(NaN).mag).toBe(1);
  });
});

describe('debug world views', () => {
  function fakeQuery(layouts: Map<string, ChunkLayout>): WorldQuery {
    return { layoutAt: (cx: number, cz: number) => layouts.get(`${cx},${cz}`) ?? null } as unknown as WorldQuery;
  }
  const l = createEmptyLayout({ s: 0, cx: 0, cz: 0 }, Zone.OFFICE, 7, Mood.DYING);
  l.flags[cellIdx(3, 3)] = CellFlag.SOLID;
  l.floorCm[cellIdx(1, 1)] = 10;
  l.ceilCm[cellIdx(1, 1)] = 270;
  l.cellZone[cellIdx(1, 1)] = Zone.OFFICE;
  l.room[cellIdx(1, 1)] = 5;
  l.power[cellIdx(1, 1)] = 255;
  l.ex.kind[exIdx(1, 1)] = EdgeKind.WALL; // west of (1,1)
  l.ez.kind[ezIdx(1, 2)] = EdgeKind.DOORWAY; // south of (1,1)
  const q = fakeQuery(new Map([['0,0', l]]));

  it('edge names are indexed by EdgeKind', () => {
    expect(EDGE_KIND_NAMES[EdgeKind.GLITCH]).toBe('GLITCH');
    expect(EDGE_KIND_NAMES[EdgeKind.OPEN]).toBe('OPEN');
  });
  it('cellInfoAt', () => {
    const c = cellInfoAt(q, 0, 1.2 * 1.5, 1.2 * 1.5);
    expect(c).not.toBeNull();
    expect(c).toMatchObject({
      s: 0, gi: 1, gj: 1, chunk: [0, 0], tile: 0, zone: 'OFFICE', mood: 'DYING', floorY: 0.1, ceilY: 2.7, waterY: null, room: 5,
      power: 1, edges: { W: 'WALL', E: 'OPEN', N: 'OPEN', S: 'DOORWAY' },
    });
    expect(cellInfoAt(q, 0, -5, 3)).toBeNull(); // chunk (-1, 0) not loaded
    expect(cellInfoAt(q, 0, NaN, 3)).toBeNull();
  });
  it('asciiAround marks the player, solids, walls and unloaded cells', () => {
    const txt = asciiAround(q, 1.2 * 2.5, 1.2 * 2.5, 3);
    const lines = txt.split('\n');
    expect(txt).toContain('@');
    expect(txt).toContain('#');
    expect(txt).toContain('?'); // x < 0 is unloaded
    expect(lines.some((row) => row.includes('|'))).toBe(true);
    expect(lines.length).toBe(3 + 2 * 7 + 1); // 2 legend lines + header + 7 cell rows + 8 edge rows
  });
});
