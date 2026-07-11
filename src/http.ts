export const HTTP_RETRY_COUNT = 3;
export const HTTP_RETRY_DELAY_MS = 10_000;

export class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "HttpRequestError";
  }
}

export type RetryRequestInit = RequestInit & {
  timeoutMs?: number;
};

/**
 * Performs an HTTP request with a fixed retry policy. A retry is attempted for
 * network failures, timeouts, and every non-success HTTP response.
 */
export const fetchWithRetry = async (url: string | URL, init: RetryRequestInit = {}): Promise<Response> => {
  const { signal, timeoutMs, ...requestInit } = init;
  let lastError: unknown;

  for (let attempt = 0; attempt <= HTTP_RETRY_COUNT; attempt += 1) {
    try {
      const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
      const requestSignal = signal && timeoutSignal
        ? AbortSignal.any([signal, timeoutSignal])
        : signal ?? timeoutSignal;
      const response = await fetch(url, { ...requestInit, signal: requestSignal });
      if (!response.ok) {
        throw new HttpRequestError(response.status, response.statusText);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt === HTTP_RETRY_COUNT) {
        throw error;
      }

      await delay(HTTP_RETRY_DELAY_MS);
    }
  }

  throw lastError;
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
