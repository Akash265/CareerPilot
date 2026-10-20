import { createHash } from "node:crypto";
import { RENDERER_VERSION, TEX_TEMPLATE_VERSION, type DocumentFormat, type DocumentModel, type PaperSize, type TailoredResumeDetails } from "./types";

/** JSON with object keys sorted recursively; arrays keep their order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash of what the document says, not of the rendered bytes (PDF output embeds timestamps). */
export function modelContentHash(model: DocumentModel, format: DocumentFormat): string {
  return createHash("sha256").update(`${format}\n${RENDERER_VERSION}\n${stableStringify(model)}`).digest("hex");
}

/** Phase 13c (D210): template version, paper, the compiler's TeX version (PDF only) and the details are part of what the file is. */
export function tailoredContentHash(input: {
  format: "pdf" | "tex"; paperSize: PaperSize; texVersion: string | null; model: DocumentModel; details: TailoredResumeDetails;
}): string {
  return createHash("sha256")
    .update(["tailored", input.format, TEX_TEMPLATE_VERSION, input.paperSize, input.texVersion ?? "", stableStringify({ model: input.model, details: input.details })].join("\n"))
    .digest("hex");
}
