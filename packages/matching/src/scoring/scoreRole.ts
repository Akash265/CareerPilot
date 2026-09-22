function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean));
}

/** Word-overlap ratio between the job title and every stated target role, combined -- deliberately simple and explainable rather than a fuzzy-match library. */
export function scoreRole(targetRoles: string[], jobTitle: string): number {
  if (targetRoles.length === 0) return 1;
  const titleWords = words(jobTitle);
  if (titleWords.size === 0) return 0.5;
  const goalWords = new Set(targetRoles.flatMap((role) => [...words(role)]));
  if (goalWords.size === 0) return 0.5;
  const overlap = [...titleWords].filter((w) => goalWords.has(w)).length;
  return Math.min(1, overlap / Math.min(titleWords.size, goalWords.size));
}
