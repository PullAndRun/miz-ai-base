import { describe, expect, test } from "bun:test";
import { parseStrictLocalDateTime } from "@/local-date-time";

describe("strict local date-time parsing", () => {
  test("accepts valid local times without normalizing invalid fields", () => {
    expect(parseStrictLocalDateTime("2030-08-01", "20:30")).toBeInstanceOf(Date);
    expect(parseStrictLocalDateTime("2030-02-30", "20:30")).toBeUndefined();
    expect(parseStrictLocalDateTime("2030-08-01", "24:00")).toBeUndefined();
    expect(parseStrictLocalDateTime("2030-8-1", "20:30")).toBeUndefined();
  });
});
