/**
 * Runs all work items while keeping the number of in-flight operations bounded.
 * Results keep the same order as the input, including individual failures.
 */
export const settleWithConcurrency = async <T, R>(
  items: readonly T[],
  maximumConcurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  if (items.length === 0) {
    return [];
  }

  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const requestedWorkers = Number.isFinite(maximumConcurrency)
    ? Math.floor(maximumConcurrency)
    : 1;
  const workerCount = Math.min(items.length, Math.max(1, requestedWorkers));
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));

  return results;
};

/**
 * Starts tasks gradually while maintaining a bounded number of active jobs.
 * The returned promises preserve input order and can be awaited independently.
 */
export const startWithConcurrency = <T, R>(
  items: readonly T[],
  maximumConcurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R>[] => {
  const deferred = items.map(createDeferred<R>);
  const requestedWorkers = Number.isFinite(maximumConcurrency)
    ? Math.floor(maximumConcurrency)
    : 1;
  const workerCount = Math.min(items.length, Math.max(1, requestedWorkers));
  let nextIndex = 0;

  void Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      try {
        deferred[index].resolve(await worker(items[index]));
      } catch (error) {
        deferred[index].reject(error);
      }
    }
  }));

  return deferred.map((item) => item.promise);
};

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
