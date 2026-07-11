declare module "qrcode-reader" {
  type QrCodeResult = { result?: string };

  export default class QrCodeReader {
    callback: (error: Error | null, result: QrCodeResult | undefined) => void;
    decode(image: { width: number; height: number; data: Buffer | Uint8Array }): void;
  }
}
