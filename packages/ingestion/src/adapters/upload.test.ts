import { describe, it, expect } from "vitest";
import { parseUploadFile, UploadParseError, MAX_UPLOAD_ROWS } from "./upload";

const buf = (s: string) => Buffer.from(s, "utf8");

// Wall-clock budgets for heavy adversarial inputs sit an order of magnitude below the pathological
// behaviour they detect (regressions were 40-80 s) so that a loaded CI machine running the whole
// suite in parallel cannot trip them (measured 0.3 s standalone, 1.1-2.4 s under heavy load).
const HEAVY_INPUT_BUDGET_MS = 10_000;
// Above the budget, so a budget breach fails on the assertion rather than on vitest's 5 s default.
const HEAVY_INPUT_TIMEOUT_MS = 30_000;

describe("parseUploadFile — CSV", () => {
  it("parses quoted commas and embedded newlines, and maps header aliases case-insensitively", () => {
    const csv = [
      'Job Title,Company Name,Location,Job Description,Job URL,Date Posted,Type,Compensation,Job ID',
      '"Data Engineer, Platform",Acme,Berlin,"Line one\nLine two",https://acme.example/1,2026-08-01,Full-time,"€60,000 - €80,000",A-1',
    ].join("\n");
    const [record] = parseUploadFile(buf(csv), "jobs.csv");
    expect(record.externalId).toBe("A-1");
    expect(record.payload).toEqual({
      title: "Data Engineer, Platform", company: "Acme", location: "Berlin", description: "Line one\nLine two",
      url: "https://acme.example/1", postedAt: "2026-08-01", employmentType: "Full-time", salary: "€60,000 - €80,000",
    });
  });

  it("derives a stable content-hash id when there is no id column, and keeps the first of duplicates", () => {
    const csv = "title,company\nAnalyst,Beta\nAnalyst,Beta\nEngineer,Beta";
    const records = parseUploadFile(buf(csv), "jobs.csv");
    expect(records).toHaveLength(2);
    expect(records[0].externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseUploadFile(buf(csv), "jobs.csv")[0].externalId).toBe(records[0].externalId);
  });
});

describe("parseUploadFile — JSON", () => {
  it("accepts a bare array and a {jobs: []} wrapper", () => {
    const rows = [{ title: "Analyst", company: "Beta", url: "https://b.example/1" }];
    expect(parseUploadFile(buf(JSON.stringify(rows)), "jobs.json")).toHaveLength(1);
    expect(parseUploadFile(buf(JSON.stringify({ jobs: rows })), "jobs.json")).toHaveLength(1);
  });
});

describe("parseUploadFile — rejections (messages are user-safe)", () => {
  const rejects = (b: Buffer, name: string, pattern: RegExp) => {
    expect(() => parseUploadFile(b, name)).toThrow(UploadParseError);
    expect(() => parseUploadFile(b, name)).toThrow(pattern);
  };

  it("rejects unsupported extensions, binary content and invalid syntax", () => {
    rejects(buf("x"), "jobs.txt", /\.csv or \.json/);
    rejects(Buffer.from([0x50, 0x4b, 0x00, 0x03]), "jobs.csv", /binary/i);
    rejects(buf("{not json"), "jobs.json", /valid JSON/);
    rejects(buf('{"unexpected": true}'), "jobs.json", /"jobs" array/);
  });

  it("rejects an empty file and rows missing a title or company, naming the row numbers", () => {
    rejects(buf("title,company\n"), "jobs.csv", /no jobs/i);
    rejects(buf("title,company\nAnalyst,Beta\n,Gamma\nEngineer,"), "jobs.csv", /rows 2, 3/);
  });

  it("rejects a row whose title contains a NUL byte as an invalid row", () => {
    const json = JSON.stringify([{ title: "Data\u0000Engineer", company: "Acme" }]);
    rejects(buf(json), "jobs.json", /1 row is invalid \(first: rows 1\)/);
  });

  it("rejects a row whose explicit id contains a NUL byte as an invalid row, before it ever becomes an externalId", () => {
    const json = JSON.stringify([{ id: "a\u0000b", title: "Data Engineer", company: "Acme" }]);
    rejects(buf(json), "jobs.json", /1 row is invalid \(first: rows 1\)/);
  });

  it("rejects files over the row cap", () => {
    const lines = ["title,company", ...Array.from({ length: MAX_UPLOAD_ROWS + 1 }, (_, i) => `Job ${i},Co`)];
    rejects(buf(lines.join("\n")), "jobs.csv", /5,000/);
  });
});

describe("parseUploadFile — field length limits", () => {
  const HEX32 = /^[0-9a-f]{32}$/;
  const csvWithId = (id: string) => buf(`id,title,company\n${id},Analyst,Beta`);

  it("keeps an id of exactly 200 characters verbatim and hashes one of 201", () => {
    const at = "i".repeat(200);
    const over = "i".repeat(201);
    expect(parseUploadFile(csvWithId(at), "jobs.csv")[0].externalId).toBe(at);
    const hashed = parseUploadFile(csvWithId(over), "jobs.csv")[0].externalId;
    expect(hashed).toMatch(HEX32);
    expect(hashed).not.toContain("i");
    expect(parseUploadFile(csvWithId(over), "jobs.csv")[0].externalId).toBe(hashed);
  });

  it("hashes different oversized ids to different externalIds", () => {
    const a = parseUploadFile(csvWithId("a".repeat(300)), "jobs.csv")[0].externalId;
    const b = parseUploadFile(csvWithId("b".repeat(300)), "jobs.csv")[0].externalId;
    expect(a).not.toBe(b);
  });

  it("turns a 5,000,000-character id into a stable 32-hex externalId, quickly", () => {
    const b = csvWithId("z".repeat(5_000_000));
    const start = performance.now();
    const first = parseUploadFile(b, "jobs.csv");
    const second = parseUploadFile(b, "jobs.csv");
    expect(performance.now() - start).toBeLessThan(HEAVY_INPUT_BUDGET_MS);
    expect(first[0].externalId).toMatch(HEX32);
    expect(second[0].externalId).toBe(first[0].externalId);
    expect(first[0].payload).toEqual({ title: "Analyst", company: "Beta" });
  }, HEAVY_INPUT_TIMEOUT_MS);

  it("rejects a 501-character title through the invalid-rows path, listing the rows", () => {
    expect.assertions(3);
    const csv = `title,company\nAnalyst,Beta\n${"t".repeat(501)},Gamma\nEngineer,${"c".repeat(501)}`;
    try {
      parseUploadFile(buf(csv), "jobs.csv");
    } catch (error) {
      expect(error).toBeInstanceOf(UploadParseError);
      expect((error as UploadParseError).message).toBe(
        "2 rows are invalid (first: rows 2, 3): each needs a title and a company, within the length limits",
      );
      expect((error as UploadParseError).message).not.toContain("tttt");
    }
  });

  it("accepts a title of exactly 500 characters", () => {
    const title = "t".repeat(500);
    const [record] = parseUploadFile(buf(`title,company\n${title},Beta`), "jobs.csv");
    expect(record.payload).toEqual({ title, company: "Beta" });
  });
});

describe("parseUploadFile — header mapping and cell handling", () => {
  const JOB_SHAPE_ERROR = 'JSON must be an array of jobs, or an object with a "jobs" array';

  it("strips a leading BOM from JSON (CSV already handles one)", () => {
    const rows = [{ title: "Analyst", company: "Beta" }];
    const json = parseUploadFile(buf("﻿" + JSON.stringify(rows)), "jobs.json");
    expect(json).toHaveLength(1);
    expect(json[0].payload).toEqual({ title: "Analyst", company: "Beta" });
    const wrapped = parseUploadFile(buf("﻿" + JSON.stringify({ jobs: rows })), "jobs.json");
    expect(wrapped[0].payload).toEqual({ title: "Analyst", company: "Beta" });

    const csv = parseUploadFile(buf("﻿title,company\nAnalyst,Beta"), "jobs.csv");
    expect(csv[0].payload).toEqual({ title: "Analyst", company: "Beta" });
  });

  it("ignores headers that name inherited object keys, and never pollutes Object.prototype", () => {
    const csv = "constructor,__proto__,toString,hasOwnProperty,title,company\nA,B,C,D,Analyst,Beta";
    const [record] = parseUploadFile(buf(csv), "jobs.csv");
    expect(record.payload).toEqual({ title: "Analyst", company: "Beta" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const json = '[{"__proto__":"x","constructor":"y","toString":"z","title":"Analyst","company":"Beta"}]';
    const [fromJson] = parseUploadFile(buf(json), "jobs.json");
    expect(fromJson.payload).toEqual({ title: "Analyst", company: "Beta" });
    expect(Object.keys(fromJson.payload as object).sort()).toEqual(["company", "title"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("lets the first non-empty column win when several headers alias the same field", () => {
    const first = parseUploadFile(buf("title,position,company\nFirst,Second,Beta"), "jobs.csv");
    expect(first[0].payload).toEqual({ title: "First", company: "Beta" });
    const later = parseUploadFile(buf("title,position,company\n,Second,Beta"), "jobs.csv");
    expect(later[0].payload).toEqual({ title: "Second", company: "Beta" });
  });

  it("skips whitespace-only cells so a later alias column supplies the value", () => {
    const json = JSON.stringify([{ title: "   \t", jobTitle: "Real", company: "Beta", city: "  " }]);
    const [record] = parseUploadFile(buf(json), "jobs.json");
    expect(record.payload).toEqual({ title: "Real", company: "Beta" });
  });

  it("keeps the first row when explicit ids repeat", () => {
    const csv = "id,title,company\nX,First,Beta\nX,Second,Beta\nY,Third,Beta";
    const records = parseUploadFile(buf(csv), "jobs.csv");
    expect(records.map((r) => r.externalId)).toEqual(["X", "Y"]);
    expect((records[0].payload as { title: string }).title).toBe("First");
  });

  it("coerces numbers to strings and ignores null, object and array cells", () => {
    const json = JSON.stringify([
      { title: "Analyst", company: "Beta", id: 42, salary: 75000, location: null, url: { a: 1 }, description: ["x"] },
    ]);
    const [record] = parseUploadFile(buf(json), "jobs.json");
    expect(record.externalId).toBe("42");
    expect(record.payload).toEqual({ title: "Analyst", company: "Beta", salary: "75000" });
  });

  it('rejects {"jobs": null}, a top-level null and other non-array shapes with the JSON-shape message', () => {
    for (const body of ['{"jobs": null}', "null", "42", '"jobs"', '{"jobs": {}}']) {
      expect(() => parseUploadFile(buf(body), "jobs.json")).toThrow(new UploadParseError(JOB_SHAPE_ERROR));
    }
  });
});

// Uploaded files are hostile. Every case must finish quickly and end in either the exact parsed
// result or an UploadParseError whose user-safe message contains none of the file's content.
describe("parseUploadFile — adversarial input", { timeout: HEAVY_INPUT_TIMEOUT_MS }, () => {
  const BUDGET_MS = HEAVY_INPUT_BUDGET_MS;

  /** Builds nothing itself: the buffer is prepared by the caller so only parsing is timed. */
  const run = (b: Buffer, name: string) => {
    const start = performance.now();
    try {
      const records = parseUploadFile(b, name);
      return { ms: performance.now() - start, records, error: undefined as unknown };
    } catch (error) {
      return { ms: performance.now() - start, records: undefined, error };
    }
  };

  /** Asserts an UploadParseError with exactly this message, and that it leaks no file content. */
  const expectUserSafeError = (error: unknown, message: string, leakMarker: string) => {
    expect(error).toBeInstanceOf(UploadParseError);
    expect((error as UploadParseError).message).toBe(message);
    expect((error as UploadParseError).message).not.toContain(leakMarker);
  };

  it("(1) a ~5 MB CSV that is one unterminated quoted field is rejected as invalid CSV", () => {
    const b = buf('title,company\n"' + "a".repeat(5_000_000));
    const { ms, records, error } = run(b, "jobs.csv");
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(records).toBeUndefined();
    expectUserSafeError(error, "File is not valid CSV", "aaaa");
  });

  it("(2) 5000 rows x 2 KB descriptions is valid and parses in full", () => {
    const description = "d".repeat(2048);
    const rows = Array.from({ length: MAX_UPLOAD_ROWS }, (_, i) => `Job ${i},Co,${description}`);
    const b = buf(["title,company,description", ...rows].join("\n"));
    const { ms, records, error } = run(b, "jobs.csv");
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(records).toHaveLength(MAX_UPLOAD_ROWS);
    expect(records![0].payload).toEqual({ title: "Job 0", company: "Co", description });
    expect(records![MAX_UPLOAD_ROWS - 1].payload).toEqual({ title: `Job ${MAX_UPLOAD_ROWS - 1}`, company: "Co", description });
    expect(new Set(records!.map((r) => r.externalId)).size).toBe(MAX_UPLOAD_ROWS);
  });

  it("(3) 200,000 empty lines are skipped: header only is 'no jobs', a trailing row still parses", () => {
    const empty = run(buf("title,company\n" + "\n".repeat(200_000)), "jobs.csv");
    expect(empty.ms).toBeLessThan(BUDGET_MS);
    expect(empty.records).toBeUndefined();
    expectUserSafeError(empty.error, "File contains no jobs", "title");

    const withRow = run(buf("title,company\n" + "\n".repeat(200_000) + "Analyst,Beta"), "jobs.csv");
    expect(withRow.error).toBeUndefined();
    expect(withRow.ms).toBeLessThan(BUDGET_MS);
    expect(withRow.records).toHaveLength(1);
    expect(withRow.records![0].payload).toEqual({ title: "Analyst", company: "Beta" });
  });

  it("(4) 100,000 commas in the header row: no recognised columns is invalid, real columns still map", () => {
    const junk = run(buf(",".repeat(100_000) + "\nAnalyst,Beta"), "jobs.csv");
    expect(junk.ms).toBeLessThan(BUDGET_MS);
    expect(junk.records).toBeUndefined();
    expectUserSafeError(
      junk.error,
      "1 row is invalid (first: rows 1): each needs a title and a company, within the length limits",
      "Analyst",
    );

    const mapped = run(buf("title,company" + ",".repeat(100_000) + "\nAnalyst,Beta"), "jobs.csv");
    expect(mapped.error).toBeUndefined();
    expect(mapped.ms).toBeLessThan(BUDGET_MS);
    expect(mapped.records).toHaveLength(1);
    expect(mapped.records![0].payload).toEqual({ title: "Analyst", company: "Beta" });
  });

  it("(5) JSON nested 100,000 levels deep neither crashes nor overflows: it is one non-object row, rejected as invalid", () => {
    const b = buf("[".repeat(100_000) + "]".repeat(100_000));
    const { ms, records, error } = run(b, "jobs.json");
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(records).toBeUndefined();
    expect(error).not.toBeInstanceOf(RangeError);
    // V8's JSON.parse is iterative, so this is valid JSON: an array holding one (array) entry,
    // which the parser turns into an empty row that fails the title/company check.
    expectUserSafeError(
      error,
      "1 row is invalid (first: rows 1): each needs a title and a company, within the length limits",
      "[[",
    );
  });

  it("(6) a JSON array of 200,000 non-object entries hits the row cap before any per-row work", () => {
    const b = buf(JSON.stringify(Array.from({ length: 200_000 }, (_, i) => (i % 2 ? i : null))));
    const { ms, records, error } = run(b, "jobs.json");
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(records).toBeUndefined();
    expectUserSafeError(error, "File has more than 5,000 rows", "null");
  });

  it("(6b) a JSON array of 100 non-object entries reports all of them as invalid rows", () => {
    const b = buf(JSON.stringify(Array.from({ length: 100 }, (_, i) => (i % 2 ? i : null))));
    const { ms, error } = run(b, "jobs.json");
    expect(ms).toBeLessThan(BUDGET_MS);
    expectUserSafeError(
      error,
      "100 rows are invalid (first: rows 1, 2, 3): each needs a title and a company, within the length limits",
      "null",
    );
  });

  // The row cap must stop the parse itself: a 10 MB file of tiny rows would otherwise be ~5M records.
  it("(8) a ~10 MB CSV of 5.2M one-cell rows is rejected at the row cap without parsing them all", () => {
    const b = buf("title,company\n" + "a\n".repeat(5_200_000));
    const { ms, records, error } = run(b, "jobs.csv");
    expect(records).toBeUndefined();
    expectUserSafeError(error, "File has more than 5,000 rows", "aaaa");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("(9) a ~10 MB CSV of 2.6M two-cell rows is rejected at the row cap without parsing them all", () => {
    const b = buf("title,company\n" + "a,b\n".repeat(2_600_000));
    const { ms, records, error } = run(b, "jobs.csv");
    expect(records).toBeUndefined();
    expectUserSafeError(error, "File has more than 5,000 rows", "a,b");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("(10) a ~10 MB JSON array of 5.2M zeros is rejected at the row cap before any per-row work", () => {
    const b = buf("[" + "0,".repeat(5_200_000) + "0]");
    const { ms, records, error } = run(b, "jobs.json");
    expect(records).toBeUndefined();
    expectUserSafeError(error, "File has more than 5,000 rows", "0,0");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("(11) exactly 5,000 rows parse; 5,001 are rejected, for both CSV and JSON", () => {
    const csvRows = (n: number) => buf("title,company\n" + Array.from({ length: n }, (_, i) => `Job ${i},Co`).join("\n"));
    const jsonRows = (n: number) =>
      buf(JSON.stringify(Array.from({ length: n }, (_, i) => ({ title: `Job ${i}`, company: "Co" }))));
    expect(run(csvRows(MAX_UPLOAD_ROWS), "jobs.csv").records).toHaveLength(MAX_UPLOAD_ROWS);
    expect(run(jsonRows(MAX_UPLOAD_ROWS), "jobs.json").records).toHaveLength(MAX_UPLOAD_ROWS);
    expectUserSafeError(run(csvRows(MAX_UPLOAD_ROWS + 1), "jobs.csv").error, "File has more than 5,000 rows", "Job");
    expectUserSafeError(run(jsonRows(MAX_UPLOAD_ROWS + 1), "jobs.json").error, "File has more than 5,000 rows", "Job");
  });

  it("(7) the file type comes from the final extension only: NUL bytes and path separators in the name change nothing else", () => {
    const csv = buf("title,company\nAnalyst,Beta");
    const json = buf('[{"title":"Analyst","company":"Beta"}]');

    // Ends in .json, so the CSV text is parsed (and rejected) as JSON; the reverse for .csv.
    expectUserSafeError(run(csv, "jobs.csv\u0000.json").error, "File is not valid JSON", "Analyst");
    expectUserSafeError(run(json, "jobs.json\u0000.csv").error, "File is not valid CSV", "Analyst");
    // A name whose real extension is unsupported stays unsupported, whatever precedes it.
    expectUserSafeError(run(csv, "jobs.csv\u0000.txt").error, "Unsupported file type: use a .csv or .json file", "Analyst");
    expectUserSafeError(run(csv, "jobs.csv/").error, "Unsupported file type: use a .csv or .json file", "Analyst");

    // Directory parts are irrelevant; only the suffix decides. Detection is case-insensitive.
    for (const name of ["../../etc/jobs.csv", "C:\\x\\jobs.csv", "JOBS.CSV"]) {
      const { error, records } = run(csv, name);
      expect(error).toBeUndefined();
      expect(records).toHaveLength(1);
      expect(records![0].payload).toEqual({ title: "Analyst", company: "Beta" });
    }
  });
});
