// src/materials/chunks/screenspace.ts — screen-space helpers of the surface shaders (package A): the pre-shade SSAO
// lookup (uSsaoTex: half-res r AO, g view Z, ba oct view normal), its albedo multi-bounce and the contact-shadow
// march along the baked dominant light direction. chunks/lighting.ts gates every call by uSsaoP.x > 0.5 and
// uBrReflPass < 0.5. IGN is the only dither of the surface programs: the 16-sampler budget has no room for a
// blue-noise texture.
// A.0 stub: neutral bodies (no occlusion, full visibility), so every program compiles with every define on; A.2
// (SSAO) and A.3 (contact shadows) fill them in.

/** Appended to the fragment common block (after the uniforms). */
export const SCREENSPACE_GLSL = /* glsl */ `
#if defined( BR_SSAO ) || defined( BR_CS_STEPS )
// interleaved gradient noise (Jimenez 2014) at a pixel position
float brIGN( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
// ambient occlusion at the view-space fragment P with geometric normal N (1 = open)
float brSsao( vec3 P, vec3 N ) { return 1.0; }
// multi-bounce occlusion of albedo a (Jimenez 2016): occluded corners keep their hue
vec3 brAoMultiBounce( float v, vec3 a ) { return vec3( v ); }
// visibility of the baked directional light L (view space, directionality w) from P (1 = unshadowed)
float brContactShadow( vec3 P, vec3 Ng, vec3 L, float w ) { return 1.0; }
#endif
`;
