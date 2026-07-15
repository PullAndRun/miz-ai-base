import { describe, expect, test } from "bun:test";
import { parseScheduleAction } from "../plugins/schedule";

describe("schedule parsing", () => {
  const nowMs = new Date("2030-01-01T00:00:00+08:00").getTime();

  test("accepts a valid future local time", () => {
    const action = parseScheduleAction("add 2099-07-15 20:30 团队活动", nowMs);
    expect(action).toMatchObject({ type: "add", content: "团队活动" });
  });

  test("rejects normalized but invalid clock values", () => {
    expect(parseScheduleAction("add 2099-07-15 20:60 团队活动", nowMs)).toBeUndefined();
    expect(parseScheduleAction("add 2099-07-15 24:00 团队活动", nowMs)).toBeUndefined();
  });

  test("rejects unsafe display IDs", () => {
    expect(parseScheduleAction("cancel 999999999999999999999", nowMs)).toBeUndefined();
  });
});
