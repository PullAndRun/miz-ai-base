import { describe, expect, test } from "bun:test";
import { parseReminderSpec } from "../plugins/remind";

describe("reminder target parsing", () => {
  test("recognizes @all aliases for repeating reminders", () => {
    expect(parseReminderSpec("every 1d @全体成员 开会")).toEqual({
      delayMinutes: 24 * 60,
      repeatIntervalMinutes: 24 * 60,
      targetId: "all",
      content: "开会",
    });
    expect(parseReminderSpec("every 1d @all 开会")?.targetId).toBe("all");
  });

  test("keeps numeric targets unchanged", () => {
    expect(parseReminderSpec("every 2h @123456 开会")).toMatchObject({
      delayMinutes: 2 * 60,
      repeatIntervalMinutes: 2 * 60,
      targetId: "123456",
      content: "开会",
    });
  });
});
