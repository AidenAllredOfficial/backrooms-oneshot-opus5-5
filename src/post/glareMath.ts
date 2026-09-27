// src/post/glareMath.ts (package C.1 / C.5) — pure maths of the camera lens glare, shared by GlareEffect and the tests.
// No three, no DOM.
//
// A real (cheap) lens scatters a fixed fraction k of ALL incoming light with a point-spread function that has a narrow
// core (axial CA, softness) and a power-law tail (veiling glare): out = (1 - k) I + k (PSF * I). Energy moves, it is
// not added, so a dark corner far from any light keeps its black while a troffer 7-8 EV over mid grey grows a halo.
// The PSF is defined in ANGLE (radians off-axis), so the glow has the same angular size at every preset, buffer size
// and dynamic-resolution scale:
//   EE(theta) = CORE_FRAC (1 - exp(-theta^2 / (2 THETA_CORE^2)))                      (Gaussian core)
//             + (1 - CORE_FRAC) (1 - (1 + (ALPHA - 1) u) (1 + u)^(1 - ALPHA)),  u = theta / THETA_0
// the encircled energy (normalised CDF) of p(theta) ~ (1 + theta / THETA_0)^-ALPHA per unit solid angle plus the core.
// GlareChain approximates it with a mip pyramid: chain level i blurs with a Gaussian of sigma SIGMA0_PX * 2^i full-res
// pixels (a CPU model of the 13-tap down + tent up chain gives 1.6, 3.8, 7.9, 16.0, 32.0 ... px), so level i carries
// the PSF energy of the angular band around theta_i = SIGMA0_PX * 2^i * (2 tan(fov / 2) / heightPx).
//
// C.5 aperture flare: a consumer camcorder's 2-blade diamond iris diffracts overexposed points into a 4-point 'X'
// (two streak axes at +-45 deg, wavelength-scaled so the tips are rainbow), and the zoom lens throws faint tinted
// ghost copies mirrored through the frame centre. Both only see energy above STAR_T exposed units.

/** Glare PSF constants (see the header). Tints are Rec.709-luma normalised when used. */
export const GLARE = {
  /** scatter fraction per unit atmosphere bloomIntensity (LOBBY 0.5 -> 10 %, PARKING 0.3 -> 6 %, POOL 0.6 -> 12 %) */
  K: 0.2,
  CORE_FRAC: 0.35,
  THETA_CORE: 0.0025, // rad (0.14 deg)
  THETA_0: 0.004, // rad
  ALPHA: 2.6,
  /** effective Gaussian sigma of chain level 0 in full-res px (calibrated by harness/post.html?scene=psf) */
  SIGMA0_PX: 2.0,
  /** violet axial-CA fringe hugging the source (camcorder 'purple fringing') */
  TINT_NEAR: [0.93, 0.9, 1.35] as readonly [number, number, number],
  /** the warm consumer-lens veil further out */
  TINT_FAR: [1.0, 0.9, 0.76] as readonly [number, number, number],
  /** the tint moves from NEAR to FAR between these angles (log-spaced), independent of the level count */
  TINT_THETA: [0.003, 0.08] as readonly [number, number],
  /** per-tap clamp of the prefilter in EXPOSED units (kills HDR_CLAMP specular fireflies; nits = this / exposure) */
  MAX_EXPOSED: 256,
  /** recompute the level weights only when the FOV changes by more than this (sprint FOV kick) */
  FOV_EPS_DEG: 0.1,
} as const;

/** Aperture star + ghost constants (C.5). Gains multiply Settings.film.flare and the lens toggle. */
export const FLARE = {
  /** buffers taller than this (ultra's 1.5x supersampled one) run the star one chain level coarser, so its arms keep
   * their on-screen width and its cost stays flat */
  HI_RES_H: 1500,
  /** only exposed luminance above this feeds the star and the ghosts: 'truly hot' sources (a bare bulb in PIPEWORKS
   * ~400, a highbay ~600, a troffer seen from a dark corridor ~60), while a lit Level 0 room's troffers (~35) give a
   * barely visible diagonal smear */
  STAR_T: 12,
  /** the two streak axes (deg from horizontal): a diamond iris gives an 'X' */
  STAR_ANGLES: [45, -45] as readonly number[],
  /** texel steps (in D1 texels) of the three cascaded 7-tap streak passes */
  STAR_STEPS: [1, 4, 16] as readonly number[],
  /** per-texel decay of the streak kernel: w_j = OMEGA^(|j| * step) */
  OMEGA: 0.93,
  /** the last pass samples R and B at scaled offsets: diffraction length grows with wavelength (rainbow tips) */
  STAR_CHROMA: [1.08, 0.92] as readonly [number, number],
  /** 0.004 (the design value): at 0.006 an extended hot source near the camera (a PARKING tube strip in the frame
   * corner, a near highbay) threw a broad X over a quarter of the frame that read as a stain on the ceiling */
  STAR_GAIN: 0.004,
  GHOST_GAIN: 0.001,
  /** ghost sampling scales about the frame centre: the ghost of a source at uv lands at .5 + (uv - .5) / s (negative =
   * mirrored through the centre; |s| < 1 magnified, |s| > 1 shrunk) */
  GHOST_SCALES: [-0.62, -1.35, 0.42, -0.28, 1.8] as readonly number[],
  /** coating tints (muted): green, amber, violet, cyan, warm */
  GHOST_TINTS: [
    [0.55, 1.0, 0.65], [1.0, 0.7, 0.45], [0.75, 0.65, 1.0], [0.6, 0.85, 1.0], [1.0, 0.85, 0.7],
  ] as readonly (readonly [number, number, number])[],
  /** lateral colour of a ghost: R / B sampled at scale * (1 +- GHOST_CA) */
  GHOST_CA: 0.008,
} as const;

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** rgb / Rec.709 luma(rgb). */
export function lumaNorm(c: readonly number[]): [number, number, number] {
  const l = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** Encircled energy of the glare PSF within theta (rad), 0 at 0 and -> 1 at infinity. */
export function glareEE(theta: number): number {
  if (!(theta > 0)) return 0;
  if (!Number.isFinite(theta)) return 1;
  const G = GLARE;
  const core = 1 - Math.exp(-(theta * theta) / (2 * G.THETA_CORE * G.THETA_CORE));
  const u = theta / G.THETA_0;
  const tail = 1 - (1 + (G.ALPHA - 1) * u) * (1 + u) ** (1 - G.ALPHA);
  return G.CORE_FRAC * core + (1 - G.CORE_FRAC) * tail;
}

/** dEE/dtheta: the radial energy density (for numeric checks of the closed form). */
export function glareRadialDensity(theta: number): number {
  const G = GLARE;
  const t = Math.max(0, theta);
  const core = (t / (G.THETA_CORE * G.THETA_CORE)) * Math.exp(-(t * t) / (2 * G.THETA_CORE * G.THETA_CORE));
  const u = t / G.THETA_0;
  // d/du [1 - (1 + (a-1)u)(1+u)^(1-a)] = (a-1)(a-2) u (1+u)^-a
  const tail = ((G.ALPHA - 1) * (G.ALPHA - 2) * u * (1 + u) ** -G.ALPHA) / G.THETA_0;
  return G.CORE_FRAC * core + (1 - G.CORE_FRAC) * tail;
}

/** Characteristic angle (rad) of chain level i: its Gaussian sigma projected through the lens. */
export function glareLevelTheta(i: number, tanHalfFov: number, heightPx: number): number {
  return (GLARE.SIGMA0_PX * 2 ** i * 2 * tanHalfFov) / Math.max(1, heightPx);
}

/**
 * Per-level tinted weights of the chain: out[3i..3i+2] = w_i * tint_i with w_i = EE(b_i) - EE(b_(i-1)),
 * b_i = theta_i * sqrt2 (b_-1 = 0, b_(L-1) = infinity), so the weights sum to 1 in luma. The tint moves from TINT_NEAR
 * to TINT_FAR with the band's (log) angle, so it does not depend on the level count or the buffer height either.
 */
export function glareWeights(tanHalfFov: number, heightPx: number, levels: number, out?: Float32Array): Float32Array {
  const L = Math.max(1, Math.floor(levels));
  const o = out ?? new Float32Array(3 * L);
  const near = lumaNorm(GLARE.TINT_NEAR);
  const far = lumaNorm(GLARE.TINT_FAR);
  const [ta, tb] = GLARE.TINT_THETA;
  let prev = 0;
  for (let i = 0; i < L; i++) {
    const th = glareLevelTheta(i, tanHalfFov, heightPx);
    const b = i === L - 1 ? Infinity : th * Math.SQRT2;
    const ee = glareEE(b);
    const w = ee - prev;
    prev = ee;
    const s = Math.min(1, Math.max(0, Math.log(th / ta) / Math.log(tb / ta)));
    const t = s * s * (3 - 2 * s);
    // mix in rgb, then re-normalise to unit luma (a mix of two unit-luma tints already has unit luma)
    for (let c = 0; c < 3; c++) o[3 * i + c] = w * (near[c] + (far[c] - near[c]) * t);
  }
  return o;
}

/** Normalised 7-tap streak kernel for one cascaded pass: w_j ~ OMEGA^(|j| * step), j = -3..3. */
export function streakWeights(step: number): number[] {
  const w: number[] = [];
  let s = 0;
  for (let j = -3; j <= 3; j++) {
    const v = FLARE.OMEGA ** (Math.abs(j) * step);
    w.push(v);
    s += v;
  }
  return w.map((v) => v / s);
}

/** Where ghost j of a source at uv lands: .5 + (uv - .5) / s_j. The GPU pass samples the source at .5 + (out - .5) * s_j
 * for every output texel (the inverse map), so |s| < 1 is a magnified ghost and |s| > 1 a shrunk one. */
export function ghostUv(uv: readonly [number, number], scale: number): [number, number] {
  return [0.5 + (uv[0] - 0.5) / scale, 0.5 + (uv[1] - 0.5) / scale];
}

/** Hot (overexposed) fraction the star / ghosts extract from a texel of exposed luma y*e. */
export function flareHotFraction(exposedLuma: number): number {
  return Math.max(0, exposedLuma - FLARE.STAR_T) / Math.max(exposedLuma, 1e-4);
}
