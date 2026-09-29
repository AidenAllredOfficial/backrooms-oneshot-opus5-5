// src/textures/layers/concrete.ts — mineral surfaces: CONCRETE_FLOOR, CONCRETE_WALL, CONCRETE_CEIL, FLOOR_PAINT,
// TERRAZZO (WP8). CMU lives in layers/masonry.ts.

import { Mat } from '../../core/ids.ts';
import { phys, type RecipeTable } from './types.ts';

// CONCRETE_FLOOR and CONCRETE_CEIL are authored over square 2.4 m generator frames (RecipeBody.frame): their horizontal
// faces are what counts; the vertical faces that borrow them (tower risers, beam sides: v = y / 3.0) stretch them 1.25x.

/** Hard-troweled interior slab over a square 2.4 m generator frame (2.34 mm texels; the tower risers, v = y / 3.0,
 * stretch it 1.25x). A real slab is flat (micro-relief +-0.1-0.3 mm, waviness +-1 mm over metres) and reads through
 * tone and sheen, so nothing here is domed:
 * - tone: soft 0.8 m clouds, lacy 5-30 cm hydration mottle (darker in the burnished zones), faint flush aggregate
 *   shadows, dark mineral / dirt specks and 4-8 mm pinholes with dark dirty cores and a paler lip (2 mm deep: the
 *   cavity AO and the normal map see pits, not beads);
 * - power-trowel passes: rotor discs (R 0.45-0.58 m) on a jittered 0.6 x 0.8 m lattice; where discs overlap the last
 *   pass (highest hashed key) wins and only its rim ridge and inner blade arcs (25-60 mm pitch) show: fish scales.
 *   About 40 % of the slab is burnished (darker, glossier), the rest keeps a chalky laitance (paler, rougher): darker
 *   is glossier, roughness 0.35-0.8;
 * - dragged-load scratches (0.1-0.6 m, sub-texel wide: coverage), light (fresh paste) or dark (dirt);
 * - waviness +-1 mm (wobbles the lamp reflections and places the puddles).
 * Joints, spalls, cracks, pours and traffic lanes are world-space (chunks/family/concrete.ts). ormh.a ('mask') holds
 * the trowel swirl outside the laitance, so the shader scales it per finish class and turns it off on risers. */
const CONCRETE_FLOOR = /* glsl */ `
#define SS 4
// the power-trowel pass covering m (metres): the machine travels in serpentine rows, so each disc overlaps the one
// before it and the covering disc with the highest travel key is the last pass. Only its rim ridge (the edge of that
// pass, fading in and out around the disc) and a few partial blade arcs show: overlapping fish scales, not rings.
float cfTrowel(vec2 m, out float rim) {
  ivec2 P = PMxy(1.0 / 0.6, 1.0 / 0.7);
  vec2 cs = FRAME / vec2(P);
  vec2 c0 = floor(m / cs);
  float bestK = -1e9, bestD = 0.0, bestR = 1.0;
  vec2 bestId = vec2(0.0), bestRel = vec2(1.0, 0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = c0 + vec2(float(x), float(y));
      vec2 w = wrapCell(c, vec2(P));
      vec4 h = hash4f(w, 31);
      vec2 ctr = (c + 0.5 + 0.35 * (h.xy - 0.5)) * cs;
      float R = mix(0.45, 0.58, h.z);
      vec2 rel = m - ctr;
      float d = length(rel);
      float col = mod(w.y, 2.0) < 0.5 ? w.x : float(P.x) - 1.0 - w.x;
      float key = w.y * float(P.x) + col + 0.7 * (h.w - 0.5);
      if (d < R && key > bestK) { bestK = key; bestD = d; bestR = R; bestId = w; bestRel = rel; }
    }
  }
  rim = 0.0;
  if (bestK < -1e8) return 0.0;
  vec4 a = hash4f(bestId, 32);
  vec4 b = hash4f(bestId, 33);
  float ang = atan(bestRel.y, bestRel.x);
  // the blades bear unevenly: the ridge and the arcs come and go around the disc (integer harmonics: continuous)
  float along = 0.6 * sin(2.0 * ang + b.x * 6.2831853) + 0.4 * sin(3.0 * ang + b.y * 6.2831853);
  rim = gauss((bestR - bestD) / 0.012) * smoothstep(-0.5, 0.5, along) * mix(0.6, 1.0, a.z);
  float pitch = mix(0.025, 0.06, a.x);
  float arcs = pow(0.5 + 0.5 * sin(6.2831853 * (bestD + 0.01 * sin(5.0 * ang + b.z * 6.2831853)) / pitch + a.y * 6.2831853), 6.0);
  float sector = smoothstep(0.1, 0.8, 0.6 * sin(ang + b.w * 6.2831853) + 0.4 * sin(4.0 * ang + b.z * 6.2831853));
  float inner = 0.35 * smoothstep(0.3, 0.9, bestD / bestR) * arcs * sector;
  return rim + inner * mix(0.5, 1.0, a.w);
}
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  float cloud = fbm(uv, PM(1.2), 4, 1);
  float burn = smoothstep(0.35, 0.75, fbmV(uv, PM(1.5), 3, 2));
  // chalky laitance and settled dust where the slab was not burnished (anti-correlated with the burn)
  float lait = smoothstep(0.5, 0.8, fbmV(uv, PM(2.0), 3, 3)) * (1.0 - burn);
  // lacy hydration / trowel mottle: 5-30 cm patches with crisp, ragged edges
  float mottle = smoothstep(0.0, 0.14, fbm(warp(uv, PM(3.0), 3, 4, 0.03), PM(6.0), 5, 5) + 0.12 * fbm(uv, PM(40.0), 2, 19));
  // flush aggregate shadows (stone under a thin paste skin) and dark mineral / dirt specks
  Cell ag = worley(uv, PM(45.0), 0.9, 6);
  vec2 agh = hash2f(ag.id, 7);
  float aggr = step(agh.x, 0.35) * (1.0 - smoothstep(mix(0.25, 0.4, agh.y) - 0.08, mix(0.25, 0.4, agh.y), ag.f1 + 0.06 * vnoise(uv, PM(400.0), 8)));
  Cell sp = worley(uv, PM(160.0), 0.9, 9);
  vec2 sph = hash2f(sp.id, 10);
  float speck = step(sph.x, 0.05) * (1.0 - smoothstep(mix(0.2, 0.35, sph.y) * 0.6, mix(0.2, 0.35, sph.y), sp.f1));
  // coarse aggregate fines showing through the paste: light and dark 3-6 mm flecks, and a sandy 1-4 cm paste tone
  Cell fl = worley(uv, PM(90.0), 0.9, 15);
  vec2 flh = hash2f(fl.id, 16);
  float flc = 1.0 - smoothstep(0.18, 0.34, fl.f1 + 0.1 * vnoise(uv, PM(360.0), 17));
  float fleck = flc * (step(0.86, flh.x) * (0.6 + 0.4 * flh.y) - 1.6 * step(flh.x, 0.06));
  float sand = fbm(uv, PM(30.0), 3, 18);
  // pinholes (entrapped air, 4-8 mm): dark dirty core, a paler 0.4 mm lip, 2 mm deep
  Cell ph = worley(uv, PM(30.0), 0.9, 11);
  vec2 phh = hash2f(ph.id, 12);
  float phOn = step(phh.x, 0.12);
  float phR = mix(0.06, 0.12, phh.y);
  float pin = phOn * (1.0 - smoothstep(phR * 0.55, phR, ph.f1));
  float lip = phOn * gauss((ph.f1 - phR * 1.15) / (phR * 0.25)) * (1.0 - pin);
  // power trowel
  float rim;
  float swirl = cfTrowel(m, rim);
  // dragged-load scratches: 0-2 segments per 0.4 m cell, 0.1-0.6 m long, 0.15-0.5 mm half-width (sub-texel: coverage)
  float scrL = 0.0, scrD = 0.0;
  {
    ivec2 P = PM(2.5);
    vec2 cs = FRAME / vec2(P);
    vec2 c0 = floor(m / cs);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 c = c0 + vec2(float(x), float(y));
        vec2 w = wrapCell(c, vec2(P));
        for (int k = 0; k < 2; k++) {
          vec4 h = hash4f(w, 40 + k);
          if (h.w > 0.55 - 0.3 * float(k)) continue;
          vec4 g = hash4f(w, 50 + k);
          vec2 a = (c + h.xy) * cs;
          float ang = g.x * 6.2831853;
          vec2 b = a + vec2(cos(ang), sin(ang)) * mix(0.1, 0.6, g.y);
          float cov = fillM(sdSeg(m, a, b) - mix(0.00015, 0.0005, g.z));
          if (g.w < 0.6) scrL = max(scrL, cov); else scrD = max(scrD, cov);
        }
      }
    }
  }
  float wav = fbm(uv, PM(0.6), 3, 13);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.1 * cloud) * mix(vec3(1.0), vec3(1.012, 1.0, 0.985), 0.5 + 0.5 * cloud);
  col *= 1.0 - 0.07 * burn - (0.04 + 0.06 * burn) * mottle;
  col *= 1.0 - 0.05 * aggr;
  col *= 1.0 - 0.45 * speck;
  col *= (1.0 + 0.15 * fleck) * (1.0 + 0.06 * sand);
  col *= (1.0 - 0.55 * pin) * (1.0 + 0.04 * lip);
  col *= 1.0 - 0.03 * swirl;
  col *= 1.0 + 0.07 * lait;
  col *= (1.0 + 0.06 * scrL) * (1.0 - 0.1 * scrD);
  s.albedo = col;
  s.height = 0.5 + 0.25 * wav + 0.02 * rim + 0.02 * fbm(uv, PM(40.0), 2, 14) - 0.5 * pin + 0.012 * lip - 0.02 * (scrL + scrD);
  float r = 0.62 + 0.05 * cloud - 0.08 * swirl - 0.15 * burn + 0.1 * lait - 0.04 * mottle * burn;
  r += 0.12 * max(scrL, scrD);
  s.rough = mix(r, 0.9, pin);
  s.aux = sat(swirl) * (1.0 - lait);
}
`;

/** A plywood-formed concrete face over form panels of `panel` metres (dividing FRAME), shared by CONCRETE_WALL and
 * CONCRETE_CEIL. Returns the albedo multiplier over TABLE_ALBEDO, the relief in METRES above the face plane (< 0 into
 * the concrete; the recipe scales it by its heightScale) and the roughness:
 * - panels: each sheet's own tone (+-10 %) and hue (form reuse, release oil), darker bleed toward the bottom of the
 *   lift, lippage (+-0.8 mm between sheets) and pillowing between the 0.3 m studs;
 * - bug holes: 0.6-7 mm (log-normal around 2 mm), clustered and denser toward the top of each lift, taller than
 *   wide with a steep top wall, 30 % half-skinned; bugK scales their number (walls 1, soffits 0.1);
 * - seams: 1.5 mm fins intact on 65 % of the 10 cm seam segments and broken into jagged scars elsewhere, a grout-leak
 *   line on half the seams and sandy streaks along one side where paste leaked out;
 * - the plywood's rotary-cut grain (vertical, ~9 mm) imprinted, with 0-2 boat-shaped patches per sheet;
 * - faint aggregate shadows, hydration mottle, torn-skin patches (matte) and form-oil blotches (satin); satin skin
 *   0.72 otherwise. */
const FORM_FACE = /* glsl */ `
struct FormOut { vec3 am; float hM; float rough; vec2 local; vec2 pid; };
FormOut formFace(vec2 uv, vec2 panel, float bugK, int seed) {
  FormOut o;
  vec2 m = uv * FRAME;
  TileInfo pn = tiles(m, panel);
  vec4 pr = tileRand4(pn.id, seed);
  float vL = pn.local.y / panel.y + 0.5;
  vec3 am = vec3(1.0 + 0.2 * (pr.x - 0.5)) * mix(vec3(0.985, 1.0, 1.015), vec3(1.015, 1.0, 0.985), pr.y);
  am *= 1.0 - 0.05 * (1.0 - vL);
  float hM = 0.0016 * (pr.z - 0.5) + 0.0004 * pow(sin(3.14159265 * m.x / 0.3), 2.0);
  float rough = 0.72;
  // ---- plywood grain (vertical rotary-cut figure, ~9 mm) and boat-shaped patches
  float ph = uv.x * floor(FRAME.x / 0.009 + 0.5) + 1.5 * fbm(uv + pr.zw, PMxy(1.5, 0.5), 3, seed + 2)
           + 0.4 * gnoise(uv + pr.wz, PMxy(6.0, 2.0), seed + 3);
  float grain = smoothstep(0.85, 1.0, 0.5 + 0.5 * sin(6.2831853 * ph));
  for (int k = 0; k < 2; k++) {
    vec4 fh = tileRand4(pn.id, seed + 10 + k);
    if (fh.w > 0.45) continue;
    vec2 c = (fh.xy - 0.5) * (panel - 0.2);
    vec2 q = pn.local - c;
    // vesica (two 47 mm circles 47 mm apart): about 45 x 95 mm, long axis vertical
    float dv = max(length(q - vec2(0.0235, 0.0)), length(q + vec2(0.0235, 0.0))) - 0.047;
    dv = max(dv, abs(q.y) - 0.0475);
    float inside = fillM(dv);
    float gp = smoothstep(0.85, 1.0, 0.5 + 0.5 * sin(6.2831853 * (q.y / 0.008 + 3.0 * fh.z)));
    grain = mix(grain, gp, inside);
    float outl = lineM(dv, 0.00025);
    am *= 1.0 - 0.06 * outl;
    hM -= 0.0003 * outl;
  }
  am *= 1.0 - 0.025 * (grain - 0.3);
  hM -= 0.00008 * grain;
  rough += 0.04 * grain;
  // ---- aggregate shadows and hydration mottle
  Cell ag = worley(uv, PM(40.0), 0.9, seed + 4);
  vec2 agh = hash2f(ag.id, seed + 5);
  float agR = mix(0.25, 0.4, agh.y);
  am *= 1.0 - 0.03 * step(agh.x, 0.35) * (1.0 - smoothstep(agR - 0.1, agR, ag.f1 + 0.15 * fbm(uv, PM(160.0), 2, seed + 20)));
  // soft 0.3-1 m clouds (water gain, uneven vibration) and a faint 3-15 cm hydration mottle
  float mot = smoothstep(-0.3, 0.4, fbm(warp(uv, PM(4.0), 2, seed + 21, 0.02), PM(8.0), 4, seed + 6)) - 0.5;
  am *= 1.0 + 0.05 * mot + 0.2 * fbm(uv, PM(1.2), 4, seed + 7);
  // ---- skin: torn patches (matte, a little paler and coarser), form-oil blotches (satin, darker)
  float torn = smoothstep(0.38, 0.5, fbm(uv, PM(3.0), 4, seed + 8));
  float oilF = smoothstep(0.3, 0.45, fbm(uv + 0.5, PM(2.5), 3, seed + 9)) * (1.0 - torn);
  am *= (1.0 + 0.04 * torn) * (1.0 - 0.04 * oilF);
  rough = mix(mix(rough, 0.9, torn), 0.64, oilF);
  hM += 0.00012 * torn * vnoise(uv, PM(300.0), seed + 11);
  // ---- seams: fins, broken scars, grout-leak lines, sand streaks
  bool vert = abs(pn.local.x) / panel.x > abs(pn.local.y) / panel.y;
  float along = vert ? m.y : m.x;
  vec2 nLines = floor(FRAME / panel + 0.5);
  vec2 lineId = vert ? vec2(mod(floor(m.x / panel.x + 0.5), nLines.x), 0.0) : vec2(mod(floor(m.y / panel.y + 0.5), nLines.y), 1.0);
  // seam segments are centred on the frame edge (the wrap falls inside one, so the texture tiles)
  float alongF = vert ? FRAME.y : FRAME.x;
  vec2 segId = vec2(lineId.x * 2.0 + lineId.y, mod(floor(along / 0.1 + 0.5), floor(alongF / 0.1 + 0.5)));
  vec4 sh = hash4f(segId, seed + 12);
  float lh = hashf(lineId, seed + 13);
  float e = pn.edge;
  float intact = step(sh.x, 0.65);
  float fin = gauss(e / 0.00125);
  float jag = vnoise(uv, PM(200.0), seed + 14);
  hM += fin * mix(0.0003 * jag, 0.0015, intact);
  am *= mix(1.04, 1.0, intact * fin) * (1.0 - 0.05 * lineM(e, 0.0004));
  rough = mix(rough, 0.95, fin * (1.0 - intact));
  float leak = step(lh, 0.5) * (1.0 - smoothstep(0.002, 0.006, e));
  am *= 1.0 - 0.1 * leak;
  // sand streak: where paste leaked out through the joint, a 20-50 mm band of exposed sand along one side of the seam
  // over 35 % of its 0.3 m segments, tapering at the ends, with a ragged edge
  vec4 st = hash4f(vec2(segId.x, mod(floor(along / 0.3 + 0.5), floor(alongF / 0.3 + 0.5))), seed + 23);
  float fa = fract(along / 0.3 + 0.5);
  float sideS = vert ? m.x - floor(m.x / panel.x + 0.5) * panel.x : m.y - floor(m.y / panel.y + 0.5) * panel.y;
  float streakW = mix(0.02, 0.05, st.y) * smoothstep(0.0, 0.3, fa) * (1.0 - smoothstep(0.7, 1.0, fa))
                * (0.7 + 0.6 * vnoise(uv, PM(40.0), seed + 22)) * (0.85 + 0.3 * vnoise(uv, PM(400.0), seed + 24));
  float streak = step(st.z, 0.35) * step(0.0, sideS * (st.w - 0.5)) * (1.0 - smoothstep(streakW * 0.6, streakW + 1e-4, e));
  am *= mix(1.0, 0.9 * (0.85 + 0.3 * vnoise(uv, PM(500.0), seed + 15)), streak);
  hM -= 0.0003 * streak;
  rough = mix(rough, 0.95, streak);
  // ---- bug holes (air trapped against the form), decided from each candidate's centre
  Cell bh = worley(uv, PM(35.0), 0.8, seed + 16);
  vec2 cellM = FRAME / vec2(PM(35.0));
  vec2 mc = m + bh.rel * cellM;
  vec4 bhh = hash4f(bh.id, seed + 17);
  vec4 bh2 = hash4f(bh.id, seed + 18);
  float vLc = fract(mc.y / panel.y);
  float clus = smoothstep(0.05, 0.25, fbm(mc / FRAME, PM(4.0), 3, seed + 19));
  float pHole = bugK * 0.12 * (0.4 + 1.4 * vLc * vLc) * mix(0.4, 2.5, clus);
  if (bhh.x < pHole) {
    float n = (bhh.y + bhh.z + bhh.w + bh2.x - 2.0) * 1.7;
    float r = clamp(exp(log(0.002) + 0.55 * n), 0.0006, 0.007);
    vec2 q = -bh.rel * cellM;
    q.y /= 1.3;
    float qy = q.y - 0.2 * r;
    float rho = length(vec2(q.x, qy * (qy > 0.0 ? 1.8 : 0.85))) / r;
    float cover = fillM((rho - 1.0) * r);
    if (bh2.y < 0.3) cover *= fillM(q.y - 0.1 * r); // half-skinned: a paste lip over the upper half
    float depth = 0.6 * r * sqrt(max(1.0 - rho * rho, 0.0));
    hM -= depth * cover;
    am *= 1.0 - 0.3 * cover;
    rough = mix(rough, 0.95, cover);
  }
  o.am = am; o.hM = hM; o.rough = rough; o.local = pn.local; o.pid = pn.id;
  return o;
}
`;

/** Cast-in-place wall, frame 2.4 x 1.5 m: plywood-formed face (formFace, 1.2 x 1.5 m sheets) with 4 snap-tie holes per
 * sheet. Relief for parallax occlusion mapping: the face rests at 0.9 (x CONCRETE_WALL_HS = 18 mm above height 0,
 * pomTop 0.92) and the tie holes are cones from the rim down to 0 (the plastic cones of the snap ties leave 18 mm deep
 * conical recesses). Tie holes by hash: 60 % open cones with the rusty rod end at the bottom, 25 % grout plugs recessed
 * 4 mm (paler, matte, a hairline shrinkage ring), 15 % grey plastic cones left in. The shader adds a per-sheet world
 * tone and sheen (chunks/family/concrete.ts), so the 2.4 m repeat does not show as ABAB. */
const CONCRETE_WALL_HS = 0.02; // heightScale (m per height unit)
const CONCRETE_WALL = /* glsl */ `
#define SS 4
${FORM_FACE}
void gen(vec2 uv, inout Surf s) {
  FormOut f = formFace(uv, vec2(1.2, 1.5), 1.0, 3);
  vec3 col = TABLE_ALBEDO * f.am;
  float face = 0.9 + f.hM / ${CONCRETE_WALL_HS};
  float rough = f.rough;
  vec2 tl = vec2(abs(f.local.x) - 0.3, abs(f.local.y) - 0.375);
  float tr = length(tl);
  vec2 tid = f.pid * 4.0 + vec2(step(0.0, f.local.x), step(0.0, f.local.y));
  float kind = hashf(tid, 30);
  float tie = 1.0 - smoothstep(0.011, 0.0125 + 0.7 * aaM(), tr);
  float cone = 0.9 * sat(tr / 0.0125);
  float h;
  if (kind < 0.6) {
    // open cone: the concrete recess darkens by its own depth (cavity AO, POM); rust on the rod end at the bottom
    float rod = 1.0 - smoothstep(0.0025, 0.0035, tr);
    col = mix(col, col * 0.7, tie);
    col = mix(col, srgb8(96.0, 58.0, 38.0), rod * tie);
    rough = mix(rough, mix(0.8, 0.6, rod), tie);
    h = mix(face, cone, tie);
  } else if (kind < 0.85) {
    // grout plug recessed 4 mm, with a hairline shrinkage ring
    float ring = lineM(tr - 0.0112, 0.00015);
    col = mix(col, col * 1.08 * (1.0 - 0.4 * ring), tie);
    rough = mix(rough, 0.95, tie);
    h = mix(face, 0.7, tie);
  } else {
    // grey plastic cone left in, 2 mm below the face
    col = mix(col, vec3(0.25), tie);
    rough = mix(rough, 0.4, tie);
    h = mix(face, 0.8 - 0.05 * sat(1.0 - tr / 0.004), tie);
  }
  float tieRing = gauss((tr - 0.017) / 0.003);
  col *= 1.0 - 0.08 * tieRing;
  s.albedo = col;
  s.height = h + 0.008 * tieRing;
  s.rough = rough;
}
`;

/** Flat slab soffit (parking, utility): the plywood-formed face (formFace) at 1.2 x 2.4 m sheets over a square
 * 2.4 m frame, with few bug holes (air rises away from a soffit form), rebar ghosting (faint darker bands on a
 * 0.2-0.3 m grid where the cover is thin, on 30 % of the sheets) and rust dots from the tie wire. */
const CONCRETE_CEIL = /* glsl */ `
#define SS 4
${FORM_FACE}
void gen(vec2 uv, inout Surf s) {
  FormOut f = formFace(uv, vec2(1.2, 2.4), 0.1, 5);
  vec3 col = TABLE_ALBEDO * f.am;
  vec2 m = uv * FRAME;
  vec4 pr = tileRand4(f.pid, 40);
  if (pr.x < 0.3) {
    float pitch = 2.4 / floor(2.4 / mix(0.2, 0.3, pr.y) + 0.5); // divides the frame
    vec2 g = abs(fract(m / pitch + pr.zw) - 0.5) * pitch;
    float band = max(1.0 - smoothstep(0.004, 0.012, g.x), 1.0 - smoothstep(0.004, 0.012, g.y));
    col *= 1.0 - 0.03 * band * (0.6 + 0.4 * vnoise(uv, PM(6.0), 41));
  }
  // rust dots (tie-wire ends): 1-3 mm cores with a 5-15 mm warm halo, a quarter of a 0.11 m lattice
  Cell rt = worley(uv, PM(9.0), 0.9, 44);
  vec2 rth = hash2f(rt.id, 45);
  float dM = rt.f1 * FRAME.x / float(PM(9.0).x);
  float rr = mix(0.0005, 0.0015, rth.y);
  float on = step(rth.x, 0.25);
  float core = on * (1.0 - smoothstep(rr, rr + aaM(), dM));
  float halo = on * (1.0 - smoothstep(0.0, mix(0.005, 0.015, rth.y), dM));
  col *= mix(vec3(1.0), vec3(1.0, 0.96, 0.9) * 0.97, halo);
  col = mix(col, srgb8(110.0, 62.0, 35.0), core);
  s.albedo = col;
  s.height = 0.5 + f.hM / 0.005;
  s.rough = mix(f.rough, 0.9, 0.5);
}
`;

/** Worn floor paint (safety yellow, white): a 0.25 mm film. On stripes (mesh/decals.ts) u runs across the stripe and v
 * along it, so the wheel-track bands (0.3 m cells, where tyres cross) run across the stripe and carry grey tyre dirt.
 * Traffic takes the film off the slab's high points first (a 4 mm proxy field), so partly worn paint survives as a
 * stipple in the pores instead of blobs; thinner film lets the grey slab through and is rougher (0.4 fresh, 0.6 worn).
 * Edge flakes, the slab's joints, speckle and wetness come from the shader (chunks/family/concrete.ts). */
const FLOOR_PAINT = /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float blot = fbm(warp(uv, PM(6.0), 3, 3, 0.02), PM(9.0), 5, 4);
  float bands = smoothstep(0.45, 0.8, vnoise(uv + vec2(0.0, 0.15 * vnoise(uv, PM(2.0), 8)), PMxy(0.84, 3.5), 7));
  float hp = vnoise(uv, PM(300.0), 5);
  float wear = 0.5 + blot + 0.3 * bands;
  float a = 1.0 - smoothstep(0.8, 0.9, wear * (0.55 + 0.9 * hp));
  float thin = smoothstep(0.45, 0.75, wear);
  vec3 col = TABLE_ALBEDO * (1.0 + 0.04 * fbm(uv, PM(30.0), 2, 6));
  col *= mix(1.0, 0.88, thin);
  col *= mix(vec3(1.0), vec3(0.9, 0.88, 0.85), bands * 0.8);
  s.alpha = a;
  s.albedo = col;
  s.rough = mix(0.4, 0.6, max(thin, bands));
  s.height = 0.4 + 0.5 * a;
}
`;

/** Precast terrazzo tile, 0.6 m (2 x 2 per 1.2 m frame; the shader rotates / flips whole tiles): crushed marble
 * chips cover ~70-75 % of a grey cement matrix. Chips are angular polygons (Voronoi cells shrunk by a per-chip gap,
 * F2 - F1) at three sizes (15, 6 and 3 mm lattices; the smaller fill the matrix gaps), in a restrained palette
 * (white marble 50 %, light grey 24 %, buff 12 %, charcoal 8 %, rare muted accents) with their own value, a tone gradient across each
 * chip and veins in some white chips. The matrix has 1 mm sand speckle and 0.5-2 mm pits. The polish leaves the chips
 * glossier (0.07-0.1) than the matrix (0.16-0.22) and the matrix ~20 microns lower. 1.5 mm grout joints; each tile
 * sits with its own tilt (+-0.15 degrees) and lippage (+-0.1 mm), so the lamp reflections step at the joints. */
const TERRAZZO = /* glsl */ `
#define SS 4
vec3 tzChip(float h) {
  return h < 0.5 ? srgb8(222.0, 219.0, 210.0)
       : h < 0.74 ? srgb8(170.0, 168.0, 162.0)
       : h < 0.82 ? srgb8(64.0, 64.0, 66.0)
       : h < 0.94 ? srgb8(205.0, 190.0, 164.0)
       : h < 0.97 ? srgb8(128.0, 112.0, 100.0)
       : srgb8(110.0, 120.0, 108.0);
}
// one chip population on lattice P: Voronoi cells shrunk by a per-chip gap (cell units) into angular chips, on a share
// pOn of the cells; h = the chip's hashes, rel = the vector to its seed point (cell units)
float tzChips(vec2 uv, ivec2 P, float gLo, float gHi, float pOn, int seed, out vec4 h, out vec2 rel) {
  Cell c = worley(uv, P, 0.95, seed);
  h = hash4f(c.id, seed + 1);
  rel = c.rel;
  float g = mix(gLo, gHi, h.y);
  float aa = 1.4 * float(P.x) * br_texel.x;
  return step(h.w, pOn) * smoothstep(g, g + aa, c.f2 - c.f1);
}
vec3 tzColor(vec4 h, vec2 rel, vec2 uv, int seed) {
  vec3 c = tzChip(h.x) * (0.92 + 0.16 * h.z);
  float ang = h.y * 6.2831853;
  c *= 1.0 + 0.1 * dot(rel, vec2(cos(ang), sin(ang)));
  // veins in 30 % of the white chips: zero crossings of warped gradient noise
  if (h.x < 0.5 && fract(h.z * 7.13) < 0.3) {
    float v = gnoise(warp(uv + h.zw, PM(20.0), 2, seed + 3, 0.01), PM(60.0), seed + 4);
    c *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.05, abs(v)));
  }
  return c;
}
void gen(vec2 uv, inout Surf s) {
  vec2 m = uv * FRAME;
  TileInfo t = tiles(m, vec2(0.6));
  vec4 r = tileRand4(t.id, 3);
  vec2 tuv = uv + floor(r.zw * 16.0) / 8.0; // per-tile pattern offset (multiples of 1/8: periodic)
  vec3 matrixCol = srgb8(160.0, 158.0, 151.0) * (0.92 + 0.16 * vnoise(tuv, PM(420.0), 4)) * (1.0 + 0.03 * fbm(tuv, PM(8.0), 3, 5));
  vec4 h1, h2, h3;
  vec2 r1, r2, r3;
  float c1 = tzChips(tuv, PM(60.0), 0.18, 0.46, 0.88, 10, h1, r1);
  float c2 = tzChips(tuv + 0.37, PM(140.0), 0.16, 0.4, 0.8, 20, h2, r2) * (1.0 - c1);
  float c3 = tzChips(tuv + 0.71, PM(300.0), 0.18, 0.42, 0.6, 30, h3, r3) * (1.0 - c1) * (1.0 - c2);
  vec3 col = matrixCol;
  col = mix(col, tzColor(h3, r3, tuv, 31), c3);
  col = mix(col, tzColor(h2, r2, tuv, 21), c2);
  col = mix(col, tzColor(h1, r1, tuv, 11), c1);
  float chip = c1 + c2 + c3;
  Cell pt = worley(tuv, PM(250.0), 0.9, 40);
  vec2 ph = hash2f(pt.id, 41);
  float pit = step(ph.x, 0.08) * (1.0 - smoothstep(mix(0.15, 0.4, ph.y) * 0.7, mix(0.15, 0.4, ph.y), pt.f1)) * (1.0 - 0.7 * chip);
  col *= 1.0 - 0.4 * pit;
  float w = 0.7 * aaM();
  float grout = 1.0 - smoothstep(0.00075 - w, 0.00075 + w, t.edge);
  vec3 groutCol = srgb8(125.0, 122.0, 116.0) * (0.9 + 0.2 * vnoise(uv, PM(300.0), 42));
  s.albedo = mix(col, groutCol, grout);
  float rMatrix = 0.16 + 0.06 * fbmV(tuv, PM(6.0), 2, 43);
  float rChip = 0.07 + 0.03 * fract(h1.z * 3.7 + h2.z * 5.3 + h3.z * 1.9);
  s.rough = mix(mix(mix(rMatrix, rChip, chip), 0.4, pit), 0.7, grout);
  // per-tile tilt (+-0.15 deg: 0.0026) and lippage (+-0.1 mm) at heightScale 2 mm per unit
  vec2 slope = (r.xy - 0.5) * 2.0 * 0.0026;
  float hTile = 0.5 + (dot(t.local, slope) + (r.z - 0.5) * 0.0002) / 0.002 + 0.01 * chip - 0.25 * pit;
  s.height = mix(hTile, 0.2, grout);
}
`;

// trim: albedo calibration (layerAlbedoCheck at 1024); phys: SurfacePhys (types.ts); sigma and dirt take effect with
// the v2 shading block (EON diffuse, relief-aware dirt)
export const CONCRETE_RECIPES: RecipeTable = {
  // normalStrength: the recipes use physical amplitudes (a troweled slab is flat, pinholes, fins and bug holes carry
  // the relief), so only a mild 1.5-2x makes up for the 2.3 mm texels smoothing the small features (it was 3-6x on the
  // former smooth fields, which turned the slab's raised pebbles into beads)
  [Mat.CONCRETE_FLOOR]: {
    glsl: CONCRETE_FLOOR, normalStrength: 1.75, heightScale: 0.004, trim: [1.058, 1.065, 1.074],
    phys: phys(0.6, { det: 12, detS: 1, sigma: 0.25, dirt: [0.6, 0.56, 0.5, 0.6] }), aux: 'mask', frame: [2.4, 2.4],
  },
  [Mat.CONCRETE_WALL]: {
    glsl: CONCRETE_WALL, normalStrength: 2.0, heightScale: CONCRETE_WALL_HS, trim: [1.03, 1.027, 1.024],
    phys: phys(0.6, { pomTop: 0.92, det: 4, detS: 0.8, sigma: 0.35, dirt: [0.7, 0.66, 0.6, 0.5] }),
  },
  [Mat.CONCRETE_CEIL]: {
    glsl: CONCRETE_CEIL, normalStrength: 1.5, heightScale: 0.005, trim: [0.995, 1.001, 1.007],
    phys: phys(0.6, { det: 4, detS: 0.8, sigma: 0.35, dirt: [0.75, 0.72, 0.66, 0.4] }), frame: [2.4, 2.4],
  },
  [Mat.FLOOR_PAINT]: {
    glsl: FLOOR_PAINT, normalStrength: 1.0, heightScale: 0.0005, trim: [1.11, 1.119, 1.131],
    phys: phys(0.15),
  },
  [Mat.TERRAZZO]: {
    glsl: TERRAZZO, normalStrength: 1.0, heightScale: 0.002, trim: [1.088, 1.089, 1.117],
    phys: phys(0.1, { det: 13, detS: 0.6, glaze: 0.09, roughComp: 0.45, tok: 0.5, dirt: [0.6, 0.58, 0.52, 0.5] }),
  },
};
