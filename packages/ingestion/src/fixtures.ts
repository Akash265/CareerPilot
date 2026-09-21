// Field names and shapes match live responses from
//   https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true
//   https://api.lever.co/v0/postings/spotify?mode=json
// (verified 2026-09-21). Text content is trimmed and synthetic.

export const greenhouseJobFixture = {
  id: 8556658002,
  internal_job_id: 6417799002,
  title: "AI Engineer",
  company_name: "GitLab",
  absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/8556658002",
  location: { name: "Remote, United States" },
  first_published: "2026-05-22T09:16:29-04:00",
  updated_at: "2026-09-14T16:01:39-04:00",
  requisition_id: "6401",
  language: "en",
  // Entity-escaped HTML, exactly as Greenhouse returns it.
  content:
    "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;GitLab is the intelligent orchestration platform.&lt;/p&gt;&lt;/div&gt;" +
    "&lt;h3&gt;What You&#39;ll Do&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Build agents.&lt;/li&gt;&lt;/ul&gt;" +
    "&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;5+ years of experience in software engineering&lt;/li&gt;" +
    "&lt;li&gt;2+ years of experience with LLMs (nice to have)&lt;/li&gt;&lt;/ul&gt;" +
    "&lt;p&gt;The base salary range for this role is $150,000 - $200,000 per year. Visa sponsorship is not available.&lt;/p&gt;",
};

export const leverPostingFixture = {
  id: "2193db3f-77c5-43b8-b030-8f92c9882bf1",
  text: "Senior Data Engineer",
  hostedUrl: "https://jobs.lever.co/acme/2193db3f-77c5-43b8-b030-8f92c9882bf1",
  applyUrl: "https://jobs.lever.co/acme/2193db3f-77c5-43b8-b030-8f92c9882bf1/apply",
  createdAt: 1782214185805,
  country: "GB",
  workplaceType: "hybrid",
  categories: {
    commitment: "Permanent",
    department: "Engineering",
    location: "London",
    team: "Data",
    allLocations: ["London", "Stockholm"],
  },
  descriptionPlain: "We build the data platform.",
  lists: [
    {
      text: "Who You Are",
      content: "<li>3+ years of experience with SQL</li><li>Kotlin is a plus</li>",
    },
  ],
  additionalPlain: "Acme is an equal opportunity employer.",
};
