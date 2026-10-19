import { describe, it, expect, vi } from "vitest";
import { createFollowUp } from "./followUp";

vi.mock("@ai-career/matching", async (orig) => ({ ...(await orig<typeof import("@ai-career/matching")>()), pushMatching: vi.fn(async () => "enqueued") }));
import { pushMatching } from "@ai-career/matching";

describe("createFollowUp (Phase 13a)", () => {
  it("re-queues only when the flag was set", async () => {
    const queue = {} as never;
    const set = createFollowUp({ redis: { del: vi.fn(async () => 1) }, queue, onError: vi.fn() });
    await set("u1");
    expect(pushMatching).toHaveBeenCalledWith(queue, "u1");
    vi.mocked(pushMatching).mockClear();
    const unset = createFollowUp({ redis: { del: vi.fn(async () => 0) }, queue, onError: vi.fn() });
    await unset("u1");
    expect(pushMatching).not.toHaveBeenCalled();
  });
  it("reports errors instead of throwing", async () => {
    const onError = vi.fn();
    await createFollowUp({ redis: { del: vi.fn(async () => { throw new Error("down"); }) }, queue: {} as never, onError })("u1");
    expect(onError).toHaveBeenCalled();
  });
});
