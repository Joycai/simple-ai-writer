/**
 * A picture link written by the model, in the surface that has no folder.
 *
 * The property worth protecting is not "images show" — it is that a string the
 * model chose cannot name a file outside the project and have the app read it.
 */
import { describe, expect, it } from "vitest";

import { chatImageSource } from "../chatImages";
import { renderMarkdown } from "../../fs/markdown";

const ROOT = "/Users/me/书";

describe("chatImageSource", () => {
  it("leaves links the webview can already load alone", () => {
    for (const raw of [
      "https://example.com/a.png",
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "blob:tauri://localhost/abcd",
      "ai-writer-asset://localhost/a.png", // older documents' links
      "",
    ]) {
      expect(chatImageSource(ROOT, raw)).toEqual({ kind: "skip" });
    }
  });

  it("resolves a relative link against the project root, not a document", () => {
    // The failing case that started this: the model listed an entity's gallery
    // and wrote the bare filename it had been shown.
    expect(chatImageSource(ROOT, "img-1787719349788.jpg")).toEqual({
      kind: "read",
      path: `${ROOT}/img-1787719349788.jpg`,
    });
    expect(chatImageSource(ROOT, "assets/第三章/图1.png")).toEqual({
      kind: "read",
      path: `${ROOT}/assets/第三章/图1.png`,
    });
  });

  it("percent-decodes each segment, the way the exporter's links are written", () => {
    expect(chatImageSource(ROOT, "assets/%E7%AC%AC1%E7%AB%A0%20%26%20%E7%BB%88%E5%B1%80/a.png")).toEqual({
      kind: "read",
      path: `${ROOT}/assets/第1章 & 终局/a.png`,
    });
  });

  it("accepts an absolute path inside the project — including .ai-writer", () => {
    // A gallery image lives under .ai-writer/lore/…; the write tools' ban on
    // that directory is about writes, and this is a read for display.
    expect(chatImageSource(ROOT, `${ROOT}/.ai-writer/lore/characters/白石雫/img-1.jpg`)).toEqual({
      kind: "read",
      path: `${ROOT}/.ai-writer/lore/characters/白石雫/img-1.jpg`,
    });
  });

  it("refuses anything that lands outside the project", () => {
    expect(chatImageSource(ROOT, "/etc/passwd")).toEqual({ kind: "refuse" });
    expect(chatImageSource(ROOT, "../../../etc/passwd")).toEqual({ kind: "refuse" });
    expect(chatImageSource(ROOT, `${ROOT}/../别人的书/秘密.png`)).toEqual({ kind: "refuse" });
    // A sibling directory sharing the project's name as a prefix is not inside it.
    expect(chatImageSource(ROOT, "/Users/me/书-备份/a.png")).toEqual({ kind: "refuse" });
  });

  it("refuses every local link when no project is open", () => {
    expect(chatImageSource("", "a.png")).toEqual({ kind: "refuse" });
    expect(chatImageSource("", "/etc/passwd")).toEqual({ kind: "refuse" });
    // …but a remote one is still none of its business.
    expect(chatImageSource("", "https://example.com/a.png")).toEqual({ kind: "skip" });
  });
});

describe("what the renderer actually hands it", () => {
  /** The `src` attribute markdown-it writes, which is what the DOM walk reads. */
  const srcOf = (md: string) => /<img src="([^"]*)"/.exec(renderMarkdown(md))?.[1] ?? "";

  it("survives markdown-it's percent-encoding of a non-ASCII path", () => {
    // markdown-it normalizes every link through encodeURI, so a Chinese folder
    // never reaches this module as the characters the filesystem wants. This is
    // the pairing that matters: the decode has to be the exact inverse.
    const src = srcOf("![](.ai-writer/lore/characters/白石雫/img-1.jpg)");
    expect(src).toContain("%E7%99%BD"); // 白, encoded — not a hypothetical
    expect(chatImageSource(ROOT, src)).toEqual({
      kind: "read",
      path: `${ROOT}/.ai-writer/lore/characters/白石雫/img-1.jpg`,
    });
  });

  it("reads an absolute path written the way the gallery listing gives it", () => {
    const src = srcOf(`![人设图](${ROOT}/.ai-writer/lore/characters/白石雫/img-1787719349788.jpg)`);
    expect(chatImageSource(ROOT, src)).toEqual({
      kind: "read",
      path: `${ROOT}/.ai-writer/lore/characters/白石雫/img-1787719349788.jpg`,
    });
  });
});
