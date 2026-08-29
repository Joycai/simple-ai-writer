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
  capRecentProjects,
  mergeOpenedAt,
  openedAtKind,
  parseOpenedAt,
  pruneOpenedAt,
  sanitizeOpenedAt,
  mergePinnedProjects,
  mergeRecentProjects,
  parsePinnedProjects,
  parseRecentProjects,
  RECENT_PROJECTS_MAX,
  sanitizePinnedProjects,
  sanitizeRecentProjects,
  splitProjects,
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

/**
 * Pins are markers over the same paths, and the property they buy is exemption
 * from the cap — which means every function that trims has to know about them.
 * The failure they guard against is silent: a pinned project quietly evicted
 * the next time any instance opens something.
 */
const many = (n: number, prefix = "/mine") => Array.from({ length: n }, (_, i) => `${prefix}/${i}`);

describe("capRecentProjects", () => {
  it("counts unpinned entries only", () => {
    const list = [...many(RECENT_PROJECTS_MAX), "/p/pin"];
    expect(capRecentProjects(list, ["/p/pin"])).toEqual(list);
    // Without the pin it is the eleventh entry, and the eleventh is evicted.
    expect(capRecentProjects(list)).toEqual(many(RECENT_PROJECTS_MAX));
  });

  it("keeps recency order — pinned-first is a view, not a stored order", () => {
    expect(capRecentProjects(["/a", "/pin", "/b"], ["/pin"])).toEqual(["/a", "/pin", "/b"]);
  });

  it("matches pins by path identity, not string equality", () => {
    const list = [...many(RECENT_PROJECTS_MAX), "D:/books/a"];
    expect(capRecentProjects(list, ["D:\\books\\a"])).toContain("D:/books/a");
  });
});

describe("sanitizePinnedProjects", () => {
  it("normalises and dedupes like the recents", () => {
    expect(sanitizePinnedProjects(["D:\\books\\a", 7, "D:/books/a", "/home/u/b"])).toEqual([
      "D:/books/a",
      "/home/u/b",
    ]);
  });

  it("does not cap — every entry here was put there by hand", () => {
    expect(sanitizePinnedProjects(many(RECENT_PROJECTS_MAX * 2))).toHaveLength(
      RECENT_PROJECTS_MAX * 2,
    );
  });

  it("answers empty for anything that isn't a list", () => {
    expect(sanitizePinnedProjects("nope")).toEqual([]);
    expect(parsePinnedProjects(null)).toEqual([]);
    expect(parsePinnedProjects("{not json")).toEqual([]);
  });
});

describe("mergeRecentProjects · with pins", () => {
  it("never evicts a pinned project to make room for the other instance", () => {
    const ours = JSON.stringify([...many(RECENT_PROJECTS_MAX), "/p/pin"]);
    const merged = JSON.parse(mergeRecentProjects(JSON.stringify(["/theirs/x"]), ours, ["/p/pin"]));
    expect(merged).toContain("/p/pin");
    expect(merged).not.toContain("/theirs/x"); // the cap still bites, on an unpinned entry
    expect(merged).toHaveLength(RECENT_PROJECTS_MAX + 1);
  });

  it("still caps the unpinned union at the same number", () => {
    const merged = JSON.parse(
      mergeRecentProjects(JSON.stringify(many(5, "/theirs")), JSON.stringify(many(8)), ["/p/pin"]),
    );
    expect(merged).toHaveLength(RECENT_PROJECTS_MAX);
  });
});

describe("mergePinnedProjects", () => {
  it("keeps both instances' pins, ours first", () => {
    const merged = JSON.parse(
      mergePinnedProjects(JSON.stringify(["/p/theirs", "/p/shared"]),
        JSON.stringify(["/p/mine", "/p/shared"])),
    );
    expect(merged).toEqual(["/p/mine", "/p/shared", "/p/theirs"]);
  });

  it("dedupes across the two sides by path identity", () => {
    const merged = JSON.parse(
      mergePinnedProjects(JSON.stringify(["D:\\books\\a"]), JSON.stringify(["D:/books/a"])),
    );
    expect(merged).toEqual(["D:/books/a"]);
  });

  it("is a plain save when the database row is missing or unreadable", () => {
    expect(JSON.parse(mergePinnedProjects(null, JSON.stringify(["/p/a"])))).toEqual(["/p/a"]);
    expect(JSON.parse(mergePinnedProjects("{not json", JSON.stringify(["/p/a"])))).toEqual(["/p/a"]);
  });
});

describe("splitProjects", () => {
  it("splits into pin order and the unpinned remainder", () => {
    expect(splitProjects(["/a", "/pin1", "/b", "/pin2"], ["/pin2", "/pin1"])).toEqual({
      pinned: ["/pin2", "/pin1"],
      recent: ["/a", "/b"],
    });
  });

  it("lists a pin the recents no longer carry — a pin you can't see is one you can't release", () => {
    expect(splitProjects(["/a"], ["/gone"])).toEqual({ pinned: ["/gone"], recent: ["/a"] });
  });

  it("excludes by path identity, so a re-spelled entry isn't shown twice", () => {
    expect(splitProjects(["D:/books/a"], ["D:\\books\\a"]).recent).toEqual([]);
  });
});

/**
 * The open-at stamps: their own row, and the one place in this module where a
 * merge resolves to the *other* instance's value — a stamp is a fact about
 * when a folder was opened, not an opinion about ordering.
 */
describe("sanitizeOpenedAt", () => {
  it("normalises keys and drops anything that isn't a positive number", () => {
    expect(sanitizeOpenedAt({ "D:\\books\\a": 5, "/p/b": "nope", "/p/c": 0, "/p/d": -1 })).toEqual({
      "D:/books/a": 5,
    });
  });

  it("keeps the later stamp when two spellings name one project", () => {
    expect(sanitizeOpenedAt({ "D:\\books\\a": 5, "D:/books/a": 9 })).toEqual({ "D:/books/a": 9 });
  });

  it("answers empty for anything that isn't an object", () => {
    expect(sanitizeOpenedAt(["/p/a"])).toEqual({});
    expect(parseOpenedAt(null)).toEqual({});
    expect(parseOpenedAt("{not json")).toEqual({});
  });
});

describe("mergeOpenedAt", () => {
  it("takes the later stamp from either side", () => {
    const merged = JSON.parse(
      mergeOpenedAt(JSON.stringify({ "/p/a": 9, "/p/b": 1 }), JSON.stringify({ "/p/a": 4 })),
    );
    expect(merged).toEqual({ "/p/a": 9, "/p/b": 1 });
  });

  it("is a plain save when the database row is missing or unreadable", () => {
    expect(JSON.parse(mergeOpenedAt(null, JSON.stringify({ "/p/a": 4 })))).toEqual({ "/p/a": 4 });
    expect(JSON.parse(mergeOpenedAt("{not json", JSON.stringify({ "/p/a": 4 })))).toEqual({ "/p/a": 4 });
  });
});

describe("pruneOpenedAt", () => {
  it("keeps only the projects still listed, by path identity", () => {
    expect(pruneOpenedAt({ "D:/books/a": 1, "/p/gone": 2 }, ["D:\\books\\a"])).toEqual({ "D:/books/a": 1 });
  });
});

describe("openedAtKind", () => {
  const at = (y: number, m: number, d: number, h = 12, min = 0) =>
    new Date(y, m, d, h, min).getTime();

  it("buckets by calendar day, not by a 24-hour window", () => {
    const now = at(2026, 7, 29, 0, 10);
    // 20 minutes earlier, but on the other side of midnight.
    expect(openedAtKind(at(2026, 7, 28, 23, 50), now)).toBe("yesterday");
    expect(openedAtKind(at(2026, 7, 29, 0, 5), now)).toBe("today");
  });

  it("calls anything before yesterday older", () => {
    const now = at(2026, 7, 29);
    expect(openedAtKind(at(2026, 7, 27, 23, 59), now)).toBe("older");
  });

  it("crosses a month boundary without arithmetic", () => {
    const now = at(2026, 8, 1, 9);
    expect(openedAtKind(at(2026, 7, 31, 22), now)).toBe("yesterday");
    expect(openedAtKind(at(2026, 7, 30, 22), now)).toBe("older");
  });

  it("keeps a whole calendar day of yesterday even across a DST shift", () => {
    // `today - 86_400_000` lands at 23:00 on a spring-forward day and would
    // call 00:30 yesterday "older". The boundary is the previous midnight.
    const now = at(2026, 2, 9, 10);           // day after a US spring-forward
    expect(openedAtKind(at(2026, 2, 8, 0, 30), now)).toBe("yesterday");
    expect(openedAtKind(at(2026, 2, 7, 23, 30), now)).toBe("older");
  });
});
