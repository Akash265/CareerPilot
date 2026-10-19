/** Phase 13b: the one way a skill_verifications.term_key is made. Punctuation is kept ("c++" is not "c"). */
export function normalizeTermKey(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}
