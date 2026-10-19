import { describe, it, expect, vi } from "vitest";
import { createRequirementsRefresh } from "./requirementsRefresh";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("createRequirementsRefresh", () => {
  it("ignores a missing user id", async () => {
    const run = vi.fn(async () => undefined);
    await createRequirementsRefresh({ run, onError: vi.fn() })(undefined);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once per user at a time and once more if asked while running", async () => {
    const gate = deferred();
    const run = vi.fn(async () => { if (run.mock.calls.length === 1) await gate.promise; });
    const refresh = createRequirementsRefresh({ run, onError: vi.fn() });
    const first = refresh("u1");
    void refresh("u1");
    void refresh("u1");
    gate.resolve();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs different users independently", async () => {
    const run = vi.fn(async (userId: string) => void userId);
    const refresh = createRequirementsRefresh({ run, onError: vi.fn() });
    await Promise.all([refresh("u1"), refresh("u2")]);
    expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(["u1", "u2"]);
  });

  it("reports an error and never rejects; the next call runs again", async () => {
    const onError = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const refresh = createRequirementsRefresh({ run, onError });
    await expect(refresh("u1")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await refresh("u1");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
