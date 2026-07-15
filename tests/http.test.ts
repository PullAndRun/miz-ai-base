import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry, readResponseBytes } from "@/http";

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
});
