declare module "qrcode-reader" {
  type QrCodeResult = { result?: string };

  type QrCodeReader = {
    callback: (error: Error | null, result: QrCodeResult | undefined) => void;
    decode(image: { width: number; height: number; data: Buffer | Uint8Array }): void;
  };

  type QrCodeReaderConstructor = {
    new (): QrCodeReader;
  };

  const QrCodeReader: QrCodeReaderConstructor;
  export default QrCodeReader;
}
