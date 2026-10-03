import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCurtain } from '../../src/ui/curtain.ts';
import { createHud } from '../../src/ui/overlay.ts';
import { tapeDate } from '../../src/ui/dom.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('loading curtain', () => {
  it('resolves both fades when a transition replaces an awaited fade', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout });
    const element = { style: {}, offsetWidth: 10 } as unknown as HTMLElement;
    const fade = createCurtain(element);
    let firstDone = false, secondDone = false;
    const first = fade(1, 1000).then(() => { firstDone = true; });
    const second = fade(0, 200).then(() => { secondDone = true; });
    await Promise.resolve();
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    expect(element.style.opacity).toBe('0');
  });
});

describe('camcorder tape date', () => {
  it('changes the seeded fictional year immediately after loading a different tape', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const elements: { className: string; innerHTML: string }[] = [];
    vi.stubGlobal('document', { createElement() {
      const element = {
        className: '', textContent: '', innerHTML: '', append() {},
        classList: { toggle() {}, add() {}, remove() {} },
      };
      elements.push(element);
      return element;
    } });
    const hud = createHud('a');
    hud.setRec(true);
    hud.tick(1);
    const date = elements.find((e) => e.className === 'br-rec-br')!;
    expect(date.innerHTML).toContain(tapeDate('a', new Date()));
    hud.setSeed('b');
    hud.tick(1);
    expect(date.innerHTML).toContain(tapeDate('b', new Date()));
    expect(date.innerHTML).not.toContain(tapeDate('a', new Date()));
  });
});
