/**
 * lib/recentProjects — the recent-projects list's parsing and its
 * multi-instance merge.
 *
 * The merge is what `writePrefMerged` applies when the row is persisted: two
 * app instances each save the whole list from their own snapshot, and the
 * property worth pinning is that an entry added by *either* survives — the
 * plain overwrite this replaced silently dropped whichever instance saved
 * first. Ordering matters too: the project just opened *here* must stay on
 * top here, with the other instance's additions behind it.
 */
import { describe, expect, it } from "vitest";
import {
  mergeRecentProjects,
  parseRecentProjects,
  RECENT_PROJECTS_MAX,
  sanitizeRecentProjects,
} from "../recentProjects";

describe("sanitizeRecentProjects", () => {
  it("keeps strings only and normalises the host's spelling", () => {
    expect(sanitizeRecentProjects(["D:\\books\\a", 42, null, "/home/u/b"])).toEqual([
      "D:/books/a",
      "/home/u/b",
    ]);
  });

  it("dedupes by path identity, not string equality", () => {
    // The same project written by two builds with two spellings must not
    // occupy two slots (the cap would quietly evict a real entry).
    expect(sanitizeRecentProjects(["D:\\books\\a", "D:/books/a"])).toEqual(["D:/books/a"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => `/p/${i}`);
    expect(sanitizeRecentProjects(many)).toHaveLength(RECENT_PROJECTS_MAX);
  });

  it("answers empty for anything that isn't a list", () => {
    expect(sanitizeRecentProjects("nope")).toEqual([]);
    expect(sanitizeRecentProjects(null)).toEqual([]);
  });
});

describe("parseRecentProjects", () => {
  it("tolerates a missing or unreadable raw value", () => {
    expect(parseRecentProjects(null)).toEqual([]);
    expect(parseRecentProjects("{not json")).toEqual([]);
  });
});

describe("mergeRecentProjects", () => {
  const ours = JSON.stringify(["/p/mine", "/p/shared"]);

  it("keeps both instances' additions, ours first", () => {
    const db = JSON.stringify(["/p/theirs", "/p/shared"]);
    expect(JSON.parse(mergeRecentProjects(db, ours))).toEqual([
      "/p/mine",
      "/p/shared",
      "/p/theirs",
    ]);
  });

  it("is a plain save when the database row is missing or unreadable", () => {
    expect(JSON.parse(mergeRecentProjects(null, ours))).toEqual(["/p/mine", "/p/shared"]);
    expect(JSON.parse(mergeRecentProjects("{not json", ours))).toEqual(["/p/mine", "/p/shared"]);
  });

  it("caps the union, evicting the other side's tail first", () => {
    const mine = Array.from({ length: RECENT_PROJECTS_MAX }, (_, i) => `/mine/${i}`);
    const merged = JSON.parse(
      mergeRecentProjects(JSON.stringify(["/theirs/x"]), JSON.stringify(mine)),
    );
    // Ours fill the cap; the other instance's entry is the one that yields.
    expect(merged).toEqual(mine);
  });

  it("dedupes across the two sides by path identity", () => {
    const merged = JSON.parse(
      mergeRecentProjects(JSON.stringify(["D:\\books\\a"]), JSON.stringify(["D:/books/a"])),
    );
    expect(merged).toEqual(["D:/books/a"]);
  });
});
