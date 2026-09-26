// tools/showcase-route.ts — route planning for tools/showcase.mjs shots. Runs the pure generator and the player's
// collision build (src/player/collisionBuild.ts) in Node (type stripping), so routes respect the same walls, props
// and solids the controller collides with.
//
//   node tools/showcase-route.ts sites --seed 7 --s 0 --at x,z [--r 4]
//       landmarks (world rect), elevators and stair towers within r chunks of (x, z); --all adds anomaly sites,
//       vignettes and glitch walls with their zone / district mood; --only REGEXP filters the lines
//   node tools/showcase-route.ts route --seed 7 --s 0 --from x,z --to x,z [--via x,z]... [--speed 1.2]
//                                      [--t0 0] [--png out.png] [--clear 0.45] [--ease-in] [--ease-out]
//       (hard limit: PLAYER.radius + 4 cm from anything that blocks; --clear is the preferred distance)
//       A* over a 0.1 m occupancy grid (boxes that block a standing player, VOID cells), a cost that keeps to the
//       middle of corridors, smoothing that keeps the clearance, then timed keys: prints {"path": [[t, x, z]...],
//       "look": [[t, yawDeg, pitchDeg]...]} for a shot (look = where the walk is heading, low-passed).
//
// Game yaw convention: forward = (-sin yaw, -cos yaw), yaw 0 = north (-z).

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { CELL, CHUNK_CELLS, CHUNK_SIZE, PLAYER } from '../src/core/constants.ts';
import { cellIdx } from '../src/core/grid.ts';
import { AnomalyKind, CellFlag, LANDMARK_NAMES, MOOD_NAMES, type StoreyId, VIGNETTE_NAMES, ZONE_NAMES } from '../src/core/ids.ts';

const ANOMALY_NAMES: string[] = [];
for (const [k, v] of Object.entries(AnomalyKind)) ANOMALY_NAMES[v] = k;
import type { ChunkLayout } from '../src/core/layout.ts';
import { hashString } from '../src/core/rng.ts';
import { elevatorFootprint, towerFootprint } from '../src/core/world.ts';
import { buildChunkCollision } from '../src/player/collisionBuild.ts';
import { createWorldGen } from '../src/world/worldgen.ts';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = new Map<string, string[]>();
for (let i = 1; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const v = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
  opt.set(k, [...(opt.get(k) ?? []), v]);
}
const one = (k: string, d?: string): string | undefined => opt.get(k)?.[0] ?? d;
const pt = (s: string): [number, number] => { const [x, z] = s.split(',').map(Number); return [x, z]; };
const seedText = one('seed', '7')!;
const s = Number(one('s', '0')) as StoreyId;
const gen = createWorldGen({ seed: hashString(seedText), seedText, forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });
const chunkOf = (m: number): number => Math.floor(m / CHUNK_SIZE);
const r1 = (v: number): number => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ sites
if (cmd === 'sites') {
  const [x, z] = pt(one('at')!);
  const r = Number(one('r', '4'));
  const all = opt.has('all'); // also anomalies, vignettes and glitch walls (generates every chunk in range)
  const only = one('only'); // keep lines whose kind word matches this regexp
  const cx0 = chunkOf(x), cz0 = chunkOf(z);
  const out: string[] = [];
  const seenE = new Set<number>(), seenT = new Set<number>();
  for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
    for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
      const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
      const lm = gen.landmarkAt(s, cx, cz);
      if (lm || all) {
        const l = gen.generateChunk({ s, cx, cz });
        for (const li of l.landmarks) {
          out.push(`landmark ${LANDMARK_NAMES[li.kind]} chunk (${cx},${cz}) x ${r1(ox + li.i0 * CELL)}..${r1(ox + li.i1 * CELL)} z ${r1(oz + li.j0 * CELL)}..${r1(oz + li.j1 * CELL)}`);
        }
        if (all) {
          // point features: anomaly sites, vignettes, glitch walls (with the chunk's zone and district mood)
          const where = (px: number, pz: number): string => `x ${r1(ox + px)}..${r1(ox + px)} z ${r1(oz + pz)}..${r1(oz + pz)}`;
          const tag = `${ZONE_NAMES[l.zone]}/${MOOD_NAMES[l.mood]}`;
          for (const a of l.anomalies) out.push(`anomaly ${ANOMALY_NAMES[a.kind] ?? a.kind} (${tag}) r ${r1(a.r)} ${where(a.x, a.z)}`);
          for (const v of l.vignettes) out.push(`vignette ${VIGNETTE_NAMES[v.kind]} (${tag}) yaw ${r1((v.yaw * 180) / Math.PI)} ${where(v.x, v.z)}`);
          for (const st of l.structures) {
            if (st.portal?.kind !== 'glitch') continue;
            const p = st.portal;
            out.push(`glitch-wall (${tag}) ${where((p.min[0] + p.max[0]) / 2, (p.min[2] + p.max[2]) / 2)}`);
          }
        }
      }
      for (const e of gen.elevatorsNear(s, cx, cz)) {
        if (e.cx !== cx || e.cz !== cz || seenE.has(e.id)) continue;
        seenE.add(e.id);
        const [i0, j0, i1, j1] = elevatorFootprint(e);
        out.push(`elevator chunk (${cx},${cz}) rot ${e.rot} x ${r1(ox + i0 * CELL)}..${r1(ox + i1 * CELL)} z ${r1(oz + j0 * CELL)}..${r1(oz + j1 * CELL)}`);
      }
      for (const t of gen.towersNear(s, cx, cz)) {
        if (t.cx !== cx || t.cz !== cz || seenT.has(t.id)) continue;
        seenT.add(t.id);
        const [i0, j0, i1, j1] = towerFootprint(t);
        out.push(`tower chunk (${cx},${cz}) rot ${t.rot}${t.endless ? ' ENDLESS' : ''} x ${r1(ox + i0 * CELL)}..${r1(ox + i1 * CELL)} z ${r1(oz + j0 * CELL)}..${r1(oz + j1 * CELL)}`);
      }
    }
  }
  const d = (line: string): number => {
    const m = /x ([-\d.]+)\.\.([-\d.]+) z ([-\d.]+)\.\.([-\d.]+)/.exec(line)!;
    return Math.hypot((+m[1] + +m[2]) / 2 - x, (+m[3] + +m[4]) / 2 - z);
  };
  out.sort((a, b) => d(a) - d(b));
  for (const l of out) if (!only || new RegExp(only).test(l)) console.log(`${d(l).toFixed(0).padStart(5)} m  ${l}`);
  process.exit(0);
}

if (cmd !== 'route' && cmd !== 'map') { console.error('usage: node tools/showcase-route.ts sites|route|map ...'); process.exit(2); }

// ------------------------------------------------------------------ occupancy grid
const RES = 0.1;
const from = pt(one('from') ?? one('at')!), to = pt(one('to') ?? one('from') ?? one('at')!);
const via = (opt.get('via') ?? []).map(pt);
const pts = [from, ...via, to];
const margin = 1;
const CX0 = Math.min(...pts.map((p) => chunkOf(p[0]))) - margin, CX1 = Math.max(...pts.map((p) => chunkOf(p[0]))) + margin;
const CZ0 = Math.min(...pts.map((p) => chunkOf(p[1]))) - margin, CZ1 = Math.max(...pts.map((p) => chunkOf(p[1]))) + margin;
const PER = Math.round(CHUNK_SIZE / RES); // 384 samples per chunk
const W = (CX1 - CX0 + 1) * PER, H = (CZ1 - CZ0 + 1) * PER;
const X0 = CX0 * CHUNK_SIZE, Z0 = CZ0 * CHUNK_SIZE;
const blocked = new Uint8Array(W * H);
const zoneAt = new Uint8Array(W * H);
const layouts = new Map<string, ChunkLayout>();
const gx = (x: number): number => Math.floor((x - X0) / RES), gz = (z: number): number => Math.floor((z - Z0) / RES);
const wx = (i: number): number => X0 + (i + 0.5) * RES, wz = (j: number): number => Z0 + (j + 0.5) * RES;

function fillRect(x0: number, z0: number, x1: number, z1: number): void {
  const i0 = Math.max(0, gx(x0)), i1 = Math.min(W - 1, gx(x1 - 1e-6)), j0 = Math.max(0, gz(z0)), j1 = Math.min(H - 1, gz(z1 - 1e-6));
  for (let j = j0; j <= j1; j++) blocked.fill(1, j * W + i0, j * W + i1 + 1);
}

for (let cz = CZ0; cz <= CZ1; cz++) {
  for (let cx = CX0; cx <= CX1; cx++) {
    const l = gen.generateChunk({ s, cx, cz });
    layouts.set(`${cx},${cz}`, l);
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    // lowest floor under a box footprint grown by one cell: a riser (a raised cell's step box) blocks a player
    // arriving from the lower neighbour, so compare box tops against the lowest floor around them
    const floorUnder = (x0: number, z0: number, x1: number, z1: number): number => {
      const cl = (v: number): number => Math.min(CHUNK_CELLS - 1, Math.max(0, v));
      let m = Infinity;
      for (let lj = cl(Math.floor(z0 / CELL) - 1); lj <= cl(Math.floor(z1 / CELL) + 1); lj++) {
        for (let li = cl(Math.floor(x0 / CELL) - 1); li <= cl(Math.floor(x1 / CELL) + 1); li++) {
          const c = cellIdx(li, lj);
          if (!(l.flags[c] & (CellFlag.SOLID | CellFlag.VOID | CellFlag.TOWER))) m = Math.min(m, l.floorCm[c] / 100);
        }
      }
      return m === Infinity ? 0 : m;
    };
    // cells: VOID / towers blocked (tower flights are periodic ramps: routes stop at the tower door); zone per sample
    for (let lj = 0; lj < CHUNK_CELLS; lj++) {
      for (let li = 0; li < CHUNK_CELLS; li++) {
        const c = cellIdx(li, lj);
        const f = l.flags[c];
        const x0 = ox + li * CELL, z0 = oz + lj * CELL;
        if (f & (CellFlag.VOID | CellFlag.TOWER)) fillRect(x0, z0, x0 + CELL, z0 + CELL);
        const i0 = gx(x0), j0 = gz(z0), n = Math.round(CELL / RES);
        for (let j = j0; j < j0 + n; j++) if (j >= 0 && j < H) zoneAt.fill(l.cellZone[c], j * W + Math.max(0, i0), j * W + Math.min(W, i0 + n));
      }
    }
    const col = buildChunkCollision(l);
    const b = col.boxes;
    for (let k = 0; k < b.length; k += 6) {
      const floor = floorUnder(b[k], b[k + 2], b[k + 3], b[k + 5]);
      // blocks a standing player whose feet are on the local floor (a step up to stepMax is climbed)
      if (b[k + 4] <= floor + PLAYER.stepMax + 0.01 || b[k + 1] >= floor + PLAYER.height) continue;
      fillRect(ox + b[k], oz + b[k + 2], ox + b[k + 3], oz + b[k + 5]);
    }
  }
}

// distance to the nearest blocked sample (m), two-pass 3-4 chamfer
const dist = new Float32Array(W * H);
{
  const INF = 1e9;
  for (let i = 0; i < W * H; i++) dist[i] = blocked[i] ? 0 : INF;
  const a = RES, d = RES * Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    let v = dist[k];
    if (i > 0) v = Math.min(v, dist[k - 1] + a);
    if (j > 0) { v = Math.min(v, dist[k - W] + a); if (i > 0) v = Math.min(v, dist[k - W - 1] + d); if (i < W - 1) v = Math.min(v, dist[k - W + 1] + d); }
    dist[k] = v;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    let v = dist[k];
    if (i < W - 1) v = Math.min(v, dist[k + 1] + a);
    if (j < H - 1) { v = Math.min(v, dist[k + W] + a); if (i < W - 1) v = Math.min(v, dist[k + W + 1] + d); if (i > 0) v = Math.min(v, dist[k + W - 1] + d); }
    dist[k] = v;
  }
}
const CLEAR = Number(one('clear', '0.45')); // preferred clearance (smoothing target)
const MIN_CLEAR = PLAYER.radius + 0.04; // hard limit: doorways are ~0.9 m wide
const distAt = (x: number, z: number): number => {
  const i = gx(x), j = gz(z);
  return i < 0 || j < 0 || i >= W || j >= H ? 0 : dist[j * W + i];
};

// ------------------------------------------------------------------ A*
function astar(a: [number, number], b: [number, number]): [number, number][] {
  const si = gx(a[0]), sj = gz(a[1]), ti = gx(b[0]), tj = gz(b[1]);
  for (const [n, x, z] of [['from/via', a[0], a[1]], ['to/via', b[0], b[1]]] as const) {
    if (distAt(x, z) < MIN_CLEAR) console.error(`warning: ${n} point (${x}, ${z}) has only ${distAt(x, z).toFixed(2)} m clearance`);
  }
  const N = W * H;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  // binary heap of [f, idx]
  const hf: number[] = [], hi: number[] = [];
  const push = (f: number, i: number): void => {
    hf.push(f); hi.push(i);
    let c = hf.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (hf[p] <= hf[c]) break; [hf[p], hf[c]] = [hf[c], hf[p]]; [hi[p], hi[c]] = [hi[c], hi[p]]; c = p; }
  };
  const pop = (): number => {
    const top = hi[0];
    const lf = hf.pop()!, li = hi.pop()!;
    if (hf.length) {
      hf[0] = lf; hi[0] = li;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < hf.length && hf[l] < hf[m]) m = l;
        if (r < hf.length && hf[r] < hf[m]) m = r;
        if (m === c) break;
        [hf[m], hf[c]] = [hf[c], hf[m]]; [hi[m], hi[c]] = [hi[c], hi[m]]; c = m;
      }
    }
    return top;
  };
  const hcost = (i: number, j: number): number => Math.hypot(i - ti, j - tj) * RES;
  const s0 = sj * W + si, t0 = tj * W + ti;
  g[s0] = 0; push(hcost(si, sj), s0);
  const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  while (hf.length) {
    const k = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === t0) break;
    const i = k % W, j = (k - i) / W;
    for (let d = 0; d < 8; d++) {
      const ni = i + DI[d], nj = j + DJ[d];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nk = nj * W + ni;
      if (closed[nk]) continue;
      const dd = dist[nk];
      // start / end samples may sit a little inside the clearance band; everything between must not
      if (dd < MIN_CLEAR && nk !== t0 && Math.hypot(ni - si, nj - sj) * RES > 0.6 && Math.hypot(ni - ti, nj - tj) * RES > 0.6) continue;
      const step = (d < 4 ? 1 : Math.SQRT2) * RES;
      const pen = 1 + 3 * Math.max(0, 1.4 - dd) / 1.4; // keep to the middle of corridors and doorways
      const ng = g[k] + step * pen;
      if (ng < g[nk]) { g[nk] = ng; came[nk] = k; push(ng + hcost(ni, nj), nk); }
    }
  }
  if (came[t0] < 0 && t0 !== s0) throw new Error(`no route from (${a}) to (${b})`);
  const out: [number, number][] = [];
  for (let k = t0; k >= 0; k = came[k]) { const i = k % W; out.push([wx(i), wz((k - i) / W)]); if (k === s0) break; }
  out.reverse();
  out[0] = [a[0], a[1]]; out[out.length - 1] = [b[0], b[1]];
  return out;
}

let route: [number, number][] = [from];
let total = 0;
let posAt = (_d: number): [number, number] => from;
if (cmd === 'route') {
route = [];
for (let k = 0; k < pts.length - 1; k++) {
  const seg = astar(pts[k], pts[k + 1]);
  route.push(...(k === 0 ? seg : seg.slice(1)));
}

// resample every 0.25 m, then relax (moving average) where the clearance allows
function resample(p: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [p[0]];
  let carry = 0;
  for (let k = 1; k < p.length; k++) {
    const [ax, az] = p[k - 1], [bx, bz] = p[k];
    const L = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= L) { out.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); t += step; }
    carry = L - (t - step);
  }
  const last = p[p.length - 1];
  if (Math.hypot(out[out.length - 1][0] - last[0], out[out.length - 1][1] - last[1]) > 1e-3) out.push(last);
  return out;
}
route = resample(route, 0.25);
const pinned = new Set<number>([0, route.length - 1]);
for (const v of via) { let best = 0, bd = Infinity; route.forEach((p, i) => { const d = Math.hypot(p[0] - v[0], p[1] - v[1]); if (d < bd) { bd = d; best = i; } }); pinned.add(best); }
for (let it = 0; it < 60; it++) {
  const nxt = route.map((p) => [p[0], p[1]] as [number, number]);
  for (let k = 1; k < route.length - 1; k++) {
    if (pinned.has(k)) continue;
    const w = 3;
    let sx = 0, sz = 0, n = 0;
    for (let d = -w; d <= w; d++) { const q = route[Math.min(route.length - 1, Math.max(0, k + d))]; sx += q[0]; sz += q[1]; n++; }
    const c: [number, number] = [sx / n, sz / n];
    if (distAt(c[0], c[1]) >= Math.min(CLEAR + 0.05, distAt(route[k][0], route[k][1]))) nxt[k] = c;
  }
  route = nxt;
}
route = resample(route, 0.25);

// ------------------------------------------------------------------ timing + look
const speed = Number(one('speed', '1.2'));
const t0 = Number(one('t0', '0'));
const easeIn = opt.has('ease-in'), easeOut = opt.has('ease-out');
const cum = [0];
for (let k = 1; k < route.length; k++) cum.push(cum[k - 1] + Math.hypot(route[k][0] - route[k - 1][0], route[k][1] - route[k - 1][1]));
total = cum[cum.length - 1];
// distance(t): constant speed with optional 1.2 s cosine ramps (the ramp covers half its distance at full speed)
const RAMP = 1.2;
const rampD = (speed * RAMP) / 2;
const dur = total / speed + (easeIn ? RAMP / 2 : 0) + (easeOut ? RAMP / 2 : 0);
function distAtTime(t: number): number {
  if (easeIn && t < RAMP) return speed * (t - (RAMP / Math.PI) * Math.sin((Math.PI * t) / RAMP)) / 2;
  const tIn = easeIn ? RAMP : 0, dIn = easeIn ? rampD : 0;
  if (easeOut && t > dur - RAMP) {
    const u = dur - t;
    return total - speed * (u - (RAMP / Math.PI) * Math.sin((Math.PI * u) / RAMP)) / 2;
  }
  return dIn + (t - tIn) * speed;
}
posAt = (d: number): [number, number] => {
  d = Math.max(0, Math.min(total, d));
  let k = 1;
  while (k < cum.length - 1 && cum[k] < d) k++;
  const u = (d - cum[k - 1]) / Math.max(1e-9, cum[k] - cum[k - 1]);
  return [route[k - 1][0] + (route[k][0] - route[k - 1][0]) * u, route[k - 1][1] + (route[k][1] - route[k - 1][1]) * u];
}
const KEY_DT = 0.5;
const path: number[][] = [];
for (let t = 0; t <= dur + 1e-6; t += KEY_DT) { const p = posAt(distAtTime(t)); path.push([r1(t0 + t), r1(p[0]), r1(p[1])]); }
if (path[path.length - 1][0] < r1(t0 + dur)) { const p = posAt(total); path.push([r1(t0 + dur), r1(p[0]), r1(p[1])]); }
// look: toward the point 2.2 m further along the route, unwrapped, then a gaussian low-pass (sigma 0.6 s)
const LA = 2.2, DT = 0.1;
const yaws: number[] = [];
for (let t = 0; t <= dur + 1e-6; t += DT) {
  const d = distAtTime(t);
  const a = posAt(d), b = posAt(Math.min(total, d + LA));
  let dx = b[0] - a[0], dz = b[1] - a[1];
  if (Math.hypot(dx, dz) < 0.3) { const c = posAt(Math.max(0, total - LA)); dx = posAt(total)[0] - c[0]; dz = posAt(total)[1] - c[1]; }
  let y = Math.atan2(-dx, -dz);
  if (yaws.length) { const p = yaws[yaws.length - 1]; while (y - p > Math.PI) y -= 2 * Math.PI; while (y - p < -Math.PI) y += 2 * Math.PI; }
  yaws.push(y);
}
const SIG = 0.6 / DT;
const sm = yaws.map((_, k) => {
  let s0 = 0, w0 = 0;
  for (let d = -Math.ceil(3 * SIG); d <= Math.ceil(3 * SIG); d++) {
    const q = yaws[Math.min(yaws.length - 1, Math.max(0, k + d))];
    const w = Math.exp(-(d * d) / (2 * SIG * SIG));
    s0 += q * w; w0 += w;
  }
  return s0 / w0;
});
const look: number[][] = [];
for (let k = 0; k < sm.length; k += Math.round(KEY_DT / DT)) look.push([r1(t0 + k * DT), r1((sm[k] * 180) / Math.PI), 0]);

let minClear = Infinity;
for (let d = 0; d <= total; d += 0.05) { const p = posAt(d); minClear = Math.min(minClear, distAt(p[0], p[1])); }
const zones = new Set<string>();
for (let d = 0; d <= total; d += 1) { const p = posAt(d); const i = gx(p[0]), j = gz(p[1]); zones.add(ZONE_NAMES[zoneAt[j * W + i]] ?? '?'); }
console.error(`route ${total.toFixed(1)} m, ${dur.toFixed(1)} s at ${speed} m/s, min clearance ${minClear.toFixed(2)} m, zones ${[...zones].join(' > ')}`);
console.log(JSON.stringify({ duration: r1(dur), path, look }));

}

// ------------------------------------------------------------------ PNG (4 px per metre... 1 px per sample, cropped)
const png = one('png');
if (png) {
  const xs = route.map((p) => p[0]), zs = route.map((p) => p[1]);
  const pad = Number(one('pad', '12'));
  const i0 = Math.max(0, gx(Math.min(...xs) - pad)), i1 = Math.min(W - 1, gx(Math.max(...xs) + pad));
  const j0 = Math.max(0, gz(Math.min(...zs) - pad)), j1 = Math.min(H - 1, gz(Math.max(...zs) + pad));
  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  const ZC: [number, number, number][] = [[214, 190, 110], [222, 200, 160], [120, 104, 70], [200, 180, 100], [190, 170, 120], [180, 180, 170], [170, 160, 150], [150, 200, 220], [140, 140, 150], [150, 120, 90], [160, 150, 130], [130, 130, 130]];
  const rgb = new Uint8Array(w * h * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (j + j0) * W + (i + i0), o = (j * w + i) * 3;
    let c: [number, number, number] = blocked[k] ? [20, 20, 20] : ZC[zoneAt[k]] ?? [255, 0, 255];
    if (!blocked[k] && dist[k] < CLEAR) c = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6];
    // 1 m grid ticks every 10 m
    const X = wx(i + i0), Z = wz(j + j0);
    if (Math.abs(X - Math.round(X / 10) * 10) < RES / 2 || Math.abs(Z - Math.round(Z / 10) * 10) < RES / 2) c = [c[0] * 0.8 + 40, c[1] * 0.8 + 40, c[2] * 0.8 + 60];
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
  const dot = (x: number, z: number, col: [number, number, number], r: number): void => {
    const ci = gx(x) - i0, cj = gz(z) - j0;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= w || j >= h || di * di + dj * dj > r * r) continue;
      const o = (j * w + i) * 3; rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2];
    }
  };
  for (let d = 0; d <= total; d += 0.05) { const p = posAt(d); dot(p[0], p[1], [230, 30, 30], 1); }
  dot(from[0], from[1], [30, 200, 30], 5); dot(to[0], to[1], [30, 60, 230], 5);
  for (const v of via) dot(v[0], v[1], [240, 140, 0], 4);
  // PNG encode (RGB8)
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let j = 0; j < h; j++) { raw[j * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, j * w * 3, w * 3).copy(raw, j * (w * 3 + 1) + 1); }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer): number => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(png, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.error(`map ${png}: ${w}x${h} px, x ${wx(i0).toFixed(1)}..${wx(i1).toFixed(1)}, z ${wz(j0).toFixed(1)}..${wz(j1).toFixed(1)} (10 m grid lines)`);
}
