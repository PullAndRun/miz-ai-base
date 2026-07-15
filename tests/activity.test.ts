import { describe, expect, test } from "bun:test";
import { parseActivityAction } from "../plugins/activity";

describe("activity parsing", () => {
  const nowMs = new Date("2030-01-01T00:00:00+08:00").getTime();

  test("accepts activity creation and signup actions", () => {
    expect(parseActivityAction("create 2099-08-01 20:00 桌游夜", nowMs))
      .toMatchObject({ type: "create", content: "桌游夜" });
    expect(parseActivityAction("join 12", nowMs)).toEqual({ type: "join", id: 12 });
    expect(parseActivityAction("leave 12", nowMs)).toEqual({ type: "leave", id: 12 });
  });

  test("rejects invalid dates and unsafe IDs", () => {
    expect(parseActivityAction("create 2099-02-30 20:00 桌游夜", nowMs)).toBeUndefined();
    expect(parseActivityAction("join 999999999999999999999", nowMs)).toBeUndefined();
  });
});
