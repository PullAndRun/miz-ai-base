import { describe, expect, test } from "bun:test";
import { createFf14PriceAlertMentionMessage } from "@/ff14";

describe("FF14 price alert mentions", () => {
  test("creates real at segments for every configured member", () => {
    expect(createFf14PriceAlertMentionMessage([123456789, "987654321"])).toEqual([
      { type: "at", data: { qq: 123456789 } },
      { type: "text", data: { text: " " } },
      { type: "at", data: { qq: "987654321" } },
      { type: "text", data: { text: " FF14 低价提醒已触发，请查看上方行情。" } },
    ]);
  });

  test("does not mention the same member twice", () => {
    const message = createFf14PriceAlertMentionMessage([123456789, "123456789"]);
    expect(message.filter((segment) => segment.type === "at")).toHaveLength(1);
  });
});
