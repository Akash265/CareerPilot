import { describe, it, expect } from "vitest";
import { extractBoardLinks } from "./boardLinks";

describe("extractBoardLinks (Phase 12, D186)", () => {
  // Slugs keep their case: Lever is case-sensitive ("leverdemo" exists, "LeverDemo" is a 404); duplicates are compared without it.
  it("finds boards on all six platforms, in plain text and in hrefs", () => {
    const text = `
      Apply: https://boards.greenhouse.io/gitlab/jobs/123 or https://job-boards.greenhouse.io/mistral
      <a href="https://jobs.lever.co/netflix/abc-123">x</a> https://jobs.lever.co/Spotify
      https://jobs.ashbyhq.com/linear/7458 https://apply.workable.com/huggingface/j/81B46579FE/
      https://jobs.smartrecruiters.com/BoschGroup/7440001 https://careers.smartrecruiters.com/Visa
      https://bunq.recruitee.com/o/transaction-review-lead`;
    expect(extractBoardLinks(text)).toEqual([
      { kind: "greenhouse", slug: "gitlab" }, { kind: "greenhouse", slug: "mistral" },
      { kind: "lever", slug: "netflix" }, { kind: "lever", slug: "Spotify" },
      { kind: "ashby", slug: "linear" }, { kind: "workable", slug: "huggingface" },
      { kind: "smartrecruiters", slug: "BoschGroup" }, { kind: "smartrecruiters", slug: "Visa" },
      { kind: "recruitee", slug: "bunq" },
    ]);
  });

  it("decodes HTML entities first (HN writes slashes as &#x2F;) and handles the embed form", () => {
    expect(extractBoardLinks('<a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;prairielearn">')).toEqual([{ kind: "ashby", slug: "prairielearn" }]);
    expect(extractBoardLinks("https://boards.greenhouse.io/embed/job_board?for=stripe&amp;b=x")).toEqual([{ kind: "greenhouse", slug: "stripe" }]);
  });

  it("ignores platform paths that are not companies, look-alike hosts and duplicates", () => {
    const text = `https://apply.workable.com/j/81B46579FE https://boards.greenhouse.io/embed/job_app?token=1
      https://api.ashbyhq.com/posting-api https://www.recruitee.com https://app.recruitee.com/x
      https://jobs.lever.co.evil.com/acme https://notgreenhouse.io/acme https://jobs.lever.co/acme https://JOBS.LEVER.CO/Acme`;
    expect(extractBoardLinks(text)).toEqual([{ kind: "lever", slug: "acme" }]);
  });

  it("never returns a slug outside the safe character set or longer than 64", () => {
    expect(extractBoardLinks(`https://jobs.lever.co/${"a".repeat(65)} https://jobs.lever.co/a%2Fb`)).toEqual([]);
  });

  it("ignores look-alike Recruitee hosts and EU-region boards the US APIs cannot fetch (review fixes)", () => {
    expect(extractBoardLinks("https://acme.recruitee.com.evil.com/o/x https://jobs.eu.lever.co/acme https://job-boards.eu.greenhouse.io/acme")).toEqual([]);
  });
});
