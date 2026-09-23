import { describe, expect, it } from "vitest";
import {
  classifyPaste, isChatStashPath, PASTE_IMAGE_EXT, pasteNumber,
} from "../pasteImages";

const file = (type: string) => ({ kind: "file", type });
const str = (type = "text/plain") => ({ kind: "string", type });

describe("classifyPaste", () => {
  it("lets text through even when a picture rides along", () => {
    // Word / Excel / web pages put a rendering of the passage beside the text;
    // taking the picture would make the passage itself unpasteable.
    expect(classifyPaste([str(), file("image/png")], true)).toBe("passthrough");
  });

  it("takes a clipboard that holds only pictures", () => {
    expect(classifyPaste([file("image/png")], false)).toBe("images");
    expect(classifyPaste([file("image/heic"), file("image/jpeg")], false)).toBe("images");
  });

  it("accepts exactly the four whitelisted formats", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(classifyPaste([file(type)], false)).toBe("images");
    }
    expect(Object.keys(PASTE_IMAGE_EXT).sort()).toEqual(
      ["image/gif", "image/jpeg", "image/png", "image/webp"],
    );
  });

  it("names a file it cannot take instead of ignoring it", () => {
    expect(classifyPaste([file("image/heic")], false)).toBe("unsupported");
    expect(classifyPaste([file("image/tiff")], false)).toBe("unsupported");
    expect(classifyPaste([file("application/pdf")], false)).toBe("unsupported");
  });

  it("leaves an empty or string-only clipboard to the textarea", () => {
    expect(classifyPaste([], false)).toBe("passthrough");
    expect(classifyPaste([str("text/html")], false)).toBe("passthrough");
  });
});

describe("isChatStashPath", () => {
  it("recognises the scratch area in either separator spelling", () => {
    expect(isChatStashPath("/p/.ai-writer/tmp/chat/s1/a.png")).toBe(true);
    expect(isChatStashPath("D:\\书\\.ai-writer\\tmp\\chat\\s1\\a.png")).toBe(true);
    expect(isChatStashPath("/p/.ai-writer/tmp/convert/x/a.png")).toBe(false);
    expect(isChatStashPath("/p/chat/a.png")).toBe(false);
  });
});

describe("pasteNumber", () => {
  const a = "/p/.ai-writer/tmp/chat/s/aaa.png";
  const b = "/p/.ai-writer/tmp/chat/s/bbb.png";
  const c = "/p/.ai-writer/tmp/chat/s/ccc.png";
  const none = new Map<string, number>();

  it("numbers a restored session's pictures by first appearance, ignoring other files", () => {
    const known = ["/p/assets/x.png", a, a, b];
    expect(pasteNumber(a, none, known)).toBe(1);
    expect(pasteNumber(b, none, known)).toBe(2);
    expect(pasteNumber(c, none, known)).toBe(3);
  });

  it("never reuses a number after a chip is removed", () => {
    // Pasted a (1) and b (2), removed a's chip: c must not be 「2」 again.
    const assigned = new Map([[a, 1], [b, 2]]);
    expect(pasteNumber(c, assigned, [b])).toBe(3);
    // And a pasted again is still 1.
    expect(pasteNumber(a, assigned, [b])).toBe(1);
  });
});
