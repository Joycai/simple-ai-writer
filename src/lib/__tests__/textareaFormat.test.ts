import { describe, it, expect } from "vitest";
import {
  wrapEdit,
  headingEdit,
  linePrefixEdit,
  linkEdit,
  type TextEdit,
} from "../editor/textareaFormat";

/** Apply a computed edit to a string the way the DOM applier would. */
function applied(v: string, edit: TextEdit): string {
  return v.slice(0, edit.from) + edit.insert + v.slice(edit.to);
}

describe("wrapEdit", () => {
  it("wraps a selection and keeps it selected inside the markers", () => {
    const e = wrapEdit("hello world", 0, 5, "**");
    expect(applied("hello world", e)).toBe("**hello** world");
    expect([e.selStart, e.selEnd]).toEqual([2, 7]);
  });

  it("unwraps when markers surround the selection", () => {
    const v = "**hello** world";
    const e = wrapEdit(v, 2, 7, "**"); // "hello" between the **
    expect(applied(v, e)).toBe("hello world");
  });

  it("unwraps when markers are part of the selection", () => {
    const v = "**hello** world";
    const e = wrapEdit(v, 0, 9, "**"); // whole "**hello**" selected
    expect(applied(v, e)).toBe("hello world");
  });

  it("inserts empty markers with the cursor between them", () => {
    const e = wrapEdit("ab", 1, 1, "*");
    expect(applied("ab", e)).toBe("a**b");
    expect([e.selStart, e.selEnd]).toEqual([2, 2]);
  });
});

describe("headingEdit", () => {
  it("adds a level-2 heading", () => {
    const e = headingEdit("Title", 2, 2, 2);
    expect(applied("Title", e)).toBe("## Title");
  });

  it("clears the heading when toggling the same level", () => {
    const e = headingEdit("## Title", 4, 4, 2);
    expect(applied("## Title", e)).toBe("Title");
  });

  it("replaces a different level", () => {
    const e = headingEdit("# Title", 3, 3, 3);
    expect(applied("# Title", e)).toBe("### Title");
  });

  it("applies across every line the selection spans", () => {
    const v = "a\nb";
    const e = headingEdit(v, 0, 3, 1);
    expect(applied(v, e)).toBe("# a\n# b");
  });
});

describe("linePrefixEdit", () => {
  it("quotes each line", () => {
    const v = "a\nb";
    const e = linePrefixEdit(v, 0, 3, "> ");
    expect(applied(v, e)).toBe("> a\n> b");
  });

  it("removes a bullet prefix when already applied", () => {
    const e = linePrefixEdit("- item", 3, 3, "- ");
    expect(applied("- item", e)).toBe("item");
  });
});

describe("linkEdit", () => {
  it("wraps the selection as the label and selects the url placeholder", () => {
    const v = "Anthropic";
    const e = linkEdit(v, 0, 9);
    const out = applied(v, e);
    expect(out).toBe("[Anthropic](url)");
    expect(out.slice(e.selStart, e.selEnd)).toBe("url");
  });
});
