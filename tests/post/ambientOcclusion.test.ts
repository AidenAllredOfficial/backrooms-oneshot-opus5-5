// tests/post/ambientOcclusion.test.ts — AmbientOcclusionPass structure (no GL context needed to build it).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AmbientOcclusionPass, hemisphereSamples } from '../../src/post/AmbientOcclusionPass.ts';
import { AO_SAMPLES } from '../../src/post/PostStack.ts';
import { QUALITY } from '../../src/core/quality.ts';

type Internals = { zRT: THREE.WebGLRenderTarget; zRT2: THREE.WebGLRenderTarget; aoRT: THREE.WebGLRenderTarget; denoiseRT: THREE.WebGLRenderTarget; compMat: THREE.ShaderMaterial };

describe('AmbientOcclusionPass', () => {
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
    const p = new AmbientOcclusionPass(cam, { samples: 12, halfRes: true });
    p.setSize(1921, 1081);
    const i = p as unknown as Internals;
    expect([i.aoRT.width, i.aoRT.height]).toEqual([961, 541]);
    expect([i.denoiseRT.width, i.denoiseRT.height]).toEqual([961, 541]);
    expect([i.zRT.width, i.zRT.height]).toEqual([961, 541]);
    expect([i.zRT2.width, i.zRT2.height]).toEqual([481, 271]);
    expect(i.zRT.texture.type).toBe(THREE.FloatType);
    expect(p.needsSwap).toBe(false);
    expect(p.needsDepthTexture).toBe(true);
    for (const m of p.materials) expect(m.defines.BR_AO_STEP).toBe(2);
    p.dispose();
  });

  it('multiplies the scene colour in place (N8AO composite: scene x mix(color, 1, ao^intensity))', () => {
    const p = new AmbientOcclusionPass(new THREE.PerspectiveCamera(), { samples: 16, halfRes: false });
    const m = (p as unknown as Internals).compMat;
    expect(m.blending).toBe(THREE.CustomBlending);
    expect([m.blendSrc, m.blendDst, m.blendSrcAlpha, m.blendDstAlpha]).toEqual([THREE.ZeroFactor, THREE.SrcColorFactor, THREE.ZeroFactor, THREE.OneFactor]);
    expect(m.fragmentShader).toContain('mix( uColor, vec3( 1.0 ), a )');
    expect(m.defines.BR_AO_STEP).toBe(1);
    p.dispose();
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
