/** Replacing a fade completes its waiters so interrupted loading transitions cannot hang. */
export function createCurtain(curtainEl: HTMLElement): (opacity: number, ms: number) => Promise<void> {
  let fadeTimer = 0;
  let pending: (() => void) | null = null;
  return (opacity, ms) => {
    clearTimeout(fadeTimer);
    pending?.();
    pending = null;
    curtainEl.style.transition = ms > 0 ? `opacity ${ms}ms ease` : 'none';
    void curtainEl.offsetWidth;
    curtainEl.style.opacity = String(opacity);
    return new Promise((resolve) => {
      pending = resolve;
      fadeTimer = window.setTimeout(() => { pending = null; resolve(); }, Math.max(0, ms));
    });
  };
}
