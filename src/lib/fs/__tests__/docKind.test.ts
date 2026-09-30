/**
 * docKind — what the editor area is for one file.
 *
 * The part worth pinning is the line between "not opened here" and "failed to
 * open": a `.pptx` used to be read as text, refused by the decoder, and shown
 * on the read-failure page with a retry button — an outcome that is certain by
 * design, worded as a fault.
 */
import { describe, expect, it } from "vitest";
import { docKindOf, fileNoticeReason, isViewOnlyKind } from "../docKind";

// 按 sourceNulBytes.test.ts 的先例就地声明 fs：tsconfig 没有 `@types/node`。
declare const require: (m: string) => { readFileSync(p: string, enc: string): string };
declare const process: { cwd(): string };

/**
 * The refusal exactly as `decode_text` words it — read from the Rust source,
 * not retyped here, so this test breaks when that string is reworded.
 */
function rustNotTextRefusal(): string {
  const src = require("node:fs").readFileSync(`${process.cwd()}/src-tauri/src/commands.rs`, "utf8");
  const body = src.slice(src.indexOf("fn decode_text("));
  const m = /if bytes\.contains\(&0\) \{\s*return Err\("([^"]+)"\.into\(\)\);/.exec(body);
  if (!m) throw new Error("decode_text's NUL-byte refusal moved — update this test's anchor");
  return m[1];
}

describe("isViewOnlyKind — which files the editor never reads as text", () => {
  it.each(["a.docx", "a.xlsx", "a.pdf", "a.pptx", "a.PPTX", "a.png"])("%s is not read", (name) => {
    expect(isViewOnlyKind(docKindOf(`/p/${name}`))).toBe(true);
  });

  // `opaque` holds every text file with an unlisted extension; only a read can
  // tell those from a .zip, so they must still be attempted.
  it.each(["a.md", "a.txt", "a.html", "a.json", "a.zip", "LICENSE"])("%s is read", (name) => {
    expect(isViewOnlyKind(docKindOf(`/p/${name}`))).toBe(false);
  });
});

describe("fileNoticeReason — which page a file that isn't in the buffer gets", () => {
  it("a convertible file is never an error, read or not", () => {
    const kind = docKindOf("/p/调研.pptx");
    expect(fileNoticeReason(kind, null)).toBe("convertible");
    expect(fileNoticeReason(kind, rustNotTextRefusal())).toBe("convertible");
    expect(fileNoticeReason(kind, "Permission denied (os error 13)")).toBe("convertible");
  });

  it("a binary the decoder refused is 'not text', not a failure", () => {
    expect(fileNoticeReason(docKindOf("/p/素材.zip"), rustNotTextRefusal())).toBe("notText");
    // …including through editorStore's `String(error)` of a thrown Error.
    expect(fileNoticeReason(docKindOf("/p/素材.zip"), String(new Error(rustNotTextRefusal())))).toBe("notText");
  });

  it("a read that really failed stays an error, whatever the extension", () => {
    expect(fileNoticeReason(docKindOf("/p/第一篇.md"), "Permission denied (os error 13)")).toBe("error");
    expect(fileNoticeReason(docKindOf("/p/素材.zip"), "No such file or directory (os error 2)")).toBe("error");
    // A .md full of NULs is still refused, and that is still not a fault.
    expect(fileNoticeReason(docKindOf("/p/第一篇.md"), rustNotTextRefusal())).toBe("notText");
  });

  it("no page while the file is in the editor, loading, or a picture", () => {
    expect(fileNoticeReason(docKindOf("/p/第一篇.md"), null)).toBeNull();
    expect(fileNoticeReason(docKindOf("/p/素材.zip"), null)).toBeNull();
    expect(fileNoticeReason(docKindOf("/p/封面.png"), "stale error from elsewhere")).toBeNull();
  });
});
