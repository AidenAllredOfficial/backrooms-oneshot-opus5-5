// src/textures/layers/wallpaper.ts — wall coverings: WALLPAPER_L0, WALLPAPER_MANILA, DRYWALL, TRIM_PAINT (WP8).

import { Mat } from '../../core/ids.ts';
import type { RecipeTable } from './types.ts';

/** Level 0 wallpaper: mustard vinyl-coated paper in two 0.6 m rolls (+-2 % shade offset). Print: vertical stripe
 * system on a 0.15 m pitch (a slightly darker ink band carrying a column of stacked up-pointing chevrons, flanked by
 * pinlines) and, in the light band between, a faint damask fleur on a 0.3 m diamond lattice (+-4 % value, 0.2 mm
 * emboss, ink a touch glossier than the paper). Paper: satin vinyl coat (roughness ~0.7), fine vertical strie,
 * supersampled 1 mm fibre, cloudy formation, a slight cockle (~0.25 mm over 7 cm, seen only in grazing sheen);
 * vertical roll-seam ridge. Lifted edges, fading and stains come from the WP7 mask. */
const WALLPAPER_L0 = /* glsl */ `
#define SS 4
// damask fleur, q in metres from the motif centre (+y up); returns ink coverage 0..1
float wpFleur(vec2 q) {
  vec2 a = vec2(abs(q.x), q.y);
  // central petal: pointed teardrop
  float petal = sdEllipse(q - vec2(0.0, 0.006), vec2(0.0055, 0.019));
  petal = max(petal, -sdCircle(a - vec2(0.0125, 0.016), 0.009)); // pinched tip
  // curled side petals, mirrored
  float side = sdEllipse(rot2(a - vec2(0.0125, 0.0), -0.75), vec2(0.0042, 0.0135));
  float curl = abs(sdCircle(a - vec2(0.021, 0.011), 0.0045)) - 0.0012;
  // collar and tail
  float collar = sdRoundBox(q - vec2(0.0, -0.0105), vec2(0.0115, 0.0016), 0.001);
  float tail = sdEllipse(rot2(a - vec2(0.0045, -0.02), 0.5), vec2(0.0022, 0.007));
  float crown = sdCircle(q - vec2(0.0, 0.0305), 0.0022);
  float d = min(min(min(petal, side), min(curl, collar)), min(tail, crown));
  // outline ring (engraved look): solid fill slightly weaker than the contour
  float fill = fillM(d);
  float edge = lineM(d, 0.00055);
  // faint lozenge frame around the fleur
  float rh = (a.x * 0.052 + abs(q.y) * 0.034 - 0.052 * 0.034) / length(vec2(0.052, 0.034));
  float frame = 0.55 * lineM(rh, 0.0005);
  return max(max(0.85 * fill, edge), frame);
}
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  // rolls (0.6 m): per-roll shade and pattern offset come from WP9 (world-anchored hash); hairline seam here
  float dSeam = distLines(m.x, 0.6);
  // stripe system, pitch 0.15 m: dark ink band centred on x = 0.075 + k 0.15
  float xs = m.x - (floor(m.x / 0.15) + 0.5) * 0.15;
  float ax = abs(xs);
  float band = fillM(ax - 0.021);
  float pins = lineM(ax - 0.0275, 0.0012) + 0.6 * lineM(ax - 0.0325, 0.0008);
  // chevrons, 30 mm pitch, pointing +v, 2.4 mm stroke, 24 mm wide
  float cy = m.y - (floor(m.y / 0.03) + 0.5) * 0.03;
  float chev = lineM(sdSeg(vec2(ax, cy), vec2(0.0, 0.0055), vec2(0.0115, -0.0055)), 0.0018);
  chev *= band;
  // fleur on the light band (x = k 0.15), diamond lattice: odd columns offset by 0.15 m
  float col = floor(m.x / 0.15 + 0.5);
  float yOff = mod(col, 2.0) * 0.15;
  vec2 q = vec2(m.x - col * 0.15, m.y - yOff - (floor((m.y - yOff) / 0.3) + 0.5) * 0.3);
  float fleur = wpFleur(q);
  // small dot between fleurs (half-drop)
  vec2 qd = vec2(q.x, abs(q.y) - 0.15);
  float dotI = fillM(sdCircle(qd, 0.0022));
  float ink = sat(max(max(chev, fleur), max(pins * 0.8, dotI)));
  // paper structure
  float fibre = fbm(uv, PM(420.0), 3, 11);            // ~1-2 mm fibre (supersampled)
  float strie = gnoise(uv, PMxy(380.0, 3.0), 14) * 0.6
              + gnoise(uv, PMxy(760.0, 5.0), 15) * 0.4; // vertical strie (gnoise is band limited)
  float formation = fbm(uv, PM(24.0), 3, 13);         // cloudy sheet formation
  float age = fbm(uv, PM(2.5), 3, 16);                // broad ageing
  float bandTone = 0.5 + 0.5 * cos(6.2831853 * xs / 0.15); // 1 at the ink band centre
  vec3 c = TABLE_ALBEDO;
  c *= 1.0 + 0.012 * fibre + 0.016 * strie + 0.02 * formation;
  // ground print: the band is a slightly deeper mustard, the gap between a paler cream-yellow
  c *= mix(vec3(1.035, 1.03, 1.05), vec3(0.93, 0.915, 0.85), band * 0.85 + 0.15 * bandTone);
  // ageing: slightly browner, deeper patches
  c *= mix(vec3(1.0), vec3(0.965, 0.95, 0.9), sat(age * 1.6));
  // ink: about -15 % value, browner (more saturated): the print must read at room distance
  c *= mix(vec3(1.0), vec3(0.86, 0.83, 0.72), ink);
  // roll seam: hairline gap, dirt line, glue sheen
  float gap = lineM(dSeam, 0.00025);
  float seamDirt = gauss(dSeam / 0.004);
  c *= 1.0 - 0.3 * gap - 0.04 * seamDirt;
  s.albedo = c;
  s.height = 0.45 + 0.25 * ink + 0.05 * fibre + 0.035 * strie + 0.28 * gauss(dSeam / 0.0018) - 0.2 * gap
           + 0.3 * fbm(uv, PM(7.0), 2, 17);
  s.rough = 0.70 - 0.07 * ink - 0.06 * gauss(dSeam / 0.006) + 0.015 * fibre + 0.01 * strie;
}
`;

/** Manila: beige paper-backed vinyl (satin, ~0.72) with a linen emboss, a slight cockle and vertical double
 * pinstripes at 0.15 m pitch. */
const WALLPAPER_MANILA = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  // linen weave emboss: threads at 1.6 mm (750 per 1.2 m) with slubs
  float tx = 0.5 + 0.5 * cos(6.2831853 * uv.x * 750.0);
  float ty = 0.5 + 0.5 * cos(6.2831853 * uv.y * 750.0);
  float slubX = vnoise(uv, ivec2(750, 24), 3);
  float slubY = vnoise(uv, ivec2(24, 750), 4);
  float linen = 0.5 * (tx * (0.6 + 0.8 * slubX) + ty * (0.6 + 0.8 * slubY));
  linen = mix(0.5, linen, bandLimitPx(750.0)); // 1.6 mm threads exceed the texel Nyquist limit: keep only the mean
  // pinstripes: two dark lines 4 mm apart with a light hairline between, every 0.15 m
  float d = distLines(m.x, 0.15);
  float dark = lineM(d - 0.0022, 0.0012);
  float light = lineM(d, 0.00035);
  float ground = gauss(d / 0.012);
  float gband = fillM(d - 0.005); // 10 mm lighter ground band carrying the pinstripes
  // paper and ageing
  float formation = fbm(uv, PM(25.0), 3, 5);
  float age = fbm(uv, PM(2.5), 3, 6);
  float dSeam = distLines(m.x, 0.6);
  vec3 c = TABLE_ALBEDO;
  c *= 1.0 + 0.02 * formation + 0.03 * (linen - 0.5);
  c *= mix(vec3(1.0), vec3(0.975, 0.965, 0.935), sat(age * 1.5));
  c *= 1.0 - 0.025 * ground + 0.04 * gband;
  c = mix(c, c * vec3(0.74, 0.7, 0.64), dark);
  c = mix(c, c * 1.07, light);
  float gap = lineM(dSeam, 0.0002);
  c *= 1.0 - 0.3 * gap - 0.03 * gauss(dSeam / 0.003);
  s.albedo = c;
  s.height = 0.45 + 0.18 * linen + 0.05 * (dark + light) + 0.25 * gauss(dSeam / 0.0015) - 0.2 * gap
           + 0.3 * fbm(uv, PM(7.0), 2, 17);
  s.rough = 0.72 + 0.03 * (linen - 0.5) - 0.04 * (dark + light);
}
`;

/** Painted drywall: roller stipple (orange-peel nap), eggshell sheen, flatter "flashing" bands over taped joints. */
const DRYWALL = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  Cell c = worley(uv, PM(150.0), 1.0, 3);
  float blob = 1.0 - smoothstep(0.05, 0.75, c.f1);
  float bh = hashf(c.id, 4);
  float nap = fbm(uv, PM(80.0), 3, 5);
  float micro = fbm(uv, PM(400.0), 2, 6);
  // taped joints every 1.2 m: smoother, slightly glossier bands ~15 cm wide
  float joint = 1.0 - smoothstep(0.05, 0.09, distLines(m.x, 1.2));
  float lap = gnoise(uv, PMxy(0.9, 0.5), 7); // roller lap marks, very faint and broad
  float stip = blob * (0.45 + 0.55 * bh) + 0.35 * nap;
  float amp = mix(1.0, 0.55, joint);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.012 * fbm(uv, PM(5.0), 3, 8) + 0.006 * lap);
  col *= 1.0 - 0.012 * (1.0 - blob) * amp + 0.004 * micro;
  s.albedo = col;
  s.height = 0.5 + amp * (0.32 * stip + 0.04 * micro);
  s.rough = 0.87 - 0.06 * blob * amp - 0.03 * joint + 0.02 * micro;
}
`;

/** Semi-gloss trim paint (baseboards, casings): orange peel, brush drag, scuffs and small dings. */
const TRIM_PAINT = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float peel = fbm(uv, PM(220.0), 3, 3);
  float brush = gnoise(uv, PMxy(3.0, 320.0), 4) * 0.6 + gnoise(uv, PMxy(6.0, 700.0), 5) * 0.4;
  float scuffN = gnoise(warp(uv, PM(4.0), 2, 6, 0.02), PMxy(22.0, 150.0), 7);
  float scuffZone = smoothstep(0.15, 0.6, fbmV(uv, PM(3.0), 3, 8));
  float scuff = smoothstep(0.45, 0.85, scuffN) * scuffZone;
  Cell dg = worley(uv, PM(28.0), 0.9, 9);
  float ding = step(hashf(dg.id, 10), 0.12) * (1.0 - smoothstep(0.03, 0.07, dg.f1));
  vec3 col = TABLE_ALBEDO * (1.0 + 0.008 * peel + 0.012 * fbm(uv, PM(4.0), 3, 11));
  col = mix(col, srgb8(52.0, 48.0, 44.0), 0.55 * scuff);
  col *= 1.0 - 0.25 * ding;
  s.albedo = col;
  s.height = 0.55 + 0.12 * peel + 0.05 * brush - 0.3 * ding - 0.04 * scuff;
  s.rough = 0.44 + 0.05 * peel + 0.03 * brush + 0.25 * scuff + 0.2 * ding;
}
`;

export const WALL_RECIPES: RecipeTable = {
  [Mat.WALLPAPER_L0]: { glsl: WALLPAPER_L0, normalStrength: 1.0, heightScale: 0.0008 },
  [Mat.WALLPAPER_MANILA]: { glsl: WALLPAPER_MANILA, normalStrength: 1.0, heightScale: 0.0006 },
  [Mat.DRYWALL]: { glsl: DRYWALL, normalStrength: 1.0, heightScale: 0.0005 },
  [Mat.TRIM_PAINT]: { glsl: TRIM_PAINT, normalStrength: 1.0, heightScale: 0.0003 },
};
