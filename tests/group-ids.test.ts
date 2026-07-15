import { describe, expect, test } from "bun:test";
import { getGroupIds } from "@/group-ids";

describe("group ID normalization", () => {
  test("trims, de-duplicates and ignores invalid entries", () => {
    expect(getGroupIds([
      { group_id: " 123 " },
      { group_id: 123 },
      { group_id: "" },
      { group_id: Number.NaN },
      null,
    ])).toEqual(["123"]);
  });

  test("returns an empty list for an invalid response", () => {
    expect(getGroupIds({ group_id: 1 })).toEqual([]);
  });
});
