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

/**
 * HTML -> plain text. The output is only ever stored and rendered as text
 * (React escapes it), never interpreted as HTML, so regex tag-stripping is
 * sufficient here; this is text extraction, not sanitization for an HTML sink.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*(?:br|\/p|\/div|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
      // <li> opens its own line ("- item"); no newline on </li>, or items get blank lines between them.
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Greenhouse returns `content` as entity-escaped HTML ("&lt;p&gt;..."): decode first, then strip the tags. */
export function escapedHtmlToText(content: string): string {
  return htmlToText(htmlToText(content));
}
