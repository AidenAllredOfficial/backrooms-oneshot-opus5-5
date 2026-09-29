import { CHUNK_SIZE, PLAYER } from '../core/constants.ts';
import type { PropPlacement } from '../core/layout.ts';
import type { PlayerState } from '../core/player.ts';
import type { CollisionWorld, PropHit, WorldQuery } from '../core/runtime.ts';
import type { TraversalHost } from './PlayerSystem.ts';
import type { Emit } from '../core/events.ts';

export const angleDelta = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const HALF = 0.44, THICK = 0.035, SEGMENTS = 8;
interface Door {
  p: PropPlacement; cx: number; cz: number; s: PlayerState['s'];
  yaw: number; goal: number; ox: number; oz: number;
}

/** Animated leaves use short collision segments, so an angled door has no invisible square around it. */
export function leafBoxes(p: PropPlacement, ox: number, oz: number, yaw: number, out: Float32Array, n: number): number {
  const d = p.door!;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const length = HALF * 2 * p.scale;
  const tx = Math.abs(s) * THICK, tz = Math.abs(c) * THICK;
  for (let k = 0; k < SEGMENTS && (n + 1) * 6 <= out.length; k++) {
    const a = length * k / SEGMENTS, b = length * (k + 1) / SEGMENTS;
    const x0 = ox + d.hingeX + c * a, z0 = oz + d.hingeZ - s * a;
    const x1 = ox + d.hingeX + c * b, z1 = oz + d.hingeZ - s * b;
    out.set([Math.min(x0, x1) - tx, p.y, Math.min(z0, z1) - tz, Math.max(x0, x1) + tx, p.y + 2.08 * p.scale, Math.max(z0, z1) + tz], n++ * 6);
  }
  return n;
}

export function createHingedDoors(host: TraversalHost) {
  const saved = new Map<string, number>();
  const active: Door[] = [];
  const scratch = new Float32Array(SEGMENTS * 6);
  const key = (s: number, cx: number, cz: number, seed: number) => `${s}:${cx}:${cz}:${seed}`;
  let scanS = -1;
  const find = (hit: PropHit) => active.find((d) => d.p.seed === hit.seed && d.cx === hit.cx && d.cz === hit.cz);

  const intersectsPlayer = (d: Door, yaw: number, player: PlayerState): boolean => {
    if (player.y + PLAYER.height <= d.p.y || player.y >= d.p.y + 2.08) return false;
    const n = leafBoxes(d.p, d.ox, d.oz, yaw, scratch, 0);
    for (let k = 0; k < n; k++) {
      const o = k * 6;
      const x = Math.max(scratch[o], Math.min(scratch[o + 3], player.x));
      const z = Math.max(scratch[o + 2], Math.min(scratch[o + 5], player.z));
      if ((x - player.x) ** 2 + (z - player.z) ** 2 < (PLAYER.radius + 0.012) ** 2) return true;
    }
    return false;
  };

  return {
    update(w: CollisionWorld, player: PlayerState, dt: number, emit?: Emit) {
      const q = w as Partial<WorldQuery>;
      if (!q.layoutAt) return;
      // Reconcile streamed layouts each frame; doors are a small fraction of props and retain their poses on eviction.
      const old = new Map(active.map((d) => [key(d.s, d.cx, d.cz, d.p.seed), d]));
      active.length = 0;
      const cx0 = Math.floor(player.x / CHUNK_SIZE), cz0 = Math.floor(player.z / CHUNK_SIZE);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const cx = cx0 + dx, cz = cz0 + dz, l = q.layoutAt(cx, cz);
        if (!l) continue;
        for (const p of l.props) if (p.door) {
          const id = key(player.s, cx, cz, p.seed);
          const d = old.get(id) ?? { p, cx, cz, s: player.s, yaw: saved.get(id) ?? p.yaw, goal: saved.get(id) ?? p.yaw, ox: cx * CHUNK_SIZE, oz: cz * CHUNK_SIZE };
          d.p = p;
          const delta = angleDelta(d.yaw, d.goal);
          const next = d.yaw + Math.sign(delta) * Math.min(Math.abs(delta), Math.max(0, dt) * 1.7);
          // Stop the swing against the player instead of pushing or trapping them. It resumes when they step clear.
          if (Math.abs(delta) > 1e-5 && !intersectsPlayer(d, next, player)) d.yaw = next;
          if (Math.abs(delta) > 1e-5 && Math.abs(angleDelta(d.yaw, d.goal)) < 1e-5 && Math.abs(angleDelta(p.door.closedYaw, d.goal)) < 1e-5) {
            emit?.('interact', { propKind: p.kind, x: d.ox + p.x, y: p.y, z: d.oz + p.z, yaw: d.yaw, seed: p.seed, door: 'latch' });
          }
          p.yaw = d.yaw;
          p.x = p.door.hingeX + Math.cos(d.yaw) * HALF * p.scale;
          p.z = p.door.hingeZ - Math.sin(d.yaw) * HALF * p.scale;
          saved.set(id, d.yaw);
          host.setDoorYaw?.(player.s, cx, cz, p.seed, d.yaw);
          active.push(d);
        }
      }
      scanS = player.s;
      if (saved.size > 4096) saved.delete(saved.keys().next().value!);
    },
    use(hit: PropHit): 'open' | 'close' | undefined {
      const d = find(hit);
      if (!d) return undefined;
      const frame = d.p.door!;
      const opening = Math.abs(angleDelta(frame.closedYaw, d.goal)) < 0.7;
      d.goal = opening ? frame.openYaw : frame.closedYaw;
      return opening ? 'open' : 'close';
    },
    cue(hit: PropHit): string {
      const d = find(hit);
      if (!d) return 'Try door';
      return Math.abs(angleDelta(d.p.door!.closedYaw, d.goal)) < 0.7 ? 'Open door' : 'Close door';
    },
    appendBoxes(x: number, z: number, r: number, out: Float32Array, n: number): number {
      for (const d of active) {
        if (d.s !== scanS || Math.abs(x - d.ox - d.p.x) > r + 1 || Math.abs(z - d.oz - d.p.z) > r + 1) continue;
        n = leafBoxes(d.p, d.ox, d.oz, d.yaw, out, n);
      }
      return n;
    },
    reset() { active.length = 0; scanS = -1; },
  };
}
