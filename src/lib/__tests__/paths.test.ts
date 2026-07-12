import { describe, it, expect } from "vitest";
import { resolveRelativePath } from "../paths";

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
