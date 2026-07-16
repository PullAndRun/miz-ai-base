import { afterEach, describe, expect, test } from "bun:test";
import { getDailyWallpaper } from "@/wallpaper";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("daily wallpaper cache", () => {
  test("uses the configured Bing endpoints and coalesces identical requests", async () => {
    const metadataUrl = "https://metadata.example.test/HPImageArchive.aspx";
    const imageBaseUrl = "https://images.example.test";
    const calls = new Map<string, number>();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.set(url, (calls.get(url) ?? 0) + 1);
      if (url === metadataUrl) {
        return Response.json({ images: [{ url: "/official-image", hsh: "official", copyright: "Bing" }] });
      }
      if (url === "https://images.example.test/official-image") {
        return new Response(new Uint8Array([3]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const [first, second] = await Promise.all([
      getDailyWallpaper(metadataUrl, imageBaseUrl),
      getDailyWallpaper(metadataUrl, imageBaseUrl),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ id: "official", copyright: "Bing", imageBase64: "Aw==" });
    expect(calls.get(metadataUrl)).toBe(1);
    expect(calls.get("https://images.example.test/official-image")).toBe(1);
  });
});
