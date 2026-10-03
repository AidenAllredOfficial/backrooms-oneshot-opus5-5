// src/app/continueStore.ts (WP14) — last played position (localStorage 'backrooms.continue.v1') for the CONTINUE entry,
// and (R2, B7) the per-seed tape log shown on the pause screen.

import type { StoreyId } from '../core/ids.ts';

export interface ContinuePoint { seedText: string; s: StoreyId; x: number; y: number; z: number; yaw: number; savedAt: number }

export const CONTINUE_KEY = 'backrooms.continue.v1';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates a parsed JSON value; null if it is not a usable ContinuePoint. */
export function validateContinuePoint(raw: unknown): ContinuePoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seedText !== 'string' || r.seedText.trim() === '' || r.seedText.length > 64) return null;
  if (r.s !== 0 && r.s !== 1 && r.s !== 2) return null;
  if (!finite(r.x) || !finite(r.y) || !finite(r.z) || !finite(r.yaw)) return null;
  if (Math.abs(r.x) > 1e6 || Math.abs(r.z) > 1e6 || Math.abs(r.y) > 100) return null;
  return {
    seedText: r.seedText, s: r.s, x: r.x, y: r.y, z: r.z, yaw: r.yaw,
    savedAt: finite(r.savedAt) ? r.savedAt : 0,
  };
}

export function createContinueStore(storage: Storage | null): { load(): ContinuePoint | null; save(p: ContinuePoint): void; clear(): void } {
  return {
    load() {
      if (!storage) return null;
      try {
        const txt = storage.getItem(CONTINUE_KEY);
        return txt === null ? null : validateContinuePoint(JSON.parse(txt));
      } catch {
        return null;
      }
    },
    save(p) {
      const v = validateContinuePoint(p);
      if (!storage || !v) return;
      try { storage.setItem(CONTINUE_KEY, JSON.stringify(v)); } catch { /* quota / private mode */ }
    },
    clear() {
      if (!storage) return;
      try { storage.removeItem(CONTINUE_KEY); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------- R2 (B7): tape log (localStorage 'backrooms.tapes.v1')
// Discovery record per seed, shown on the pause screen: zones seen (ZoneId bitmask), landmark kinds found, storeys
// visited (bitmask), metres walked and tape time (seconds in play). At most TAPE_LOG_MAX seeds are kept (the least
// recently updated are dropped).

export interface TapeLog { zones: number; landmarks: number[]; storeys: number; metres: number; seconds: number; updatedAt: number }

export const TAPE_LOG_KEY = 'backrooms.tapes.v1';
export const TAPE_LOG_MAX = 24;

export function emptyTapeLog(): TapeLog { return { zones: 0, landmarks: [], storeys: 0, metres: 0, seconds: 0, updatedAt: 0 }; }

/** Validates one parsed log; null if unusable. Unknown / duplicate landmark kinds are dropped. */
export function validateTapeLog(raw: unknown): TapeLog | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, max: number): number => (finite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
  const num = (v: unknown, max: number): number => (finite(v) ? Math.max(0, Math.min(max, v)) : 0);
  const lm = Array.isArray(r.landmarks) ? r.landmarks : [];
  const landmarks = [...new Set(lm.filter((k): k is number => Number.isInteger(k) && (k as number) >= 0 && (k as number) < 256))].sort((a, b) => a - b);
  return {
    zones: int(r.zones, 0xfffffff), landmarks, storeys: int(r.storeys, 0xff),
    metres: num(r.metres, 1e9), seconds: num(r.seconds, 1e9), updatedAt: num(r.updatedAt, 1e15),
  };
}

export interface TapeLogStore { load(seedText: string): TapeLog; save(seedText: string, log: TapeLog): void }

export function createTapeLogStore(storage: Storage | null): TapeLogStore {
  const readAll = (): Record<string, unknown> => {
    if (!storage) return {};
    try {
      const txt = storage.getItem(TAPE_LOG_KEY);
      const v = txt === null ? null : (JSON.parse(txt) as unknown);
      // Seeds are arbitrary strings, including object prototype property names.
      return Object.assign(Object.create(null) as Record<string, unknown>,
        typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {});
    } catch {
      return {};
    }
  };
  return {
    load(seedText) {
      return validateTapeLog(readAll()[seedText]) ?? emptyTapeLog();
    },
    save(seedText, log) {
      const v = validateTapeLog(log);
      if (!storage || !v || seedText.trim() === '' || seedText.length > 64) return;
      const all = Object.assign(Object.create(null) as Record<string, unknown>, readAll());
      all[seedText] = { ...v, updatedAt: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > TAPE_LOG_MAX) {
        const age = (k: string): number => validateTapeLog(all[k])?.updatedAt ?? 0;
        for (const k of keys.sort((a, b) => age(a) - age(b)).slice(0, keys.length - TAPE_LOG_MAX)) delete all[k];
      }
      try { storage.setItem(TAPE_LOG_KEY, JSON.stringify(all)); } catch { /* quota / private mode */ }
    },
  };
}
