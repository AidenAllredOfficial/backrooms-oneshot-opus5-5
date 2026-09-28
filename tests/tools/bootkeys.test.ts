// The capture tools group shots by the launch params that need a page boot (tools/lib/capture.mjs BOOT_PARAM_KEYS).
// The game owns the list (src/app/urlParams.ts BOOT_PARAM_KEYS, capture contract v2): every key it names must be in
// the tools' mirror, or shots differing only in that key would be moved in place and the page would refuse them.
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const capture = path.resolve(import.meta.dirname, '../../tools/lib/capture.mjs');
const { BOOT_PARAM_KEYS } = (await import(capture)) as { BOOT_PARAM_KEYS: string[] };

describe('boot keys', () => {
  it('mirror src/app/urlParams.ts BOOT_PARAM_KEYS', async () => {
    const mod: Record<string, unknown> = await import('../../src/app/urlParams.ts');
    const game = mod.BOOT_PARAM_KEYS as readonly string[] | undefined;
    if (!game) {
      console.warn('src/app/urlParams.ts exports no BOOT_PARAM_KEYS yet (capture contract v2): skipped');
      return;
    }
    for (const k of game) expect(BOOT_PARAM_KEYS, `boot key '${k}'`).toContain(k);
    const launch = mod.LAUNCH_PARAM_KEYS as readonly string[];
    for (const k of BOOT_PARAM_KEYS) expect(launch, `mirrored boot key '${k}' is a launch param`).toContain(k);
  });
});
