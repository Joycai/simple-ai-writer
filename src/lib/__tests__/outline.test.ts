import { describe, it, expect } from "vitest";
import {
  isChapterFile,
  naturalCompare,
  groupVolumes,
  applySpine,
  spineFromVolumes,
  findChapterContext,
  chapterTitle,
  parentDir,
  type BookSpine,
} from "../context/outline";
import type { FileNode } from "../project";

const PROJ = "D:/proj";

function file(name: string): FileNode {
  return { name, path: `${PROJ}/writing/${name}`, is_dir: false };
}
function tree(names: string[], extra: FileNode[] = []): FileNode[] {
  return [
    {
      name: "writing",
      path: `${PROJ}/writing`,
      is_dir: true,
      children: [...names.map(file), ...extra],
    },
  ];
}

describe("isChapterFile", () => {
  it("accepts md / markdown / txt, rejects others", () => {
    expect(isChapterFile("a.md")).toBe(true);
    expect(isChapterFile("a.markdown")).toBe(true);
    expect(isChapterFile("a.txt")).toBe(true);
    expect(isChapterFile("a.png")).toBe(false);
    expect(isChapterFile("a")).toBe(false);
  });
});

describe("naturalCompare", () => {
  it("orders numbers numerically, not lexically", () => {
    const arr = ["ch10.md", "ch2.md", "ch1.md"];
    expect([...arr].sort(naturalCompare)).toEqual(["ch1.md", "ch2.md", "ch10.md"]);
  });
  it("orders sub-numbered chapters correctly", () => {
    const arr = ["h7.md", "h6-2.md", "h6-1.md"];
    expect([...arr].sort(naturalCompare)).toEqual(["h6-1.md", "h6-2.md", "h7.md"]);
  });
});

describe("groupVolumes", () => {
  it("collects top-level chapter files (md + txt) as one default volume", () => {
    const vols = groupVolumes(tree(["1.txt", "2.md", "cover.png"]), PROJ);
    expect(vols).toHaveLength(1);
    expect(vols[0].name).toBe("writing");
    expect(vols[0].relPath).toBe("writing");
    expect(vols[0].chapters.map((c) => c.name)).toEqual(["1.txt", "2.md"]);
    expect(vols[0].chapters[0].relPath).toBe("writing/1.txt");
  });

  it("makes each sub-folder its own volume", () => {
    const subVol: FileNode = {
      name: "vol2",
      path: `${PROJ}/writing/vol2`,
      is_dir: true,
      children: [
        { name: "a.md", path: `${PROJ}/writing/vol2/a.md`, is_dir: false },
      ],
    };
    const vols = groupVolumes(tree(["1.md"], [subVol]), PROJ);
    expect(vols.map((v) => v.name)).toEqual(["writing", "vol2"]);
    expect(vols[1].relPath).toBe("writing/vol2");
    expect(vols[1].chapters[0].relPath).toBe("writing/vol2/a.md");
  });

  it("includes empty sub-folders as volumes (so new volumes are usable)", () => {
    const emptyVol: FileNode = {
      name: "vol2",
      path: `${PROJ}/writing/vol2`,
      is_dir: true,
      children: [],
    };
    const vols = groupVolumes(tree(["1.md"], [emptyVol]), PROJ);
    expect(vols.map((v) => v.name)).toEqual(["writing", "vol2"]);
    expect(vols[1].chapters).toEqual([]);
  });
});

describe("parentDir", () => {
  it("returns the directory of a path with either separator", () => {
    expect(parentDir("D:/proj/writing/a.md")).toBe("D:/proj/writing");
    expect(parentDir("D:\\proj\\writing\\a.md")).toBe("D:\\proj\\writing");
  });
});

describe("applySpine", () => {
  const vols = groupVolumes(tree(["ch1.md", "ch2.md", "ch10.md"]), PROJ);

  it("natural-sorts when no spine is present", () => {
    const out = applySpine(vols, null);
    expect(out[0].chapters.map((c) => c.name)).toEqual(["ch1.md", "ch2.md", "ch10.md"]);
  });

  it("honours the manifest order, appending un-listed files by natural sort", () => {
    const spine: BookSpine = {
      version: 1,
      order: { writing: ["writing/ch10.md", "writing/ch2.md"] },
    };
    const out = applySpine(vols, spine);
    // ch10, ch2 first (manifest), then ch1 appended naturally.
    expect(out[0].chapters.map((c) => c.name)).toEqual(["ch10.md", "ch2.md", "ch1.md"]);
  });

  it("drops manifest entries whose file no longer exists", () => {
    const spine: BookSpine = {
      version: 1,
      order: { writing: ["writing/gone.md", "writing/ch2.md"] },
    };
    const out = applySpine(vols, spine);
    expect(out[0].chapters.map((c) => c.name)).toEqual(["ch2.md", "ch1.md", "ch10.md"]);
  });
});

describe("spineFromVolumes", () => {
  it("captures each volume's current order by relPath", () => {
    const vols = applySpine(groupVolumes(tree(["a.md", "b.md"]), PROJ), null);
    const spine = spineFromVolumes(vols);
    expect(spine.order.writing).toEqual(["writing/a.md", "writing/b.md"]);
    expect(spine.status).toBeUndefined();
  });

  it("carries over the previous chapter status map", () => {
    const vols = applySpine(groupVolumes(tree(["a.md", "b.md"]), PROJ), null);
    const prev: BookSpine = {
      version: 1,
      order: {},
      status: { "writing/a.md": "writing" },
    };
    const spine = spineFromVolumes(vols, prev);
    expect(spine.status).toEqual({ "writing/a.md": "writing" });
    // Must be a copy, not the same reference.
    expect(spine.status).not.toBe(prev.status);
  });
});

describe("findChapterContext", () => {
  const vols = applySpine(groupVolumes(tree(["ch1.md", "ch2.md", "ch3.md"]), PROJ), null);

  it("locates prior chapters and the immediate previous one", () => {
    const ctx = findChapterContext(vols, "writing/ch3.md");
    expect(ctx?.index).toBe(2);
    expect(ctx?.prev?.relPath).toBe("writing/ch2.md");
    expect(ctx?.prior.map((c) => c.name)).toEqual(["ch1.md", "ch2.md"]);
  });

  it("reports no previous chapter for the first one", () => {
    const ctx = findChapterContext(vols, "writing/ch1.md");
    expect(ctx?.index).toBe(0);
    expect(ctx?.prev).toBeNull();
    expect(ctx?.prior).toEqual([]);
  });

  it("returns null for an unknown chapter", () => {
    expect(findChapterContext(vols, "writing/nope.md")).toBeNull();
  });
});

describe("chapterTitle", () => {
  it("strips the chapter extension", () => {
    expect(chapterTitle({ name: "第1章.md", path: "", relPath: "" })).toBe("第1章");
    expect(chapterTitle({ name: "a.txt", path: "", relPath: "" })).toBe("a");
  });
});
