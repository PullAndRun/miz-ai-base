import type { MizPlugin } from "@/plugins";
import { createQrCode, decodeQrCode } from "@/qrcode";

const qrcodePlugin: MizPlugin = {
  name: "qrcode",
  commands: ["qrcode", "二维码"],
  description: [
    "生成或识别二维码。",
    "生成：miz qrcode 需要编码的文本",
    "识别：将 miz qrcode decode 与二维码图片一同发送",
  ].join("\n"),
  async handle({ command, logger, message, reply }) {
    const args = command.args.trim();
    if (!args) {
      await reply("生成：miz qrcode 需要编码的文本\n识别：将 miz qrcode decode 与二维码图片一同发送。");
      return;
    }

    if (args.toLowerCase() === "decode" || args === "识别") {
      const imageSource = findImageSource(message.raw.message);
      if (!imageSource) {
        await reply("没有找到图片。请将 `miz qrcode decode` 和二维码图片放在同一条消息里发送。");
        return;
      }

      try {
        const text = await decodeQrCode(imageSource);
        await reply(`二维码内容：\n${text}`);
      } catch (error) {
        logger.warn("plugin", "qrcode decode failed", normalizeError(error));
        await reply("没有识别到二维码。请确认图片清晰、包含完整二维码，且文件不超过 10MB。");
      }
      return;
    }

    try {
      const image = await createQrCode(args);
      await reply({
        type: "image",
        data: { file: `base64://${image.toString("base64")}` },
      });
    } catch (error) {
      logger.warn("plugin", "qrcode generation failed", normalizeError(error));
      await reply("二维码没有生成成功：内容不能为空，且最多支持 1000 个字符。");
    }
  },
};

export default qrcodePlugin;

const findImageSource = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const segment of value) {
    if (!segment || typeof segment !== "object") {
      continue;
    }

    const record = segment as Record<string, unknown>;
    if (record.type !== "image" || !record.data || typeof record.data !== "object") {
      continue;
    }

    const data = record.data as Record<string, unknown>;
    // NapCat's `file` field is often just a cache filename, while `url` is
    // the actual downloadable image address. Prefer the latter for decoding.
    for (const source of [data.url, data.file]) {
      if (typeof source === "string" && source.trim()) {
        return source;
      }
    }
  }

  return undefined;
};

const normalizeError = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message }
  : error;
