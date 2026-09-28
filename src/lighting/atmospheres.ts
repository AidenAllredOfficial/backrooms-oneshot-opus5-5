// src/lighting/atmospheres.ts — per-zone atmosphere table and per-mood modifiers (WP11).
// Values follow the DESIGN §5.WP11 "Initial atmosphere table"; they are the calibration knobs of the photometric
// chain (haze, exposure clamps, bloom, AO, grain, grade). EV ranges are CLAMPS: dark sectors must stay dark.
// Grades are applied by post/effects/ColorGradeEffect in sRGB-encoded space after AgX:
//   temperature/tint: white-balance shift (+temperature = warmer, +tint = magenta, -tint = green)
//   lift/gamma/gain:  per channel, c' = pow(gain * (c + lift * (1 - c)), 1 / gamma)  (gamma > 1 brightens mids)
//   shadowTint/highlightTint: split-tone multipliers weighted by luma (fading to neutral near white); saturation;
//   contrast about 0.5; pedestal: black level added after the contrast curve.

import { LandmarkKind, Zone, ZONE_COUNT } from '../core/ids.ts';
import type { AtmosphereParams, ColorGrade } from '../core/runtime.ts';

const AO_COLOR: [number, number, number] = [0.12, 0.09, 0.04]; // warm dark, all zones (linear)

const grade = (g: Partial<ColorGrade>): ColorGrade => ({
  temperature: 0, tint: 0, saturation: 1, contrast: 1,
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  shadowTint: [1, 1, 1], highlightTint: [1, 1, 1], pedestal: 0,
  ...g,
});

// R2-post: every grade has gain = [1, 1, 1] and (almost) neutral highlights so the troffer cores and other emitters
// clip to pure white like a consumer sensor (the shader also fades the split-tone to neutral above y 0.85 and
// bleaches channels toward white near clip). Colour casts live in gamma (midtones) and shadowTint instead.
// `pedestal` is the sensor black level (sRGB-encoded) added after the contrast curve: no pure #000 anywhere.
// Package C.7 retune (C.7b, with every realism package merged: energy-conserving glare, froxel haze, SSR / probe,
// pre-shade SSAO, luminaire profiles, water, torch + bounce). No halation veil and a filmic `toe` (ColorGradeEffect):
// lift is (almost) gone, the pedestal sits at 0.02-0.03 and a luma S-curve of 1.15-1.46 takes the deep reveals toward
// black while the mids stay bright and the famous yellow keeps its saturation. Measured p5 / p50 (imageStats of the
// zone= spawn views, ultra 1920x1080, seed 7, time 10, grain off; before -> after C.7b):
//   LOBBY .26/.47 -> .24/.52 (clipped .03, hue 43, sat .53)   MANILA .29/.46 -> .24/.44 (hue 54 -> 49)
//   MAZE .26/.50 -> .24/.53   LOW_EXPANSE (SPARSE) .30/.43 -> .25/.45   PILLAR_HALL .31/.44 -> .27/.44
//   OFFICE .24/.41 -> .22/.43   POOLROOMS .37/.55 -> .33/.54   PARKING .17/.35 -> .17/.36
//   WAREHOUSE .17/.33 -> .12/.31 (the haze no longer greys the dark roof)   PIPEWORKS / CONCRETE / DARK unchanged

/** Level 0 look (LOBBY; LOW_EXPANSE via GRADE_EXPANSE): sickly fluorescent yellow, over-exposed (+1.35 EV bias): the green-yellow push
 * lives in gamma (G up, B down) and shadowTint; white clips to white. */
const GRADE_L0 = grade({
  temperature: 0.0, tint: -0.04, saturation: 1.06, contrast: 1.38,
  lift: [0, 0, 0], gamma: [1.0, 1.08, 0.86], gain: [1, 1, 1],
  shadowTint: [0.97, 1.0, 0.9], highlightTint: [1, 1, 1], pedestal: 0.02, toe: 0.6,
});
/** LOW_EXPANSE: the L0 look with a steeper curve: the open, evenly lit hall has no deep reveals, so its darkest pixels
 * are lamp-lit carpet far across the floor (p5 ~0.3 at the L0 contrast) */
const GRADE_EXPANSE = grade({ ...GRADE_L0, contrast: 1.46, toe: 0.65 });
/** MAZE: the same office fluorescents seen by a slightly warmer, dimmer camera (narrow halls, older tubes). */
const GRADE_MAZE = grade({
  temperature: 0.0, tint: -0.04, saturation: 0.97, contrast: 1.3,
  lift: [0.004, 0.0035, 0.002], gamma: [0.98, 1.06, 0.88], gain: [1, 1, 1],
  shadowTint: [0.98, 0.99, 0.88], highlightTint: [1, 1, 1], pedestal: 0.025, toe: 0.6,
});
const GRADE_MANILA = grade({
  // manila = pale sickly tan-green, desaturated; inside the §8.2 Level 0 hue band [38, 65] deg (C.7b: less green,
  // hue 54 -> ~48, so the walls read as manila paper rather than grey-green)
  temperature: -0.02, tint: -0.06, saturation: 0.88, contrast: 1.32,
  lift: [0.006, 0.007, 0.005], gamma: [0.97, 1.08, 0.92], gain: [1, 1, 1],
  shadowTint: [0.95, 1.0, 0.93], highlightTint: [1, 1, 1], pedestal: 0.025, toe: 0.55,
});
const GRADE_DARK = grade({
  temperature: 0.03, tint: -0.05, saturation: 0.9, contrast: 1.15,
  lift: [0.005, 0.006, 0.004], gamma: [0.99, 1.02, 0.92], gain: [1, 1, 1],
  shadowTint: [0.92, 1.0, 0.92], highlightTint: [1.02, 1.0, 0.96], pedestal: 0.028, toe: 0.55,
});
const GRADE_OFFICE = grade({
  temperature: -0.03, tint: -0.03, saturation: 0.96, contrast: 1.3,
  lift: [0.004, 0.005, 0.006], gamma: [0.98, 1.01, 1.0], gain: [1, 1, 1],
  shadowTint: [0.95, 1.0, 0.98], highlightTint: [1, 1, 1], pedestal: 0.025, toe: 0.6,
});
/** Poolrooms: neutral white tile under soft daylight; the water supplies the turquoise (saturation 1.06 keeps it). */
const GRADE_POOL = grade({
  temperature: 0, tint: -0.02, saturation: 1.06, contrast: 1.25,
  lift: [0.006, 0.007, 0.008], gamma: [1.0, 1.01, 1.01], gain: [1, 1, 1],
  shadowTint: [0.98, 1.0, 1.0], highlightTint: [1, 1, 1], pedestal: 0.02, toe: 0.5,
});
const GRADE_INDUSTRIAL = grade({
  temperature: 0.02, tint: -0.04, saturation: 0.88, contrast: 1.2,
  lift: [0.006, 0.007, 0.006], gamma: [1.0, 1.01, 0.94], gain: [1, 1, 1],
  shadowTint: [0.93, 1.0, 0.95], highlightTint: [1.02, 1.0, 0.95], pedestal: 0.028, toe: 0.5,
});
const GRADE_PARKING = grade({
  temperature: 0.04, tint: -0.06, saturation: 0.9, contrast: 1.22,
  lift: [0.006, 0.007, 0.005], gamma: [1.0, 1.02, 0.93], gain: [1, 1, 1],
  shadowTint: [0.9, 1.0, 0.94], highlightTint: [1.03, 1.0, 0.94], pedestal: 0.028, toe: 0.55,
});

interface Row {
  haze: number; tint: [number, number, number]; albedo: number; ev: [number, number]; bias: number;
  bloom: number; ao: number; grain: number; grade: ColorGrade;
}
const row = (r: Row): AtmosphereParams => ({
  hazeDensity: r.haze,
  hazeTint: [...r.tint] as [number, number, number],
  hazeAlbedo: r.albedo,
  ev100Range: [...r.ev] as [number, number],
  exposureBias: r.bias,
  bloomIntensity: r.bloom,
  aoIntensity: r.ao,
  aoColor: [...AO_COLOR] as [number, number, number],
  grain: r.grain,
  grade: { ...r.grade, pedestal: r.grade.pedestal ?? 0, lift: [...r.grade.lift], gamma: [...r.grade.gamma], gain: [...r.grade.gain], shadowTint: [...r.grade.shadowTint], highlightTint: [...r.grade.highlightTint] } as ColorGrade,
});

const L0_TINT: [number, number, number] = [1.0, 0.93, 0.75];
// deep zones: EV floor 5 (table: 5.5). Their bare-bulb / sodium lighting meters around EV 5-5.5, so a 5.5 floor left
// every lit deep-zone view clamped and under-exposed (meanLum 0.08-0.11); DARK mood still floors at 5.5 (MOOD_MODS).
const DEEP_TINT: [number, number, number] = [1.0, 0.97, 0.9];

function buildAtmospheres(): Record<number, AtmosphereParams> {
  const t: Record<number, AtmosphereParams> = {};
  // R2-post: the cheap camera over-exposes the famous yellow rooms by about a stop (bias +1 EV: p50 ~130/255 like
  // the Level 0 photo). Non-DARK Level 0 zones floor at EV 4 (was 6.5-7): an unlit pocket in a NORMAL district is a
  // camcorder at max gain (noisy grey-brown murk), not #000. DARK mood/zone keep their 5.5 floor via MOOD_MODS.
  t[Zone.LOBBY] = row({ haze: 0.004, tint: L0_TINT, albedo: 0.5, ev: [4, 11], bias: 1.35, bloom: 0.5, ao: 3.0, grain: 0.8, grade: GRADE_L0 });
  t[Zone.MANILA] = row({ haze: 0.005, tint: [1.0, 0.95, 0.82], albedo: 0.5, ev: [4, 11], bias: 1.0, bloom: 0.5, ao: 3.0, grain: 0.8, grade: GRADE_MANILA });
  // DARK zone = the L0 base with its own grade; the zone forces mood DARK, whose MOOD_MODS/MOOD_EXTRA give the
  // table's "DARK (mood)" row: haze x1.5, tint x0.8, EV [5.5, 10], bloom 0.6, grain 0.8.
  t[Zone.DARK] = row({ haze: 0.006, tint: L0_TINT, albedo: 0.5, ev: [6.5, 11], bias: 0, bloom: 0.5, ao: 3.0, grain: 0.8, grade: GRADE_DARK });
  t[Zone.MAZE] = row({ haze: 0.005, tint: L0_TINT, albedo: 0.5, ev: [4, 11], bias: 1.2, bloom: 0.5, ao: 3.0, grain: 0.8, grade: GRADE_MAZE });
  t[Zone.LOW_EXPANSE] = row({ haze: 0.006, tint: [1.0, 0.95, 0.8], albedo: 0.5, ev: [4, 11], bias: 1.2, bloom: 0.5, ao: 2.7, grain: 0.8, grade: GRADE_EXPANSE });
  t[Zone.PILLAR_HALL] = row({ haze: 0.006, tint: [0.95, 0.95, 0.9], albedo: 0.5, ev: [4, 11.5], bias: 0.8, bloom: 0.45, ao: 2.7, grain: 0.7, grade: GRADE_MANILA });
  t[Zone.OFFICE] = row({ haze: 0.004, tint: [0.9, 0.95, 1.0], albedo: 0.5, ev: [4, 11], bias: 0.8, bloom: 0.4, ao: 3.0, grain: 0.65, grade: GRADE_OFFICE });
  // Poolrooms: bright soft daylight-like white tile (bias +1.6 EV, range up to 13.5 for the sunlit halls)
  t[Zone.POOLROOMS] = row({ haze: 0.008, tint: [0.95, 1.0, 1.0], albedo: 0.6, ev: [8, 13.5], bias: 1.6, bloom: 0.6, ao: 1.5, grain: 0.45, grade: GRADE_POOL });
  // Deep zones (polish): real underground parking / service areas have only a slight haze (far pillars readable at
  // 30-40 m with mild aerial fading). These zones meter at EV 4-5, where the sensor gain already sits at its cap
  // (PostStack GRAIN_GAIN_MAX), so a base grain of 0.8 plus the wide bloom veil over the lit concrete read as smoke.
  t[Zone.PARKING] = row({ haze: 0.004, tint: DEEP_TINT, albedo: 0.5, ev: [5, 11], bias: 0.15, bloom: 0.3, ao: 2.2, grain: 0.5, grade: GRADE_PARKING });
  // PIPEWORKS: EV floor 4. Its 64 cd cage bulbs (zoneMul 0.7) light the tunnels to ~10-40 lux, which meters below EV 5:
  // at a 5 floor every lit PIPEWORKS view was clamped (meanLum ~0.09). DARK mood still floors at 5.5 (MOOD_MODS).
  t[Zone.PIPEWORKS] = row({ haze: 0.008, tint: DEEP_TINT, albedo: 0.6, ev: [4, 11], bias: 0.15, bloom: 0.45, ao: 2.2, grain: 0.6, grade: GRADE_INDUSTRIAL });
  t[Zone.WAREHOUSE] = row({ haze: 0.003, tint: DEEP_TINT, albedo: 0.5, ev: [5, 11], bias: 0.2, bloom: 0.4, ao: 2.2, grain: 0.6, grade: GRADE_INDUSTRIAL });
  t[Zone.CONCRETE] = row({ haze: 0.004, tint: DEEP_TINT, albedo: 0.5, ev: [5, 11], bias: 0.25, bloom: 0.45, ao: 2.2, grain: 0.6, grade: GRADE_INDUSTRIAL });
  for (let z = 0; z < ZONE_COUNT; z++) if (!t[z]) throw new Error(`ATMOSPHERES: zone ${z} missing`);
  for (let z = 0; z < ZONE_COUNT; z++) Object.assign(t[z], VOL_ROWS[z]);
  return t;
}

/** Package F: the living air of each zone (froxel volumetrics and dust motes, high / ultra). dustDensity (1/m) of
 * drifting dust and dustNoise (0..1) its patchiness; mistDensity (1/m at the surface) over pool / flooded water;
 * hazePhase the forward-lobe weight of the dual HG (lighting/phase.ts; absent = 0.7); moteDensity the visible
 * fraction of the dust motes (<= 0.35 in lit zones, or the air reads as snow). */
type VolRow = Pick<AtmosphereParams, 'dustDensity' | 'dustNoise' | 'mistDensity' | 'hazePhase' | 'moteDensity'>;
const vol = (dustDensity: number, dustNoise: number, mistDensity: number, moteDensity: number, hazePhase?: number): VolRow =>
  hazePhase === undefined ? { dustDensity, dustNoise, mistDensity, moteDensity } : { dustDensity, dustNoise, mistDensity, moteDensity, hazePhase };
const VOL_ROWS: Readonly<Record<number, VolRow>> = {
  [Zone.LOBBY]: vol(0.0012, 0.5, 0, 0.2),
  [Zone.MANILA]: vol(0.0015, 0.5, 0, 0.2),
  [Zone.DARK]: vol(0.007, 0.6, 0, 1.0),
  [Zone.MAZE]: vol(0.0015, 0.5, 0, 0.2),
  [Zone.LOW_EXPANSE]: vol(0.002, 0.5, 0.006, 0.25),
  [Zone.PILLAR_HALL]: vol(0.002, 0.4, 0.012, 0.25),
  [Zone.OFFICE]: vol(0.0015, 0.4, 0, 0.15),
  // warm water under soft light: the mist carries the air; droplets scatter forward
  [Zone.POOLROOMS]: vol(0, 0.3, 0.08, 0.1, 0.85),
  [Zone.PARKING]: vol(0.002, 0.5, 0, 0.5),
  [Zone.PIPEWORKS]: vol(0.006, 0.6, 0.02, 1.0),
  [Zone.WAREHOUSE]: vol(0.002, 0.5, 0, 0.7),
  [Zone.CONCRETE]: vol(0.003, 0.5, 0, 0.7),
};

/** By ZoneId. */
export const ATMOSPHERES: Readonly<Record<number, AtmosphereParams>> = buildAtmospheres();

/** By MoodId (NORMAL, SPARSE, DYING, DARK). Applied by lighting/atmosphereBlend.ts:
 *   ev100Range' = [max(lo + evShift, evMin), hi + evShift]  (evMin is a floor: dark moods never auto-brighten below it)
 *   hazeDensity' = hazeDensity * hazeMul;  hazeTint' = hazeTint * tintMul. */
export const MOOD_MODS: readonly { evShift: number; evMin: number; hazeMul: number; tintMul: [number, number, number] }[] = [
  /* NORMAL */ { evShift: 0, evMin: 0, hazeMul: 1, tintMul: [1, 1, 1] },
  /* SPARSE */ { evShift: -0.4, evMin: 6, hazeMul: 1.1, tintMul: [0.95, 0.95, 0.95] },
  /* DYING  */ { evShift: -0.5, evMin: 5.8, hazeMul: 1.25, tintMul: [0.95, 1.0, 0.86] },
  /* DARK   */ { evShift: -1, evMin: 5.5, hazeMul: 1.5, tintMul: [0.8, 0.8, 0.8] },
];

/** Exposure floor (EV100) while the eye stands inside a landmark's footprint (LightingRuntime). For authored
 * saturated-colour rooms: auto exposure meters luma, where deep red counts ~0.21, so without a floor it opens up to the
 * zone's EV 4 until the red channel clips and the highlight knee turns the room pastel pink. The floor keeps the
 * RED_ROOM a dim, deep red (DESIGN landmark table: 3 x 200 cd red bulbs, ~20 lux). */
export const LANDMARK_EV_MIN: Readonly<Partial<Record<number, number>>> = { [LandmarkKind.RED_ROOM]: 6.5 };

/** Torch exposure (C.7b). With the flashlight on, the camcorder meters the beam (LightingRuntime FLASH_METER_FOCUS)
 * and may open up DROP EV below the zone x mood floor, never below MIN (the lit zones' own max-gain floor): in a DARK
 * sector the hotspot and its bounce read as the lit subject of the frame while the unlit rest stays black. Applied
 * before LANDMARK_EV_MIN. */
export const TORCH_EV: { readonly DROP: number; readonly MIN: number } = { DROP: 0.5, MIN: 4 };

/** Extra per-mood modifiers not carried by the MOOD_MODS contract type (bloom and grain, DESIGN table "DARK (mood)"). */
export const MOOD_EXTRA: readonly { bloomMul: number; grainMul: number; saturationMul: number; biasMul: number; dustMul: number }[] = [
  // R2-post: grain multipliers reduced (1.2/1.35/1.6 -> 1.1/1.2/1.25): the post stack's low-light sensor gain
  // already makes dim footage noisier, and base grain rose 0.5 -> 0.8. biasMul scales the zone's exposureBias:
  // the +1 EV "over-exposed camcorder" look belongs to the lit rooms; a DARK sector must not be lifted by it.
  // dustMul (package F): neglected sectors hold more dust (x the zone's dustDensity, capped at VD.DUST_MAX)
  /* NORMAL */ { bloomMul: 1, grainMul: 1, saturationMul: 1, biasMul: 1, dustMul: 1 },
  /* SPARSE */ { bloomMul: 1.05, grainMul: 1.1, saturationMul: 0.97, biasMul: 0.85, dustMul: 1.2 },
  /* DYING  */ { bloomMul: 1.1, grainMul: 1.2, saturationMul: 0.93, biasMul: 0.7, dustMul: 1.6 },
  /* DARK   */ { bloomMul: 1.2, grainMul: 1.25, saturationMul: 0.9, biasMul: 0.35, dustMul: 1.9 },
];

