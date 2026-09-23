/**
 * The PDF export's page and the print window agree on one path: the page
 * requests it once `document.fonts.ready` resolves, and `print.rs` holds the
 * print dialog until it arrives (or three seconds pass). Two files, two
 * languages, one string — if either side renames it, the print silently goes
 * back to printing on a fixed delay, which is exactly when a downloaded font
 * pack's late chunks print in the fallback face.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("the PDF page's fonts-ready signal", () => {
  it("is the path print.rs waits for", () => {
    const rust = /pub const FONTS_READY_PATH: &str = "([^"]+)";/.exec(read("src-tauri/src/print.rs"))?.[1];
    expect(rust).toBe("/__fonts-ready");
    const ts = read("src/lib/fs/export.ts");
    expect(ts).toContain(`fetch("${rust}")`);
    // …and only the PDF page carries it: an author's own .html is printed on the old delay.
    expect(ts.match(/\$\{FONTS_READY_SCRIPT\}/g)).toHaveLength(1);
  });
});
