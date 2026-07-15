import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry, readResponseBytes, readResponseJson } from "@/http";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HTTP helpers", () => {
  test("does not retry permanent client errors", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("invalid", { status: 400, statusText: "Bad Request" });
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://example.invalid")).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });

  test("allows callers to disable retries for rate-limited upstreams", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("busy", { status: 429, headers: { "retry-after": "120" } });
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://example.invalid", {
      retryCount: 0,
      retryRateLimited: false,
    })).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
    expect(calls).toBe(1);
  });

  test("rejects invalid retry timing before starting a request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://example.invalid", { retryCount: Number.NaN }))
      .rejects.toThrow("retryCount must be a finite non-negative number");
    await expect(fetchWithRetry("https://example.invalid", { retryDelayMs: -1 }))
      .rejects.toThrow("retryDelayMs must be a finite non-negative number");
    expect(calls).toBe(0);
  });

  test("reads a bounded streaming response", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    }));

    expect([...await readResponseBytes(response, 3)]).toEqual([1, 2, 3]);
  });

  test("rejects oversized bodies even without content-length", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
    }));

    await expect(readResponseBytes(response, 3)).rejects.toThrow("exceeds 3 bytes");
  });

  test("parses JSON through the same response size limit", async () => {
    await expect(readResponseJson(new Response('{"ok":true}'), 20)).resolves.toEqual({ ok: true });
    await expect(readResponseJson(new Response('{"ok":true}'), 5)).rejects.toThrow("exceeds 5 bytes");
  });
});
