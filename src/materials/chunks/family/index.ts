// src/materials/chunks/family/index.ts — texture realism v2 family hooks: the fixed points where each material
// family's GLSL enters the surface shader (shell / props / decal variants), and their concatenation order.
//
// One file per family owns its hooks (textile A, concrete B, masonry and tile C, walls and ceiling D, props E); the
// core chunks (surface.ts, materialPost.ts, haze.ts, SurfaceMaterial.ts) only concatenate them, in FAMILIES order:
//   pars        fragment common block, after every package's declarations (helpers, #defines)
//   postSample  FRAG_MAP_GLSL after the base sampling, the alpha test and the v2 channel decode (brAux, brAux2,
//               brLean, brRotM, brRotC; brMuH and brRel are fetch-per-use expressions: gate them), before the detail
//               fetch: may change brA, brOrmh, brNrm and, under BR_DETAIL_MAPS without BR_DECAL, brDetUv, brDetDx,
//               brDetDy
//   postDetail  inside the detail block, after the fetch and before it is applied (only where a detail layer was
//               fetched: BR_DETAIL_MAPS, no BR_DECAL, not the mirror pass): may rescale brAm, brDetSl, brDetVar
//   grime       inside `if ( brGrime != 0 )` after the shared grime / wetness lookups (g1, g2, wetRaw, wet): the
//               family's profile branches, each an `else if ( brGrime == BR_G_<PROFILE> ) { ... }` clause of one
//               exclusive chain (the core opens it with `if ( false ) { }`)
//   postWet     after the wetness and puddle block (brWet, brSoak, brFilm, brPuddle, brRoughTo), before diffuseColor
//   rough       FRAG_ROUGHNESS_GLSL after the LEAN detail term (brRt), before roughnessFactor
//   normal      FRAG_NORMAL_GLSL after the detail slope (normal, brNg, brTbn)
//   matPost     chunks/materialPost.ts after three fills `material` (wet F0 and glaze coverage applied), before the
//               specular AA; `bool brCoat` is declared before it
//   postLight   after FRAG_AO_REFL_GLSL (aomap_fragment): may scale reflectedLight.directDiffuse / indirectDiffuse and
//               the inline reflectedLight.indirectSpecular (SSR G-buffer pixels were routed before it)
//   preFog      chunks/haze.ts, outside the debug views and before the submerged optics and haze: gl_FragColor is the
//               surface radiance
// Rules: gate on brL or brGrime (per-face values: quad-uniform, so derivatives stay valid), respect BR_DECAL, BR_LITE
// (BR_DETAIL == 0) and BR_DETAIL_MAPS, and skip expensive work when uBrReflPass > 0.5 (the planar mirror pass).
// Hooks never declare names that another family could also declare at main scope: prefix locals by family or scope
// them in braces.

import { CEILING_HOOKS } from './ceiling.ts';
import { CONCRETE_HOOKS } from './concrete.ts';
import { MASONRY_HOOKS } from './masonry.ts';
import { PROP_HOOKS } from './props.ts';
import { TEXTILE_HOOKS } from './textile.ts';
import { TILE_HOOKS } from './tile.ts';
import { WALL_HOOKS } from './walls.ts';

export interface FamilyHooks {
  pars: string;
  postSample: string;
  postDetail: string;
  grime: string;
  postWet: string;
  rough: string;
  normal: string;
  matPost: string;
  postLight: string;
  preFog: string;
}
export type HookPoint = keyof FamilyHooks;

/** The families in concatenation order. */
export const FAMILIES: readonly (readonly [string, FamilyHooks])[] = [
  ['textile', TEXTILE_HOOKS], ['walls', WALL_HOOKS], ['ceiling', CEILING_HOOKS], ['concrete', CONCRETE_HOOKS],
  ['masonry', MASONRY_HOOKS], ['tile', TILE_HOOKS], ['props', PROP_HOOKS],
];

/** The GLSL of one hook point: a point marker (emitted even when no family has code there, so tests can locate the
 * point), then every family's code for it in FAMILIES order, each under a marker comment and ending a line (a core
 * directive such as `#if` may follow). */
export function familyHook(point: HookPoint): string {
  const line = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);
  return `// ---- family hooks: ${point}\n` + FAMILIES.filter(([, h]) => h[point] !== '')
    .map(([name, h]) => `// ---- family ${name}: ${point}\n${line(h[point])}`).join('');
}
