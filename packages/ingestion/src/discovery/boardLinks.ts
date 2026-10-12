import type { BoardKind } from "../types";

/**
 * Phase 12 (D186): company job boards linked from posting text. Each pattern is anchored on the platform's own
 * host (no look-alike host can match) and captures only a safe slug -- the same character set the board adapters
 * accept, so a discovered slug can never change the host or path it is fetched from.
 */
export interface BoardLink {
  kind: BoardKind;
  slug: string;
}

// The slug must end where the path segment ends: "a%2Fb" is one encoded segment, not the board "a".
const SLUG = "([A-Za-z0-9_-]{1,64})(?=$|[/?#\"'<>\\s)\\]&,;:.!|])";
// (?<![\w.-]) stops "notgreenhouse.io" and "x.jobs.lever.co"; the trailing lookahead stops "lever.co.evil.com".
const PATTERNS: [BoardKind, RegExp][] = [
  // EU-region boards (job-boards.eu.greenhouse.io, jobs.eu.lever.co) live behind separate APIs the adapters do not
  // call, so they are not matched: fetched against the US API they would only be rejected (review fix).
  ["greenhouse", new RegExp(`(?<![\\w.-])(?:boards|job-boards)\\.greenhouse\\.io/(?:embed/job_board\\?for=)?${SLUG}`, "gi")],
  ["lever", new RegExp(`(?<![\\w.-])jobs\\.lever\\.co(?![\\w.-])/${SLUG}`, "gi")],
  ["ashby", new RegExp(`(?<![\\w.-])jobs\\.ashbyhq\\.com/${SLUG}`, "gi")],
  ["workable", new RegExp(`(?<![\\w.-])apply\\.workable\\.com/${SLUG}`, "gi")],
  ["smartrecruiters", new RegExp(`(?<![\\w.-])(?:jobs|careers)\\.smartrecruiters\\.com/${SLUG}`, "gi")],
  // (?![\w.-]): "acme.recruitee.com.evil.com" is not a Recruitee board (review fix).
  ["recruitee", new RegExp(`(?<![\\w.-])([A-Za-z0-9-]{1,63})\\.recruitee\\.com(?![\\w.-])`, "gi")],
];

/** Path segments and sub-domains that are the platform's own pages, not a company. */
const NOT_A_COMPANY: Record<BoardKind, ReadonlySet<string>> = {
  greenhouse: new Set(["embed", "v1", "api"]),
  lever: new Set(["api", "v0"]),
  ashby: new Set(["api"]),
  workable: new Set(["j", "api", "jobs", "careers"]),
  smartrecruiters: new Set(["oneclick-ui", "api", "public", "sr-jobs"]),
  recruitee: new Set(["www", "app", "api", "careers", "static", "assets", "blog", "support", "help"]),
};

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", sol: "/" };
/** Entity decoding only -- tags stay, because the links live in href attributes. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Every distinct board linked from `text`, in order of first appearance (compared without case). */
export function extractBoardLinks(text: string): BoardLink[] {
  const decoded = decodeEntities(text);
  const found: { at: number; link: BoardLink }[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of decoded.matchAll(re)) {
      const slug = m[1];
      if (!NOT_A_COMPANY[kind].has(slug.toLowerCase())) found.push({ at: m.index ?? 0, link: { kind, slug } });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: BoardLink[] = [];
  for (const { link } of found) {
    const key = `${link.kind}:${link.slug.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(link);
    }
  }
  return out;
}
