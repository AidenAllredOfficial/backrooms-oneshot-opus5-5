// src/props/index.ts — WP6 public API: procedural prop, surface-fixture and pipe geometry written through
// GeometryWriter (§5 WP6). Pure module (no three/DOM).
//
// Every kind is built in its PROP_DEFS local frame (base centre at the origin, +Y up, front toward -Z at yaw 0,
// wall-mounted backs on +Z) and fits inside PROP_DEFS.size for every variant and yaw (tested). Variants 0..3 change
// proportions / colours / shape (SHELF_RACK 2 = collapsed, CAR_SEDAN 3 = driver door open); larger variant numbers
// wrap modulo 4. The prop seed only changes tints and seeded placements, never the triangle count.

import { PropFlag, PropKind, PROP_KIND_COUNT, type PropKindId } from '../core/ids.ts';
import type { Fixture, PropPlacement, Solid } from '../core/layout.ts';
import { PROP_DEFS } from '../core/props.ts';
import type { GeometryWriter } from '../core/writer.ts';
import { PartBuilder } from './builder.ts';
import { carSedan } from './car.ts';
import { emitFixtureInto } from './fixtures.ts';
import { chairStacking, conferenceTable, desk, mattress, officeChair, sleepingBag, type PropBuild } from './furniture.ts';
import { boiler, cardboardBox, crate, extinguisher, pallet, pipeValve, shelfRack, tank, ventGrille } from './industrial.ts';
import { backpack, bottle, bucket, ceilingDebris, cone, doorFrame, doorLeaf, elevatorDoor, handrail, mop, tileFragment, wetFloorSign, wheelStop } from './misc.ts';
import { crtMonitor, filingCabinet, outlet, phone, radio, thermostat, trashCan, vendingMachine, waterCooler } from './office.ts';
import { emitPipeInto } from './pipes.ts';
import { benchTiled, floatRope, lifebuoy, loungeChair, poolFloat, poolLadder, towel } from './pool.ts';

/** Number of distinct variants per kind (variant numbers wrap modulo this). */
export const PROP_VARIANTS = 4;

/** Builders indexed by PropKind (order == core/ids.ts PropKind). */
export const PROP_BUILDERS: readonly PropBuild[] = [
  chairStacking, officeChair, desk, filingCabinet, crtMonitor, waterCooler, vendingMachine, conferenceTable, crate,
  pallet, shelfRack, trashCan, cone, wetFloorSign, wheelStop, carSedan, poolLadder, loungeChair, lifebuoy, benchTiled,
  mattress, phone, radio, backpack, doorFrame, doorLeaf, elevatorDoor, ventGrille, outlet, thermostat, extinguisher,
  pipeValve, boiler, tank, handrail, ceilingDebris, tileFragment, bottle, sleepingBag, bucket, mop, cardboardBox,
  floatRope, poolFloat, towel,
];
if (PROP_BUILDERS.length !== PROP_KIND_COUNT) throw new Error('props: builder table out of sync with PropKind');

export const variantIndex = (v: number): number => (((v | 0) % PROP_VARIANTS) + PROP_VARIANTS) % PROP_VARIANTS;

/** Kinds that never gather dust (tileProps.ts dust bits): things that float on (or were just pulled out of) water. */
const DUST_FREE: ReadonlySet<PropKindId> = new Set<PropKindId>([PropKind.POOL_FLOAT, PropKind.LIFEBUOY, PropKind.FLOAT_ROPE]);
/** Does a placed prop of this kind carry the anchor cell's dust level? */
export const propGathersDust = (kind: PropKindId): boolean => !DUST_FREE.has(kind);

const B = new PartBuilder();

/** Default aux ceiling byte when the anchor cell is unknown: a standard 2.7 m ceiling above the base. */
const defaultCeilByte = (p: PropPlacement): number => {
  const ceilM = p.flags & PropFlag.CEILING ? p.y : p.y + 2.7;
  return Math.max(0, Math.min(255, Math.round(ceilM * 20)));
};

/** Emit prop `p` (chunk-local) with explicit PROP_AUX bits / ceiling byte of its anchor cell. Returns tris. */
export function emitPropInto(w: GeometryWriter | null, p: PropPlacement, ox: number, oz: number, auxBits: number, ceilByte: number): number {
  const build = PROP_BUILDERS[p.kind];
  if (!build) return 0;
  const s = p.scale > 0 ? p.scale : 1;
  w?.setTransform(p.yaw, s, p.x - ox, p.y, p.z - oz);
  B.begin(w, (p.flags & PropFlag.CEILING) !== 0, auxBits, ceilByte, p.seed | 0, s);
  build(B, variantIndex(p.variant), p.seed | 0);
  w?.resetTransform();
  return B.tris;
}

/** Emit one prop. (ox,oz) = chunk-local origin of the tile. */
export function emitProp(w: GeometryWriter, p: PropPlacement, ox: number, oz: number): void {
  emitPropInto(w, p, ox, oz, 0, defaultCeilByte(p));
}

/** Emit a non-recessed surface fixture. (ox,oz) = chunk-local origin of the tile. (Recessed kinds are WP5's shell
 * geometry: nothing is written for them.) */
export function emitFixture(w: GeometryWriter, f: Fixture, ox: number, oz: number): void {
  emitFixtureInto(w, f, ox, oz, Number.NaN, 0, Math.max(0, Math.min(255, Math.round((f.py + 0.3) * 20))));
}

/** Emit a pipe solid (10-sided tube, elbows toward `neighbours` sharing an endpoint, flanges, hangers). */
export function emitPipe(
  w: GeometryWriter,
  pipe: Extract<Solid, { kind: 'pipe' }>,
  neighbours: readonly Extract<Solid, { kind: 'pipe' }>[],
  ox: number,
  oz: number,
): void {
  const top = Math.max(pipe.a[1], pipe.b[1]);
  emitPipeInto(w, pipe, neighbours, ox, oz, null, 0, 0, Math.max(0, Math.min(255, Math.round((top + 0.5) * 20))));
}

const trisCache = new Map<number, number>();
/** Triangle count of a prop kind/variant as emitted by emitProp. */
export function propTris(kind: PropKindId, variant: number): number {
  const v = variantIndex(variant);
  const key = kind * PROP_VARIANTS + v;
  const hit = trisCache.get(key);
  if (hit !== undefined) return hit;
  if (!PROP_DEFS[kind]) return 0;
  const n = emitPropInto(null, { kind, variant: v, x: 0, y: 0, z: 0, yaw: 0, scale: 1, flags: 0, seed: 0 }, 0, 0, 0, 0);
  trisCache.set(key, n);
  return n;
}
