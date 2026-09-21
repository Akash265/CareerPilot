import { describe, it, expect, vi } from "vitest";
import { fetchJson } from "./http";
import { IngestError } from "../types";

const respond = (body: string | null, init: ResponseInit = { status: 200 }) =>
  vi.fn<typeof fetch>(async () => new Response(body, init));
const errorClass = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof IngestError ? e.errorClass : "not-an-IngestError";
  }
  return "no-error";
};

describe("fetchJson", () => {
  it("returns parsed JSON on 200 and does not follow redirects", async () => {
    const fetchFn = respond('{"a":1}');
    expect(await fetchJson("https://x.test/a", { fetchFn })).toEqual({ a: 1 });
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [400, "http_error"],
    [302, "http_error"],
  ] as const)("classifies HTTP %i as %s", async (status, expected) => {
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: respond("{}", { status }) }))).toBe(expected);
  });

  it("classifies a rejected fetch as network, and a TimeoutError as timeout", async () => {
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: vi.fn().mockRejectedValue(new TypeError("fetch failed")) }))).toBe("network");
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: vi.fn().mockRejectedValue(timeout) }))).toBe("timeout");
  });

  it("rejects an oversized declared content-length and an oversized streamed body", async () => {
    const declared = respond("{}", { status: 200, headers: { "content-length": "999999" } });
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: declared, maxBytes: 100 }))).toBe("response_too_large");
    const streamed = respond(JSON.stringify({ pad: "x".repeat(500) }));
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: streamed, maxBytes: 100 }))).toBe("response_too_large");
  });

  it("classifies a non-JSON body as schema_mismatch", async () => {
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: respond("<html>") }))).toBe("schema_mismatch");
  });
});
