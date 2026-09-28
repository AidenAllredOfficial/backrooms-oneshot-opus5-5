// src/textures/layers/masonry.ts — masonry: CMU_PAINTED, CMU_RAW (WP8; texture realism v2 lane C).

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

/** Painted CMU, frame 2.4 x 1.0 m: 0.4 x 0.2 m blocks (6 x 5 courses) with 10 mm concave recessed joints; paint
 * over porous block faces, paint-bridged voids, paint pooled glossier and darker in the joints; each block face is
 * laid slightly out of plane (+-0.35 deg), so the sheen changes block by block along a wall. 15 courses fit a 3 m
 * storey, so a true half bond cannot be periodic; courses use a third bond (offset sequence 0, 1/3, 2/3, 1/3, 2/3 of
 * a block), so every head joint is overlapped by >= 1/3. */
const CMU_HS = 0.014; // heightScale (m per height unit): 5.6 mm tooled joints below the face
const CMU_PAINTED = /* glsl */ `
#define SS 4
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float course = floor(m.y / 0.2);
  float cw = mod(course, 5.0);
  float off = cw < 0.5 ? 0.0 : cw < 1.5 ? 1.0 / 3.0 : cw < 2.5 ? 2.0 / 3.0 : cw < 3.5 ? 1.0 / 3.0 : 2.0 / 3.0;
  float bx = m.x + off * 0.4;
  float blk = floor(bx / 0.4);
  vec2 lp = vec2(bx - (blk + 0.5) * 0.4, m.y - (course + 0.5) * 0.2);
  vec2 bid = vec2(mod(blk, 6.0), cw);
  float e = min(0.2 - abs(lp.x), 0.1 - abs(lp.y));
  float w = 0.7 * aaM();
  float joint = 1.0 - smoothstep(0.005 - w, 0.005 + w, e);
  float jprof = 1.0 - (1.0 - sat(e / 0.005)) * (1.0 - sat(e / 0.005));
  float coarse = fbm(uv, PM(60.0), 3, 3);
  Cell po = worley(uv, PM(200.0), 0.95, 4);
  float pore = step(hashf(po.id, 5), 0.45) * (1.0 - smoothstep(0.1, 0.3, po.f1));
  float edgeRound = smoothstep(0.005, 0.013, e);
  // voids in the block face that the paint bridged over: shallow dimples
  Cell vo = worley(uv, PM(90.0), 0.9, 12);
  float vd = step(hashf(vo.id, 13), 0.3) * (1.0 - smoothstep(0.12, 0.3, vo.f1));
  float face = 0.72 + 0.05 * coarse - 0.1 * pore - 0.12 * vd;
  vec2 bt = (hash2f(bid, 7) - 0.5) * 0.012; // face tilt (slope), metres per metre
  face += dot(lp, bt) / ${CMU_HS};
  face = mix(face - 0.1, face, edgeRound);
  s.height = mix(face, 0.3 + 0.12 * jprof, joint);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.03 * (tileRand(bid, 6) - 0.5) + 0.02 * coarse);
  col *= 1.0 - 0.1 * pore;
  col *= 1.0 - 0.08 * vd;
  col *= mix(1.0, 0.82, joint);
  s.albedo = col;
  s.rough = mix(0.46 + 0.12 * pore + 0.03 * coarse, 0.52, joint);
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts)
export const MASONRY_RECIPES: RecipeTable = {
  [Mat.CMU_PAINTED]: {
    glsl: CMU_PAINTED, normalStrength: 1.0, heightScale: CMU_HS, trim: [1.021, 1.021, 1.02],
    phys: phys(0.3, { pomTop: 0.8, tok: 0.6, det: 3, detS: 0.8 }),
  },
  // CMU_RAW (reserved, texture realism v2; not placed in the world yet): placeholder, the painted body at the raw grey
  // of the table
  [Mat.CMU_RAW]: {
    glsl: CMU_PAINTED, normalStrength: 1.0, heightScale: CMU_HS, trim: [1.021, 1.021, 1.02],
    phys: phys(0.6, { pomTop: 0.8, tok: 0.6, det: 4, detS: 0.8 }),
  },
};
