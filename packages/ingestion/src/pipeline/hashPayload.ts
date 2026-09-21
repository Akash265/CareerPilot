import { createHash } from "node:crypto";

/** JSON with object keys sorted, so key order in a source's response never changes a record's hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}
