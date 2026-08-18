import { describe, it, expect } from "vitest";
import {
  isPathWithin,
  isProtectedPath,
  isStrictDescendant,
  isWorkspacePath,
  normalizePathSegments,
  relativePathFrom,
  resolveRelativePath,
} from "../paths";

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

describe("isProtectedPath", () => {
  it("covers .ai-writer itself and its subtree", () => {
    expect(isProtectedPath("/proj", "/proj/.ai-writer")).toBe(true);
    expect(isProtectedPath("/proj", "/proj/.ai-writer/lore/角色/主角/index.md")).toBe(true);
  });

  it("does not cover ordinary project files", () => {
    expect(isProtectedPath("/proj", "/proj/第一章.md")).toBe(false);
    expect(isProtectedPath("/proj", "/proj/writing/第一章.md")).toBe(false);
  });

  it("normalizes `..` before deciding", () => {
    expect(isProtectedPath("/proj", "/proj/writing/../.ai-writer/profile.json")).toBe(true);
  });

  it("does not mistake a lookalike sibling for the data dir", () => {
    expect(isProtectedPath("/proj", "/proj/.ai-writer-evil/x.md")).toBe(false);
  });

  it("fails closed on an empty project path", () => {
    expect(isProtectedPath("", "/anywhere/at/all")).toBe(true);
  });
});

describe("isWorkspacePath", () => {
  it("accepts files anywhere in the project, at any depth", () => {
    expect(isWorkspacePath("/proj", "/proj/第一章.md")).toBe(true);
    expect(isWorkspacePath("/proj", "/proj/素材/摘录/第9层/notes.txt")).toBe(true);
  });

  it("rejects paths outside the project", () => {
    expect(isWorkspacePath("/proj", "/etc/passwd")).toBe(false);
    expect(isWorkspacePath("/proj", "/proj/../other/a.md")).toBe(false);
    expect(isWorkspacePath("/proj", "/proj-evil/a.md")).toBe(false);
  });

  it("rejects the app's own .ai-writer data", () => {
    expect(isWorkspacePath("/proj", "/proj/.ai-writer/profile.json")).toBe(false);
    expect(isWorkspacePath("/proj", "/proj/.ai-writer")).toBe(false);
  });

  it("rejects everything when the project path is empty", () => {
    // The load-bearing guard: an empty base would otherwise prefix-match any
    // absolute path and turn the tools into a whole-disk read.
    expect(isWorkspacePath("", "/proj/a.md")).toBe(false);
    expect(isWorkspacePath("", "")).toBe(false);
  });
});

describe("normalizePathSegments", () => {
  it("resolves . and .. lexically", () => {
    expect(normalizePathSegments("/a/b/../c/./d")).toBe("/a/c/d");
    expect(normalizePathSegments("/a//b/")).toBe("/a/b");
  });

  it("cannot climb above the filesystem root", () => {
    expect(normalizePathSegments("/../../etc")).toBe("/etc");
  });

  it("normalizes backslash separators", () => {
    expect(normalizePathSegments("C:\\proj\\writing\\..\\lore")).toBe("C:/proj/lore");
  });
});

describe("isPathWithin", () => {
  const base = "/home/user/project";

  it("accepts the base itself and nested paths", () => {
    expect(isPathWithin(base, base)).toBe(true);
    expect(isPathWithin(base, `${base}/writing/ch1.md`)).toBe(true);
  });

  it("accepts traversal that stays inside the base", () => {
    expect(isPathWithin(base, `${base}/writing/../lore/a.md`)).toBe(true);
  });

  it("rejects ../ traversal escaping the base", () => {
    expect(isPathWithin(base, `${base}/../../../etc/passwd`)).toBe(false);
    expect(isPathWithin(base, `${base}/../other/file.md`)).toBe(false);
  });

  it("rejects sibling directories sharing the base as a string prefix", () => {
    expect(isPathWithin(base, "/home/user/project-evil/x.md")).toBe(false);
  });

  it("rejects unrelated absolute paths", () => {
    expect(isPathWithin(base, "/etc/passwd")).toBe(false);
  });
});

describe("isStrictDescendant", () => {
  const dir = "/home/user/project/writing/卷一";

  it("is false for the path itself — a move onto itself is not a nesting", () => {
    expect(isStrictDescendant(dir, dir)).toBe(false);
    expect(isStrictDescendant(dir, `${dir}/`)).toBe(false);
  });

  it("catches a folder being moved into its own subtree", () => {
    expect(isStrictDescendant(dir, `${dir}/第1章.md`)).toBe(true);
    expect(isStrictDescendant(dir, `${dir}/子卷/深处`)).toBe(true);
  });

  it("allows siblings and ancestors", () => {
    expect(isStrictDescendant(dir, "/home/user/project/writing/卷二")).toBe(false);
    expect(isStrictDescendant(dir, "/home/user/project/writing")).toBe(false);
    expect(isStrictDescendant(dir, `${dir}-备份/第1章.md`)).toBe(false);
  });
});
