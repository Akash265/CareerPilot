import type { WorkMode } from "../types";

function fromStructured(value: string | null | undefined): WorkMode | null {
  const v = value?.toLowerCase().replace(/[^a-z]/g, "");
  if (v === "remote") return "remote";
  if (v === "hybrid") return "hybrid";
  if (v === "onsite") return "onsite";
  return null; // "unspecified", empty, or anything unknown falls through
}

function fromText(text: string | null | undefined): WorkMode | null {
  if (!text) return null;
  if (/\bhybrid\b/i.test(text)) return "hybrid"; // beats "remote" in "Hybrid (remote-friendly)"
  if (/\bremote\b/i.test(text)) return "remote";
  if (/\bon[- ]?site\b|\bin[- ]office\b/i.test(text)) return "onsite";
  return null;
}

/** Structured field first, then location, then title. The description is deliberately not scanned: boilerplate says "remote" everywhere. */
export function detectWorkMode(input: {
  structured?: string | null;
  location?: string | null;
  title?: string | null;
}): WorkMode {
  return fromStructured(input.structured) ?? fromText(input.location) ?? fromText(input.title) ?? "unknown";
}
