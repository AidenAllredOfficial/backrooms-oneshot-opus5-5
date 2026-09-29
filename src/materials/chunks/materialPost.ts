// src/materials/chunks/materialPost.ts — package B: material edits after three's lights_physical_fragment (which
// fills `material`) and before lights_fragment_begin computes material.dfg, so every light path (baked direct,
// flashlight, ambient, reflections, the MRT fallback) sees them. Fixed order: wet F0 -> glaze coverage -> the EON
// diffuse roughness brDiffSigma (texture realism v2, chunks/brdf.ts) -> the family matPost hooks
// (chunks/family/index.ts: the textile sheen (USE_SHEEN), then the props clearcoat fields (USE_CLEARCOAT); a family may
// rescale brDiffSigma) -> spec AA (BR_SPEC_AA, on roughness and clearcoatRoughness) -> the punctual lights' diffuse
// albedo (brPunctAlb, chunks/surface.ts FRAG_EMISSIVE). Inputs are the main-scope values of chunks/surface.ts (brFilm,
// brPuddle, brCov, brAbs, brWear, brPileLean, brDust, brVar, brDetVar); brCoat is declared here for package D (coat
// radiance, G-buffer routing) and set by the props family.

import { familyHook } from './family/index.ts';

/** Injected after `#include <lights_physical_fragment>`. */
export const FRAG_MATERIAL_POST_GLSL = /* glsl */ `
// ==== package B: material post
// 1. wet F0: the film and standing water are optically water (F0 0.02, F90 1), whatever the substrate (metals too)
{
	float brWf = max( BR_WET_FILM_F0 * brFilm, brPuddle );
	material.specularColor = mix( material.specularColor, vec3( 0.02 ), brWf );
	material.specularColorBlended = mix( material.specularColorBlended, vec3( 0.02 ), brWf );
	material.specularF90 = mix( material.specularF90, 1.0, brWf );
}
// 2. glaze coverage: the glaze lobe covers 1 - brCov of the footprint (a puddle over grout is still a mirror)
{
	float brGk = 1.0 - brCov * ( 1.0 - brPuddle );
	material.specularColor *= brGk;
	material.specularColorBlended *= brGk;
	material.specularF90 *= brGk;
}
// 3. rough diffuse (texture realism v2, chunks/brdf.ts): the EON roughness of the direct lights on layers with
// BR_L_SIGMA > 0, raised by the unresolved slope variance per axis (detail LEAN and the mip-filtered normal's Toksvig
// term: relief below the pixel is facet roughness to the diffuse too); 0 keeps three's Lambert term
{
	float brSg = BR_L_SIGMA[ brL ];
	if ( brSg > 0.0 ) {
		float brSv = brVar;
#if defined( BR_DETAIL_MAPS ) && ! defined( BR_DECAL )
		brSv += brDetVar;
#endif
		brDiffSigma = min( 1.0, sqrt( brSg * brSg + 0.5 * brSv ) );
	}
}
// 4. family hooks (textile sheen, props clearcoat); brCoat: a clearcoat pixel (props)
bool brCoat = false;
${familyHook('matPost')}// 5. specular AA (projected-space NDF filtering, Tokuyoshi & Kaplanyan 2019): the screen-space variance of the
// shading normal widens the lobe, alpha^2 += min( 2 sigma^2 ( |dn/dx|^2 + |dn/dy|^2 ), kappa ), so normal-mapped
// glints, grout bevels and puddle shores do not sparkle. Weighted like the Toksvig term by the layer's share of
// normal variance that is lobe broadening (tiles: the bevels cover little area, the glaze must stay glossy far away)
#ifdef BR_SPEC_AA
{
	vec3 brDnx = dFdx( normal );
	vec3 brDny = dFdy( normal );
	float brK2 = min( 2.0 * BR_SAA_SIGMA2 * ( dot( brDnx, brDnx ) + dot( brDny, brDny ) ), BR_SAA_KAPPA ) * brLC.w;
	material.roughness = min( sqrt( sqrt( pow4( material.roughness ) + brK2 ) ), 1.0 );
#ifdef USE_CLEARCOAT
	material.clearcoatRoughness = min( sqrt( sqrt( pow4( material.clearcoatRoughness ) + brK2 ) ), 1.0 );
#endif
}
#endif
// 6. punctual lights (three's lights_fragment_begin: the flashlight) see the emitter model's own diffuse albedo where it
// sets one (brPunctAlb: a parabolic louver's blades mirror a torch at the eye away instead of glowing like white
// paint); chunks/lighting.ts puts the room's back before the baked light
vec3 brDiffRoom = material.diffuseContribution;
if ( brPunctAlb >= 0.0 ) material.diffuseContribution = vec3( brPunctAlb ) * ( 1.0 - metalnessFactor );
`;
