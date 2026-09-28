// tools/lib/procmem.mjs: process-tree sampling and the capture tools' memory governor state machine.
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const mod = path.resolve(import.meta.dirname, '../../tools/lib/procmem.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { createGovernor, descendants, treeMem, memAvailableMb } = (await import(mod)) as any;

describe('process tree', () => {
  it('measures this process', () => {
    expect(descendants(process.pid)).toContain(process.pid);
    const m = treeMem(process.pid, { pss: true });
    expect(m.rssMb).toBeGreaterThan(10);
    expect(m.pssMb).toBeGreaterThan(5);
    expect(m.procs).toBeGreaterThanOrEqual(1);
    expect(memAvailableMb()).toBeGreaterThan(0);
  });
});

describe('memory governor', () => {
  it('sheds below 3.5 GB, closes below 2.5 GB, and recovers with hysteresis', () => {
    let avail = 8000;
    const ev: string[] = [];
    const g = createGovernor({
      manual: true, memAvailable: () => avail, pssMs: 1e9, recyclePssMb: 1e9,
      onShed: () => ev.push('shed'), onClose: () => ev.push('close'), onRecover: () => ev.push('recover'),
    });
    g.step();
    expect(g.state).toBe('ok');
    avail = 3400; g.step();
    expect(g.state).toBe('shed');
    avail = 3800; g.step(); // not yet: back to ok at 4000 (shed + 500)
    expect(g.state).toBe('shed');
    avail = 4100; g.step();
    expect(g.state).toBe('ok');
    avail = 2400; g.step();
    expect(g.state).toBe('closed');
    avail = 4000; g.step(); // closed stays closed until 4500
    expect(g.state).toBe('closed');
    avail = 4600; g.step();
    expect(g.state).toBe('ok');
    expect(ev).toEqual(['shed', 'recover', 'close', 'recover']);
    expect(g.peak.minAvailMb).toBe(2400);
    g.stop();
  });

  it('flags a recycle once when the tree PSS exceeds the cap', () => {
    let n = 0;
    const g = createGovernor({ manual: true, memAvailable: () => 9000, pssMs: 0, recyclePssMb: 1, onRecycle: () => n++ });
    g.step(0); g.step(1);
    expect(n).toBe(1);
    expect(g.takeRecycle()).toBe(true);
    expect(g.takeRecycle()).toBe(false);
    g.stop();
  });

  it('whenOk waits for recovery and gives up with a memory-guard error', async () => {
    let avail = 2000;
    const g = createGovernor({ manual: true, memAvailable: () => avail, pssMs: 1e9 });
    g.step();
    await expect(g.whenOk(300)).rejects.toThrow(/memory guard/);
    setTimeout(() => { avail = 9000; }, 100);
    await expect(g.whenOk(5000)).resolves.toBeUndefined();
    g.stop();
  });
});
