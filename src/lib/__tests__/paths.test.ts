import { describe, it, expect } from "vitest";
import {
  baseName,
  dirName,
  isPathWithin,
  isProtectedPath,
  isSamePath,
  isStrictDescendant,
  isWorkspacePath,
  joinPath,
  normalizePathSegments,
  pathKey,
  projectRelative,
  relativePathFrom,
  resolveRelativePath,
  resolveWorkspacePath,
  toPosixPath,
} from "../paths";

/**
 * The two platform questions this module answers from the *shape* of a path —
 * so one test file covers Windows and Linux/macOS without mocking a host.
 */
describe("platform spelling", () => {
  it("reads a backslash as a separator on a Windows-shaped path", () => {
    expect(toPosixPath("D:\\书\\第一章.md")).toBe("D:/书/第一章.md");
    expect(baseName("D:\\书\\第一章.md")).toBe("第一章.md");
    expect(dirName("D:\\书\\第一章.md")).toBe("D:/书");
  });

  it("reads a backslash as a filename character on a POSIX absolute path", () => {
    // `a\b.md` is one legal file on Linux and macOS — splitting it would
    // invent a directory that does not exist.
    expect(toPosixPath("/home/me/书/a\\b.md")).toBe("/home/me/书/a\\b.md");
    expect(baseName("/home/me/书/a\\b.md")).toBe("a\\b.md");
    expect(dirName("/home/me/书/a\\b.md")).toBe("/home/me/书");
  });

  it("keeps a UNC share's two leading slashes", () => {
    expect(toPosixPath("\\\\nas\\书\\第一章.md")).toBe("//nas/书/第一章.md");
    expect(normalizePathSegments("\\\\nas\\书\\..\\第一章.md")).toBe("//nas/第一章.md");
    expect(projectRelative("//nas/书", "//nas/书/第一章.md")).toBe("第一章.md");
  });

  it("folds case for a Windows path and keeps it everywhere else", () => {
    expect(pathKey("D:\\Proj\\A.md")).toBe(pathKey("d:/proj/a.md"));
    expect(pathKey("/proj/A.md")).not.toBe(pathKey("/proj/a.md"));
  });

  it("carries that rule into the comparisons", () => {
    // Windows: one file, two spellings — the editor must not be told otherwise.
    expect(isSamePath("D:\\Proj\\第一章.md", "d:/proj/第一章.md")).toBe(true);
    expect(isPathWithin("D:\\Proj", "d:/proj/卷一/第一章.md")).toBe(true);
    expect(isProtectedPath("D:\\Proj", "D:/proj/.AI-Writer/lore")).toBe(true);
    // Linux: genuinely two files.
    expect(isSamePath("/proj/A.md", "/proj/a.md")).toBe(false);
    expect(isPathWithin("/proj", "/PROJ/a.md")).toBe(false);
  });

  it("treats an absent path as the same as nothing", () => {
    expect(isSamePath(null, null)).toBe(false);
    expect(isSamePath(undefined, "/proj/a.md")).toBe(false);
  });
});

describe("joinPath", () => {
  it("joins with a single separator whatever the pieces carry", () => {
    expect(joinPath("D:\\proj\\", "/卷一/", "第1章.md")).toBe("D:/proj/卷一/第1章.md");
    expect(joinPath("/proj", "a.md")).toBe("/proj/a.md");
  });
});

describe("projectRelative", () => {
  it("strips the project prefix, separators and case aside on Windows", () => {
    expect(projectRelative("D:\\proj", "D:/PROJ/卷一/第1章.md")).toBe("卷一/第1章.md");
  });

  it("is null for anything not inside the project — the root included", () => {
    expect(projectRelative("/proj", "/proj")).toBeNull();
    expect(projectRelative("/proj", "/other/a.md")).toBeNull();
    expect(projectRelative("", "/proj/a.md")).toBeNull();
  });
});

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

describe("resolveWorkspacePath", () => {
  it("rebases a project-relative path — the shape the prompt hands the model", () => {
    expect(resolveWorkspacePath("D:\\proj", "卷一/第31章.md")).toBe("D:/proj/卷一/第31章.md");
    expect(resolveWorkspacePath("D:\\proj", "大纲.md")).toBe("D:/proj/大纲.md");
  });

  it("leaves an absolute path where it is, whichever separator it uses", () => {
    expect(resolveWorkspacePath("D:\\proj", "D:\\proj\\卷一\\第31章.md")).toBe("D:/proj/卷一/第31章.md");
    expect(resolveWorkspacePath("D:\\proj", "D:/proj/卷一/第31章.md")).toBe("D:/proj/卷一/第31章.md");
  });

  it("refuses what isWorkspacePath refuses, after resolution", () => {
    expect(resolveWorkspacePath("D:/proj", "../other/a.md")).toBeNull();
    expect(resolveWorkspacePath("D:/proj", ".ai-writer/profile.json")).toBeNull();
    expect(resolveWorkspacePath("D:/proj", "/etc/passwd")).toBeNull();
    expect(resolveWorkspacePath("", "a.md")).toBeNull();
  });
});

describe("isSamePath", () => {
  it("sees through separators and traversal", () => {
    expect(isSamePath("D:\\proj\\第1章.md", "D:/proj/第1章.md")).toBe(true);
    expect(isSamePath("D:/proj/卷一/../第1章.md", "D:/proj/第1章.md")).toBe(true);
  });

  it("still tells different files apart", () => {
    expect(isSamePath("D:/proj/第1章.md", "D:/proj/第2章.md")).toBe(false);
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
