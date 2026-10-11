import { describe, expect, test } from "bun:test";
import { Jimp } from "jimp";
import { prepareImageForUpload, UPLOAD_IMAGE_BUDGET_BYTES } from "@/image-compress";
import { createNoiseJpeg } from "./support/vtb-image-fixture";

describe("prepareImageForUpload", () => {
  test("returns images within the budget unchanged", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await prepareImageForUpload(bytes)).toBe(bytes);
  });

  test("shrinks an oversized photo into the upload budget", async () => {
    const source = await createNoiseJpeg(2600, 2000, 92);
    expect(source.length).toBeGreaterThan(UPLOAD_IMAGE_BUDGET_BYTES);

    const prepared = await prepareImageForUpload(source);
    expect(prepared.length).toBeLessThanOrEqual(UPLOAD_IMAGE_BUDGET_BYTES);
    expect(prepared.length).toBeLessThan(source.length);

    const decoded = await Jimp.read(Buffer.from(prepared));
    expect(decoded.bitmap.width).toBeLessThan(2600);
    expect(decoded.bitmap.height).toBeLessThan(2000);
  });

  test("keeps undecodable images that stay under the fallback limit", async () => {
    const bytes = new Uint8Array(1_800_000);
    bytes.fill(7);
    expect(await prepareImageForUpload(bytes)).toBe(bytes);
  });

  test("rejects oversized images that cannot be decoded", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024);
    bytes.fill(7);
    await expect(prepareImageForUpload(bytes)).rejects.toThrow("could not be decoded");
  });
});
