// src/materials/chunks/lighting.ts — baked lighting for the surface variants (replaces lights_fragment_maps),
// submerged caustics, specular occlusion and the floor/prop reflections (replaces aomap_fragment).
//
// r186 note: RE_IndirectSpecular_Physical turns `iblIrradiance` into BOTH indirect diffuse (energy-conserving
// against the specular lobe) and the multiscatter specular term, and RE_IndirectDiffuse_Physical turns
// `irradiance` into diffuse. The non-directional part of the baked irradiance is therefore added to
// iblIrradiance only (adding it to `irradiance` too would double the ambient diffuse); `radiance` receives the
// same part as a uniform environment (1-w)E/PI so metals, glossy tile, CRT glass and car paint get highlights.

/** Replaces `#include <lights_fragment_maps>`. */
export const FRAG_LIGHTS_GLSL = /* glsl */ `
// ==== WP9 baked lighting
vec4 brLmA;
vec4 brLmB;
vec4 brFl;
#ifdef BR_LV
	// props: tile light volume (32x6x32, 0.6 m), per-fragment wall clamp inside the fragment's own cell
	vec3 brLvP = vBrLocal;
	if ( ( brF & BR_F_PROP_AUX ) != 0 && ( int( brAuxB.z ) & 1 ) != 0 ) brLvP.y = 1.5 + mod( brLvP.y - 1.5, BR_PITCH );
	{
		ivec2 cell = ivec2( floor( brLvP.xz / BR_CELL ) );
		ivec2 msz = textureSize( uVolMask, 0 );
		int m = int( texelFetch( uVolMask, clamp( cell + 1, ivec2( 0 ), msz - 1 ), 0 ).r * 255.0 + 0.5 );
		vec2 lo = vec2( cell ) * BR_CELL;
		vec2 hi = lo + BR_CELL;
		if ( ( m & 1 ) != 0 ) brLvP.z = max( brLvP.z, lo.y + BR_LV_WALL_CLAMP ); // N (-z)
		if ( ( m & 2 ) != 0 ) brLvP.x = min( brLvP.x, hi.x - BR_LV_WALL_CLAMP ); // E (+x)
		if ( ( m & 4 ) != 0 ) brLvP.z = min( brLvP.z, hi.y - BR_LV_WALL_CLAMP ); // S (+z)
		if ( ( m & 8 ) != 0 ) brLvP.x = max( brLvP.x, lo.x + BR_LV_WALL_CLAMP ); // W (-x)
	}
	vec3 brUvw = vec3( brLvP.x / BR_TILE, brLvV( brLvP.y ), brLvP.z / BR_TILE );
	brLmA = texture( uVolA, brUvw );
	brLmB = texture( uVolB, brUvw );
	brFl = texture( uVolC, brUvw );
#else
	brLmA = texture( uLmIrr, vBrLmUv );
	brLmB = texture( uLmDir, vBrLmUv );
	brFl = texture( uLmFlick, vBrLmUv );
#endif
vec3 brE = max( brLmA.rgb, vec3( 0.0 ) );
float brAO = clamp( brLmA.a, 0.0, 1.0 );
float brW = clamp( brLmB.a, 0.0, 1.0 );
vec3 brLw = brDecodeDir( brLmB.xyz, brW );
vec3 brEf = vec3( 0.0 );
for ( int k = 0; k < 4; k ++ ) brEf += max( brFl[ k ], 0.0 ) * uFlick[ brChannelSlot( k, vBrLocal.xz, uOwnParity ) ];
// r186 only initialises this when punctual lights exist; set it exactly as lights_fragment_begin does
material.multiScatteringCompensation = 1.0 + material.specularColorBlended * ( 1.0 / ( material.dfg.x + material.dfg.y ) - 1.0 );
if ( brW > 0.0 ) {
	// directional part through RE_Direct: dividing by the unperturbed cosine lets the normal map re-shade it
	vec3 brLv = normalize( ( viewMatrix * vec4( brLw, 0.0 ) ).xyz );
	float brNgL = max( dot( brNg, brLv ), BR_NG_MIN );
	IncidentLight brDL;
	brDL.color = brW * brE / brNgL;
	brDL.direction = brLv;
	brDL.visible = true;
	float brR0 = material.roughness;
	material.roughness = max( brR0, BR_DIRECT_MIN_ROUGH );
	RE_Direct( brDL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	material.roughness = brR0;
}
irradiance += brEf; // flicker channels: diffuse irradiance
iblIrradiance += ( 1.0 - brW ) * brE; // ambient part (diffuse + multiscatter specular in RE_IndirectSpecular)
radiance += ( 1.0 - brW ) * brE * RECIPROCAL_PI; // ambient part as a uniform environment (indirect specular)
vec3 brIrrLocal = brE + brEf; // haze inscatter + water in-scatter
// ---- submerged caustics (up-facing, below the water plane): redistributes the local irradiance. The water body
// kind rides in tint.a of submerged floors (mesh/floors.ts): 0 pool (full), 1 flooded room (weak, large, slow),
// 2 film (none). Deeper water spreads the filaments (brCaustics) and the finite source size blurs them further.
if ( ( brF & BR_F_UNDERWATER ) != 0 && brNWg.y > 0.5 ) {
	float brWy = brAuxB.w * 0.05 - 3.2;
	float brDepth = brWy - vBrLocal.y; // both storey-relative (tile-local)
	int brWK = int( vBrTint.a * 255.0 + 0.5 );
	float brKS = brWK == 0 ? 1.0 : brWK == 1 ? BR_CAUSTIC_FLOOD : 0.0;
	if ( brDepth > 0.0 && brKS > 0.0 ) {
		float brSc = brWK == 1 ? BR_CAUSTIC_FLOOD_SCALE : 1.0;
		float brTs = brWK == 1 ? BR_CAUSTIC_FLOOD_SPEED : 1.0;
		float brC = brCaustics( vBrLocal.xz + uNoiseOrigin.xz, uTime * brTs, brDepth, brSc );
		float brSoft = 1.0 / ( 1.0 + brDepth * BR_CAUSTIC_SRC_TAN / ( 0.6 * brSc ) );
		float brCf = exp( - brDepth * BR_CAUSTIC_DEPTH_K ) * smoothstep( 0.0, 0.15, brDepth ) * brSoft * brKS;
		irradiance += brE * ( BR_CAUSTIC_STRENGTH * ( brC - brCausticMean( brDepth ) ) * brCf );
	}
}
`;

/** Replaces `#include <aomap_fragment>`: specular occlusion from the baked AO (indirect diffuse already holds the
 * baked AO) times the texture cavity AO + planar / emission-map reflections added to indirectSpecular. */
export const FRAG_AO_REFL_GLSL = /* glsl */ `
// ==== WP9 specular occlusion + reflections
float brDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
// texture cavity AO (WP8 ormh.r: grout, seams, carpet pile) on the ambient terms; the baked AO is already inside
// the indirect diffuse, so only the micro occlusion multiplies it
float brCav = clamp( brOrmh.r, 0.0, 1.0 );
reflectedLight.indirectDiffuse *= brCav;
reflectedLight.indirectSpecular *= computeSpecularOcclusion( brDotNV, brAO * brCav, material.roughness );
vec3 brNWp = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
vec3 brRefl = vec3( 0.0 );
#ifndef BR_DECAL
{
	float brFres = F_Schlick( 0.04, 1.0, brDotNV );
	float brGloss = pow2( 1.0 - material.roughness );
	bool brPlanar = false;
	// planar reflection: only the plane currently mirrored by PlanarReflection (uReflY)
	if ( uReflOn > 0.5 && ( brF & BR_F_REFLECTIVE ) != 0 && brNWg.y > 0.9 && abs( vBrLocal.y + uTileOrigin.y - uReflY ) < BR_PLANE_EPS ) {
		vec4 brRc = uReflMatrix * vec4( - vViewPosition, 1.0 );
		vec2 brRuv = brRc.xy / brRc.w + brNWp.xz * BR_REFL_DISTORT;
		brRefl = textureLod( uReflTex, brRuv, material.roughness * BR_REFL_LOD ).rgb * brFres * brGloss * brAO;
		brPlanar = true;
	}
#ifdef BR_FLOOR_REFL
	// emission-map reflection: intersect the reflected ray with the emitter plane in TILE-LOCAL space
	// roughness gate: full below BR_EM_ROUGH_CUT (the spec's 0.5), soft tail to BR_EM_ROUGH_END so per-pixel roughness
	// texture never speckles the reflection on/off and damp carpet (0.55) keeps a faint blurred sheen of the lamps
	float brRGate = 1.0 - smoothstep( BR_EM_ROUGH_CUT, BR_EM_ROUGH_END, material.roughness );
	if ( ! brPlanar && uFloorReflOn > 0.5 && brRGate > 0.0 && ( brF & ( BR_F_DYN_EMIT | BR_F_SHIMMER ) ) == 0 ) {
		bool brFloorR = ( brF & BR_F_FLOOR_AUX ) != 0 && ( brF & BR_F_REFLECTIVE ) != 0 && brNWg.y > 0.7;
		bool brPropR = ( brF & BR_F_PROP_AUX ) != 0 && brNWg.y > 0.7;
		if ( brFloorR || brPropR ) {
			vec3 brRw = normalize( ( vec4( reflect( - geometryViewDir, geometryNormal ), 0.0 ) * viewMatrix ).xyz );
			// floors: emitter plane aux.x * 5 cm above the floor; props: the anchor cell's ceiling (aux.w * 5 cm,
			// storey-relative = tile-local y; tower props: shifted by the same whole periods as the fragment)
			float brPlaneY = vBrLocal.y + brAuxB.x * 0.05;
			if ( ! brFloorR ) {
				brPlaneY = brAuxB.w * 0.05;
#ifdef BR_LV
				brPlaneY += vBrLocal.y - brLvP.y;
#endif
			}
			float brRk = brFloorR ? brAuxB.y + 256.0 * brAuxB.z : - 1.0;
			float brFade;
			vec3 brEc = brEmissionRefl( vBrLocal, brRw, brPlaneY, brRk, material.roughness, brFade );
			brRefl = brEc * brFres * brGloss * brAO * brFade * brRGate;
			// submerged: the tile/water interface reflects ~10x less than tile/air (F0 0.004 vs 0.04)
			if ( ( brF & BR_F_UNDERWATER ) != 0 && brAuxB.w * 0.05 - 3.2 > vBrLocal.y ) brRefl *= BR_UNDERWATER_REFL;
		}
	}
#endif
}
#endif
reflectedLight.indirectSpecular += brRefl;
`;
