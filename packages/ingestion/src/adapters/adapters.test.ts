import { describe, it, expect, vi } from "vitest";
import { createGreenhouseAdapter } from "./greenhouse";
import { createLeverAdapter } from "./lever";
import { assertValidSlug } from "./slug";
import { IngestError, type RawRecord, type SourceRef } from "../types";
import { greenhouseJobFixture, leverPostingFixture } from "../fixtures";

const ref = (kind: "greenhouse" | "lever", slug: unknown): SourceRef =>
  ({ id: "s", kind, label: "x", config: { slug: slug as string } });
const json = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
async function collect(iter: AsyncIterable<RawRecord>) {
  const out: RawRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as IngestError).errorClass;
  }
  return "no-error";
};

describe("assertValidSlug", () => {
  it("accepts board tokens and rejects anything that could alter host or path", () => {
    expect(assertValidSlug("gitlab")).toBe("gitlab");
    expect(assertValidSlug("Acme_Corp-2")).toBe("Acme_Corp-2");
    for (const bad of ["", "../etc", "a/b", "a.b", "a:b", "a b", "x".repeat(65), undefined, 5]) {
      expect(() => assertValidSlug(bad)).toThrow(IngestError);
    }
  });
});

describe("Greenhouse adapter", () => {
  it("requests the content=true board URL and yields one record per identifiable job", async () => {
    const fetchFn = json({ jobs: [greenhouseJobFixture, { title: "no id" }, { ...greenhouseJobFixture, id: 2 }], meta: { total: 3 } });
    const records = await collect(createGreenhouseAdapter({ baseUrl: "https://gh.test/", fetchFn }).fetch(ref("greenhouse", "gitlab")));
    expect(fetchFn.mock.calls[0][0]).toBe("https://gh.test/v1/boards/gitlab/jobs?content=true");
    expect(records.map((r) => r.externalId)).toEqual(["8556658002", "2"]);
    expect(records[0].payload).toMatchObject({ id: 8556658002, title: "AI Engineer" });
  });

  it("refuses an invalid slug before making any request", async () => {
    const fetchFn = json({ jobs: [] });
    expect(await failure(collect(createGreenhouseAdapter({ baseUrl: "https://gh.test", fetchFn }).fetch(ref("greenhouse", "../x"))))).toBe("invalid_slug");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a 404 to not_found and an envelope without jobs to schema_mismatch", async () => {
    const adapter = (f: typeof fetch) => createGreenhouseAdapter({ baseUrl: "https://gh.test", fetchFn: f });
    expect(await failure(collect(adapter(json({}, 404)).fetch(ref("greenhouse", "nope"))))).toBe("not_found");
    expect(await failure(collect(adapter(json({ unexpected: true })).fetch(ref("greenhouse", "gitlab"))))).toBe("schema_mismatch");
  });
});

describe("Lever adapter", () => {
  it("requests mode=json and yields a record per posting keyed by its id", async () => {
    const fetchFn = json([leverPostingFixture]);
    const records = await collect(createLeverAdapter({ baseUrl: "https://lv.test", fetchFn }).fetch(ref("lever", "acme")));
    expect(fetchFn.mock.calls[0][0]).toBe("https://lv.test/v0/postings/acme?mode=json");
    expect(records).toEqual([{ externalId: leverPostingFixture.id, payload: leverPostingFixture }]);
  });

  it("treats Lever's {ok:false} 404 body and a non-array 200 as failures", async () => {
    const adapter = (f: typeof fetch) => createLeverAdapter({ baseUrl: "https://lv.test", fetchFn: f });
    expect(await failure(collect(adapter(json({ ok: false, error: "Document not found" }, 404)).fetch(ref("lever", "nope"))))).toBe("not_found");
    expect(await failure(collect(adapter(json({ ok: false })).fetch(ref("lever", "acme"))))).toBe("schema_mismatch");
  });
});
