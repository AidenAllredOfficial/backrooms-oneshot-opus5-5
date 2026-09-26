// src/audio/roomProbe.ts — room probe (rays -> V, S, absorption) and Sabine RT60 (pure).
//
// The runtime (reverb.ts) casts PROBE_RAYS horizontal rays (WorldQuery.rayDistance at y = 1.2, max 40 m) 4 times a
// second. roomFromRays() turns them into the star-shaped floor polygon around the listener (area, perimeter), then
// with the ceiling height into V and S, averages the Sabine absorption of floor / walls / ceiling weighted by their
// surface, and returns RT60 = 0.161 V / (S a) plus the mean free path 4V/S (pre-delay) and the openness (fraction of
// rays that reached max distance; drives the wet level).

export const PROBE_RAYS = 24;
export const PROBE_MAX = 40;
export const PROBE_Y = 1.2;
export const RT60_MIN = 0.12;
export const RT60_MAX = 8;

export function sabineRT60(volume: number, surface: number, alpha: number): number {
  // plain Sabine formula, RT60 = 0.161 V / (S a); 0 for degenerate input
  const a = surface * alpha;
  return a > 0 && volume > 0 && Number.isFinite(a) && Number.isFinite(volume) ? (0.161 * volume) / a : 0;
}

export interface RoomEstimate {
  area: number; // m^2 (floor polygon)
  perimeter: number; // m
  height: number; // m
  volume: number; // m^3
  surface: number; // m^2 (floor + ceiling + walls)
  alpha: number; // surface-weighted Sabine absorption
  mfp: number; // mean free path 4V/S (m)
  openness: number; // 0..1 fraction of rays that hit max distance
  rt60: number; // s, clamped to [RT60_MIN, RT60_MAX]
}
export function createRoomEstimate(): RoomEstimate {
  return { area: 0, perimeter: 0, height: 0, volume: 0, surface: 0, alpha: 0, mfp: 0, openness: 0, rt60: 0 };
}

/**
 * Room estimate from `count` equally spaced horizontal ray lengths (ray i at angle 2 pi i / count).
 * alphaWall applies to the vertical boundary (perimeter x height); open rays (>= 0.98 maxDist) contribute their
 * chord as a wall of `alphaOpen` (sound escaping into the rest of a huge space is partly lost).
 */
export function roomFromRays(
  rays: ArrayLike<number>, count: number, maxDist: number, height: number,
  alphaFloor: number, alphaWall: number, alphaCeil: number, out: RoomEstimate, alphaOpen = 0.25,
): RoomEstimate {
  const n = Math.max(3, count | 0);
  const dth = (Math.PI * 2) / n;
  const s = Math.sin(dth), c = Math.cos(dth);
  let area = 0, perim = 0, openPerim = 0, open = 0;
  for (let i = 0; i < n; i++) {
    const r0 = Math.max(0.1, rays[i]), r1 = Math.max(0.1, rays[(i + 1) % n]);
    area += 0.5 * r0 * r1 * s;
    const chord = Math.sqrt(r0 * r0 + r1 * r1 - 2 * r0 * r1 * c);
    const isOpen = r0 >= maxDist * 0.98 && r1 >= maxDist * 0.98;
    if (isOpen) openPerim += chord; else perim += chord;
    if (rays[i] >= maxDist * 0.98) open++;
  }
  const h = Math.max(1.8, height);
  const floorS = area, ceilS = area, wallS = perim * h, openS = openPerim * h;
  const S = floorS + ceilS + wallS + openS;
  const alpha = S > 0 ? (floorS * alphaFloor + ceilS * alphaCeil + wallS * alphaWall + openS * alphaOpen) / S : 0.1;
  const V = area * h;
  out.area = area; out.perimeter = perim + openPerim; out.height = h; out.volume = V; out.surface = S;
  out.alpha = alpha; out.mfp = S > 0 ? (4 * V) / S : 0; out.openness = open / n;
  const rt = sabineRT60(V, S, Math.max(0.01, alpha));
  out.rt60 = Math.min(RT60_MAX, Math.max(RT60_MIN, rt || RT60_MIN));
  return out;
}

/** Standard IR set (RT60 s) and the shoebox dims / brightness each is rendered with. */
export const IR_RT60 = [0.3, 0.6, 1.0, 1.6, 2.5, 4.0] as const;
export const IR_DIMS: readonly [number, number, number][] = [[4, 4, 2.6], [8, 7, 2.7], [14, 11, 2.8], [22, 18, 3.2], [34, 28, 3.6], [50, 42, 5]];
export const IR_BRIGHTNESS = [0.45, 0.55, 0.65, 0.72, 0.8, 0.85] as const;

/** Nearest IR (in log RT60) with hysteresis: keep `current` while rt60 is within +-hyst of its nominal RT60, and
 * otherwise until another IR is nearer by more than a factor (1 + hyst) in log distance (a +-7 % dead band around
 * each switching point, so a probe hovering between two IRs does not keep crossfading). */
export function pickIR(rt60: number, current: number, hyst = 0.15): number {
  if (current >= 0 && current < IR_RT60.length) {
    const nom = IR_RT60[current];
    if (rt60 >= nom * (1 - hyst) && rt60 <= nom * (1 + hyst)) return current;
  }
  let best = 0, bd = Infinity;
  const lr = Math.log(Math.max(1e-3, rt60));
  for (let i = 0; i < IR_RT60.length; i++) {
    const d = Math.abs(Math.log(IR_RT60[i]) - lr);
    if (d < bd) { bd = d; best = i; }
  }
  if (current >= 0 && current < IR_RT60.length && best !== current) {
    // switch only when the new choice is clearly better (outside the band AND nearer in log space)
    const dc = Math.abs(Math.log(IR_RT60[current]) - lr);
    if (dc - bd < Math.log(1 + hyst)) return current;
  }
  return best;
}

/** Reverb pre-delay from the mean free path, clamped to 5-60 ms. */
export const preDelayOf = (mfp: number): number => Math.min(0.06, Math.max(0.005, mfp / 343));

/** Wet level from reverberance and openness (enclosed long rooms are wettest; wide-open spaces leak energy). */
export function wetOf(rt60: number, openness: number): number {
  const base = 0.16 + 0.11 * Math.log2(Math.max(0.3, rt60) / 0.3);
  return Math.min(0.62, Math.max(0.12, base)) * (1 - 0.3 * Math.min(1, Math.max(0, openness)));
}
