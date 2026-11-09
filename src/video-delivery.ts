import type { VideoSegment } from "@snowluma/sdk";
import type { VideoConfig } from "@/config";
import {
  getSnowLumaVideoBase64,
  getSnowLumaVideoFile,
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

export type VideoDeliveryOptions = Readonly<{
  /** Treat API timeouts as an unknown result instead of retrying the upload. */
  stopOnTimeout?: boolean;
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

const createUnknownDeliveryError = (
  mode: VideoDeliveryMode,
  cause: unknown,
): VideoDeliveryUnknownError => Object.assign(
  new Error(`${mode} video delivery timed out; the send result is unknown`, { cause }),
  {
    name: "VideoDeliveryUnknownError" as const,
    mode,
    cause,
  },
);

export const createSnowLumaVideoMessage = (
  videoPath: string,
  config: VideoConfig,
): VideoSegment => ({
  type: "video",
  data: {
    file: getSnowLumaVideoFile(videoPath, config),
  },
});

export const createSnowLumaBase64VideoMessage = async (
  videoPath: string,
): Promise<VideoSegment> => ({
  type: "video",
  data: {
    file: await getSnowLumaVideoBase64(videoPath),
  },
});

export const deliverVideoWithFallback = async (
  videoPath: string,
  config: VideoConfig,
  sendVideoMessage: (message: VideoSegment) => Promise<unknown>,
  sendForwardMessage: (message: VideoSegment) => Promise<unknown>,
  options: VideoDeliveryOptions = {},
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
      // The gateway may continue uploading after its API request times out. Retrying
      // with another representation can therefore send duplicates or produce a
      // misleading all-failed message.
      if (options.stopOnTimeout && isVideoSendTimeoutError(error)) {
        throw createUnknownDeliveryError(mode, error);
      }
      attempts.push({ mode, error });
      return undefined;
    }
  };

  const fileMessage = createSnowLumaVideoMessage(videoPath, config);
  const fileResult = await attempt("file", () => sendVideoMessage(fileMessage));
  if (fileResult) {
    return fileResult;
  }

  const base64Result = await attempt("base64", async () =>
    sendVideoMessage(await createSnowLumaBase64VideoMessage(videoPath)));
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
