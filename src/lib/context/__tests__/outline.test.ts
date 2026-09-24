import { describe, it, expect } from "vitest";
import {
  isChapterFile,
  normalizeChapterFileName,
  naturalCompare,
  groupVolumes,
  applySpine,
  spineFromVolumes,
  renameVolumeInSpine,
  rewritePathInSpine,
  libraryVolumes,
  findChapterContext,
  chapterTitle,
  parentDir,
  type BookSpine,
} from "../outline";
import type { FileNode } from "../../project";

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

  it("keeps the folder note off the spine", () => {
    // index.md describes the volume; it is not chapter zero of it.
    expect(isChapterFile("index.md")).toBe(false);
    expect(isChapterFile("Index.md")).toBe(false);
    expect(isChapterFile("index.txt")).toBe(true);
  });
});

describe("normalizeChapterFileName", () => {
  it("appends .md to a bare name so it stays a recognised chapter", () => {
    expect(normalizeChapterFileName("第1章")).toBe("第1章.md");
    expect(isChapterFile(normalizeChapterFileName("第1章"))).toBe(true);
  });

  it("leaves an explicit extension alone", () => {
    expect(normalizeChapterFileName("第1章.txt")).toBe("第1章.txt");
    expect(normalizeChapterFileName("notes.json")).toBe("notes.json");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeChapterFileName("  第1章  ")).toBe("第1章.md");
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
    // Non-chapter files surface as the volume's resources, not chapters.
    expect(vols[0].resources.map((r) => r.name)).toEqual(["cover.png"]);
    expect(vols[0].resources[0].relPath).toBe("writing/cover.png");
  });

  it("natural-sorts resources and keeps them out of the spine's chapter set", () => {
    const vols = groupVolumes(tree(["ch1.md", "img10.png", "img2.png", "notes.pdf"]), PROJ);
    expect(vols[0].chapters.map((c) => c.name)).toEqual(["ch1.md"]);
    expect(vols[0].resources.map((r) => r.name)).toEqual(["img2.png", "img10.png", "notes.pdf"]);
  });

  it("shows a folder holding only resources as a volume (root included)", () => {
    const roots: FileNode[] = [
      { name: "ref.png", path: `${PROJ}/ref.png`, is_dir: false },
      {
        name: "素材", path: `${PROJ}/素材`, is_dir: true,
        children: [{ name: "map.jpg", path: `${PROJ}/素材/map.jpg`, is_dir: false }],
      },
    ];
    const vols = groupVolumes(roots, PROJ);
    expect(vols.map((v) => v.relPath)).toEqual(["", "素材"]);
    expect(vols[0].chapters).toEqual([]);
    expect(vols[0].resources.map((r) => r.name)).toEqual(["ref.png"]);
    expect(vols[1].resources.map((r) => r.relPath)).toEqual(["素材/map.jpg"]);
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

  it("groups workspace-root chapter files as a default volume keyed \"\"", () => {
    const roots: FileNode[] = [
      { name: "序章.md", path: `${PROJ}/序章.md`, is_dir: false },
      { name: "cover.png", path: `${PROJ}/cover.png`, is_dir: false },
      {
        name: "卷一", path: `${PROJ}/卷一`, is_dir: true,
        children: [{ name: "第1章.md", path: `${PROJ}/卷一/第1章.md`, is_dir: false }],
      },
    ];
    const vols = groupVolumes(roots, PROJ);
    expect(vols.map((v) => v.relPath)).toEqual(["", "卷一"]);
    // The root volume is named after the project folder, and its key "" can
    // never collide with a real directory's relPath.
    expect(vols[0].name).toBe("proj");
    expect(vols[0].chapters.map((c) => c.relPath)).toEqual(["序章.md"]);
    expect(vols[1].chapters[0].relPath).toBe("卷一/第1章.md");
  });

  it("recurses into nested folders so deep chapters are not lost", () => {
    const roots: FileNode[] = [
      {
        name: "写作", path: `${PROJ}/写作`, is_dir: true,
        children: [
          {
            name: "第一部", path: `${PROJ}/写作/第一部`, is_dir: true,
            children: [{ name: "a.md", path: `${PROJ}/写作/第一部/a.md`, is_dir: false }],
          },
        ],
      },
    ];
    const vols = groupVolumes(roots, PROJ);
    expect(vols.map((v) => v.relPath)).toEqual(["写作", "写作/第一部"]);
    expect(vols[1].chapters[0].relPath).toBe("写作/第一部/a.md");
  });

  it("skips assets/ folders — illustrations are not a volume", () => {
    const roots: FileNode[] = [
      { name: "第1章.md", path: `${PROJ}/第1章.md`, is_dir: false },
      {
        name: "assets", path: `${PROJ}/assets`, is_dir: true,
        children: [
          {
            name: "第1章", path: `${PROJ}/assets/第1章`, is_dir: true,
            children: [{ name: "img.png", path: `${PROJ}/assets/第1章/img.png`, is_dir: false }],
          },
        ],
      },
    ];
    const vols = groupVolumes(roots, PROJ);
    expect(vols.map((v) => v.relPath)).toEqual([""]);
  });

  it("keeps an old writing/-layout project's spine keys intact", () => {
    // The zero-migration guarantee: writing/ is just a folder now, and the
    // recursive grouping must produce the exact relPaths an old outline.json
    // recorded ("writing", "writing/卷二", "writing/卷二/第3章.md").
    const sub: FileNode = {
      name: "卷二", path: `${PROJ}/writing/卷二`, is_dir: true,
      children: [{ name: "第3章.md", path: `${PROJ}/writing/卷二/第3章.md`, is_dir: false }],
    };
    const vols = groupVolumes(tree(["第1章.md"], [sub]), PROJ);
    expect(vols.map((v) => v.relPath)).toEqual(["writing", "writing/卷二"]);

    const spine: BookSpine = { version: 1, order: { "writing/卷二": ["writing/卷二/第3章.md"] } };
    const out = applySpine(vols, spine);
    expect(out[1].chapters.map((c) => c.relPath)).toEqual(["writing/卷二/第3章.md"]);
  });
});

describe("parentDir", () => {
  it("returns the directory of a path with either separator, spelled POSIX", () => {
    expect(parentDir("D:/proj/writing/a.md")).toBe("D:/proj/writing");
    expect(parentDir("D:\\proj\\writing\\a.md")).toBe("D:/proj/writing");
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

  it("orders the volume list by spine.volumes with overlay semantics", () => {
    const sub = (n: string): FileNode => ({
      name: n, path: `${PROJ}/writing/${n}`, is_dir: true,
      children: [{ name: "a.md", path: `${PROJ}/writing/${n}/a.md`, is_dir: false }],
    });
    const grouped = groupVolumes(tree(["1.md"], [sub("v1"), sub("v2"), sub("v3")]), PROJ);
    const spine: BookSpine = {
      version: 1,
      order: {},
      // v2 first, gone volume dropped, unlisted (writing, v1, v3) appended in
      // traversal order.
      volumes: ["writing/v2", "writing/gone"],
    };
    const out = applySpine(grouped, spine);
    expect(out.map((v) => v.relPath)).toEqual(["writing/v2", "writing", "writing/v1", "writing/v3"]);
  });
});

describe("spineFromVolumes", () => {
  it("captures each volume's current order by relPath", () => {
    const vols = applySpine(groupVolumes(tree(["a.md", "b.md"]), PROJ), null);
    const spine = spineFromVolumes(vols);
    expect(spine.order.writing).toEqual(["writing/a.md", "writing/b.md"]);
    expect(spine.volumes).toEqual(["writing"]);
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

describe("renameVolumeInSpine", () => {
  const spine: BookSpine = {
    version: 1,
    order: {
      "写作": ["写作/序.md"],
      "写作/第一部": ["写作/第一部/1.md", "写作/第一部/2.md"],
      "写作/第一部分册": ["写作/第一部分册/x.md"],
    },
    status: { "写作/第一部/1.md": "writing" },
    volumes: ["写作/第一部", "写作", "写作/第一部分册"],
  };

  it("rewrites the volume key, its chapters, status and volume order", () => {
    const out = renameVolumeInSpine(spine, "写作/第一部", "写作/首部");
    expect(out.order["写作/首部"]).toEqual(["写作/首部/1.md", "写作/首部/2.md"]);
    expect(out.order["写作/第一部"]).toBeUndefined();
    expect(out.status).toEqual({ "写作/首部/1.md": "writing" });
    expect(out.volumes).toEqual(["写作/首部", "写作", "写作/第一部分册"]);
  });

  it("rewrites nested volumes under a renamed parent, but not lookalike prefixes", () => {
    const out = renameVolumeInSpine(spine, "写作", "手稿");
    expect(Object.keys(out.order).sort()).toEqual(["手稿", "手稿/第一部", "手稿/第一部分册"].sort());
    expect(out.order["手稿/第一部"]).toEqual(["手稿/第一部/1.md", "手稿/第一部/2.md"]);
    // "写作/第一部分册" starts with "写作/第一部" as a *string* but is a sibling
    // volume — prefix rewriting must be path-segment aware.
    const sib = renameVolumeInSpine(spine, "写作/第一部", "写作/首部");
    expect(sib.order["写作/第一部分册"]).toEqual(["写作/第一部分册/x.md"]);
  });

  it("returns the spine untouched for the root or a no-op rename", () => {
    expect(renameVolumeInSpine(spine, "", "x")).toBe(spine);
    expect(renameVolumeInSpine(spine, "写作", "写作")).toBe(spine);
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

describe("rewritePathInSpine", () => {
  const base: BookSpine = {
    version: 1,
    order: { 卷一: ["卷一/a.md", "卷一/b.md"], 卷一续: ["卷一续/c.md"], "卷一/番外": ["卷一/番外/x.md"] },
    volumes: ["卷一", "卷一/番外", "卷一续"],
    status: { "卷一/a.md": "writing", "卷一续/c.md": "writing" },
    members: { folders: ["卷一", "卷一续"], docs: ["卷一/番外/x.md"], exclude: ["卷一/b.md"] },
  };

  it("renames a file everywhere it appears", () => {
    const got = rewritePathInSpine(base, "卷一/a.md", "卷一/甲.md");
    expect(got.order["卷一"]).toEqual(["卷一/甲.md", "卷一/b.md"]);
    expect(got.status).toEqual({ "卷一/甲.md": "writing", "卷一续/c.md": "writing" });
  });

  it("moves a folder with its nested volumes and members, sparing same-prefix siblings", () => {
    const got = rewritePathInSpine(base, "卷一", "第一卷");
    expect(Object.keys(got.order).sort()).toEqual(["卷一续", "第一卷", "第一卷/番外"].sort());
    expect(got.volumes).toEqual(["第一卷", "第一卷/番外", "卷一续"]);
    expect(got.members).toEqual({
      folders: ["第一卷", "卷一续"],
      docs: ["第一卷/番外/x.md"],
      exclude: ["第一卷/b.md"],
    });
    expect(got.status?.["卷一续/c.md"]).toBe("writing");
  });

  it("a picked doc moved elsewhere keeps its pick", () => {
    const got = rewritePathInSpine(base, "卷一/番外/x.md", "资料/x.md");
    expect(got.members?.docs).toEqual(["资料/x.md"]);
  });

  it("leaves a spine without members without members", () => {
    const { members: _drop, ...legacy } = base;
    void _drop;
    expect(rewritePathInSpine(legacy, "卷一", "甲").members).toBeUndefined();
  });

  it("renameVolumeInSpine carries the members", () => {
    expect(renameVolumeInSpine(base, "卷一续", "乙").members?.folders).toEqual(["卷一", "乙"]);
  });
});

describe("libraryVolumes", () => {
  const t: FileNode[] = [
    { name: "r.md", path: `${PROJ}/r.md`, is_dir: false },
    {
      name: "卷一",
      path: `${PROJ}/卷一`,
      is_dir: true,
      children: [
        { name: "b.md", path: `${PROJ}/卷一/b.md`, is_dir: false },
        { name: "a.md", path: `${PROJ}/卷一/a.md`, is_dir: false },
      ],
    },
    { name: "杂", path: `${PROJ}/杂`, is_dir: true, children: [] },
  ];

  it("no spine means an empty library", () => {
    expect(libraryVolumes(groupVolumes(t, PROJ), null)).toEqual([]);
  });

  it("filters to members, then applies the order", () => {
    const spine: BookSpine = {
      version: 1,
      order: { 卷一: ["卷一/b.md", "卷一/a.md"] },
      members: { folders: ["卷一"], docs: [], exclude: [] },
    };
    const got = libraryVolumes(groupVolumes(t, PROJ), spine);
    expect(got.map((v) => v.relPath)).toEqual(["卷一"]);
    expect(got[0].chapters.map((c) => c.name)).toEqual(["b.md", "a.md"]);
  });

  it("findChapterContext misses a doc outside the library", () => {
    const spine: BookSpine = { version: 1, order: {}, members: { folders: ["卷一"], docs: [], exclude: [] } };
    expect(findChapterContext(libraryVolumes(groupVolumes(t, PROJ), spine), "r.md")).toBeNull();
  });
});

describe("spineFromVolumes members", () => {
  it("starts empty with no previous spine and carries previous members", () => {
    expect(spineFromVolumes([], null).members).toEqual({ folders: [], docs: [], exclude: [] });
    const prev: BookSpine = { version: 1, order: {}, members: { folders: ["a"], docs: [], exclude: [] } };
    const next = spineFromVolumes([], prev);
    expect(next.members).toEqual(prev.members);
    expect(next.members).not.toBe(prev.members);
  });
});
