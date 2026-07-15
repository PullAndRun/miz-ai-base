import { describe, expect, test } from "bun:test";
import { parseActivityAction } from "../plugins/activity";

describe("activity parsing", () => {
  test("accepts activity creation and signup actions", () => {
    expect(parseActivityAction("create 2099-08-01 20:00 桌游夜"))
      .toMatchObject({ type: "create", content: "桌游夜" });
    expect(parseActivityAction("join 12")).toEqual({ type: "join", id: 12 });
    expect(parseActivityAction("leave 12")).toEqual({ type: "leave", id: 12 });
  });

  test("rejects invalid dates and unsafe IDs", () => {
    expect(parseActivityAction("create 2099-02-30 20:00 桌游夜")).toBeUndefined();
    expect(parseActivityAction("join 999999999999999999999")).toBeUndefined();
  });
});
