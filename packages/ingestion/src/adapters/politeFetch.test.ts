import { describe, it, expect, vi } from "vitest";
import { createPoliteFetch } from "./politeFetch";
import { fetchJson } from "./http";

const ok = () => new Response("{}", { status: 200 });

describe("createPoliteFetch (Phase 12, D188)", () => {
  it("spaces requests to the same host by minIntervalMs, but not requests to different hosts", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const inner = vi.fn(async () => ok());
    const polite = createPoliteFetch({
      fetchFn: inner, minIntervalMs: 1000, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    await polite("https://a.example/1");
    clock += 200;
    await polite("https://a.example/2");
    await polite("https://b.example/1");
    expect(sleeps).toEqual([800]);
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("waits out a 429's Retry-After (up to 60 s) and retries once", async () => {
    const sleeps: number[] = [];
    const inner = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "7" } }))
      .mockResolvedValueOnce(ok());
    const polite = createPoliteFetch({ fetchFn: inner, minIntervalMs: 0, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
    expect((await polite("https://a.example/")).status).toBe(200);
    expect(sleeps).toEqual([7000]);
  });

  it("returns the 429 when Retry-After is missing, too long, or the retry is limited again", async () => {
    for (const header of [undefined, "600", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      const inner = vi.fn(async () => new Response("", { status: 429, headers: header ? { "retry-after": header } : {} }));
      const polite = createPoliteFetch({ fetchFn: inner, minIntervalMs: 0, now: () => 0, sleep: async () => undefined });
      expect((await polite("https://a.example/")).status).toBe(429);
      expect(inner).toHaveBeenCalledTimes(1);
    }
    const twice = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    const polite = createPoliteFetch({ fetchFn: twice, minIntervalMs: 0, now: () => 0, sleep: async () => undefined });
    expect((await polite("https://a.example/")).status).toBe(429);
    expect(twice).toHaveBeenCalledTimes(2);
  });
});

describe("fetchJson — POST and headers (Phase 12)", () => {
  it("sends a JSON body with POST and merges extra headers, keeping its own accept/user-agent", async () => {
    const inner = vi.fn(async (...args: [string, RequestInit?]) => (void args, ok()));
    await fetchJson("https://x.example/api", { fetchFn: inner as unknown as typeof fetch, method: "POST", body: { keywords: "a" }, headers: { "authorization-key": "k" } });
    const init = inner.mock.calls[0][1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"keywords":"a"}');
    expect(init.headers).toMatchObject({ "content-type": "application/json", "authorization-key": "k", accept: "application/json" });
  });
});
