// src/materials/chunks/family/props.ts — texture realism v2 family hooks: props and metals (METAL_PAINTED,
// METAL_RUST, METAL_GRATE, METAL_DECK, METAL_BARE, WOOD, PLASTIC, RUBBER). Owns grime profile 6 (metal) and the
// clearcoat fields (materialPost). Lane E's file; hook points and rules in chunks/family/index.ts.

import type { FamilyHooks } from './index.ts';

export const PROP_HOOKS: FamilyHooks = {
  pars: '',
  postSample: '',
  postDetail: '',
  grime: /* glsl */ `
	else if ( brGrime == BR_G_METAL ) {
		// metal: rust streaks
		float rust = smoothstep( 0.5, 0.85, brMask.g * 0.8 + g1.a * 0.6 + g2.g * 0.2 );
		brA = mix( brA, BR_RUST * ( 0.8 + 0.4 * g2.g ), rust * 0.75 );
		brMetal *= 1.0 - rust;
		brRoughMul = mix( 1.0, 1.6, rust );
	}
`,
  postWet: '',
  rough: '',
  normal: '',
  matPost: /* glsl */ `
// clearcoat (props with the coat bit: car paint, locker enamel): a lacquer lobe that dust dulls
#ifdef USE_CLEARCOAT
brCoat = ( brF & BR_F_PROP_AUX ) != 0 && vBrEmit <= 0.0 && ( int( brAuxB.z ) & 2 ) != 0;
material.clearcoat = brCoat ? 1.0 - brDust : 0.0;
material.clearcoatRoughness = min( max( BR_COAT_ROUGH, 0.0525 ) + geometryRoughness, 1.0 );
material.clearcoatF0 = vec3( 0.04 );
material.clearcoatF90 = 1.0;
#endif
`,
  postLight: '',
  preFog: '',
};
