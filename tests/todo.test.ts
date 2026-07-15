import { describe, expect, test } from "bun:test";
import { parseTodoAction } from "../plugins/todo";

describe("todo parsing", () => {
  test("accepts plain and scheduled todos", () => {
    expect(parseTodoAction("add 整理群文件"))
      .toEqual({ type: "add", dueAt: undefined, assigneeId: undefined, content: "整理群文件" });
    expect(parseTodoAction("add 2099-08-01 20:00 @123456789 发布活动总结"))
      .toMatchObject({ type: "add", assigneeId: "123456789", content: "发布活动总结" });
  });

  test("rejects invalid times and unsafe IDs", () => {
    expect(parseTodoAction("add 2099-08-01 24:00 发布活动总结")).toBeUndefined();
    expect(parseTodoAction("add 2099-08-01 20:00")).toBeUndefined();
    expect(parseTodoAction("add @123456789")).toBeUndefined();
    expect(parseTodoAction("done 999999999999999999999")).toBeUndefined();
  });
});
