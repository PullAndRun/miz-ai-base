import { describe, expect, test } from "bun:test";
import { findPluginCommand, parseCommandText } from "@/plugin-command";

describe("command parsing", () => {
  test("allows an optional gap between the prefix and every command", () => {
    const commands = ["help", "video", "占卜"];

    expect(parseCommandText(" miz help ", "miz", commands)).toBe("help");
    expect(parseCommandText("mizhelp", "miz", commands)).toBe("help");
    expect(parseCommandText("mizvideo https://example.com/a.mp4", "miz", commands))
      .toBe("video https://example.com/a.mp4");
    expect(parseCommandText("miz占卜", "miz", commands)).toBe("占卜");
    expect(parseCommandText("miz占卜明天", "miz", commands)).toBe("占卜明天");
    expect(parseCommandText("miz", "miz", commands)).toBe("");
    expect(parseCommandText("mizuki help", "miz", commands)).toBeUndefined();
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
