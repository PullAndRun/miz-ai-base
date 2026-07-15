import type { MizPlugin } from "@/plugins";
import { createQrCode, decodeQrCode } from "@/qrcode";

const qrcodePlugin: MizPlugin = {
  name: "qrcode",
  commands: ["qrcode", "二维码"],
  description: [
    "把文字生成二维码，也可以读取图片里的二维码内容。",
    "生成：miz qrcode 需要编码的文本",
    "识别：将 miz qrcode decode 与二维码图片一同发送",
    "生成内容最多 1000 个字符，识别图片最大 10MB。",
  ].join("\n"),
  async handle({ command, logger, message, reply }) {
    const args = command.args.trim();
    if (!args) {
      await reply("二维码支持两种操作：\n生成：miz qrcode 要写入的内容\n识别：把 miz qrcode decode 和二维码图片放在同一条消息里");
      return;
    }

    if (args.toLowerCase() === "decode" || args === "识别") {
      const imageSource = findImageSource(message.raw.message);
      if (!imageSource) {
        await reply("这条消息里没看到图片。请把识别命令和二维码图片一起发送。");
        return;
      }

      try {
        const text = await decodeQrCode(imageSource);
        await reply(`识别到的内容：\n${text}`);
      } catch (error) {
        logger.warn("plugin", "qrcode decode failed", normalizeError(error));
        await reply("这个二维码没读出来。换一张更清晰、四周没有裁切的图片试试，大小不要超过 10MB。");
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
      await reply("二维码没生成成功。请确认内容不是空白，并且不超过 1000 个字符。");
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
