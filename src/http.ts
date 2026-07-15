export const HTTP_RETRY_COUNT = 3;
export const HTTP_RETRY_DELAY_MS = 10_000;

export type HttpRequestError = Error & Readonly<{ status: number }>;

export const createHttpRequestError = (status: number, statusText: string): HttpRequestError =>
  Object.assign(new Error(`HTTP ${status}: ${statusText}`), {
    name: "HttpRequestError",
    status,
  });

export type RetryRequestInit = RequestInit & {
  timeoutMs?: number;
};

/**
 * Performs an HTTP request with a fixed retry policy. Only transient failures
 * are retried, and cancellation interrupts both a request and its backoff.
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
        await response.body?.cancel().catch(() => undefined);
        throw createHttpRequestError(response.status, response.statusText);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === HTTP_RETRY_COUNT || !isRetryableHttpError(error)) {
        throw error;
      }

      await delay(HTTP_RETRY_DELAY_MS, signal ?? undefined);
    }
  }

  throw lastError;
};

const isRetryableHttpError = (error: unknown) =>
  !isHttpRequestError(error) ||
  error.status === 408 ||
  error.status === 429 ||
  error.status >= 500;

const isHttpRequestError = (error: unknown): error is HttpRequestError =>
  error instanceof Error &&
  typeof (error as Partial<HttpRequestError>).status === "number";

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
