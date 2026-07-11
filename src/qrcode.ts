import { Jimp } from "jimp";
import QRCode from "qrcode";
import QrCodeReader from "qrcode-reader";
import { fetchWithRetry } from "@/http";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_QR_TEXT_LENGTH = 1_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const createQrCode = async (text: string) => {
  const normalized = text.trim();
  if (!normalized || normalized.length > MAX_QR_TEXT_LENGTH) {
    throw new Error("QR code text is empty or too long");
  }

  return QRCode.toBuffer(normalized, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
  });
};

export const decodeQrCode = async (imageSource: string) => {
  const image = await Jimp.read(await readImage(imageSource));
  const result = await new Promise<string>((resolve, reject) => {
    const reader = createQrCodeReader();
    reader.callback = (error, decoded) => {
      if (error) {
        reject(error);
        return;
      }

      const text = decoded?.result?.trim();
      if (!text) {
        reject(new Error("No QR code found in image"));
        return;
      }

      resolve(text);
    };
    reader.decode(image.bitmap);
  });

  return result;
};

const createQrCodeReader = () => Reflect.construct(QrCodeReader, []) as {
  callback: (error: Error | null, result?: { result?: string }) => void;
  decode(bitmap: unknown): void;
};

const readImage = async (source: string) => {
  if (source.startsWith("base64://")) {
    const bytes = Buffer.from(source.slice("base64://".length), "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("QR code image is empty or too large");
    }
    return bytes;
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return readLocalImage(source);
  }
  if (url.protocol === "file:") {
    return readLocalImage(url);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("QR code image has an unsupported source");
  }

  const response = await fetchWithRetry(url, { timeoutMs: FETCH_TIMEOUT_MS });

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error("QR code image is too large");
  }

  const bytes = await readResponseBytes(response);
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("QR code image is empty or too large");
  }
  return bytes;
};

const readResponseBytes = async (response: Response) => {
  if (!response.body) {
    throw new Error("QR code image response has no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, size);
      }

      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        throw new Error("QR code image is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
};

const readLocalImage = async (source: string | URL) => {
  const file = Bun.file(source);
  if (!(await file.exists()) || file.size > MAX_IMAGE_BYTES) {
    throw new Error("QR code image is missing or too large");
  }
  return Buffer.from(await file.arrayBuffer());
};
