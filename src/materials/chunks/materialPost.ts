// src/materials/chunks/materialPost.ts — package B: material edits after three's lights_physical_fragment (which
// fills `material`) and before lights_fragment_begin computes material.dfg, so every light path (baked direct,
// flashlight, ambient, reflections, the MRT fallback) sees them. Fixed order: wet F0 -> glaze coverage -> sheen
// (USE_SHEEN) -> clearcoat fields (USE_CLEARCOAT, props) -> spec AA (BR_SPEC_AA, on roughness and
// clearcoatRoughness) last. Inputs are the main-scope values of chunks/surface.ts (brFilm, brPuddle, brCov, brAbs,
// brWear, brPileLean, brDust); brCoat is declared here for package D (coat radiance, G-buffer routing).

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
// 3. textile sheen (Charlie lobe): fibre-tinted, lost where the pile is wet or crushed; the pile lean seen from the
// camera narrows / widens it
#ifdef USE_SHEEN
{
	vec4 brLD = uBrLayerD[ brL ];
	material.sheenColor = brLD.z * sqrt( max( diffuseColor.rgb, vec3( 0.0 ) ) ) * ( 1.0 - 0.85 * max( brFilm, brAbs ) ) * ( 1.0 - 0.4 * brWear );
	material.sheenRoughness = clamp( brLD.w + BR_SHEEN_LEAN_ROUGH * brPileLean, 0.07, 1.0 );
}
#endif
// 4. clearcoat (props with the coat bit: car paint, locker enamel): a lacquer lobe that dust dulls
bool brCoat = false;
#ifdef USE_CLEARCOAT
brCoat = ( brF & BR_F_PROP_AUX ) != 0 && vBrEmit <= 0.0 && ( int( brAuxB.z ) & 2 ) != 0;
material.clearcoat = brCoat ? 1.0 - brDust : 0.0;
material.clearcoatRoughness = min( max( BR_COAT_ROUGH, 0.0525 ) + geometryRoughness, 1.0 );
material.clearcoatF0 = vec3( 0.04 );
material.clearcoatF90 = 1.0;
#endif
// 5. specular AA (projected-space NDF filtering, Tokuyoshi & Kaplanyan 2019): the screen-space variance of the
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
`;
