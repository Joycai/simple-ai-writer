import { describe, expect, it } from "vitest";
import { isPathWithin, normalizePathSegments } from "../agent/tools";

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
