// tests/materials/depthPrepass.test.ts — the invariants the depth prepass (materials/prepass.ts, DepthMaterial.ts)
// and the flat per-face varyings (chunks/vertex.ts) rely on, plus the prepass render bookkeeping.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VFlag, Zone, type ZoneId } from '../../src/core/ids.ts';
import { LAYER_DEFS } from '../../src/core/materials.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { createDepthMaterial } from '../../src/materials/DepthMaterial.ts';
import { HELPERS_GLSL } from '../../src/materials/chunks/common.ts';
import { TUNE } from '../../src/materials/chunks/params.ts';
import { PREPASS, renderWithPrepass } from '../../src/materials/prepass.ts';
import { buildSurfaceFragment, buildSurfaceVertex } from '../../src/materials/SurfaceMaterial.ts';
import { genNb, tileKey } from '../mesh/helpers.ts';

const ZONES: ZoneId[] = [Zone.LOBBY, Zone.OFFICE, Zone.PARKING, Zone.POOLROOMS, Zone.PIPEWORKS, Zone.WAREHOUSE];

function* tileMeshes(): Generator<[string, MeshBuffers]> {
  for (const z of ZONES) {
    const s = z === Zone.POOLROOMS ? 2 : z === Zone.LOBBY || z === Zone.OFFICE ? 0 : 1;
    const nb = genNb(7, s, 0, 0, z);
    for (let q = 0; q < 4; q++) {
      const { mesh } = buildTile(nb, tileKey(s, 0, 0, q), 8);
      for (const [name, m] of [['shell', mesh.shell], ['props', mesh.props], ['decals', mesh.decals]] as const) {
        if (m && m.indexCount > 0) yield [`${z}/${q}/${name}`, m];
      }
    }
  }
}

describe('per-face vertex state', () => {
  it('layer, flags, tint, emit and aux are equal on the three vertices of every triangle (flat varyings)', () => {
    let tris = 0;
    for (const [name, m] of tileMeshes()) {
      const I = m.index;
      for (let t = 0; t < m.indexCount; t += 3) {
        const a = I[t], b = I[t + 1], c = I[t + 2];
        for (const v of [b, c]) {
          const same = m.layer[v] === m.layer[a] && m.flags[v] === m.flags[a] && m.emit[v] === m.emit[a] &&
            m.tint[v * 4] === m.tint[a * 4] && m.tint[v * 4 + 1] === m.tint[a * 4 + 1] && m.tint[v * 4 + 2] === m.tint[a * 4 + 2] &&
            m.tint[v * 4 + 3] === m.tint[a * 4 + 3] && m.aux[v * 4] === m.aux[a * 4] && m.aux[v * 4 + 1] === m.aux[a * 4 + 1] &&
            m.aux[v * 4 + 2] === m.aux[a * 4 + 2] && m.aux[v * 4 + 3] === m.aux[a * 4 + 3];
          if (!same) throw new Error(`${name}: triangle ${t / 3} mixes per-face state`);
        }
        tris++;
      }
    }
    expect(tris).toBeGreaterThan(10000);
  });

  it('alpha-tested (DECAL-flag) shell/props surfaces use layers the depth program samples like the surface program', () => {
    const layers = new Set<number>();
    for (const [name, m] of tileMeshes()) {
      if (name.endsWith('decals')) continue;
      for (let v = 0; v < m.vertexCount; v++) if (m.flags[v] & VFlag.DECAL) layers.add(m.layer[v]);
    }
    expect(layers.size).toBeGreaterThan(0);
    for (const l of layers) {
      const d = LAYER_DEFS[l];
      // plain textureGrad path: no rotated physical tiles, no stochastic tiling, no wallpaper roll offset
      expect(d.tileSize, d.name).toBe(0);
      expect(d.hexTile ?? 0, d.name).toBe(0);
      expect(d.name.startsWith('WALLPAPER'), d.name).toBe(false);
    }
  });
});

describe('depth program', () => {
  const shared = { albedo: { value: new THREE.Texture() }, reflPass: { value: 0 } };
  const bindings = { fade: { value: 1 } };
  const depth = createDepthMaterial(shared as never, bindings as never, true);

  it('computes gl_Position with three\'s project_vertex expressions, invariant in both programs', () => {
    const pv = THREE.ShaderChunk.project_vertex;
    for (const line of ['vec4 mvPosition = vec4( transformed, 1.0 );', 'mvPosition = modelViewMatrix * mvPosition;', 'gl_Position = projectionMatrix * mvPosition;']) {
      expect(pv).toContain(line);
      expect(depth.vertexShader).toContain(line);
    }
    expect(depth.vertexShader).toContain('invariant gl_Position;');
    expect(buildSurfaceVertex(THREE.ShaderLib.physical.vertexShader)).toContain('invariant gl_Position;');
  });

  it('shares the fade dither, the reflection props cull and the uniform objects', () => {
    const bayer = /const float m\[ 16 \] = float\[ 16 \]\([^)]*\);/;
    expect(depth.fragmentShader.match(bayer)?.[0]).toBe(HELPERS_GLSL.match(bayer)?.[0]);
    expect(depth.fragmentShader).toContain(`length( vViewPosition ) > ${TUNE.REFL_PROP_DIST.toFixed(1)}`);
    expect(depth.uniforms.uFade).toBe(bindings.fade);
    expect(depth.uniforms.uBrReflPass).toBe(shared.reflPass);
    expect(depth.uniforms.uPropCull.value).toBe(1);
    expect(depth.colorWrite).toBe(false);
    expect(depth.side).toBe(THREE.FrontSide);
  });

  it('POM and detail maps only move texture lookups: nothing writes gl_FragDepth, the depth program has neither', () => {
    // parallax occlusion mapping shifts the shading uv of the flat face; depth, discards and silhouettes stay those of
    // the geometry, so the prepass depth still matches the shading pass bit for bit
    expect(buildSurfaceFragment(THREE.ShaderLib.physical.fragmentShader)).not.toMatch(/gl_FragDepth/);
    expect(depth.fragmentShader).not.toMatch(/gl_FragDepth|BR_POM|brPom|uBrDetail/);
  });
});

describe('renderWithPrepass', () => {
  const setup = () => {
    const scene = new THREE.Scene();
    const depthMat = new THREE.MeshBasicMaterial();
    const surf = new THREE.MeshBasicMaterial(); surf.userData.brDepth = depthMat;
    const surf2 = new THREE.MeshBasicMaterial();
    const geo = new THREE.BoxGeometry();
    const shell = new THREE.Mesh(geo, [surf, surf2]); // grouped mesh: the first material decides
    const props = new THREE.Mesh(geo, surf);
    const decal = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    const hiddenProps = new THREE.Mesh(geo, surf); hiddenProps.visible = false;
    scene.add(shell, props, decal, hiddenProps);
    const depth = { mask: true, locked: false, setMask(v: boolean) { if (!this.locked) this.mask = v; }, setLocked(v: boolean) { this.locked = v; } };
    const calls: { shellMat: unknown; propsMat: unknown; decal: boolean; depthLocked: boolean; mask: boolean; shadow: boolean; autoClear: boolean }[] = [];
    const renderer = {
      autoClear: true, shadowMap: { autoUpdate: true }, state: { buffers: { depth } },
      render() {
        calls.push({ shellMat: shell.material, propsMat: props.material, decal: decal.visible, depthLocked: depth.locked, mask: depth.mask, shadow: renderer.shadowMap.autoUpdate, autoClear: renderer.autoClear });
      },
    };
    return { scene, depthMat, surf, surf2, shell, props, decal, hiddenProps, depth, calls, renderer };
  };

  it('renders depth with the depth materials, then shades with depth writes locked off, and restores everything', () => {
    const t = setup();
    renderWithPrepass(t.renderer as unknown as THREE.WebGLRenderer, t.scene, new THREE.PerspectiveCamera());
    expect(t.calls).toHaveLength(2);
    const [pre, shade] = t.calls;
    expect(pre).toMatchObject({ shellMat: t.depthMat, propsMat: t.depthMat, decal: false, depthLocked: false, shadow: true, autoClear: false });
    expect(shade.shellMat).toEqual([t.surf, t.surf2]);
    expect(shade).toMatchObject({ propsMat: t.surf, decal: true, depthLocked: true, mask: false, shadow: false, autoClear: false });
    expect(t.renderer).toMatchObject({ autoClear: true, shadowMap: { autoUpdate: true } });
    expect(t.depth).toMatchObject({ locked: false, mask: true });
    expect(t.hiddenProps.visible).toBe(false);
    expect(t.hiddenProps.material).toBe(t.surf);
  });

  it('restores materials, visibility and state when a draw throws', () => {
    const t = setup();
    let n = 0;
    t.renderer.render = () => { if (++n === 1) throw new Error('boom'); };
    expect(() => renderWithPrepass(t.renderer as unknown as THREE.WebGLRenderer, t.scene, new THREE.PerspectiveCamera())).toThrow('boom');
    expect(t.props.material).toBe(t.surf);
    expect(t.decal.visible).toBe(true);
    expect(t.renderer.autoClear).toBe(true);
    expect(t.depth).toMatchObject({ locked: false, mask: true });
  });

  it('renders once when disabled', () => {
    const t = setup();
    PREPASS.enabled = false;
    try {
      renderWithPrepass(t.renderer as unknown as THREE.WebGLRenderer, t.scene, new THREE.PerspectiveCamera());
    } finally { PREPASS.enabled = true; }
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ propsMat: t.surf, decal: true, depthLocked: false });
  });
});
