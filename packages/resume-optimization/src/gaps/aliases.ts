/**
 * Phase 13b: names that mean the same skill. Used only to SUGGEST "same as your <profile skill>?" for an unanswered
 * gap; a suggestion never covers a term. Only unambiguous equivalents (no "tf", "cv", "dl"). Keys are normalized
 * (normalizeTermKey); aliases.test.ts checks that and that no key is in two groups.
 */
export const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["postgres", "postgresql"],
  ["javascript", "js", "ecmascript"],
  ["typescript", "ts"],
  ["kubernetes", "k8s"],
  ["aws", "amazon web services"],
  ["gcp", "google cloud", "google cloud platform"],
  ["azure", "microsoft azure"],
  ["machine learning", "ml"],
  ["artificial intelligence", "ai"],
  ["natural language processing", "nlp"],
  ["large language models", "llm", "llms"],
  ["ci/cd", "cicd", "ci-cd", "continuous integration and delivery", "continuous integration/continuous delivery"],
  ["node.js", "nodejs", "node"],
  ["react", "react.js", "reactjs"],
  ["vue", "vue.js", "vuejs"],
  ["next.js", "nextjs"],
  ["go", "golang"],
  ["c#", "csharp", "c sharp"],
  ["c++", "cpp"],
  [".net", "dotnet"],
  ["python", "python 3", "python3"],
  ["scikit-learn", "sklearn", "scikit learn"],
  ["pytorch", "torch"],
  ["power bi", "powerbi"],
  ["excel", "microsoft excel", "ms excel"],
  ["spark", "apache spark"],
  ["kafka", "apache kafka"],
  ["airflow", "apache airflow"],
  ["dbt", "data build tool"],
  ["elasticsearch", "elastic search"],
  ["mongodb", "mongo"],
  ["sql server", "microsoft sql server", "mssql", "ms sql"],
  ["s3", "amazon s3", "aws s3"],
  ["redshift", "amazon redshift", "aws redshift"],
  ["bigquery", "google bigquery"],
  ["ec2", "amazon ec2", "aws ec2"],
  ["lambda", "aws lambda"],
  ["terraform", "hashicorp terraform"],
  ["github actions", "gh actions"],
  ["rest", "rest api", "rest apis", "restful api", "restful apis"],
  ["graphql", "graph ql"],
  ["ruby on rails", "rails", "ror"],
  ["ux", "user experience"],
  ["ui", "user interface"],
  ["ui/ux", "ux/ui"],
  ["seo", "search engine optimization"],
  ["etl", "extract transform load", "extract, transform, load"],
  ["bi", "business intelligence"],
  ["a/b testing", "ab testing", "split testing"],
  ["oop", "object-oriented programming", "object oriented programming"],
  ["tdd", "test-driven development", "test driven development"],
  ["html", "html5"],
  ["css", "css3"],
  ["sass", "scss"],
  ["salesforce", "sfdc"],
  ["bash", "bash scripting"],
];

const GROUP_BY_KEY = new Map<string, readonly string[]>(ALIAS_GROUPS.flatMap((group) => group.map((key) => [key, group] as const)));

export function aliasGroupOf(termKey: string): readonly string[] | undefined {
  return GROUP_BY_KEY.get(termKey);
}
