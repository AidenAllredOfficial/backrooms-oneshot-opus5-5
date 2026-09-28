// Types for tools/lib/budget.mjs (machine-wide memory budget ledger; see the header of budget.mjs).

export type LeaseKind = 'browser' | 'page' | 'build' | 'vite' | 'tsc' | 'vitest' | 'job' | (string & {});

export interface AcquireOptions {
  weightMb: number;
  label?: string;
  /** 'browser' also takes a browser slot (count cap BACKROOMS_BROWSER_SLOTS); 'build' is capped at one at a time. */
  kind?: LeaseKind;
  minFreeMb?: number;
  budgetMb?: number;
  /** false: return null instead of waiting when the lease is not admitted now. Default true. */
  wait?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  announceAfterMs?: number;
  onWait?: (message: string, state: unknown) => void;
}

export interface Lease {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly weightMb: number;
  release(): void;
  resize(mb: number, opts?: { wait?: boolean; pollMs?: number; timeoutMs?: number }): Promise<boolean>;
}

export interface HolderInfo {
  id: string; pid: number; label: string; kind: string; weightMb: number; started: number; ageS: number; slot?: string | null;
}

export interface BudgetStatus {
  budgetMb: number;
  minFreeMb: number;
  memAvailableMb: number;
  usedMb: number;
  /** Largest weight that would be admitted right now (ignoring the browser/build count caps). */
  headroomMb: number;
  holders: HolderInfo[];
  waiters: HolderInfo[];
  browsers: { slots: number; used: number; legacy: { slot: string; pid: number }[] };
}

export interface Ledger {
  acquire(opts: AcquireOptions): Promise<Lease | null>;
  status(): BudgetStatus;
  dir: string;
  slotDir: string;
}

export const WEIGHTS: Readonly<{
  browser: number; page: number; pageHeavy: number; vite: number; build: number; tsc: number;
  vitestBase: number; vitestFork: number; legacySlot: number;
}>;
export function pageWeight(o?: { quality?: string; width?: number; height?: number; cold?: boolean }): number;
export function memAvailableMb(): number;
export function pidStartTime(pid: number): number | null;
export function createLedger(o?: {
  dir?: string; slotDir?: string; memAvailable?: () => number; budgetMb?: number; minFreeMb?: number;
  browserSlots?: number; pid?: number; noExitHook?: boolean;
}): Ledger;
export function acquire(opts: AcquireOptions): Promise<Lease | null>;
export function status(): BudgetStatus;
