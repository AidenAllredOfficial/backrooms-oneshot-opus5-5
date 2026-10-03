import { describe, expect, it } from 'vitest';
import type { AppCore } from '../../src/app/appState.ts';
import { cancelWalk, runAutowalk, runWalk } from '../../src/app/autowalk.ts';
import { createClock } from '../../src/app/clock.ts';
import { createPlayerState } from '../../src/core/player.ts';
import { EventBus, type GameEvents } from '../../src/core/events.ts';

function fixture(): AppCore {
  return {
    sys: {
      player: { state: createPlayerState(0, 0, 0, 0, 0, 0) },
      streamer: { stats: () => ({ texturesPooled: 0 }) },
    },
    bus: new EventBus<GameEvents>(), hooks: [], driver: null, renderer: null,
    errors: [], debug: { ready: true }, clock: createClock(),
  } as unknown as AppCore;
}

function frame(core: AppCore, ms: number): void {
  for (let i = core.hooks.length - 1; i >= 0; i--) if (core.hooks[i](ms)) core.hooks.splice(i, 1);
}

describe('measurement walk lifecycle', () => {
  it('completes a walk when its world is replaced, before frame hooks are cleared', async () => {
    const core = fixture();
    const done = runWalk(core, [{ x: 100, z: 0 }]);
    frame(core, 16);
    cancelWalk(core, 'new seed');
    core.hooks.length = 0;
    await expect(done).resolves.toEqual({ footsteps: 0, ms: 16 });
    expect(core.driver).toBeNull();
  });

  it('marks a cancelled autowalk as stuck and settles its report', async () => {
    const core = fixture();
    const done = runAutowalk(core, { distance: 100 });
    cancelWalk(core);
    await expect(done).resolves.toMatchObject({ stuck: true, seconds: 0, distance: 0 });
    expect(core.driver).toBeNull();
  });

  it('walks from separate app instances do not cancel one another', async () => {
    const a = fixture(), b = fixture();
    const first = runWalk(a, [{ x: 100, z: 0 }]);
    const driver = a.driver;
    const second = runWalk(b, [{ x: 100, z: 0 }]);
    expect(a.driver).toBe(driver);
    cancelWalk(a); cancelWalk(b);
    await Promise.all([first, second]);
  });

  it.each(['paused', 'loading'] as const)('does not consume a waypoint timeout while %s', async (state) => {
    const core = fixture();
    const done = runWalk(core, [{ x: 100, z: 0 }]);
    if (state === 'paused') core.clock.paused = true;
    else core.debug.ready = false;
    for (let i = 0; i < 10; i++) frame(core, 1000);
    expect(core.driver).not.toBeNull();
    core.clock.paused = false;
    core.debug.ready = true;
    cancelWalk(core);
    await expect(done).resolves.toEqual({ footsteps: 0, ms: 0 });
  });
});
