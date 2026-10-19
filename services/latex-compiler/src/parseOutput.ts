/** pdflatex's final line, e.g. "Output written on resume.pdf (1 page, 34567 bytes)." (max_print_line is raised, so it is never wrapped). */
export function parsePageCount(output: string): number | null {
  const m = /Output written on .*?\((\d+) pages?/s.exec(output);
  return m ? Number(m[1]) : null;
}

/** "-file-line-error" format: "./resume.tex:42: <message>". Only the number leaves this service. */
export function parseErrorLine(output: string): number | undefined {
  const m = /^\.\/resume\.tex:(\d+):/m.exec(output);
  return m ? Number(m[1]) : undefined;
}
