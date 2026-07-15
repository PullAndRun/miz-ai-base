import { describe, expect, test } from "bun:test";
import { parseTodoAction } from "../plugins/todo";

describe("todo parsing", () => {
  const nowMs = new Date("2030-01-01T00:00:00+08:00").getTime();

  test("accepts plain and scheduled todos", () => {
    expect(parseTodoAction("add 整理群文件", nowMs))
      .toEqual({ type: "add", dueAt: undefined, assigneeId: undefined, content: "整理群文件" });
    expect(parseTodoAction("add 2099-08-01 20:00 @123456789 发布活动总结", nowMs))
      .toMatchObject({ type: "add", assigneeId: "123456789", content: "发布活动总结" });
  });

  test("rejects invalid times and unsafe IDs", () => {
    expect(parseTodoAction("add 2099-08-01 24:00 发布活动总结", nowMs)).toBeUndefined();
    expect(parseTodoAction("add 2099-08-01 20:00", nowMs)).toBeUndefined();
    expect(parseTodoAction("add @123456789", nowMs)).toBeUndefined();
    expect(parseTodoAction("done 999999999999999999999", nowMs)).toBeUndefined();
  });
});
