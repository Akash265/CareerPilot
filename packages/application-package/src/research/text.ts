/**
 * Truncates to at most `max` UTF-16 code units without ever leaving a lone high surrogate at the end
 * (the Phase 4 lesson, D44: an ordinary emoji cut in half by a slice is enough to make jsonb reject
 * the whole row).
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** True only for an absolute http: or https: URL -- the only schemes ever stored or rendered as links. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
