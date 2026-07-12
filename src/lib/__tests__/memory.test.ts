import { describe, it, expect } from "vitest";
import {
  hashText,
  splitRange,
  coverEndFor,
  serializeMemory,
  parseMemory,
  checkFreshness,
  selectMemoryForContext,
  projectRelativePath,
  segmentTargetChars,
  memoryStatus,
  MEMORY_TAIL_KEEP_CHARS,
  type DocMemory,
} from "../memory";

function makeMemory(overrides: Partial<DocMemory> = {}): DocMemory {
  return {
    sourcePath: "writing/ch1.md",
    coveredChars: 30,
    updatedAt: "2026-07-12T00:00:00.000Z",
    segments: [
      { from: 0, to: 10, hash: "h1", summary: "第一段摘要" },
      { from: 10, to: 20, hash: "h2", summary: "第二段摘要" },
      { from: 20, to: 30, hash: "h3", summary: "第三段摘要" },
    ],
    ...overrides,
  };
}

describe("memoryStatus", () => {
  const long = "a".repeat(8000); // > MEMORY_MIN_DOC_CHARS
  const freshMem = (): DocMemory => {
    const to = coverEndFor(long); // 6000 (no paragraph breaks)
    return {
      sourcePath: "x",
      coveredChars: to,
      updatedAt: "",
      segments: [{ from: 0, to, hash: hashText(long.slice(0, to)), summary: "s" }],
    };
  };

  it("reports 'short' for a too-short doc with no memory", () => {
    expect(memoryStatus("tiny", null)).toBe("short");
  });

  it("reports 'none' for a long doc with no memory", () => {
    expect(memoryStatus(long, null)).toBe("none");
  });

  it("reports 'fresh' when memory covers the doc up to its tail", () => {
    expect(memoryStatus(long, freshMem())).toBe("fresh");
  });

  it("reports 'stale' when covered text changed", () => {
    const changed = "b".repeat(8000);
    expect(memoryStatus(changed, freshMem())).toBe("stale");
  });

  it("reports 'stale' when the doc grew past its coverage", () => {
    const grown = long + "c".repeat(3000);
    expect(memoryStatus(grown, freshMem())).toBe("stale");
  });
});

describe("hashText", () => {
  it("is deterministic and change-sensitive", () => {
    expect(hashText("hello world")).toBe(hashText("hello world"));
    expect(hashText("hello world")).not.toBe(hashText("hello world!"));
    expect(hashText("")).toHaveLength(8);
  });
});

describe("splitRange", () => {
  const para = "这是一个段落，讲述了一些情节内容。".repeat(10); // 170 chars
  const text = Array.from({ length: 40 }, () => para).join("\n\n"); // ~6.9k chars

  it("produces contiguous ranges covering [from, to) exactly", () => {
    const ranges = splitRange(text, 0, text.length, 1000);
    expect(ranges[0].from).toBe(0);
    expect(ranges[ranges.length - 1].to).toBe(text.length);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].from).toBe(ranges[i - 1].to);
    }
  });

  it("prefers paragraph boundaries for cuts", () => {
    const ranges = splitRange(text, 0, text.length, 1000);
    // Every non-final cut should land right after a blank line.
    for (const r of ranges.slice(0, -1)) {
      expect(text.slice(r.to - 2, r.to)).toBe("\n\n");
    }
  });

  it("absorbs a small tail into the final segment instead of orphaning it", () => {
    const ranges = splitRange(text, 0, text.length, 5000);
    const last = ranges[ranges.length - 1];
    expect(last.to - last.from).toBeGreaterThan(1000);
  });

  it("returns a single range for short inputs", () => {
    expect(splitRange("short", 0, 5, 1000)).toEqual([{ from: 0, to: 5 }]);
  });
});

describe("coverEndFor", () => {
  it("is 0 for documents shorter than the tail keep", () => {
    expect(coverEndFor("x".repeat(MEMORY_TAIL_KEEP_CHARS - 1))).toBe(0);
  });

  it("keeps the tail verbatim and snaps to a paragraph boundary", () => {
    const doc = "早期情节。".repeat(1000) + "\n\n" + "近期情节。".repeat(1000);
    const end = coverEndFor(doc);
    expect(end).toBeLessThanOrEqual(doc.length - MEMORY_TAIL_KEEP_CHARS + 2);
    expect(doc.slice(end - 2, end)).toBe("\n\n");
  });
});

describe("serializeMemory / parseMemory", () => {
  it("round-trips metadata and summaries", () => {
    const mem = makeMemory();
    const parsed = parseMemory(serializeMemory(mem));
    expect(parsed).toEqual(mem);
  });

  it("survives author-edited headings (pairs summaries by order)", () => {
    const raw = serializeMemory(makeMemory()).replace("## 2 ·", "## 我自己改的标题");
    const parsed = parseMemory(raw);
    expect(parsed?.segments[1].summary).toBe("第二段摘要");
  });

  it("returns null for files without a metadata block or with broken JSON", () => {
    expect(parseMemory("# just some markdown")).toBeNull();
    expect(parseMemory("<!-- ai-writer-memory\nnot json\n-->\n")).toBeNull();
  });
});

describe("checkFreshness", () => {
  const doc = "aaaaaaaaaabbbbbbbbbbccccccccccdddddd"; // 36 chars, segments of 10
  const mem = makeMemory({
    coveredChars: 30,
    segments: [
      { from: 0, to: 10, hash: hashText("aaaaaaaaaa"), summary: "A" },
      { from: 10, to: 20, hash: hashText("bbbbbbbbbb"), summary: "B" },
      { from: 20, to: 30, hash: hashText("cccccccccc"), summary: "C" },
    ],
  });

  it("reports all fresh with the uncovered tail", () => {
    expect(checkFreshness(doc, mem)).toEqual({ firstStaleIndex: -1, uncoveredChars: 6 });
  });

  it("flags the first edited segment", () => {
    const edited = doc.slice(0, 12) + "X" + doc.slice(13); // mutate segment 2
    const res = checkFreshness(edited, mem);
    expect(res.firstStaleIndex).toBe(1);
    expect(res.uncoveredChars).toBe(edited.length - 10); // fresh coverage ends at 10
  });

  it("flags segments that fall beyond a shrunken document", () => {
    expect(checkFreshness(doc.slice(0, 15), mem).firstStaleIndex).toBe(1);
  });
});

describe("selectMemoryForContext", () => {
  it("only includes segments that begin before the detail window", () => {
    const mem = makeMemory();
    expect(selectMemoryForContext(mem, 15, 10_000)).toBe("第一段摘要\n\n第二段摘要");
  });

  it("returns empty for missing memory or a window at the document start", () => {
    expect(selectMemoryForContext(null, 100)).toBe("");
    expect(selectMemoryForContext(makeMemory(), 0)).toBe("");
  });

  it("keeps the newest summaries under budget and marks the omission", () => {
    const mem = makeMemory({
      segments: [
        { from: 0, to: 10, hash: "h", summary: "早".repeat(50) },
        { from: 10, to: 20, hash: "h", summary: "中".repeat(50) },
        { from: 20, to: 30, hash: "h", summary: "晚".repeat(50) },
      ],
    });
    const out = selectMemoryForContext(mem, 100, 120);
    expect(out).toContain("晚".repeat(50));
    expect(out).toContain("中".repeat(50));
    expect(out).not.toContain("早".repeat(50));
    expect(out.startsWith("……")).toBe(true);
  });

  it("always includes at least the newest summary even over budget", () => {
    const mem = makeMemory({
      segments: [{ from: 0, to: 10, hash: "h", summary: "长".repeat(500) }],
    });
    expect(selectMemoryForContext(mem, 100, 10)).toContain("长".repeat(500));
  });
});

describe("projectRelativePath", () => {
  it("handles Windows backslashes and case-insensitive roots", () => {
    expect(
      projectRelativePath("D:\\novel\\MyBook", "d:\\novel\\mybook\\writing\\ch1.md")
    ).toBe("writing/ch1.md");
  });

  it("returns null for paths outside the project", () => {
    expect(projectRelativePath("D:/novel/MyBook", "D:/other/ch1.md")).toBeNull();
  });
});

describe("segmentTargetChars", () => {
  it("defaults without a context size and clamps with one", () => {
    expect(segmentTargetChars()).toBe(12_000);
    expect(segmentTargetChars(2_000)).toBe(4_000);   // small model → floor
    expect(segmentTargetChars(200_000)).toBe(24_000); // big model → ceiling
  });
});
