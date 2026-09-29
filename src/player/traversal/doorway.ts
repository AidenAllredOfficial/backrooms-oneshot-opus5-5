import { PLAYER } from '../../core/constants.ts';
import { portalAcross, portalDistance, portalRotation, throughPortal, worldPortalFrame } from '../../core/portalMath.ts';
import { resetController } from '../controller.ts';
import type { TraversalCtx } from './common.ts';

/** Keep walking through the opening. Crossing transforms pose and velocity; walking back uses the paired endpoint. */
export function doorwayAfterStep(ctx: TraversalCtx, px: number, pz: number): boolean {
  const s = ctx.state;
  for (let i = 0; i < ctx.portalCount; i++) {
    const h = ctx.portals[i], link = h.spec.doorway;
    if (!link || s.y < link.frame.y - 0.15 || s.y > link.frame.y + 0.35) continue;
    const a = worldPortalFrame(h), before = portalDistance(a, px, pz), after = portalDistance(a, s.x, s.z);
    if (before <= 0 || after > 0) continue;
    const fraction = before / (before - after);
    const ix = px + (s.x - px) * fraction, iz = pz + (s.z - pz) * fraction;
    if (Math.abs(portalAcross(a, ix, iz)) > 0.45 - PLAYER.radius + 0.035) continue;
    const b = link.target;
    if (!ctx.host.isPrefetched(b.s, b.x, b.z)) {
      s.x = ix + a.nx * (PLAYER.radius + 0.025); s.z = iz + a.nz * (PLAYER.radius + 0.025);
      s.vx = s.vz = 0;
      return false;
    }
    const p = throughPortal(a, b, s.x, s.y, s.z), yaw = portalRotation(a, b);
    const c = Math.cos(yaw), sn = Math.sin(yaw), vx = s.vx, vz = s.vz, from = s.s;
    // Keep the room just left resident before streaming retargets, so the return view never goes dark.
    ctx.host.prefetch(from, a.x, a.z, 1);
    ctx.host.switchStorey(b.s);
    s.s = b.s; s.x = p.x + b.nx * 0.006; s.y = p.y; s.z = p.z + b.nz * 0.006;
    s.yaw = Math.atan2(Math.sin(s.yaw + yaw), Math.cos(s.yaw + yaw));
    s.vx = c * vx + sn * vz; s.vz = -sn * vx + c * vz;
    resetController(s);
    ctx.onTeleported(); ctx.refreshPortals();
    if (from !== b.s) ctx.emit('storeyChanged', { from, to: b.s, dy: 0, via: 'doorway' });
    ctx.emit('teleport', { s: s.s, x: s.x, y: s.y, z: s.z });
    return true;
  }
  return false;
}

/** The interpolated, bobbing eye must stay on the body's side until traversal changes worlds. */
export function doorwayEye(ctx: TraversalCtx): number {
  const s = ctx.state;
  let nearest = Infinity;
  for (let i = 0; i < ctx.portalCount; i++) {
    const h = ctx.portals[i], link = h.spec.doorway;
    if (!link || s.fly || s.y < link.frame.y - 0.15 || s.y > link.frame.y + 0.35) continue;
    const a = worldPortalFrame(h), body = portalDistance(a, s.x, s.z);
    if (body < 0 || body > 0.5 || Math.abs(portalAcross(a, s.eyeX, s.eyeZ)) > 0.75) continue;
    let distance = portalDistance(a, s.eyeX, s.eyeZ);
    if (distance < 0.004) {
      s.eyeX += a.nx * (0.004 - distance); s.eyeZ += a.nz * (0.004 - distance);
      distance = 0.004;
    }
    nearest = Math.min(nearest, distance);
  }
  return nearest;
}

export function doorwayPrefetch(ctx: TraversalCtx): void {
  for (let i = 0; i < ctx.portalCount; i++) {
    const b = ctx.portals[i].spec.doorway?.target;
    if (b) ctx.host.prefetch(b.s, b.x, b.z, 1);
  }
}

/** Until the destination is ready, its plane behaves like a closed door. Never walk into an unloaded room. */
export function doorwayBarriers(ctx: TraversalCtx, x: number, z: number, r: number, out: Float32Array, n: number): number {
  for (let i = 0; i < ctx.portalCount; i++) {
    const h = ctx.portals[i], link = h.spec.doorway;
    if (!link) continue;
    const a = worldPortalFrame(h), b = link.target;
    if (Math.hypot(x - a.x, z - a.z) > r + 0.6 || ctx.host.isPrefetched(b.s, b.x, b.z) || (n + 1) * 6 > out.length) continue;
    const hx = Math.abs(a.nz) * 0.45 + Math.abs(a.nx) * 0.02, hz = Math.abs(a.nx) * 0.45 + Math.abs(a.nz) * 0.02;
    out.set([a.x - hx, a.y, a.z - hz, a.x + hx, a.y + 2.1, a.z + hz], n++ * 6);
  }
  return n;
}
