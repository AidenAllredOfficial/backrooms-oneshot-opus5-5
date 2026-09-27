// src/post/frame/blitDepth.ts — copy one render target's depth into another (post/ScenePass.ts: the MRT sceneRT's
// depth into the composer's input buffer, so the late render and the composer's own depth blit see the opaque depth).
// Both targets carry a FloatType DepthTexture (DEPTH_COMPONENT32F) of the same size: a depth blit needs identical
// formats and NEAREST filtering.

import type * as THREE from 'three';

interface FramebufferProps { __webglFramebuffer?: WebGLFramebuffer }

export function blitDepth(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget): void {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  renderer.setRenderTarget(dst); // makes sure the destination framebuffer exists
  const srcFb = (renderer.properties.get(src) as FramebufferProps).__webglFramebuffer ?? null;
  const dstFb = (renderer.properties.get(dst) as FramebufferProps).__webglFramebuffer ?? null;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFb);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dstFb);
  gl.blitFramebuffer(0, 0, src.width, src.height, 0, 0, dst.width, dst.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  // three's state cache still believes `dst` is bound: bind through it so cache and GL agree again
  renderer.setRenderTarget(null);
}
