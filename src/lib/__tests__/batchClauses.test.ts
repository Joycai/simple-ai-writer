/**
 * Clause splitting for batch runs: mode detection (headings vs numbering vs
 * none), top-level slicing, preamble flagging, and the fence guard. The rule
 * being pinned: split at the *shallowest* structure level found, keep every
 * character (preamble included), and let the UI preview do the vetting.
 */
import { describe, expect, it } from "vitest";
import { splitClauses } from "../batch/clauses";

describe("splitClauses — heading mode", () => {
  const doc = [
    "招标编号：ABC-2026",
    "",
    "## 2.1 投标人资质",
    "应具备相应资质。",
    "### 2.1.1 细则",
    "细则内容。",
    "## 2.2 技术要求",
    "系统应支持高可用。",
  ].join("\n");

  it("splits at the top heading level, children stay inside", () => {
    const { mode, clauses } = splitClauses(doc);
    expect(mode).toBe("heading");
    // preamble + two ## sections; the ### stays inside 2.1.
    expect(clauses).toHaveLength(3);
    expect(clauses[1].title).toBe("## 2.1 投标人资质");
    expect(clauses[1].text).toContain("### 2.1.1 细则");
    expect(clauses[2].title).toBe("## 2.2 技术要求");
  });

  it("flags content before the first boundary as preamble", () => {
    const { clauses } = splitClauses(doc);
    expect(clauses[0].preamble).toBe(true);
    expect(clauses[0].text).toContain("招标编号");
    // Real clauses are not flagged.
    expect(clauses[1].preamble).toBeUndefined();
  });

  it("ignores heading-looking lines inside code fences", () => {
    const fenced = ["## A", "```", "## not a heading", "```", "## B", "x"].join("\n");
    const { clauses } = splitClauses(fenced);
    expect(clauses.map((c) => c.title)).toEqual(["## A", "## B"]);
  });
});

describe("splitClauses — numbered mode", () => {
  it("splits PDF-flat text at the shallowest numbering depth", () => {
    // No headings at all — the shape a PDF import produces.
    const doc = [
      "第二章 投标人须知",
      "2.1 投标人应具备相应资质",
      "资质说明若干。",
      "2.1.1 子项不应成为切分点",
      "2.2 投标保证金",
      "金额说明。",
    ].join("\n");
    const { mode, clauses } = splitClauses(doc);
    expect(mode).toBe("numbered");
    // 第二章 (depth 1) is the shallowest boundary — one clause from there;
    // 2.1/2.2 (depth 2) stay inside it.
    expect(clauses).toHaveLength(1);
    expect(clauses[0].title).toBe("第二章 投标人须知");
  });

  it("uses clause numbers when they are the only structure", () => {
    const doc = [
      "1. 系统应支持单点登录",
      "说明文字。",
      "2. 系统应支持审计日志",
      "3、系统应支持双机热备",
    ].join("\n");
    const { mode, clauses } = splitClauses(doc);
    expect(mode).toBe("numbered");
    expect(clauses.map((c) => c.title)).toEqual([
      "1. 系统应支持单点登录",
      "2. 系统应支持审计日志",
      "3、系统应支持双机热备",
    ]);
  });
});

describe("splitClauses — fallbacks", () => {
  it("returns the whole text as one clause when nothing is detectable", () => {
    const { mode, clauses } = splitClauses("一段没有任何结构的说明文字。\n第二行。");
    expect(mode).toBe("none");
    expect(clauses).toHaveLength(1);
    expect(clauses[0].title).toBe("一段没有任何结构的说明文字。");
  });

  it("returns no clauses for an empty document", () => {
    expect(splitClauses("").clauses).toHaveLength(0);
    expect(splitClauses("   \n  ").clauses).toHaveLength(0);
  });

  it("needs at least two boundaries to trust a mode", () => {
    // A single stray "# 标题" (a cover page) must not force heading mode.
    const { mode } = splitClauses("# 封面标题\n正文若干，没有其他结构。");
    expect(mode).toBe("none");
  });
});
