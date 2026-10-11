import { Jimp } from "jimp";

/**
 * NapCat 的 WebSocket 服务器把单帧上限硬编码为 50MiB（maxPayload），超限帧会被
 * 直接拒绝并断开连接，之后所有 API 调用都收不到响应，表现为 send_group_msg 超时。
 * B 站动态经常附带多张全分辨率原图（曾出现 7 张合计 43MB、base64 后约 58MB），
 * 因此图片必须先压回预算再发送。
 */

/** 单张图片的发送体积预算；动态最多 9 张图，合计也远小于 50MiB 帧上限。 */
export const UPLOAD_IMAGE_BUDGET_BYTES = 1.5 * 1024 * 1024;

/** 无法解码的图片：不超过该体积仍可原样发送，超过则放弃（调用方降级为纯文字通知）。 */
const UNDECODABLE_IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * 逐级缩小重编码直到进入体积预算。同时限制总像素数和最长边：照片缩到
 * 1600px 级仍清晰，长截图也不会被压成一条线。最后一级即使仍超预算也接受。
 */
const SHRINK_ATTEMPTS = [
  { maxPixels: 2_600_000, maxDimension: 6_000, quality: 80 },
  { maxPixels: 1_800_000, maxDimension: 4_000, quality: 72 },
  { maxPixels: 1_200_000, maxDimension: 2_800, quality: 64 },
] as const;

type UploadImage = Awaited<ReturnType<typeof Jimp.read>>;

const scaleToLimits = (image: UploadImage, maxPixels: number, maxDimension: number) => {
  const { width, height } = image.bitmap;
  const scale = Math.min(
    1,
    Math.sqrt(maxPixels / (width * height)),
    maxDimension / width,
    maxDimension / height,
  );
  if (scale >= 1) {
    return;
  }
  image.resize({
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  });
};

/**
 * JPEG 没有透明通道，先把半透明像素按白底合成，避免透明区域编码后变黑。
 * 直接调整位图数据，避免再引入一个 Jimp 实例类型。
 */
const flattenAlphaOntoWhite = (image: UploadImage) => {
  if (!image.hasAlpha()) {
    return;
  }
  const { data } = image.bitmap;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha >= 255) {
      continue;
    }
    const ratio = alpha / 255;
    data[index] = Math.round(data[index] * ratio + 255 * (1 - ratio));
    data[index + 1] = Math.round(data[index + 1] * ratio + 255 * (1 - ratio));
    data[index + 2] = Math.round(data[index + 2] * ratio + 255 * (1 - ratio));
    data[index + 3] = 255;
  }
};

/**
 * 返回可以安全发给 NapCat 的图片字节：小图原样返回，超预算的图片缩小重编码；
 * 无法解码且过大的图片抛错，由调用方降级为纯文字通知。
 */
export const prepareImageForUpload = async (bytes: Uint8Array): Promise<Uint8Array> => {
  if (bytes.length <= UPLOAD_IMAGE_BUDGET_BYTES) {
    return bytes;
  }

  let source: UploadImage | undefined;
  try {
    source = await Jimp.read(Buffer.from(bytes));
  } catch {
    source = undefined;
  }
  if (!source) {
    if (bytes.length <= UNDECODABLE_IMAGE_LIMIT_BYTES) {
      return bytes;
    }
    throw new Error(`image is too large to upload (${bytes.length} bytes) and could not be decoded`);
  }

  flattenAlphaOntoWhite(source);
  let encoded: Uint8Array = bytes;
  for (const attempt of SHRINK_ATTEMPTS) {
    scaleToLimits(source, attempt.maxPixels, attempt.maxDimension);
    encoded = new Uint8Array(await source.getBuffer("image/jpeg", { quality: attempt.quality }));
    if (encoded.length <= UPLOAD_IMAGE_BUDGET_BYTES) {
      return encoded;
    }
  }
  return encoded;
};
