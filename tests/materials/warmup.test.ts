import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileMaterials } from '../../src/core/runtime.ts';
import { runWarmup } from '../../src/materials/warmup.ts';

/** Stand-in pinned materials: runWarmup only reads the variant and the name. */
function pinnedOf(): TileMaterials {
  const m = (variant: string): THREE.Material => {
    const x = new THREE.MeshBasicMaterial();
    x.name = `br-${variant}`;
    x.userData.brVariant = variant;
    return x;
  };
  return { shell: m('shell'), props: m('props'), decal: m('decal'), water: m('water'), depth: m('depth') } as unknown as TileMaterials;
}

describe('runWarmup', () => {
  it('keeps the warmup triangles out of the app frames that run while compileAsync waits', async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const group = (): THREE.Object3D | undefined => scene.children.find((o) => o.name === 'br-warmup');
    const log: string[] = [];
    let release: () => void = () => {};
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      // three compiles synchronously inside compileAsync and then polls on timers (no KHR_parallel_shader_compile)
      compileAsync: () => {
        log.push(`compile visible=${group()?.visible}`);
        return new Promise<void>((r) => { release = r; });
      },
      render: () => { log.push(`render visible=${group()?.visible}`); },
      properties: { get: () => ({}) },
      getContext: () => ({}),
    } as unknown as THREE.WebGLRenderer;
    const done = runWarmup(renderer, camera, scene, pinnedOf());
    // an app frame now (the loop keeps rendering during the wait) must not see the triangles: the water one sits on
    // layer 0 and would be drawn into the MRT sceneRT of a split frame, which it has no outputs for
    expect(group()).toBeDefined();
    expect(group()?.visible).toBe(false);
    release();
    await done;
    expect(log).toEqual(['compile visible=true', 'render visible=true']);
    expect(group()).toBeUndefined();
  });
});
