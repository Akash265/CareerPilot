/** pdflatex's final line, e.g. "Output written on resume.pdf (1 page, 34567 bytes)." (max_print_line is raised, so it is never wrapped). */
export function parsePageCount(output: string): number | null {
  // The LAST match: box warnings echo document text to the log, so an earlier line could be spoofed.
  const all = [...output.matchAll(/Output written on [^\n]*?\((\d+) pages?/g)];
  const m = all[all.length - 1];
  return m ? Number(m[1]) : null;
}

/** Above any real page's text height (A4/Letter ≈ 700-760 pt); \maxdimen (16383.99998pt) means an empty page. */
const MAX_PLAUSIBLE_FREE_PT = 2000;

/**
 * Space left at the bottom of the last page, in whole points, from the template's own
 * "CAREERPILOT-FREE-SPACE=<dimen>" line (D217). The last line-start match wins: the template prints the marker after
 * all body text is typeset, so a look-alike echoed earlier (e.g. in a box warning) is superseded. A spoofed value can
 * only misdirect the refill, whose every result is still checked by the real page count. Only a number leaves here.
 */
export function parseFreeSpacePt(output: string): number | null {
  const all = [...output.matchAll(/^CAREERPILOT-FREE-SPACE=(-?\d+(?:\.\d+)?)pt$/gm)];
  const m = all[all.length - 1];
  if (!m) return null;
  const pt = Number(m[1]);
  return Number.isFinite(pt) && pt >= 0 && pt <= MAX_PLAUSIBLE_FREE_PT ? Math.floor(pt) : null;
}

/** "-file-line-error" format: "./resume.tex:42: <message>". Only the number leaves this service. */
export function parseErrorLine(output: string): number | undefined {
  const m = /^\.\/resume\.tex:(\d+):/m.exec(output);
  return m ? Number(m[1]) : undefined;
}
