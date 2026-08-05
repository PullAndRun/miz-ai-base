export type VideoJobAdmission =
  | Readonly<{
      acquired: true;
      release(): void;
    }>
  | Readonly<{
      acquired: false;
      reason: "duplicate" | "busy";
    }>;

let activeJobCount = 0;
const activeJobKeys = new Set<string>();

export const tryAcquireVideoJob = (
  jobKey: string,
  maxConcurrentJobs: number,
): VideoJobAdmission => {
  if (activeJobKeys.has(jobKey)) {
    return { acquired: false, reason: "duplicate" };
  }
  if (activeJobCount >= maxConcurrentJobs) {
    return { acquired: false, reason: "busy" };
  }

  activeJobCount += 1;
  activeJobKeys.add(jobKey);
  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      activeJobCount -= 1;
      activeJobKeys.delete(jobKey);
    },
  };
};
