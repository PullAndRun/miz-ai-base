export type VideoJobAdmission =
  | Readonly<{
      acquired: true;
      release(): void;
    }>
  | Readonly<{
      acquired: false;
      reason: "duplicate" | "busy";
    }>;

export type QueuedVideoJob = Readonly<{
  /** Number of jobs already waiting ahead of this one. */
  position: number;
  /** Resolves when this job reaches the front of the queue. */
  ready: Promise<VideoJobHandle>;
}>;

export type VideoJobHandle = Readonly<{
  release(): void;
}>;

let activeJobCount = 0;
const activeJobKeys = new Set<string>();

type PendingVideoJob = {
  resolve: (handle: VideoJobHandle) => void;
};

let queuedJobs: PendingVideoJob[] = [];

export const tryAcquireVideoJob = (
  jobKey: string,
  maxConcurrentJobs: number,
): VideoJobAdmission => {
  const limit = normalizeConcurrencyLimit(maxConcurrentJobs);
  if (activeJobKeys.has(jobKey)) {
    return { acquired: false, reason: "duplicate" };
  }
  if (activeJobCount >= limit) {
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
      drainVideoQueue(limit);
    },
  };
};

/**
 * Enqueue a video job instead of rejecting it when all transcode slots are busy.
 * Jobs are admitted FIFO; callers should await `ready` before doing the work.
 */
export const enqueueVideoJob = (
  maxConcurrentJobs: number,
): QueuedVideoJob => {
  const limit = normalizeConcurrencyLimit(maxConcurrentJobs);
  const position = activeJobCount + queuedJobs.length;
  let resolveReady!: (handle: VideoJobHandle) => void;
  const ready = new Promise<VideoJobHandle>((resolve) => {
    resolveReady = resolve;
  });
  queuedJobs.push({ resolve: resolveReady });
  drainVideoQueue(limit);
  return { position, ready };
};

const drainVideoQueue = (maxConcurrentJobs: number) => {
  const limit = normalizeConcurrencyLimit(maxConcurrentJobs);
  while (activeJobCount < limit && queuedJobs.length > 0) {
    const pending = queuedJobs.shift();
    if (!pending) {
      continue;
    }
    activeJobCount += 1;
    let released = false;
    pending.resolve({
      release: () => {
        if (released) {
          return;
        }
        released = true;
        activeJobCount -= 1;
        drainVideoQueue(limit);
      },
    });
  }
};

const normalizeConcurrencyLimit = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
