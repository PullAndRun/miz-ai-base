import { describe, expect, test } from "bun:test";
import { parseFaqAction } from "../plugins/faq";

describe("faq parsing", () => {
  test("parses lookup and maintenance actions", () => {
    expect(parseFaqAction("入群须知")).toEqual({ type: "query", keyword: "入群须知" });
    expect(parseFaqAction("add 新人 群文件里有入门说明"))
      .toEqual({ type: "add", keyword: "新人", answer: "群文件里有入门说明" });
    expect(parseFaqAction("edit 新人 请先看群公告"))
      .toEqual({ type: "edit", keyword: "新人", answer: "请先看群公告" });
    expect(parseFaqAction("delete 新人")).toEqual({ type: "delete", keyword: "新人" });
  });

  test("rejects empty answers and keywords with spaces", () => {
    expect(parseFaqAction("add 新人")).toBeUndefined();
    expect(parseFaqAction("两个 词")).toBeUndefined();
  });
});
