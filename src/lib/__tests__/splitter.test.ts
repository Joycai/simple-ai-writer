import { describe, it, expect, vi } from "vitest";
import { parseSplitResponse } from "../lore/splitter";

// i18n touches localStorage at import time (browser-only).
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

/**
 * `parseSplitResponse` is now the *fallback* — the split itself arrives through
 * the split_* tools (splitTools.test.ts). It stays covered because a model that
 * ignores the tools and prints one JSON object anyway is exactly the case it
 * catches, and because the trailing-prose case below used to be a real failure:
 * a reply that began with `{` was handed to JSON.parse whole, closing remark
 * and all.
 */
describe("parseSplitResponse", () => {
  it("parses a clean JSON response with defaults applied", () => {
    const res = parseSplitResponse(JSON.stringify({
      core: "核心正文",
      facets: [
        { title: "战甲形象", group: "outfit", priority: 2, keys: ["战甲", " 铠甲 "], content: "原文段落" },
        { title: "背景", content: "童年经历" },
        { title: "空的会被丢弃", content: "" },
      ],
      notes: "拆了两条",
    }));
    expect(res.core).toBe("核心正文");
    expect(res.notes).toBe("拆了两条");
    expect(res.facets).toHaveLength(2);
    expect(res.facets[0].meta).toEqual({
      title: "战甲形象", group: "outfit", priority: 2, keys: ["战甲", "铠甲"], mode: "auto",
    });
    expect(res.facets[1].meta.group).toBeNull();
    expect(res.facets[1].meta.priority).toBe(0);
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const res = parseSplitResponse('Sure!\n```json\n{"core":"c","facets":[],"notes":""}\n```\nDone.');
    expect(res.core).toBe("c");
  });

  it("ignores a closing remark after an object the reply starts with", () => {
    const res = parseSplitResponse('{"core":"c","facets":[],"notes":""}\n\n以上就是拆分方案。');
    expect(res.core).toBe("c");
  });

  it("throws a helpful error on non-JSON output", () => {
    expect(() => parseSplitResponse("I cannot do that")).toThrow(/valid JSON/);
  });

  it("names the unescaped-quote failure in its error, with a preview", () => {
    // The failure this whole change is about: the author's own straight quotes
    // copied verbatim into a hand-written JSON string.
    const broken = '{"core": "其名取自"在黑暗中举行的盛宴"——", "facets": []}';
    expect(() => parseSplitResponse(broken)).toThrow(/Failed to parse[\s\S]*黑暗/);
  });
});
