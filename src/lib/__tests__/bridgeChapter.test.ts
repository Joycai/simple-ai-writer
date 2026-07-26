import { describe, expect, it } from "vitest";
import { resolveBridgeChapter } from "../context/bookContext";
import { findChapterContext, type Volume } from "../context/outline";

const ch = (vol: string, name: string) => ({
  name: `${name}.md`,
  path: `/p/writing/${vol}/${name}.md`,
  relPath: `writing/${vol}/${name}.md`,
});

const volumes: Volume[] = [
  {
    name: "第一卷",
    path: "/p/writing/v1",
    relPath: "writing/v1",
    chapters: [ch("v1", "01"), ch("v1", "02"), ch("v1", "03")],
  },
  {
    name: "第二卷",
    path: "/p/writing/v2",
    relPath: "writing/v2",
    chapters: [ch("v2", "01"), ch("v2", "02")],
  },
];

const ctxFor = (relPath: string) => {
  const ctx = findChapterContext(volumes, relPath);
  if (!ctx) throw new Error(`no context for ${relPath}`);
  return ctx;
};

describe("resolveBridgeChapter", () => {
  const midVolume = ctxFor("writing/v1/02.md");
  const volumeStart = ctxFor("writing/v2/01.md");

  describe("no answer from the author (automatic)", () => {
    it("bridges with the preceding chapter near this chapter's start", () => {
      expect(resolveBridgeChapter(volumes, midVolume, 0, undefined)?.relPath)
        .toBe("writing/v1/01.md");
    });

    it("stops bridging once the chapter carries its own continuity", () => {
      expect(resolveBridgeChapter(volumes, midVolume, 9999, undefined)).toBeNull();
    });

    it("cannot reach across a volume boundary", () => {
      // v2/01 is the first chapter of its volume, so there is no same-volume
      // predecessor — this is the gap the explicit choice exists to close.
      expect(resolveBridgeChapter(volumes, volumeStart, 0, undefined)).toBeNull();
    });
  });

  describe("the author answered", () => {
    it("honors an explicit chapter", () => {
      expect(resolveBridgeChapter(volumes, midVolume, 0, "/p/writing/v1/01.md")?.relPath)
        .toBe("writing/v1/01.md");
    });

    it("reaches back into an earlier volume", () => {
      expect(resolveBridgeChapter(volumes, volumeStart, 0, "/p/writing/v1/03.md")?.relPath)
        .toBe("writing/v1/03.md");
    });

    it("honors an explicit choice regardless of how deep the anchor sits", () => {
      expect(resolveBridgeChapter(volumes, midVolume, 50_000, "/p/writing/v1/01.md")?.relPath)
        .toBe("writing/v1/01.md");
    });

    it("null means a standalone opening — no bridge, even near the start", () => {
      expect(resolveBridgeChapter(volumes, midVolume, 0, null)).toBeNull();
    });

    it("does not substitute another chapter when the chosen one is gone", () => {
      // Renamed or deleted since the choice was made. Falling back to the
      // automatic pick would bridge with a chapter the author did not choose.
      expect(resolveBridgeChapter(volumes, midVolume, 0, "/p/writing/v1/99.md")).toBeNull();
    });
  });
});
