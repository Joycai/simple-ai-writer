/**
 * The line-number contract's pure half: what the model sees, and what an
 * applied write hands back in place of a second read.
 */
import { describe, expect, it } from "vitest";
import { ECHO_MAX_LINES, echoRegion, lineOfOffset, numberLines, shiftNote } from "../lineEcho";

const FILE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

describe("numberLines", () => {
  it("numbers from the given start, right-aligned before a tab", () => {
    expect(numberLines("a\nb", 1)).toBe("     1\ta\n     2\tb");
  });

  // A continued read numbers by the file's lines, not the page's — otherwise
  // every rewrite_lines after page one names a region above the intended it.
  it("keeps counting from a page's real start line", () => {
    expect(numberLines("x", 137)).toBe("   137\tx");
  });

  it("leaves an empty line empty apart from its number", () => {
    expect(numberLines("a\n\nb", 1).split("\n")[1]).toBe("     2\t");
  });
});

describe("lineOfOffset", () => {
  it("is 1-based and counts newlines before the offset", () => {
    expect(lineOfOffset("a\nbb\nc", 0)).toBe(1);
    expect(lineOfOffset("a\nbb\nc", 2)).toBe(2);
    expect(lineOfOffset("a\nbb\nc", 5)).toBe(3);
  });
});

describe("echoRegion", () => {
  it("shows the region with a couple of lines of context either side", () => {
    const out = echoRegion(FILE, 5, 6);
    expect(out).toContain("     3\tline 3");
    expect(out).toContain("     5\tline 5");
    expect(out).toContain("     8\tline 8");
    expect(out).not.toContain("line 9");
  });

  it("does not run off either end of the file", () => {
    expect(echoRegion(FILE, 1, 1).split("\n")[0]).toBe("     1\tline 1");
    const tail = echoRegion(FILE, 12, 12).split("\n");
    expect(tail[tail.length - 1]).toBe("    12\tline 12");
  });

  // Echoing 400 lines would spend the round this exists to save.
  it("shows only the ends of a region past the cap", () => {
    const long = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join("\n");

    const out = echoRegion(long, 10, 150);

    expect(out).toContain("    10\tL10");
    expect(out).toContain("   150\tL150");
    expect(out).toContain("line(s) not echoed");
    expect(out).not.toContain("    80\tL80");
    expect(out.split("\n").length).toBeLessThan(ECHO_MAX_LINES);
  });

  // A deletion leaves `to` below `from`; the surrounding lines still have to
  // come back, because they are what the next range is named against.
  it("survives a region that no longer exists", () => {
    const out = echoRegion(FILE, 5, 4);
    expect(out).toContain("     3\tline 3");
    expect(out).toContain("     6\tline 6");
  });
});

describe("shiftNote", () => {
  it("says plainly when nothing below moved", () => {
    expect(shiftNote(4, 6, 0)).toContain("no line number below it moved");
  });

  it("gives the exact delta and where it applies from", () => {
    const note = shiftNote(4, 9, 3);
    expect(note).toContain("lines 4-9");
    expect(note).toContain("+3");
    expect(note).toContain("after 9");
  });

  it("describes a deletion as a deletion rather than as a backwards range", () => {
    const note = shiftNote(4, 3, -2);
    expect(note).toContain("gone");
    expect(note).toContain("now line 4");
    expect(note).not.toContain("4-3");
  });
});
