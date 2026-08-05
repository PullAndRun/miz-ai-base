import type { VideoSegment } from "@naplink/naplink";
import type { VideoConfig } from "@/config";
import {
  canSendNapcatVideoAsDataUrl,
  getNapcatVideoDataUrl,
  getNapcatVideoFile,
} from "@/video";

export type VideoDeliveryMode = "file" | "data-url" | "forward";

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

export type VideoDeliveryUnknownError = Error & Readonly<{
  name: "VideoDeliveryUnknownError";
  mode: VideoDeliveryMode;
  cause: unknown;
}>;

export const isVideoSendTimeoutError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "E_API_TIMEOUT";

export const isVideoDeliveryError = (error: unknown): error is VideoDeliveryError =>
  error instanceof AggregateError && error.name === "VideoDeliveryError";

export const isVideoDeliveryUnknownError = (error: unknown): error is VideoDeliveryUnknownError =>
  error instanceof Error && error.name === "VideoDeliveryUnknownError";

export const createNapcatVideoMessage = (
  videoPath: string,
  config: VideoConfig,
): VideoSegment => ({
  type: "video",
  data: {
    file: getNapcatVideoFile(videoPath, config),
  },
});

export const createNapcatDataUrlVideoMessage = async (
  videoPath: string,
): Promise<VideoSegment> => ({
  type: "video",
  data: {
    file: await getNapcatVideoDataUrl(videoPath),
  },
});

const createUnknownDeliveryError = (
  mode: VideoDeliveryMode,
  cause: unknown,
): VideoDeliveryUnknownError => Object.assign(
  new Error(`${mode} video delivery timed out; the send result is unknown`),
  {
    name: "VideoDeliveryUnknownError" as const,
    mode,
    cause,
  },
);

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
      if (isVideoSendTimeoutError(error)) {
        throw createUnknownDeliveryError(mode, error);
      }
      attempts.push({ mode, error });
      return undefined;
    }
  };

  const fileMessage = createNapcatVideoMessage(videoPath, config);
  const fileResult = await attempt("file", () => sendVideoMessage(fileMessage));
  if (fileResult) {
    return fileResult;
  }

  if (await canSendNapcatVideoAsDataUrl(videoPath)) {
    const dataUrlResult = await attempt("data-url", async () =>
      sendVideoMessage(await createNapcatDataUrlVideoMessage(videoPath)));
    if (dataUrlResult) {
      return dataUrlResult;
    }
  } else {
    attempts.push({
      mode: "data-url",
      error: new Error("video exceeds NapCat's OneBot WebSocket Base64 payload limit"),
    });
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
