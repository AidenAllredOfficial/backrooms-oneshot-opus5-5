// src/materials/anchors.ts — every three.js shader chunk that WP9 injects after / replaces. `include` is the
// ShaderChunk name; the anchor in the source text is `#include <${include}>`. tests/materials/anchors.test.ts
// asserts each one exists in ShaderLib.physical (three pinned to 0.186.1).

export type AnchorMode = 'after' | 'replace';
export interface ShaderAnchor { stage: 'vertex' | 'fragment'; include: string; mode: AnchorMode }

/** The full injection plan, in source order per stage (SurfaceMaterial applies exactly these). */
export const SURFACE_INJECTIONS: readonly ShaderAnchor[] = [
  { stage: 'vertex', include: 'common', mode: 'after' },
  { stage: 'vertex', include: 'uv_vertex', mode: 'after' },
  { stage: 'vertex', include: 'begin_vertex', mode: 'after' },
  { stage: 'vertex', include: 'worldpos_vertex', mode: 'after' },
  { stage: 'fragment', include: 'common', mode: 'after' },
  { stage: 'fragment', include: 'clipping_planes_pars_fragment', mode: 'after' },
  { stage: 'fragment', include: 'clipping_planes_fragment', mode: 'after' },
  { stage: 'fragment', include: 'map_fragment', mode: 'replace' },
  { stage: 'fragment', include: 'roughnessmap_fragment', mode: 'replace' },
  { stage: 'fragment', include: 'metalnessmap_fragment', mode: 'replace' },
  { stage: 'fragment', include: 'normal_fragment_maps', mode: 'replace' },
  { stage: 'fragment', include: 'emissivemap_fragment', mode: 'replace' },
  // after three fills `material` and before lights_fragment_begin computes material.dfg (chunks/materialPost.ts)
  { stage: 'fragment', include: 'lights_physical_fragment', mode: 'after' },
  { stage: 'fragment', include: 'lights_fragment_maps', mode: 'replace' },
  { stage: 'fragment', include: 'aomap_fragment', mode: 'replace' },
  { stage: 'fragment', include: 'fog_fragment', mode: 'replace' },
];

export const SHADER_ANCHORS: readonly { stage: 'vertex' | 'fragment'; include: string }[] =
  SURFACE_INJECTIONS.map(({ stage, include }) => ({ stage, include }));

/** Insert `code` after, or in place of, `#include <include>`. Throws if the anchor is missing (anchor drift must
 * fail loudly, never silently produce a half-injected shader). */
export function injectAt(src: string, include: string, code: string, mode: AnchorMode): string {
  const anchor = `#include <${include}>`;
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`WP9 shader anchor missing: ${anchor}`);
  if (src.indexOf(anchor, i + anchor.length) >= 0) throw new Error(`WP9 shader anchor not unique: ${anchor}`);
  const rep = mode === 'after' ? `${anchor}\n${code}\n` : `\n${code}\n`;
  return src.slice(0, i) + rep + src.slice(i + anchor.length);
}
