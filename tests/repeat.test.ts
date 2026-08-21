import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "@/gateway";
import repeatPlugin from "../plugins/repeat";

const createMessage = (groupId: string, text: string): IncomingMessage => ({
  groupId,
  text,
  raw: {},
});

const notify = async (groupId: string, text: string, reply: (message: unknown) => unknown) => {
  await repeatPlugin.onMessage?.({
    commandPrefix: "miz",
    message: createMessage(groupId, text),
    plugins: [],
    reply: async (message) => reply(message),
    replyWithoutRetry: async () => undefined,
    replyForward: async () => undefined,
    replyForwardWithoutRetry: async () => undefined,
    gateway: {} as never,
    logger: {} as never,
    config: {} as never,
  });
};

describe("repeat plugin", () => {
  test("does not repeat slash-prefixed text", async () => {
    let replies = 0;
    for (let count = 0; count < 3; count += 1) {
      await notify("repeat-slash", "/help", () => {
        replies += 1;
      });
    }

    expect(replies).toBe(0);
  });

  test("repeats ordinary text on its third occurrence", async () => {
    let replies = 0;
    for (let count = 0; count < 3; count += 1) {
      await notify("repeat-ordinary", "hello", () => {
        replies += 1;
      });
    }

    expect(replies).toBe(1);
  });
});
