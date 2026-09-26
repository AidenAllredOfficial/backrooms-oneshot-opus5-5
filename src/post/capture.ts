// src/post/capture.ts (WP11) — display blit + frame capture.
// The last post pass renders the finished, sRGB-ENCODED image into an RGBA8 target (`display`). Every frame that
// target is blitted 1:1 to the canvas (raw copy, no colour conversion). capture(w, h) downsamples the same
// target into a w x h RGBA8 target (box filter in linear light, rows flipped so row 0 is the TOP of the image)
// and reads it back with readRenderTargetPixelsAsync.

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BLIT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
void main() { gl_FragColor = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
uniform int uTaps;
varying vec2 vUv;
vec3 dec(vec3 c) { return mix(c / 12.92, pow((max(c, vec3(0.04045)) + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 enc(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y); // row 0 of the readback = top of the image
  vec2 foot = 1.0 / uDstSize;          // footprint of one output pixel in source uv
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int j = 0; j < 8; j++) {
    if (j >= uTaps) break;
    for (int i = 0; i < 8; i++) {
      if (i >= uTaps) break;
      vec2 o = (vec2(float(i), float(j)) + 0.5) / float(uTaps) - 0.5;
      acc += dec(texture2D(tSrc, uv + o * foot).rgb);
      n += 1.0;
    }
  }
  gl_FragColor = vec4(enc(acc / n), 1.0);
}
`;

function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

export interface DisplayCapture {
  /** RGBA8 target the last post pass renders into (sRGB-encoded bytes). */
  readonly display: THREE.WebGLRenderTarget;
  setSize(w: number, h: number): void;
  /** Blit `display` to the canvas (renderer target null). */
  blit(renderer: THREE.WebGLRenderer): void;
  /** Compile the downsample program once (keeps renderer.info.programs constant after ready). */
  warm(renderer: THREE.WebGLRenderer): void;
  /** Downsample `display` into a w x h RGBA8 image (top row first) and read it back. */
  read(renderer: THREE.WebGLRenderer, w: number, h: number): Promise<Uint8Array>;
  dispose(): void;
}

export function createDisplayCapture(width: number, height: number): DisplayCapture {
  const display = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  display.texture.name = 'Post.Display';
  const geo = fullscreenTriangle();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitMat = new THREE.ShaderMaterial({
    name: 'br-post-blit', vertexShader: VERT, fragmentShader: BLIT_FRAG, uniforms: { tSrc: { value: display.texture } },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const downMat = new THREE.ShaderMaterial({
    name: 'br-post-capture', vertexShader: VERT, fragmentShader: DOWN_FRAG,
    uniforms: {
      tSrc: { value: display.texture }, uSrcSize: { value: new THREE.Vector2(width, height) },
      uDstSize: { value: new THREE.Vector2(1, 1) }, uTaps: { value: 1 },
    },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const quad = new THREE.Mesh(geo, blitMat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const targets = new Map<string, THREE.WebGLRenderTarget>();
  const targetFor = (w: number, h: number): THREE.WebGLRenderTarget => {
    const key = `${w}x${h}`;
    let rt = targets.get(key);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      rt.texture.name = `Post.Capture.${key}`;
      targets.set(key, rt);
    }
    return rt;
  };
  const renderDown = (renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, w: number, h: number): void => {
    const u = downMat.uniforms;
    u.uSrcSize.value.set(display.width, display.height);
    u.uDstSize.value.set(w, h);
    const foot = Math.max(display.width / w, display.height / h);
    u.uTaps.value = Math.max(1, Math.min(8, Math.ceil(foot / 1.5)));
    quad.material = downMat;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    quad.material = blitMat;
  };

  return {
    display,
    setSize(w, h) {
      display.setSize(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
    },
    blit(renderer) {
      quad.material = blitMat;
      renderer.setRenderTarget(null);
      renderer.render(scene, cam);
    },
    warm(renderer) {
      renderDown(renderer, targetFor(1, 1), 1, 1);
    },
    read(renderer, w, h) {
      const W = Math.max(1, Math.floor(w)), H = Math.max(1, Math.floor(h));
      const rt = targetFor(W, H);
      renderDown(renderer, rt, W, H);
      const px = new Uint8Array(W * H * 4);
      return renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H, px).then(() => px);
    },
    dispose() {
      display.dispose();
      for (const rt of targets.values()) rt.dispose();
      targets.clear();
      geo.dispose();
      blitMat.dispose();
      downMat.dispose();
    },
  };
}
