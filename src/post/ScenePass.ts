// src/post/ScenePass.ts — the composer's scene pass: pmndrs RenderPass with a depth prepass
// (materials/prepass.ts; identical output, each visible pixel shaded once).

import type * as THREE from 'three';
import { RenderPass } from 'postprocessing';
import { renderWithPrepass } from '../materials/prepass.ts';
import { setWirePixel } from '../materials/shared.ts';

export class ScenePass extends RenderPass {
  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget): void {
    const clear = this.getClearPass();
    if (clear.enabled) clear.render(renderer, inputBuffer, outputBuffer);
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    setWirePixel(this.camera, inputBuffer.height);
    renderWithPrepass(renderer, this.scene, this.camera);
  }
}
