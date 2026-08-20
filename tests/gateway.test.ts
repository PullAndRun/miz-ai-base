import { describe, expect, test } from "bun:test";
import {
  createLastGroupMessageTracker,
  createGroupMessageUnavailableError,
  getSelfGroupMessageIdsFromHistory,
  getSelfSentGroupMessage,
  getRecallHistoryTimeoutMs,
  getGroupSendPermission,
  isGroupAtAllAvailable,
  isGroupMessageUnavailableError,
  isIgnorableNapLinkWarning,
  NAPLINK_RECONNECT_MAX_ATTEMPTS,
} from "@/gateway";

test("gateway reconnect attempts are unlimited", () => {
  expect(NAPLINK_RECONNECT_MAX_ATTEMPTS).toBe(Number.POSITIVE_INFINITY);
});

test("recall history lookup always has a short timeout", () => {
  expect(getRecallHistoryTimeoutMs(0)).toBe(5_000);
  expect(getRecallHistoryTimeoutMs(30_000)).toBe(5_000);
  expect(getRecallHistoryTimeoutMs(2_000)).toBe(2_000);
});

describe("last bot group message tracking", () => {
  test("recognizes group messages sent by the bot account outside the gateway send API", () => {
    expect(getSelfSentGroupMessage({
      post_type: "message_sent",
      message_type: "group",
      message_id: 11,
      group_id: 100,
      user_id: 200,
      self_id: "200",
    })).toEqual({ groupId: 100, messageId: 11 });

    expect(getSelfSentGroupMessage({
      post_type: "message",
      message_type: "group",
      message_id: 12,
      group_id: 100,
      user_id: 200,
      self_id: 200,
    })).toBeUndefined();
    expect(getSelfSentGroupMessage({
      post_type: "message_sent",
      message_type: "group",
      message_id: 13,
      group_id: 100,
      user_id: 201,
      self_id: 200,
    })).toBeUndefined();
    expect(getSelfSentGroupMessage({
      post_type: "message_sent",
      message_type: "private",
      message_id: 14,
      user_id: 200,
      self_id: 200,
    })).toBeUndefined();
  });

  test("reads the bot account's messages from group history in chronological order", () => {
    expect(getSelfGroupMessageIdsFromHistory({
      data: {
        messages: [
          { message_id: 33, message_seq: 30, user_id: 200 },
          { message_id: 11, message_seq: 10, sender: { user_id: "200" } },
          { message_id: 22, message_seq: 20, user_id: 201 },
        ],
      },
    }, 200)).toEqual(["11", "33"]);
    expect(getSelfGroupMessageIdsFromHistory({ data: {} }, 200)).toEqual([]);
  });

  test("recalls the requested number of recent messages in newest-first order", async () => {
    const tracker = createLastGroupMessageTracker();
    expect(tracker.count(100)).toBe(0);
    tracker.record(100, { data: { message_id: 11 } });
    tracker.record(200, { messageId: "22" });
    tracker.record(100, { message_id: 33 });
    expect(tracker.count(100)).toBe(2);
    const deleted: string[] = [];

    await expect(tracker.recall(100, 2, async (messageId) => {
      deleted.push(messageId);
    })).resolves.toEqual({
      status: "completed",
      recalledMessageIds: ["33", "11"],
      failures: [],
    });
    expect(deleted).toEqual(["33", "11"]);
    await expect(tracker.recall(100, 1, async () => undefined)).resolves.toEqual({ status: "not_found" });
    await expect(tracker.recall(200, 1, async (messageId) => {
      deleted.push(messageId);
    })).resolves.toEqual({ status: "completed", recalledMessageIds: ["22"], failures: [] });
  });

  test("does not reorder a message when both the send response and sent event record it", async () => {
    const tracker = createLastGroupMessageTracker();
    tracker.record(100, { message_id: 11 });
    tracker.record(100, { message_id: 22 });
    tracker.record(100, { message_id: 11 });

    await expect(tracker.recall(100, 1, async () => undefined)).resolves.toEqual({
      status: "completed",
      recalledMessageIds: ["22"],
      failures: [],
    });
  });

  test("merges group history before newer messages already observed in real time", async () => {
    const tracker = createLastGroupMessageTracker();
    tracker.record(100, { message_id: 33 });
    tracker.syncHistory(100, [11, 22]);

    await expect(tracker.recall(100, 3, async () => undefined)).resolves.toEqual({
      status: "completed",
      recalledMessageIds: ["33", "22", "11"],
      failures: [],
    });
  });

  test("keeps the message available when the recall API fails", async () => {
    const tracker = createLastGroupMessageTracker();
    tracker.record("100", { message_id: "44" });

    const failed = await tracker.recall(100, 1, async () => {
      throw new Error("permission denied");
    });
    expect(failed).toMatchObject({
      status: "completed",
      recalledMessageIds: [],
      failures: [{ messageId: "44" }],
    });
    await expect(tracker.recall(100, 1, async () => undefined)).resolves.toEqual({
      status: "completed",
      recalledMessageIds: ["44"],
      failures: [],
    });
  });

  test("stops after a timeout because older messages cannot have a longer recall window", async () => {
    const tracker = createLastGroupMessageTracker();
    tracker.record(100, { message_id: 1 });
    tracker.record(100, { message_id: 2 });
    tracker.record(100, { message_id: 3 });
    const attempted: string[] = [];

    const result = await tracker.recall(100, 3, async (messageId) => {
      attempted.push(messageId);
      throw new Error("消息已超过撤回时间");
    });

    expect(attempted).toEqual(["3"]);
    expect(result).toMatchObject({
      status: "completed",
      recalledMessageIds: [],
      failures: [{ messageId: "3" }, { messageId: "2" }, { messageId: "1" }],
    });
  });
});

describe("gateway warning filtering", () => {
  test("only suppresses the known response-without-request warning", () => {
    expect(isIgnorableNapLinkWarning("收到未知请求的响应: undefined")).toBeTrue();
    for (const action of ["send_group_msg", "send_private_msg", "send_forward_msg"]) {
      expect(isIgnorableNapLinkWarning(`API失败: ${action}`)).toBeFalse();
    }
  });
});

describe("group send permission", () => {
  test("identifies a muted or unavailable group message error", () => {
    expect(isGroupMessageUnavailableError(createGroupMessageUnavailableError(123))).toBeTrue();
    expect(isGroupMessageUnavailableError(new Error("other failure"))).toBeFalse();
  });

  test("blocks NapCat's -1 whole-group mute flag for ordinary members", () => {
    expect(getGroupSendPermission(
      { group_all_shut: -1 },
      { shut_up_timestamp: 0, role: "member" },
      1_000,
    )).toEqual({
      allowed: false,
      wholeBan: true,
      mutedUntil: 0,
    });
  });

  test("allows an unmuted administrator or owner during a whole-group mute", () => {
    expect(getGroupSendPermission(
      { group_all_shut: -1 },
      { shut_up_timestamp: 0, role: "admin" },
      1_000,
    ).allowed).toBeTrue();

    expect(getGroupSendPermission(
      { data: { group_all_shut: true } },
      { data: { shut_up_timestamp: 1_000, role: "owner" } },
      1_000,
    ).allowed).toBeTrue();
  });

  test("blocks an administrator who is individually muted during a whole-group mute", () => {
    expect(getGroupSendPermission(
      { group_all_shut: -1 },
      { shut_up_timestamp: 1_001, role: "admin" },
      1_000,
    ).allowed).toBeFalse();
  });

  test("blocks the bot while its mute timestamp is in the future", () => {
    expect(getGroupSendPermission(
      { group_all_shut: 0 },
      { shut_up_timestamp: 1_001 },
      1_000,
    ).allowed).toBeFalse();
  });

  test("allows sending only when both mute states are known and inactive", () => {
    expect(getGroupSendPermission(
      { data: { group_all_shut: 0 } },
      { data: { shut_up_timestamp: 1_000 } },
      1_000,
    ).allowed).toBeTrue();

    expect(getGroupSendPermission(
      { group_id: 123 },
      { shut_up_timestamp: 0 },
      1_000,
    ).allowed).toBeFalse();

    expect(getGroupSendPermission(
      { group_all_shut: 0 },
      { user_id: 456 },
      1_000,
    ).allowed).toBeFalse();
  });
});

describe("group @all permission", () => {
  test("supports the current NapCat quota response", () => {
    expect(isGroupAtAllAvailable({
      can_at_all: true,
      remain_at_all_count_for_group: 3,
      remain_at_all_count_for_uin: 2,
    })).toBeTrue();
    expect(isGroupAtAllAvailable({
      can_at_all: false,
      remain_at_all_count_for_group: 3,
      remain_at_all_count_for_uin: 2,
    })).toBeFalse();
    expect(isGroupAtAllAvailable({
      can_at_all: true,
      remain_at_all_count_for_group: 0,
      remain_at_all_count_for_uin: 2,
    })).toBeFalse();
  });

  test("keeps compatibility with numeric quota responses", () => {
    expect(isGroupAtAllAvailable(1)).toBeTrue();
    expect(isGroupAtAllAvailable(0)).toBeFalse();
  });
});
