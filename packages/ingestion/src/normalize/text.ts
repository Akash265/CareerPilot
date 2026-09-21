const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint =
        entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Hard cap on the input htmlToText will look at, so worst-case work on hostile content is bounded. */
export const MAX_HTML_CHARS = 1_000_000;

/** Lowercases ASCII letters only. Unlike toLowerCase() it never changes the string length, so indexes stay valid. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Removes <script>/<style> blocks (opener through closer, inclusive) with a single left-to-right indexOf scan.
 * An opener with no closer runs to the end of the input, as in browsers. Linear: every indexOf continues from
 * where the previous match ended, and the position only moves forward.
 */
function removeScriptAndStyle(html: string): string {
  const lower = asciiLower(html);
  const parts: string[] = [];
  let keepFrom = 0; // start of the text not yet emitted
  let searchFrom = 0; // where the next opener search continues (>= keepFrom)
  let nextScript = -2; // -2 = not searched yet, -1 = none left
  let nextStyle = -2;
  while (searchFrom < html.length) {
    if (nextScript !== -1 && nextScript < searchFrom) nextScript = lower.indexOf("<script", searchFrom);
    if (nextStyle !== -1 && nextStyle < searchFrom) nextStyle = lower.indexOf("<style", searchFrom);
    if (nextScript === -1 && nextStyle === -1) break;
    const useScript = nextStyle === -1 || (nextScript !== -1 && nextScript < nextStyle);
    const start = useScript ? nextScript : nextStyle;
    const name = useScript ? "script" : "style";
    // "<scripts>" / "<styled>" are ordinary tags, not blocks to drop.
    if (/[a-z0-9_]/.test(lower.charAt(start + 1 + name.length))) {
      searchFrom = start + 1;
      continue;
    }
    parts.push(html.slice(keepFrom, start));
    const close = lower.indexOf(`</${name}>`, start);
    if (close === -1) {
      keepFrom = html.length;
      break;
    }
    keepFrom = searchFrom = close + name.length + 3;
  }
  parts.push(html.slice(keepFrom));
  return parts.join(" ");
}

/**
 * HTML -> plain text. The output is only ever stored and rendered as text
 * (React escapes it), never interpreted as HTML, so regex tag-stripping is
 * sufficient here; this is text extraction, not sanitization for an HTML sink.
 * Input is untrusted, so every step is linear (or bounded) in the input size.
 */
export function htmlToText(html: string): string {
  // Every tag body below is capped at 2000 chars, so a stray "<" cannot make a regex scan to the end of the input.
  return decodeEntities(
    removeScriptAndStyle(html.slice(0, MAX_HTML_CHARS))
      .replace(/<\s*(?:br|\/p|\/div|\/h[1-6]|\/tr)\b[^<>]{0,2000}>/gi, "\n")
      // <li> opens its own line ("- item"); no newline on </li>, or items get blank lines between them.
      .replace(/<li\b[^<>]{0,2000}>/gi, "\n- ")
      .replace(/<[^<>]{0,2000}>/g, " ")
  )
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Greenhouse returns `content` as entity-escaped HTML ("&lt;p&gt;..."): decode first, then strip the tags. */
export function escapedHtmlToText(content: string): string {
  return htmlToText(htmlToText(content));
}
