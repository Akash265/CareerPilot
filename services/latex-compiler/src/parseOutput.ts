/** pdflatex's final line, e.g. "Output written on resume.pdf (1 page, 34567 bytes)." (max_print_line is raised, so it is never wrapped). */
export function parsePageCount(output: string): number | null {
  // The LAST match: box warnings echo document text to the log, so an earlier line could be spoofed.
  const all = [...output.matchAll(/Output written on [^\n]*?\((\d+) pages?/g)];
  const m = all[all.length - 1];
  return m ? Number(m[1]) : null;
}

/** "-file-line-error" format: "./resume.tex:42: <message>". Only the number leaves this service. */
export function parseErrorLine(output: string): number | undefined {
  const m = /^\.\/resume\.tex:(\d+):/m.exec(output);
  return m ? Number(m[1]) : undefined;
}
