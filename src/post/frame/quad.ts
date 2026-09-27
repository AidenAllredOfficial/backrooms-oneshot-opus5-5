// src/post/frame/quad.ts — full-screen passes of the frame graph (post/ScenePass.ts): one oversized triangle, the
// same geometry as pmndrs' Pass (so a port rasterises exactly the same fragments), and the ShaderMaterial settings
// every screen-space pass shares (GLSL3, no depth test or write, no blending, linear output).

import * as THREE from 'three';

/** The screen-covering triangle (-1,-1) (3,-1) (-1,3); vertex shaders use position.xy as clip coordinates. */
export const QUAD_VERT = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

/** A full-screen pass material: GLSL3 (declare `layout( location = 0 ) out`), depth test/write off, NoBlending. */
export function quadMaterial(name: string, frag: string, defines: Record<string, string | number>, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name, glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: frag, defines, uniforms,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
}

let sharedGeometry: THREE.BufferGeometry | null = null;
function triangle(): THREE.BufferGeometry {
  if (sharedGeometry) return sharedGeometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  sharedGeometry = g;
  return g;
}

/** Draws one material over a whole render target (its own tiny scene: no lights, no background, no shadow work). */
export class FullscreenQuad {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;

  constructor() {
    this.mesh = new THREE.Mesh(triangle(), undefined);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Render `material` into `target` (bound here; the caller rebinds its own target afterwards). */
  render(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
}
