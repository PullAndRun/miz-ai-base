export const HTTP_RETRY_COUNT = 3;
export const HTTP_RETRY_DELAY_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type HttpRequestError = Error & Readonly<{ status: number; retryAfterMs?: number }>;

export const createHttpRequestError = (status: number, statusText: string, retryAfterMs?: number): HttpRequestError =>
  Object.assign(new Error(`HTTP ${status}: ${statusText}`), {
    name: "HttpRequestError",
    status,
    retryAfterMs,
  });

export type RetryRequestInit = RequestInit & {
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
  retryRateLimited?: boolean;
};

/**
 * Performs an HTTP request with a fixed retry policy. Only transient failures
 * are retried, and cancellation interrupts both a request and its backoff.
 */
export const fetchWithRetry = async (url: string | URL, init: RetryRequestInit = {}): Promise<Response> => {
  const {
    signal,
    timeoutMs,
    retryCount = HTTP_RETRY_COUNT,
    retryDelayMs = HTTP_RETRY_DELAY_MS,
    retryJitterMs = 0,
    retryRateLimited = true,
    ...requestInit
  } = init;
  let lastError: unknown;
  const maximumRetries = normalizeNonNegativeNumber(retryCount, "retryCount");
  const baseRetryDelayMs = normalizeNonNegativeNumber(retryDelayMs, "retryDelayMs");
  const maximumRetryJitterMs = normalizeNonNegativeNumber(retryJitterMs, "retryJitterMs");
  const requestTimeoutMs = timeoutMs === undefined
    ? undefined
    : normalizeNonNegativeNumber(timeoutMs, "timeoutMs");

  for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
    try {
      const timeoutSignal = requestTimeoutMs === undefined ? undefined : AbortSignal.timeout(requestTimeoutMs);
      const requestSignal = signal && timeoutSignal
        ? AbortSignal.any([signal, timeoutSignal])
        : signal ?? timeoutSignal;
      const response = await fetch(url, { ...requestInit, signal: requestSignal });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => undefined);
        throw createHttpRequestError(response.status, response.statusText, retryAfterMs);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (
        signal?.aborted ||
        attempt === maximumRetries ||
        !isRetryableHttpError(error, retryRateLimited)
      ) {
        throw error;
      }

      const retryAfterMs = isHttpRequestError(error) ? error.retryAfterMs ?? 0 : 0;
      const exponentialDelayMs = baseRetryDelayMs * 2 ** attempt;
      const jitterMs = maximumRetryJitterMs > 0 ? Math.random() * maximumRetryJitterMs : 0;
      const backoffMs = Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(retryAfterMs, exponentialDelayMs + jitterMs),
      );
      await delay(backoffMs, signal ?? undefined);
    }
  }

  throw lastError;
};

const isRetryableHttpError = (error: unknown, retryRateLimited: boolean) =>
  !isHttpRequestError(error) ||
  error.status === 408 ||
  (retryRateLimited && error.status === 429) ||
  error.status >= 500;

const isHttpRequestError = (error: unknown): error is HttpRequestError =>
  error instanceof Error &&
  typeof (error as Partial<HttpRequestError>).status === "number";

const parseRetryAfterMs = (value: string | null) => {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
};

const normalizeNonNegativeNumber = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }

  return Math.floor(value);
};

export const readResponseBytes = async (response: Response, maximumBytes: number) => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Response body exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) {
    throw new Error("Response body is missing");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, size);
      }

      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response body exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
};

export const readResponseText = async (response: Response, maximumBytes: number) =>
  new TextDecoder().decode(await readResponseBytes(response, maximumBytes));

export const readResponseJson = async (response: Response, maximumBytes: number): Promise<unknown> =>
  JSON.parse(await readResponseText(response, maximumBytes));

const delay = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", abort);
      settle();
    };
    const abort = () => finish(() => reject(signal?.reason));
    timer = setTimeout(() => finish(resolve), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
