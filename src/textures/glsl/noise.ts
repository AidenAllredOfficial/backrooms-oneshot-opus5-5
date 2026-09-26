// src/textures/glsl/noise.ts — periodic GLSL noise library (WP8).
//
// Every function takes `uv` in FRAME units (one texture repeat = [0,1)) and an integer period `P` (lattice cells
// across one repeat, per axis). The lattice wraps every P cells, so every function is exactly periodic in uv with
// period 1 and continuous across the wrap: a layer built only from these functions (plus uv-periodic geometry)
// tiles. uv outside [0,1) is valid (the seam check evaluates at uv = -0.5 texel).
//
// Band limiting: `br_texel` (uv size of one (sub)sample, set by the generator main) fades out octaves whose lattice
// frequency approaches Nyquist, so fbm never bakes moiré into a texture; single-octave vnoise/gnoise fade the same
// way (br_vnoise / br_gnoise are the raw lattice functions).
//
// Hashing is integer (uint) based, so results are identical on every GPU and independent of float precision.
//
// Library contents:
//   br_hash / hashI / hashf / hash2f / hash4f        integer hashing of wrapped lattice cells
//   wrapCell                                          lattice wrap (cell mod P, always non-negative)
//   vnoise(uv, P, seed)            value noise, [0,1]       (band limited: fades to 0.5 near Nyquist)
//   gnoise(uv, P, seed)            gradient (Perlin) noise, ~[-1,1] (band limited: fades to 0)
//   fbm(uv, P, oct, seed)          gradient fBm, ~[-1,1], lacunarity 2, gain 0.5, band limited
//   fbmV(uv, P, oct, seed)         value fBm, [0,1]
//   turb(uv, P, oct, seed)         |gradient| turbulence, [0,1]
//   ridged(uv, P, oct, seed)       ridged multifractal, [0,1], 1 on ridges
//   warp(uv, P, oct, seed, amt)    domain warp: uv + amt * (fbm, fbm)  (periodic because the offset is periodic)
//   worley(uv, P, jitter, seed)    Worley: F1, F2 (cell units), id (wrapped cell), rel (vector to nearest point)
//   worleyEdge(uv, P, jitter, seed) exact distance to the Voronoi cell border (cell units) + nearest cell id

export const NOISE_GLSL: string = /* glsl */ `
// ---------------------------------------------------------------- NOISE_GLSL (WP8, periodic)
vec2 br_texel = vec2(1.0 / 1024.0); // uv size of one sample; the generator main overwrites it

uint br_hash(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
uint hashI(ivec2 c, int seed) {
  uint h = br_hash(uint(c.x) * 0x9E3779B9u + uint(seed) * 0x632BE5ABu);
  return br_hash(h ^ (uint(c.y) * 0x85EBCA6Bu + 0x165667B1u));
}
float hashf(ivec2 c, int seed) { return float(hashI(c, seed) >> 8u) * (1.0 / 16777216.0); }
vec2 hash2f(ivec2 c, int seed) {
  uint h = hashI(c, seed);
  return vec2(float(h >> 16u), float(h & 0xffffu)) * (1.0 / 65536.0);
}
vec4 hash4f(ivec2 c, int seed) {
  uint h = hashI(c, seed);
  uint g = br_hash(h + 0x27d4eb2du);
  return vec4(float(h >> 16u), float(h & 0xffffu), float(g >> 16u), float(g & 0xffffu)) * (1.0 / 65536.0);
}
float hashf(vec2 c, int seed) { return hashf(ivec2(c), seed); }
vec2 hash2f(vec2 c, int seed) { return hash2f(ivec2(c), seed); }
vec4 hash4f(vec2 c, int seed) { return hash4f(ivec2(c), seed); }

// cell mod P for integer-valued floats, result in [0, P). Drivers compile c / P as c * (1 / P), so floor(P / P)
// can come out 0 (or floor((kP - 1) / P) = k); the two corrections make the wrap exact regardless.
vec2 wrapCell(vec2 c, vec2 P) {
  vec2 r = c - P * floor(c / P);
  r -= P * step(P - 0.5, r);
  r += P * step(r, vec2(-0.5));
  return r;
}

// 1 while the lattice is well below Nyquist, fading to 0 as a cell shrinks toward ~1.5 samples
float br_bandLimit(vec2 P) {
  float cyclesPerSample = max(P.x * br_texel.x, P.y * br_texel.y);
  return 1.0 - smoothstep(0.35, 0.7, cyclesPerSample);
}

vec2 br_fade(vec2 f) { return f * f * f * (f * (f * 6.0 - 15.0) + 10.0); }

float br_vnoise(vec2 uv, ivec2 Pi, int seed) {
  vec2 P = vec2(Pi);
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = br_fade(f);
  vec2 i0 = wrapCell(i, P);
  vec2 i1 = wrapCell(i + 1.0, P);
  float a = hashf(ivec2(i0.x, i0.y), seed);
  float b = hashf(ivec2(i1.x, i0.y), seed);
  float c = hashf(ivec2(i0.x, i1.y), seed);
  float d = hashf(ivec2(i1.x, i1.y), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 br_grad(ivec2 c, int seed) {
  float a = hashf(c, seed) * 6.28318530718;
  return vec2(cos(a), sin(a));
}

float br_gnoise(vec2 uv, ivec2 Pi, int seed) {
  vec2 P = vec2(Pi);
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = br_fade(f);
  vec2 i0 = wrapCell(i, P);
  vec2 i1 = wrapCell(i + 1.0, P);
  float a = dot(br_grad(ivec2(i0.x, i0.y), seed), f);
  float b = dot(br_grad(ivec2(i1.x, i0.y), seed), f - vec2(1.0, 0.0));
  float c = dot(br_grad(ivec2(i0.x, i1.y), seed), f - vec2(0.0, 1.0));
  float d = dot(br_grad(ivec2(i1.x, i1.y), seed), f - vec2(1.0, 1.0));
  return 1.45 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Public single-octave noise is band limited like the fBm octaves: a lattice finer than ~1.5 samples fades to the
// mean (0.5 value / 0 gradient), so a 700-cell call at 512 texels gives flat mean instead of aliased texel grain.
float vnoise(vec2 uv, ivec2 Pi, int seed) { return mix(0.5, br_vnoise(uv, Pi, seed), br_bandLimit(vec2(Pi))); }
float gnoise(vec2 uv, ivec2 Pi, int seed) { return br_bandLimit(vec2(Pi)) * br_gnoise(uv, Pi, seed); }

float fbm(vec2 uv, ivec2 P, int oct, int seed) {
  float s = 0.0, a = 0.5, n = 0.0;
  ivec2 p = P;
  for (int k = 0; k < 10; k++) {
    if (k >= oct) break;
    s += a * br_bandLimit(vec2(p)) * br_gnoise(uv, p, seed + k * 131);
    n += a;
    a *= 0.5;
    p *= 2;
  }
  return s / n;
}

float fbmV(vec2 uv, ivec2 P, int oct, int seed) {
  float s = 0.0, a = 0.5, n = 0.0;
  ivec2 p = P;
  for (int k = 0; k < 10; k++) {
    if (k >= oct) break;
    float bl = br_bandLimit(vec2(p));
    s += a * mix(0.5, br_vnoise(uv, p, seed + k * 131), bl);
    n += a;
    a *= 0.5;
    p *= 2;
  }
  return s / n;
}

float turb(vec2 uv, ivec2 P, int oct, int seed) {
  float s = 0.0, a = 0.5, n = 0.0;
  ivec2 p = P;
  for (int k = 0; k < 10; k++) {
    if (k >= oct) break;
    float bl = br_bandLimit(vec2(p));
    s += a * mix(0.35, abs(br_gnoise(uv, p, seed + k * 131)), bl);
    n += a;
    a *= 0.5;
    p *= 2;
  }
  return clamp(s / n, 0.0, 1.0);
}

float ridged(vec2 uv, ivec2 P, int oct, int seed) {
  float s = 0.0, a = 0.5, n = 0.0, w = 1.0;
  ivec2 p = P;
  for (int k = 0; k < 10; k++) {
    if (k >= oct) break;
    float bl = br_bandLimit(vec2(p));
    float r = 1.0 - abs(br_gnoise(uv, p, seed + k * 131));
    r *= r;
    r = mix(0.45, r, bl);
    s += a * r * w;
    w = clamp(r * 1.5, 0.0, 1.0);
    n += a;
    a *= 0.5;
    p *= 2;
  }
  return clamp(s / n, 0.0, 1.0);
}

vec2 warp(vec2 uv, ivec2 P, int oct, int seed, float amt) {
  return uv + amt * vec2(fbm(uv, P, oct, seed), fbm(uv, P, oct, seed + 7919));
}

struct Cell { float f1; float f2; vec2 id; vec2 rel; };

Cell worley(vec2 uv, ivec2 Pi, float jitter, int seed) {
  vec2 P = vec2(Pi);
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = p - i;
  Cell c; c.f1 = 8.0; c.f2 = 8.0; c.id = vec2(0.0); c.rel = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 w = wrapCell(i + o, P);
      vec2 pt = o + 0.5 + jitter * (hash2f(ivec2(w), seed) - 0.5);
      vec2 d = pt - f;
      float dd = dot(d, d);
      if (dd < c.f1) { c.f2 = c.f1; c.f1 = dd; c.id = w; c.rel = d; }
      else if (dd < c.f2) { c.f2 = dd; }
    }
  }
  c.f1 = sqrt(c.f1); c.f2 = sqrt(c.f2);
  return c;
}

// x: distance to the nearest Voronoi border (cell units), yz: wrapped id of the nearest cell
vec3 worleyEdge(vec2 uv, ivec2 Pi, float jitter, int seed) {
  vec2 P = vec2(Pi);
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 mr = vec2(0.0), mo = vec2(0.0), mid = vec2(0.0);
  float md = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 w = wrapCell(i + o, P);
      vec2 r = o + 0.5 + jitter * (hash2f(ivec2(w), seed) - 0.5) - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mo = o; mid = w; }
    }
  }
  md = 8.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 o = mo + vec2(float(x), float(y));
      vec2 w = wrapCell(i + o, P);
      vec2 r = o + 0.5 + jitter * (hash2f(ivec2(w), seed) - 0.5) - f;
      vec2 dr = r - mr;
      if (dot(dr, dr) > 1e-6) md = min(md, dot(0.5 * (mr + r), normalize(dr)));
    }
  }
  return vec3(md, mid);
}
`;
