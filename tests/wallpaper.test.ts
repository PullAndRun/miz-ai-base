import { afterEach, describe, expect, test } from "bun:test";
import { getDailyWallpaper } from "@/wallpaper";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("daily wallpaper cache", () => {
  test("downloads Bing's UHD rendition and preserves its original bytes", async () => {
    const metadataUrl = "https://metadata.example.test/uhd";
    const imageBaseUrl = "https://images.example.test";
    const originalBytes = new Uint8Array([0xff, 0xd8, 0x00, 0x7f, 0xff, 0xd9]);
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === metadataUrl) {
        return Response.json({
          images: [{
            url: "/th?id=OHR.Sample_1920x1080.jpg",
            urlbase: "/th?id=OHR.Sample",
            hsh: "uhd-original",
          }],
        });
      }
      if (url === "https://images.example.test/th?id=OHR.Sample_UHD.jpg") {
        return new Response(originalBytes, { headers: { "content-type": "image/jpeg" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const wallpaper = await getDailyWallpaper(metadataUrl, imageBaseUrl);

    expect(requestedUrls).toEqual([
      metadataUrl,
      "https://images.example.test/th?id=OHR.Sample_UHD.jpg",
    ]);
    expect(Buffer.from(wallpaper.imageBase64, "base64")).toEqual(Buffer.from(originalBytes));
  });

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
