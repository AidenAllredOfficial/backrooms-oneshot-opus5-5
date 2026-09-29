// tests/post/ambientOcclusion.test.ts — the pre-shade SSAO helper (SsaoPre): structure (no GL context needed to
// build it), its render targets and what it publishes.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hemisphereSamples, SsaoPre } from '../../src/post/AmbientOcclusionPass.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { AO_SAMPLES } from '../../src/post/PostStack.ts';
import { QUALITY } from '../../src/core/quality.ts';

type Internals = { zRT: THREE.WebGLRenderTarget; zRT2: THREE.WebGLRenderTarget; aoRT: THREE.WebGLRenderTarget; denoiseRT: THREE.WebGLRenderTarget; denoiseMat: THREE.ShaderMaterial };

describe('SsaoPre', () => {
  it('uses N8AO\'s hemisphere set (Fibonacci disk lifted onto the unit hemisphere)', () => {
    for (const n of [8, 12, 16]) {
      const s = hemisphereSamples(n);
      expect(s).toHaveLength(n);
      for (const v of s) { expect(v.length()).toBeCloseTo(1, 6); expect(v.z).toBeGreaterThan(0); }
      expect(s[0].x).toBeCloseTo(Math.sqrt(0.5 / n), 6);
    }
  });

  it('has a sample count for every preset AO level', () => {
    for (const q of Object.values(QUALITY)) if (q.ao !== 'off') expect(AO_SAMPLES[q.ao]).toBeGreaterThanOrEqual(8);
  });

  it('sizes its targets from the drawing buffer (half resolution, coarse depth at half of that)', () => {
    const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 400);
    const p = new SsaoPre(cam, { samples: 12, halfRes: true });
    p.setSize(1921, 1081);
    const i = p as unknown as Internals;
    expect([i.aoRT.width, i.aoRT.height]).toEqual([961, 541]);
    expect([i.denoiseRT.width, i.denoiseRT.height]).toEqual([961, 541]);
    expect([i.zRT.width, i.zRT.height]).toEqual([961, 541]);
    expect([i.zRT2.width, i.zRT2.height]).toEqual([481, 271]);
    expect(i.zRT.texture.type).toBe(THREE.FloatType);
    expect(p.step).toBe(2);
    for (const m of p.materials) expect(m.defines.BR_AO_STEP).toBe(2);
    p.dispose();
  });

  it('has no composite: the surface shader applies the AO (no blending program, three passes only)', () => {
    const p = new SsaoPre(new THREE.PerspectiveCamera(), { samples: 16, halfRes: false });
    expect(p.materials.map((m) => m.name)).toEqual(['br-ao-z', 'br-ao', 'br-ao-denoise']);
    for (const m of p.materials) {
      expect(m.blending).toBe(THREE.NoBlending);
      expect(m.fragmentShader).not.toContain('uColor');
      expect(m.defines.BR_AO_STEP).toBe(1);
    }
    p.dispose();
  });

  it('normal reconstruction uses an inward derivative at each screen edge', () => {
    const p = new SsaoPre(new THREE.PerspectiveCamera(), { samples: 12, halfRes: true });
    const src = p.materials.find((m) => m.name === 'br-ao')!.fragmentShader;
    // Repeated clamped depths have zero extrapolation error. They must not win the best-side test on the outside
    // of the frame, where their view ray does not correspond to an actual sample on a slanted wall.
    expect(src).toContain('p.x > 0 && ( p.x >= int( uFull.x ) - 1 || dl < dr )');
    expect(src).toContain('p.y > 0 && ( p.y >= int( uFull.y ) - 1 || db < dt )');
    expect(src).toContain('vec3 dpdx = useL ?');
    expect(src).toContain('vec3 dpdy = useB ?');
    p.dispose();
  });

  it('the denoise filters .r and copies the centre texel\'s view depth and normal (.gba) unchanged', () => {
    const p = new SsaoPre(new THREE.PerspectiveCamera(), { samples: 12, halfRes: true });
    const src = (p as unknown as Internals).denoiseMat.fragmentShader;
    expect(src).toContain('outAo = vec4( wsum > 1e-4 ? sum / wsum : c.r, c.gba );');
    expect(src).toContain('if ( c.g >= 1e4 ) { outAo = c; return; }');
    p.dispose();
  });

  it('renders only into its own targets (five quads) and publishes into the material globals', () => {
    const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 400);
    const p = new SsaoPre(cam, { samples: 12, halfRes: true });
    p.intensity = 2.5;
    p.powScale = 0.8;
    const i = p as unknown as Internals;
    const own = new Set<unknown>([i.zRT, i.zRT2, i.aoRT, i.denoiseRT]);
    const bound: unknown[] = [];
    const renderer = { setRenderTarget(t: unknown) { bound.push(t); }, render() {} };
    const g = createGlobals();
    const inert = g.ssaoTex.value;
    const depth = new THREE.DepthTexture(1920, 1080, THREE.FloatType);
    p.run({ renderer: renderer as unknown as THREE.WebGLRenderer, camera: cam, depth, width: 1920, height: 1080, globals: g });
    expect(bound).toHaveLength(5);
    for (const t of bound) expect(own.has(t)).toBe(true);
    expect(bound[bound.length - 1]).toBe(i.aoRT);
    for (const m of p.materials) expect(m.uniforms.tDepth.value).toBe(depth);
    expect(g.ssaoTex.value).toBe(p.texture);
    expect(g.ssaoParams.value.toArray()).toEqual([1, 2.5 * 0.8, 0.7 * 0.6 * 0.2, 2]);
    const e = cam.projectionMatrix.elements;
    expect(g.ssaoProj.value.toArray()).toEqual([e[0], e[5], e[8], e[9]]);
    expect(g.ssaoSize.value.toArray()).toEqual([1920, 1080, 1 / 1920, 1 / 1080]);
    // disabled: nothing rendered, the surfaces skip the lookup
    p.enabled = false;
    p.run({ renderer: renderer as unknown as THREE.WebGLRenderer, camera: cam, depth, width: 1920, height: 1080, globals: g });
    expect(bound).toHaveLength(5);
    expect(g.ssaoParams.value.x).toBe(0);
    // disposing (quality switch) hands the globals back their inert stand-in
    p.dispose();
    expect(g.ssaoTex.value).toBe(inert);
  });

  it('denoise weights (0.5, 1, 1, 1, 0.5) give every residue class of the 4x4 pattern the same weight', () => {
    const w = [0.5, 1, 1, 1, 0.5];
    for (let centre = 0; centre < 4; centre++) {
      const sums = [0, 0, 0, 0];
      for (let k = -2; k <= 2; k++) sums[(((centre + k) % 4) + 4) % 4] += w[k + 2];
      expect(sums).toEqual([1, 1, 1, 1]);
    }
  });
});
