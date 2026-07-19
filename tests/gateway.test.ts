import { describe, expect, test } from "bun:test";
import {
  createGroupMessageUnavailableError,
  getGroupSendPermission,
  isGroupAtAllAvailable,
  isGroupMessageUnavailableError,
} from "@/gateway";

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
