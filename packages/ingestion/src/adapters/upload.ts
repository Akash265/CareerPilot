import { createHash } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { UploadRowSchema, type UploadRow } from "../sourceSchemas";
import type { RawRecord } from "../types";

export const MAX_UPLOAD_ROWS = 5000;

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
      data = JSON.parse(text);
    } catch {
      throw new UploadParseError("File is not valid JSON");
    }
    const list = Array.isArray(data) ? data : (data as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(list)) {
      throw new UploadParseError('JSON must be an array of jobs, or an object with a "jobs" array');
    }
    return list.map((row) => (row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {}));
  }

  if (name.endsWith(".csv")) {
    try {
      return parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
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
    const key = ALIASES[header.toLowerCase().replace(/[^a-z0-9]/g, "")];
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
  if (objects.length > MAX_UPLOAD_ROWS) throw new UploadParseError("File has more than 5,000 rows");

  const records: RawRecord[] = [];
  const seen = new Set<string>();
  const invalid: number[] = [];

  objects.forEach((raw, index) => {
    const { row, id } = toCanonical(raw);
    const parsed = UploadRowSchema.safeParse(row);
    if (!parsed.success) {
      invalid.push(index + 1);
      return;
    }
    const data = parsed.data;
    const externalId =
      id ??
      createHash("sha256")
        .update([data.company, data.title, data.location ?? "", data.url ?? ""].join("\u0001"))
        .digest("hex")
        .slice(0, 32);
    if (seen.has(externalId)) return;
    seen.add(externalId);
    records.push({ externalId, payload: data });
  });

  if (invalid.length > 0) {
    const first = invalid.slice(0, 3).join(", ");
    throw new UploadParseError(
      `${invalid.length} row${invalid.length === 1 ? " is" : "s are"} invalid (first: rows ${first}): each needs a title and a company`
    );
  }
  return records;
}
