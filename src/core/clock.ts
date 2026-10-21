// Time source for the whole core.
// Nothing in core/ calls setTimeout or performance.now() directly — only through Clock.
// That way vi.useFakeTimers() can swap time in tests, and a 100 ms timeout "passes" instantly.

/** Whatever setTimeout returns: a number in the browser, an object in Node. We don't care which. */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface Clock {
  /** Milliseconds since the clock was created (since "simulation start"). */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/**
 * The real clock. Works both in the browser and in tests:
 * vi.useFakeTimers() replaces both setTimeout and performance.now().
 * Create it AFTER vi.useFakeTimers(), otherwise the zero point is real time.
 */
export function createSystemClock(): Clock {
  const start = performance.now();
  // A background tab throttles timers to ~1 s while real time keeps running, so healthy replies would look LATE.
  // The simulation clock stands still while the tab is hidden: time only counts while you can see it.
  let hiddenAt: number | null = null;
  let hiddenTotal = 0;
  const syncVisibility = (): void => {
    if (document.hidden) hiddenAt ??= performance.now();
    else if (hiddenAt !== null) {
      hiddenTotal += performance.now() - hiddenAt;
      hiddenAt = null;
    }
  };
  if (typeof document !== 'undefined') {
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
  }
  return {
    now: () => (hiddenAt ?? performance.now()) - start - hiddenTotal,
    // Look up globalThis.setTimeout at call time instead of capturing it up front,
    // so Vitest's fake timers get picked up.
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
}