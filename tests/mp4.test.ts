import { describe, expect, test } from "bun:test";
import { inspectMp4Video } from "@/mp4";
import { createMp4VideoFixture, createNalSample } from "./support/mp4-fixture";

describe("MP4 video inspection", () => {
  test("accepts a structurally consistent H.264 file", () => {
    expect(inspectMp4Video(createMp4VideoFixture())).toEqual({ playable: true });
  });

  test("flags chunk offsets that do not point at the sample data", () => {
    // 素材生成器留下的坏文件就长这样：moov 记的偏移和采样数据的真实位置对不上。
    const inspection = inspectMp4Video(createMp4VideoFixture({ chunkOffsetShift: -8 }));

    expect(inspection).toEqual({ playable: false, reason: "sample 0 is not a valid NAL unit chain" });
  });

  test("flags samples that run past the end of the file", () => {
    const samples = [createNalSample(0x65, 32)];
    const inspection = inspectMp4Video(createMp4VideoFixture({
      samples,
      declaredSampleSizes: [samples[0]!.byteLength + 4096],
    }));

    expect(inspection).toEqual({ playable: false, reason: "sample 0 is missing or truncated" });
  });

  test("flags files without a moov box", () => {
    expect(inspectMp4Video(Buffer.from("not an mp4 file at all"))).toEqual({
      playable: false,
      reason: "missing moov box",
    });
    expect(inspectMp4Video(Buffer.alloc(4))).toEqual({
      playable: false,
      reason: "file is too small to be an MP4 video",
    });
  });

  test("only checks the sample range for codecs without length-prefixed NAL units", () => {
    expect(inspectMp4Video(createMp4VideoFixture({ sampleEntryType: "vp09" }))).toEqual({ playable: true });
  });

  test("inspects the tail of the file as well", () => {
    const samples = [
      createNalSample(0x65, 32),
      createNalSample(0x41, 16),
      createNalSample(0x41, 16),
      createNalSample(0x41, 16),
    ];
    const fixture = createMp4VideoFixture({ samples });
    // 抹掉最后一个样本，模拟尾部数据被覆盖。
    fixture.fill(0, fixture.byteLength - samples[3]!.byteLength);

    expect(inspectMp4Video(fixture)).toEqual({
      playable: false,
      reason: "sample 3 is not a valid NAL unit chain",
    });
  });
});
