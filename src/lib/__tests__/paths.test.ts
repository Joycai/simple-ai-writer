import { describe, it, expect } from "vitest";
import { relativePathFrom, resolveRelativePath } from "../paths";

describe("resolveRelativePath", () => {
  it("joins a simple relative path to the base dir", () => {
    expect(resolveRelativePath("D:/proj/writing", "images/foo.png")).toBe(
      "D:/proj/writing/images/foo.png",
    );
  });

  it("collapses `..` segments", () => {
    expect(resolveRelativePath("D:/proj/writing", "../ext_images/bar.png")).toBe(
      "D:/proj/ext_images/bar.png",
    );
  });

  it("collapses `.` and normalizes backslashes", () => {
    expect(resolveRelativePath("D:\\proj\\writing", ".\\pics\\a.png")).toBe(
      "D:/proj/writing/pics/a.png",
    );
  });

  it("returns absolute drive-letter paths without rebasing", () => {
    expect(resolveRelativePath("D:/proj/writing", "C:/other/x.png")).toBe(
      "C:/other/x.png",
    );
  });

  it("returns POSIX-absolute paths without rebasing", () => {
    expect(resolveRelativePath("/home/u/proj", "/etc/x.png")).toBe("/etc/x.png");
  });
});

describe("relativePathFrom", () => {
  it("writes a sibling file as a bare name", () => {
    expect(relativePathFrom("/proj/writing", "/proj/writing/a.png")).toBe("a.png");
  });

  it("descends into a subfolder", () => {
    // The everyday case: a document linking its own illustration.
    expect(relativePathFrom("/proj/writing", "/proj/writing/assets/第三章/img-1.png"))
      .toBe("assets/第三章/img-1.png");
  });

  it("climbs out with `..` for a picture kept elsewhere in the project", () => {
    expect(relativePathFrom("/proj/writing/卷一", "/proj/参考图/外套.png"))
      .toBe("../../参考图/外套.png");
  });

  it("round-trips through resolveRelativePath", () => {
    // The two are inverses, and an illustration link is only correct if they
    // agree — one writes it, the preview and the exporter read it back.
    for (const [dir, target] of [
      ["/proj/writing", "/proj/writing/assets/ch1/a.png"],
      ["/proj/writing/卷一/卷二", "/proj/a.png"],
      ["/proj/writing", "/proj/writing/b.png"],
    ]) {
      expect(resolveRelativePath(dir, relativePathFrom(dir, target))).toBe(target);
    }
  });

  it("normalizes backslashes and redundant segments on both sides", () => {
    expect(relativePathFrom("D:\\proj\\writing\\.", "D:/proj/writing/pics/a.png"))
      .toBe("pics/a.png");
  });

  it("falls back to the absolute path when the two share no root", () => {
    // Two Windows drives: there is no relative path to write, and a link that
    // works on this machine beats one that works nowhere.
    expect(relativePathFrom("C:/proj/writing", "D:/pics/a.png")).toBe("D:/pics/a.png");
  });
});
