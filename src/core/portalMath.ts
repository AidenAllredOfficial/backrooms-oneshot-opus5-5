import type { PortalFrame } from './layout.ts';
import type { PortalHit } from './runtime.ts';

export const worldPortalFrame = (h: PortalHit): PortalFrame => {
  const f = h.spec.doorway!.frame;
  return { ...f, x: h.ox + f.x, z: h.oz + f.z };
};
export const portalRotation = (a: PortalFrame, b: PortalFrame): number =>
  Math.atan2(b.nx, b.nz) - Math.atan2(a.nx, a.nz) + Math.PI;
export function throughPortal(a: PortalFrame, b: PortalFrame, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const angle = portalRotation(a, b), c = Math.cos(angle), s = Math.sin(angle), dx = x - a.x, dz = z - a.z;
  return { x: b.x + c * dx + s * dz, y: b.y + y - a.y, z: b.z - s * dx + c * dz };
}
export const portalDistance = (f: PortalFrame, x: number, z: number): number => (x - f.x) * f.nx + (z - f.z) * f.nz;
export const portalAcross = (f: PortalFrame, x: number, z: number): number => (x - f.x) * f.nz - (z - f.z) * f.nx;
