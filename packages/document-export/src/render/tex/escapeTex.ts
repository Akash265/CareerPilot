import type { DocumentModel } from "../../model/types";

/**
 * The only path from document text into TeX (Phase 13c spec §4, D208). Characters with a TeX meaning become
 * macros or escaped forms; typographic characters map to explicit macros so the PDF text layer is exact.
 */
const REPLACEMENTS: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "%": "\\%",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
  // `\item [x]` would read [x] as an optional argument.
  "[": "{[}",
  "]": "{]}",
  "`": "\\textasciigrave{}",
  '"': "\\textquotedbl{}",
  "|": "\\textbar{}",
  " ": "~",
  "–": "\\textendash{}",
  "—": "\\textemdash{}",
  "‘": "\\textquoteleft{}",
  "’": "\\textquoteright{}",
  "“": "\\textquotedblleft{}",
  "”": "\\textquotedblright{}",
  "•": "\\textbullet{}",
  "…": "\\ldots{}",
  "€": "\\texteuro{}",
  "£": "\\pounds{}",
  "−": "-",
  "→": "\\textrightarrow{}",
};

/** T1 ligatures that would change the text when a character is doubled ("--" en dash, ",," low quotes, "<<" guillemets). */
const LIGATURE_CHARS = new Set(["-", "'", ",", "<", ">"]);

/** Control, zero-width and soft-hyphen characters: removed, never typeset. */
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‍⁠﻿]/g;

/** Latin Extended-A code points pdflatex's T1/utf8 setup has no glyph or definition for. */
const UNSUPPORTED_LATIN = new Set([0x126, 0x127, 0x138, 0x13f, 0x140, 0x149, 0x166, 0x167, 0x17f]);

function clean(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ").replace(STRIP, "");
}

export function escapeTex(text: string): string {
  const chars = [...clean(text)];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    out += REPLACEMENTS[ch] ?? ch;
    if (LIGATURE_CHARS.has(ch) && chars[i + 1] === ch) out += "{}";
  }
  return out;
}

export function isSupportedChar(ch: string): boolean {
  if (ch in REPLACEMENTS) return true;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0x17f) return !UNSUPPORTED_LATIN.has(cp);
  return false;
}

const hasUnsupported = (text: string): boolean => [...clean(text)].some((ch) => !isSupportedChar(ch));

/** Every supported character once (the compile test typesets it to prove the whitelist is honest). */
export const SUPPORTED_SAMPLE: string = (() => {
  let s = "";
  for (let cp = 0x20; cp <= 0x17f; cp++) {
    if (cp > 0x7e && cp < 0xa0) continue;
    const ch = String.fromCodePoint(cp);
    if (isSupportedChar(ch) && !STRIP.test(ch)) s += ch;
    STRIP.lastIndex = 0;
  }
  for (const ch of Object.keys(REPLACEMENTS)) if (!s.includes(ch)) s += ch;
  return s;
})();

/**
 * Where in the document the first character pdflatex cannot typeset is, as "Section, entry N, bullet M" -- a
 * location only, never the text (the message goes to the UI; the text stays in the profile).
 */
export function findUnsupportedCharacter(model: DocumentModel): string | null {
  if (hasUnsupported(model.title)) return "Name";
  if (model.contactLine !== null && hasUnsupported(model.contactLine)) return "Contact details";
  let section = "Document";
  let entry = 0;
  for (const block of model.blocks) {
    switch (block.type) {
      case "heading":
        section = block.text;
        entry = 0;
        if (hasUnsupported(block.text)) return section;
        break;
      case "entry":
        entry += 1;
        if ([block.title, block.subtitle, block.meta].some((t) => t !== null && hasUnsupported(t))) return `${section}, entry ${entry}`;
        break;
      case "paragraph":
        if (hasUnsupported(block.text)) return entry > 0 ? `${section}, entry ${entry}` : section;
        break;
      case "bullets": {
        const i = block.items.findIndex(hasUnsupported);
        if (i >= 0) return entry > 0 ? `${section}, entry ${entry}, bullet ${i + 1}` : `${section}, item ${i + 1}`;
        break;
      }
    }
  }
  return null;
}
