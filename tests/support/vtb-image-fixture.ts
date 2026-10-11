/**
 * 测试用的大体积 JPEG：噪声图在 JPEG 下几乎不可压缩，用固定种子生成，
 * 保证每次运行都能稳定超过上传预算，覆盖缩放重编码路径。
 */
import { Jimp } from "jimp";

export const createNoiseJpeg = async (width: number, height: number, quality: number) => {
  const data = new Uint8Array(width * height * 4);
  let state = 123456789;
  for (let index = 0; index < data.length; index += 4) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[index] = state & 0xff;
    state = (state * 1664525 + 1013904223) >>> 0;
    data[index + 1] = state & 0xff;
    state = (state * 1664525 + 1013904223) >>> 0;
    data[index + 2] = state & 0xff;
    data[index + 3] = 0xff;
  }
  const image = await Jimp.fromBitmap({ width, height, data: Buffer.from(data) });
  return new Uint8Array(await image.getBuffer("image/jpeg", { quality }));
};
