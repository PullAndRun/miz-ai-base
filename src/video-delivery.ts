import type { VideoSegment } from "@naplink/naplink";
import type { VideoConfig } from "@/config";
import {
  getNapcatVideoBase64,
  getNapcatVideoFile,
} from "@/video";

export type VideoDeliveryMode = "file" | "base64" | "forward";

export type VideoDeliveryResult = Readonly<{
  mode: VideoDeliveryMode;
  attempts: readonly VideoDeliveryAttempt[];
}>;

export type VideoDeliveryAttempt = Readonly<{
  mode: VideoDeliveryMode;
  error: unknown;
}>;

export type VideoDeliveryError = AggregateError & Readonly<{
  name: "VideoDeliveryError";
  attempts: readonly VideoDeliveryAttempt[];
}>;

export const isVideoDeliveryError = (error: unknown): error is VideoDeliveryError =>
  error instanceof AggregateError && error.name === "VideoDeliveryError";

export const createNapcatVideoMessage = (
  videoPath: string,
  config: VideoConfig,
): VideoSegment => ({
  type: "video",
  data: {
    file: getNapcatVideoFile(videoPath, config),
  },
});

export const createNapcatBase64VideoMessage = async (
  videoPath: string,
): Promise<VideoSegment> => ({
  type: "video",
  data: {
    file: await getNapcatVideoBase64(videoPath),
  },
});

export const deliverVideoWithFallback = async (
  videoPath: string,
  config: VideoConfig,
  sendVideoMessage: (message: VideoSegment) => Promise<unknown>,
  sendForwardMessage: (message: VideoSegment) => Promise<unknown>,
): Promise<VideoDeliveryResult> => {
  const attempts: VideoDeliveryAttempt[] = [];
  const attempt = async (
    mode: VideoDeliveryMode,
    operation: () => Promise<unknown>,
  ): Promise<VideoDeliveryResult | undefined> => {
    try {
      await operation();
      return { mode, attempts: [...attempts] };
    } catch (error) {
      attempts.push({ mode, error });
      return undefined;
    }
  };

  const fileMessage = createNapcatVideoMessage(videoPath, config);
  const fileResult = await attempt("file", () => sendVideoMessage(fileMessage));
  if (fileResult) {
    return fileResult;
  }

  const base64Result = await attempt("base64", async () =>
    sendVideoMessage(await createNapcatBase64VideoMessage(videoPath)));
  if (base64Result) {
    return base64Result;
  }

  const forwardResult = await attempt("forward", () => sendForwardMessage(fileMessage));
  if (forwardResult) {
    return forwardResult;
  }

  throw Object.assign(
    new AggregateError(
      attempts.map(({ error }) => error),
      "file, Base64, and forward video delivery attempts failed",
    ),
    {
      name: "VideoDeliveryError" as const,
      attempts,
    },
  );
};
