import { createHash } from "node:crypto";
import type { NormalizedJob } from "../types";

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited", "gmbh", "ag", "plc",
  "corp", "corporation", "co", "sa", "bv", "nv", "oy", "ab", "pty", "srl", "spa", "kg", "se",
]);

function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function words(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

export function companyKey(name: string): string {
  let tokens = words(name).split(" ").filter(Boolean);
  if (tokens[0] === "the" && tokens.length > 1) tokens = tokens.slice(1);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

const SENIORITY: [string, RegExp][] = [
  ["intern", /\binterns?(?:hip)?\b/g],
  ["junior", /\b(?:junior|jr)\b/g],
  ["senior", /\b(?:senior|sr)\b/g],
  ["staff", /\bstaff\b/g],
  ["principal", /\bprincipal\b/g],
  ["lead", /\blead\b/g],
  ["director", /\bdirector\b/g],
  ["vp", /\b(?:vp|vice president)\b/g],
  ["head", /\bhead of\b/g],
];

export function titleKey(title: string): { titleKey: string; seniority: string | null } {
  const plain = words(title);
  let stripped = plain;
  let seniority: string | null = null;
  for (const [name, pattern] of SENIORITY) {
    if (pattern.test(stripped)) {
      seniority ??= name;
      stripped = stripped.replace(pattern, " ");
    }
    pattern.lastIndex = 0;
  }
  stripped = stripped.replace(/\s+/g, " ").trim();
  return { titleKey: stripped || plain, seniority };
}

/**
 * jobs.location_key is btree-indexed, and Postgres rejects an index row over ~2.7KB. NFKD can expand one
 * character into many (U+FDFA becomes 18), so bound the computed key itself: 600 code units x <= 4 UTF-8
 * bytes = 2400 bytes.
 */
const MAX_LOCATION_KEY_CHARS = 600;

export function locationKey(location: string | null | undefined): string {
  if (!location) return "";
  return location
    .split(";")
    .map((part) => words(part))
    .filter(Boolean)
    .sort()
    .join("|")
    .slice(0, MAX_LOCATION_KEY_CHARS);
}

function normalizeForHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function descriptionHash(text: string): string {
  return createHash("sha256").update(normalizeForHash(text)).digest("hex");
}

export function computeFingerprint(
  job: Pick<NormalizedJob, "companyKey" | "titleKey" | "locationKey" | "descriptionHash">
): string {
  return createHash("sha256")
    .update([job.companyKey, job.titleKey, job.locationKey, job.descriptionHash].join("\u0001"))
    .digest("hex");
}
