import { describe, expect, test } from "bun:test";
import {
  setVtbAtAllStreamerInSource,
  setVtbDynamicAtAllStreamerInSource,
  setVtbDynamicStreamerInSource,
} from "@/config";

const source = [
  "[[miz.vtb.subscriptions]]",
  "groupId = 100",
  'streamers = ["主播甲", "主播乙"]',
  'atAllStreamers = ["主播甲"]',
  "",
  "[[miz.vtb.subscriptions]]",
  "groupId = 200",
  'streamers = ["主播甲"]',
  "",
].join("\n");

describe("VTB at-all config updates", () => {
  test("enables and disables at-all for only the requested group", () => {
    const enabled = setVtbAtAllStreamerInSource(source, 100, "主播乙", true);
    expect(enabled.changed).toBeTrue();
    expect(enabled.subscribed).toBeTrue();
    expect(enabled.atAllStreamers).toEqual(["主播甲", "主播乙"]);

    const disabled = setVtbAtAllStreamerInSource(enabled.source, 100, "主播甲", false);
    expect(disabled.atAllStreamers).toEqual(["主播乙"]);
    expect(Bun.TOML.parse(disabled.source)).toMatchObject({
      miz: {
        vtb: {
          subscriptions: [
            { groupId: 100, atAllStreamers: ["主播乙"] },
            { groupId: 200, streamers: ["主播甲"] },
          ],
        },
      },
    });
  });

  test("adds a missing atAllStreamers assignment", () => {
    const enabled = setVtbAtAllStreamerInSource(source, 200, "主播甲", true);
    expect(enabled.changed).toBeTrue();
    expect(Bun.TOML.parse(enabled.source)).toMatchObject({
      miz: { vtb: { subscriptions: [{}, { atAllStreamers: ["主播甲"] }] } },
    });
  });

  test("does not add an unsubscribed streamer", () => {
    const result = setVtbAtAllStreamerInSource(source, 100, "不存在", true);
    expect(result.changed).toBeFalse();
    expect(result.subscribed).toBeFalse();
    expect(result.source).toBe(source);
  });
});

describe("VTB dynamic config updates", () => {
  const dynamicSource = [
    "[[miz.vtb.subscriptions]]",
    "groupId = 100",
    'streamers = ["主播甲", "主播乙"]',
    "",
    "[[miz.vtb.subscriptions]]",
    "groupId = 200",
    'streamers = ["主播甲"]',
    'dynamicStreamers = ["主播甲"]',
    'dynamicAtAllStreamers = ["主播甲"]',
    "",
  ].join("\n");

  test("enables and disables dynamic delivery for only the requested group", () => {
    const enabled = setVtbDynamicStreamerInSource(dynamicSource, 100, "主播乙", true);
    expect(enabled.changed).toBeTrue();
    expect(enabled.subscribed).toBeTrue();
    expect(Bun.TOML.parse(enabled.source)).toMatchObject({
      miz: { vtb: { subscriptions: [{ dynamicStreamers: ["主播乙"] }, {}] } },
    });

    const disabled = setVtbDynamicStreamerInSource(enabled.source, 200, "主播甲", false);
    expect(disabled.changed).toBeTrue();
    expect(disabled.dynamicStreamers).toEqual([]);
  });

  test("does not enable dynamic delivery for an unsubscribed streamer", () => {
    const result = setVtbDynamicStreamerInSource(dynamicSource, 100, "不存在", true);
    expect(result.changed).toBeFalse();
    expect(result.subscribed).toBeFalse();
    expect(result.source).toBe(dynamicSource);
  });

  test("toggles dynamic at-all independently from live at-all", () => {
    const enabled = setVtbDynamicAtAllStreamerInSource(dynamicSource, 100, "主播乙", true);
    expect(enabled.changed).toBeTrue();
    expect(Bun.TOML.parse(enabled.source)).toMatchObject({
      miz: { vtb: { subscriptions: [{ dynamicAtAllStreamers: ["主播乙"] }, {}] } },
    });

    const disabled = setVtbDynamicAtAllStreamerInSource(enabled.source, 200, "主播甲", false);
    expect(disabled.changed).toBeTrue();
    expect(disabled.dynamicAtAllStreamers).toEqual([]);
  });
});
