import { describe, expect, test } from "bun:test";
import { findPluginCommand, parseCommandText } from "@/plugin-command";

describe("command parsing", () => {
  test("requires a real prefix boundary", () => {
    expect(parseCommandText(" miz help ", "miz")).toBe("help");
    expect(parseCommandText("miz", "miz")).toBe("");
    expect(parseCommandText("mizuki help", "miz")).toBeUndefined();
    expect(parseCommandText("miz占卜", "miz")).toBeUndefined();
  });

  test("does not treat an English word prefix as a command", () => {
    expect(findPluginCommand("helpful", ["help"])).toBeUndefined();
    expect(findPluginCommand("help details", ["help"])).toEqual({
      name: "help",
      args: "details",
      raw: "help details",
    });
  });

  test("keeps compact arguments for non-ASCII commands", () => {
    expect(findPluginCommand("占卜明天", ["占卜"])).toEqual({
      name: "占卜",
      args: "明天",
      raw: "占卜明天",
    });
  });

  test("prefers the longest overlapping command", () => {
    expect(findPluginCommand("新闻列表", ["新", "新闻"])).toMatchObject({ name: "新闻", args: "列表" });
  });
});
