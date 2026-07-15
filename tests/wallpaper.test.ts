import { afterEach, describe, expect, test } from "bun:test";
import { getDailyWallpaper } from "@/wallpaper";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("daily wallpaper cache", () => {
  test("coalesces identical requests without mixing different configurations", async () => {
    const calls = new Map<string, number>();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.set(url, (calls.get(url) ?? 0) + 1);
      if (url.endsWith("/metadata-a")) {
        return Response.json({ images: [{ url: "/image-a", hsh: "a", copyright: "A" }] });
      }
      if (url.endsWith("/metadata-b")) {
        return Response.json({ images: [{ url: "/image-b", hsh: "b", copyright: "B" }] });
      }
      if (url.endsWith("/image-a")) {
        return new Response(new Uint8Array([1]));
      }
      if (url.endsWith("/image-b")) {
        return new Response(new Uint8Array([2]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const metadataA = "https://wallpaper-a.example.test/metadata-a";
    const metadataB = "https://wallpaper-b.example.test/metadata-b";
    const [firstA, secondA, wallpaperB] = await Promise.all([
      getDailyWallpaper(metadataA, "https://wallpaper-a.example.test"),
      getDailyWallpaper(metadataA, "https://wallpaper-a.example.test"),
      getDailyWallpaper(metadataB, "https://wallpaper-b.example.test"),
    ]);

    expect(firstA).toEqual(secondA);
    expect(firstA).toMatchObject({ id: "a", copyright: "A", imageBase64: "AQ==" });
    expect(wallpaperB).toMatchObject({ id: "b", copyright: "B", imageBase64: "Ag==" });
    expect(calls.get(metadataA)).toBe(1);
    expect(calls.get(metadataB)).toBe(1);
    expect(calls.get("https://wallpaper-a.example.test/image-a")).toBe(1);
    expect(calls.get("https://wallpaper-b.example.test/image-b")).toBe(1);
  });
});
