import { describe, it, expect } from "vitest";
import { parseUploadFile, UploadParseError, MAX_UPLOAD_ROWS } from "./upload";

const buf = (s: string) => Buffer.from(s, "utf8");

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

  it("rejects files over the row cap", () => {
    const lines = ["title,company", ...Array.from({ length: MAX_UPLOAD_ROWS + 1 }, (_, i) => `Job ${i},Co`)];
    rejects(buf(lines.join("\n")), "jobs.csv", /5,000/);
  });
});

// Uploaded files are hostile. Every case must finish quickly and end in either the exact parsed
// result or an UploadParseError whose user-safe message contains none of the file's content.
describe("parseUploadFile — adversarial input", () => {
  const BUDGET_MS = 1000;

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
      "1 row is invalid (first: rows 1): each needs a title and a company",
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
    expectUserSafeError(error, "1 row is invalid (first: rows 1): each needs a title and a company", "[[");
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
    expectUserSafeError(error, "100 rows are invalid (first: rows 1, 2, 3): each needs a title and a company", "null");
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
