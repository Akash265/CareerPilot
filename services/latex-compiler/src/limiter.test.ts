import { describe, it, expect } from "vitest";
import { BusyError, createLimiter } from "./limiter";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; };

describe("createLimiter", () => {
  it("runs up to `concurrency` at once, queues up to `maxQueue`, rejects beyond", async () => {
    const limiter = createLimiter({ concurrency: 2, maxQueue: 1 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0; let peak = 0;
    const job = (i: number) => limiter.run(async () => { running++; peak = Math.max(peak, running); await gates[i].promise; running--; return i; });
    const p0 = job(0), p1 = job(1), p2 = job(2);
    await expect(limiter.run(async () => 9)).rejects.toBeInstanceOf(BusyError);
    gates.forEach((g) => g.resolve());
    expect(await Promise.all([p0, p1, p2])).toEqual([0, 1, 2]);
    expect(peak).toBe(2);
  });
  it("frees the slot when a job throws", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
    await expect(limiter.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await limiter.run(async () => 1)).toBe(1);
  });
});
