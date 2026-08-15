export type RuntimeReplacement<T> =
  | { applied: true; runtime: T }
  | { applied: false; runtime: T; error: unknown };

type RuntimeReplacementOptions<T> = {
  stopPrevious(): Promise<void>;
  createNext(): Promise<T>;
  restorePrevious(): Promise<T>;
  onStopError?(error: unknown): void;
};

/** Stops an old runtime, applies the next revision, and restores the last good
 * revision when construction fails. Cleanup failure is reported but never
 * leaves the already-stopped runtime installed. */
export const replaceRuntimeWithFallback = async <T>({
  stopPrevious,
  createNext,
  restorePrevious,
  onStopError,
}: RuntimeReplacementOptions<T>): Promise<RuntimeReplacement<T>> => {
  try {
    await stopPrevious();
  } catch (error) {
    onStopError?.(error);
  }

  try {
    return { applied: true, runtime: await createNext() };
  } catch (error) {
    try {
      return { applied: false, runtime: await restorePrevious(), error };
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Configuration reload and previous-runtime restoration both failed",
      );
    }
  }
};
