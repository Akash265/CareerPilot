/**
 * Phase 13b (R3): after a matching run completes, extract requirements for the top matches -- outside the BullMQ job,
 * so a search run waiting on matching (Phase 13a) is never delayed by these AI calls. One pass per user at a time; a
 * request during a pass schedules exactly one more (new matches may have arrived). Never rejects.
 */
export function createRequirementsRefresh(deps: { run: (userId: string) => Promise<void>; onError: (error: unknown) => void }) {
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();

  const start = (userId: string): Promise<void> => {
    const pass = (async () => {
      try {
        do {
          again.delete(userId);
          await deps.run(userId);
        } while (again.has(userId));
      } catch (error) {
        again.delete(userId);
        deps.onError(error);
      } finally {
        running.delete(userId);
      }
    })();
    running.set(userId, pass);
    return pass;
  };

  return (userId: string | undefined): Promise<void> => {
    if (!userId) return Promise.resolve();
    const current = running.get(userId);
    if (current) {
      again.add(userId);
      return current;
    }
    return start(userId);
  };
}
