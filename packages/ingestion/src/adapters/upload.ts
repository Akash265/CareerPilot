import { createHash } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { hasUnsafeText } from "../normalize/text";
import { UploadRowSchema, type UploadRow } from "../sourceSchemas";
import type { RawRecord } from "../types";

export const MAX_UPLOAD_ROWS = 5000;
const TOO_MANY_ROWS = "File has more than 5,000 rows";

/** Longest `id` cell kept verbatim as externalId; longer ones are hashed (external_id is btree-indexed). */
const MAX_VERBATIM_ID_LENGTH = 200;

const hash32 = (input: string) => createHash("sha256").update(input).digest("hex").slice(0, 32);

/** Thrown with a user-safe message. It never includes file content. */
export class UploadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadParseError";
  }
}

const ALIASES: Record<string, keyof UploadRow | "id"> = {
  title: "title", jobtitle: "title", position: "title", role: "title",
  company: "company", companyname: "company", employer: "company", organization: "company",
  location: "location", city: "location",
  description: "description", jobdescription: "description", details: "description",
  url: "url", link: "url", joburl: "url", applyurl: "url",
  postedat: "postedAt", posted: "postedAt", dateposted: "postedAt", postingdate: "postedAt",
  employmenttype: "employmentType", type: "employmentType", commitment: "employmentType",
  salary: "salary", compensation: "salary", pay: "salary",
  id: "id", jobid: "id", externalid: "id",
};

function readObjects(buffer: Buffer, filename: string): Record<string, unknown>[] {
  if (buffer.includes(0)) throw new UploadParseError("File does not look like text (binary content found)");
  const text = buffer.toString("utf8");
  const name = filename.toLowerCase();

  if (name.endsWith(".json")) {
    let data: unknown;
    try {
      // JSON.parse rejects a leading BOM (csv-parse strips its own via `bom: true`).
      data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      throw new UploadParseError("File is not valid JSON");
    }
    const list = Array.isArray(data) ? data : (data as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(list)) {
      throw new UploadParseError('JSON must be an array of jobs, or an object with a "jobs" array');
    }
    // Check the cap before mapping so a file of millions of tiny entries costs no per-row work.
    if (list.length > MAX_UPLOAD_ROWS) throw new UploadParseError(TOO_MANY_ROWS);
    return list.map((row) => (row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {}));
  }

  if (name.endsWith(".csv")) {
    try {
      // `to` stops the parser after one record past the cap, so the caller's `> MAX_UPLOAD_ROWS`
      // check fires without ever materialising millions of rows from a small, tiny-row file.
      return parseCsv(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        to: MAX_UPLOAD_ROWS + 1,
      });
    } catch {
      throw new UploadParseError("File is not valid CSV");
    }
  }
  throw new UploadParseError("Unsupported file type: use a .csv or .json file");
}

function toCanonical(raw: Record<string, unknown>): { row: Record<string, string>; id: string | null } {
  const row: Record<string, string> = {};
  let id: string | null = null;
  for (const [header, value] of Object.entries(raw)) {
    const alias = header.toLowerCase().replace(/[^a-z0-9]/g, "");
    // Own keys only: a header such as `constructor` or `__proto__` must not resolve to an inherited member.
    const key = Object.hasOwn(ALIASES, alias) ? ALIASES[alias] : undefined;
    if (!key || value === null || value === undefined || typeof value === "object") continue;
    const text = String(value).trim();
    if (!text) continue;
    if (key === "id") id ??= text;
    else row[key] ??= text;
  }
  return { row, id };
}

export function parseUploadFile(buffer: Buffer, filename: string): RawRecord[] {
  const objects = readObjects(buffer, filename);
  if (objects.length === 0) throw new UploadParseError("File contains no jobs");
  if (objects.length > MAX_UPLOAD_ROWS) throw new UploadParseError(TOO_MANY_ROWS);

  const records: RawRecord[] = [];
  const seen = new Set<string>();
  const invalid: number[] = [];

  objects.forEach((raw, index) => {
    const { row, id } = toCanonical(raw);
    // `id` is pulled out of the row separately (see toCanonical) so it never passes through
    // UploadRowSchema's guards; it becomes `externalId` verbatim below and would otherwise reach the
    // raw_job_postings.external_id text column unguarded. A NUL byte makes it unstorable outright; an
    // unpaired surrogate is legal JSON, survives the parser, and then breaks the jsonb write.
    if (id !== null && hasUnsafeText(id)) {
      invalid.push(index + 1);
      return;
    }
    const parsed = UploadRowSchema.safeParse(row);
    if (!parsed.success) {
      invalid.push(index + 1);
      return;
    }
    const data = parsed.data;
    const externalId =
      id === null
        ? hash32([data.company, data.title, data.location ?? "", data.url ?? ""].join("\u0001"))
        : id.length > MAX_VERBATIM_ID_LENGTH
          ? hash32(id)
          : id;
    if (seen.has(externalId)) return;
    seen.add(externalId);
    records.push({ externalId, payload: data });
  });

  if (invalid.length > 0) {
    const first = invalid.slice(0, 3).join(", ");
    throw new UploadParseError(
      `${invalid.length} row${invalid.length === 1 ? " is" : "s are"} invalid (first: rows ${first}): each needs a title and a company, within the length limits, and must not contain null characters`
    );
  }
  return records;
}
