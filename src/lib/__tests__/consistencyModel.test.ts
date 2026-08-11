/**
 * 一致性检查 quote anchoring: the part that decides whether a finding gets
 * working buttons or a "check it by hand" note.
 */
import { describe, expect, it } from "vitest";
import { applySuggestions, locateQuote, type ConsistencyIssue } from "../consistency/model";

const issue = (over: Partial<ConsistencyIssue>): ConsistencyIssue => ({
  id: "i1",
  severity: "conflict",
  category: "characters",
  title: "t",
  quote: "",
  reference: "",
  ...over,
});

describe("locateQuote", () => {
  it("finds an exact single occurrence", () => {
    const doc = "他以左手按住剑柄，抬头看向城下。";
    expect(locateQuote(doc, "以左手按住剑柄")).toEqual({ from: 1, to: 8 });
  });

  it("refuses an ambiguous quote rather than guessing", () => {
    const doc = "他抬头。她抬头。";
    expect(locateQuote(doc, "抬头")).toBeNull();
  });

  it("tolerates whitespace the model normalised away", () => {
    const doc = "苏婉低声唤：\n“林辰”——";
    const range = locateQuote(doc, "苏婉低声唤：“林辰”");
    expect(range).not.toBeNull();
    expect(doc.slice(range!.from, range!.to)).toBe("苏婉低声唤：\n“林辰”");
  });

  it("folds curly quotes to straight ones", () => {
    const doc = 'She said "yes" softly.';
    const range = locateQuote(doc, "She said “yes”");
    expect(range).not.toBeNull();
    expect(doc.slice(range!.from, range!.to)).toBe('She said "yes"');
  });

  it("returns null for a quote that is gone", () => {
    expect(locateQuote("现在写的是别的内容。", "以左手按住剑柄")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(locateQuote("anything", "   ")).toBeNull();
  });
});

describe("applySuggestions", () => {
  it("applies one replacement", () => {
    const doc = "他以左手按住剑柄。";
    const { text, applied } = applySuggestions(doc, [
      issue({ quote: "以左手", suggestion: "以右手" }),
    ]);
    expect(text).toBe("他以右手按住剑柄。");
    expect(applied).toEqual(["i1"]);
  });

  it("applies several without shifting each other's offsets", () => {
    const doc = "甲说A。乙说B。丙说C。";
    const { text, applied } = applySuggestions(doc, [
      issue({ id: "a", quote: "甲说A", suggestion: "甲说X" }),
      issue({ id: "c", quote: "丙说C", suggestion: "丙说Z" }),
    ]);
    expect(text).toBe("甲说X。乙说B。丙说Z。");
    expect(applied.sort()).toEqual(["a", "c"]);
  });

  it("skips a finding whose passage no longer exists", () => {
    const doc = "作者已经改写过这一段了。";
    const { text, applied } = applySuggestions(doc, [
      issue({ quote: "以左手", suggestion: "以右手" }),
    ]);
    expect(text).toBe(doc);
    expect(applied).toEqual([]);
  });

  it("ignores a suggestion identical to the quote", () => {
    const doc = "不变的一句。";
    const { applied } = applySuggestions(doc, [
      issue({ quote: "不变的一句", suggestion: "不变的一句" }),
    ]);
    expect(applied).toEqual([]);
  });

  it("drops an overlapping edit instead of mangling the text", () => {
    const doc = "他以左手按住剑柄。";
    const { text, applied } = applySuggestions(doc, [
      issue({ id: "wide", quote: "以左手按住剑柄", suggestion: "以右手扶住剑柄" }),
      issue({ id: "narrow", quote: "左手", suggestion: "右手" }),
    ]);
    // The later-starting edit lands; the one it overlaps is left alone.
    expect(applied).toEqual(["narrow"]);
    expect(text).toBe("他以右手按住剑柄。");
  });
});
