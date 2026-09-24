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

/**
 * True only for an absolute http: or https: URL with no embedded username/password -- the only
 * scheme+shape ever stored or rendered as a link. Credentials in a URL rendered as an href can leak
 * to whatever host they name, or be used to mislead about the destination, so they are rejected here
 * rather than merely stripped.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Returns the canonical href for an http(s) URL with no embedded credentials, or null. `isHttpUrl`
 * only validates the RAW string; a non-canonical form the WHATWG URL parser still accepts (`http:/x`,
 * `https:evil.com`, `http:\\evil.com`) can be re-resolved differently by a browser than what was
 * validated. Storing `url.href` instead of the raw input guarantees what was validated is what is
 * later rendered as the href.
 */
export function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}
