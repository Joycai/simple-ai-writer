import { describe, expect, it } from "vitest";
import {
  classifyPaste, isChatStashPath, PASTE_IMAGE_EXT, pasteDisplayIndex, takePasted,
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

describe("takePasted", () => {
  it("takes the first ones up to the cap and refuses the rest", () => {
    expect(takePasted(0, 3, 5)).toEqual({ take: 3, refuse: 0 });
    expect(takePasted(3, 4, 5)).toEqual({ take: 2, refuse: 2 });
    expect(takePasted(5, 1, 5)).toEqual({ take: 0, refuse: 1 });
    // Already over (a pre-cap @ list): nothing more, never a negative take.
    expect(takePasted(6, 2, 5)).toEqual({ take: 0, refuse: 2 });
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

describe("pasteDisplayIndex", () => {
  const a = "/p/.ai-writer/tmp/chat/s/aaa.png";
  const b = "/p/.ai-writer/tmp/chat/s/bbb.png";
  it("numbers pasted pictures by first appearance, ignoring other files", () => {
    const known = ["/p/assets/x.png", a, a, b];
    expect(pasteDisplayIndex(a, known)).toBe(1);
    expect(pasteDisplayIndex(b, known)).toBe(2);
  });

  it("gives a new picture the next number", () => {
    expect(pasteDisplayIndex("/p/.ai-writer/tmp/chat/s/ccc.png", [a, b])).toBe(3);
    expect(pasteDisplayIndex(a, [])).toBe(1);
  });
});
