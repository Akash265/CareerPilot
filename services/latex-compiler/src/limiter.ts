export class BusyError extends Error {
  constructor() {
    super("busy");
    this.name = "BusyError";
  }
}

export interface Limiter { run<T>(fn: () => Promise<T>): Promise<T> }

/** At most `concurrency` jobs at once; up to `maxQueue` wait; beyond that BusyError (→ 503). */
export function createLimiter(opts: { concurrency: number; maxQueue: number }): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < opts.concurrency) {
        active++;
      } else {
        if (waiting.length >= opts.maxQueue) throw new BusyError();
        await new Promise<void>((resolve) => waiting.push(resolve)); // the finishing job hands its slot over
      }
      try {
        return await fn();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}
