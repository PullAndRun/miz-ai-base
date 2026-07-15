import type { MizPlugin, PluginMessageContext } from "@/plugins";
import {
  createBoundedCache,
  deleteBoundedCacheEntry,
  readBoundedCache,
  writeBoundedCache,
} from "@/cache";
import { parseCommandText } from "@/plugin-command";

type RepeatState = {
  signature: string;
  count: number;
};

const MAX_REPEAT_GROUP_STATES = 5_000;
let repeatStates = createBoundedCache<string, RepeatState>(MAX_REPEAT_GROUP_STATES);

const repeatPlugin: MizPlugin = {
  name: "repeat",
  commands: [],
  async onMessage(context) {
    await repeatIfNeeded(context);
  },
};

export default repeatPlugin;

const repeatIfNeeded = async ({ commandPrefix, message, plugins, reply }: PluginMessageContext) => {
  if (message.groupId === undefined) {
    return;
  }

  const groupKey = String(message.groupId);
  const candidate = getRepeatCandidate(message.text, message.raw.message);
  const commandNames = plugins.flatMap((plugin) => plugin.commands);
  if (!candidate || parseCommandText(message.text, commandPrefix, commandNames) !== undefined) {
    repeatStates = deleteBoundedCacheEntry(repeatStates, groupKey);
    return;
  }

  const previousRead = readBoundedCache(repeatStates, groupKey);
  repeatStates = previousRead.cache;
  const previous = previousRead.value;
  const count = previous?.signature === candidate.signature ? previous.count + 1 : 1;
  repeatStates = writeBoundedCache(repeatStates, groupKey, { signature: candidate.signature, count });
  if (count !== 3) {
    return;
  }

  await reply(candidate.payload);
};

const getRepeatCandidate = (text: string, rawMessage: unknown) => {
  const normalizedText = text.trim();
  if (normalizedText) {
    return {
      signature: `text:${normalizedText}`,
      payload: rawMessage ?? normalizedText,
    };
  }

  if (!Array.isArray(rawMessage)) {
    return undefined;
  }

  const images = rawMessage.filter(isImageSegment);
  if (images.length === 0) {
    return undefined;
  }

  return {
    signature: `image:${JSON.stringify(images.map((image) => image.data))}`,
    payload: rawMessage,
  };
};

const isImageSegment = (value: unknown): value is { type: "image"; data: unknown } => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const segment = value as Record<string, unknown>;
  return segment.type === "image" && "data" in segment;
};
