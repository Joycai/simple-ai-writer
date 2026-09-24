import { describe, it, expect } from "vitest";
import {
  addDoc,
  applyMembers,
  buildPickerTree,
  emptyMembers,
  filterPickerTree,
  folderState,
  folderRelFromInput,
  folderSubtree,
  inferLegacyMembers,
  isDocMember,
  membersEqual,
  parentRel,
  parseMembers,
  pruneMembers,
  removeDoc,
  setFolder,
  setFolders,
  subtreeHasMembers,
  toggleDoc,
  toggleFolder,
  type LibraryMembers,
} from "../library";
import type { Volume } from "../outline";

const PROJ = "/p";

function vol(relPath: string, chapters: string[], resources: string[] = []): Volume {
  const dir = relPath ? `${PROJ}/${relPath}` : PROJ;
  const rel = (name: string) => (relPath ? `${relPath}/${name}` : name);
  return {
    name: relPath ? relPath.split("/").pop()! : "p",
    path: dir,
    relPath,
    chapters: chapters.map((name) => ({ name, path: `${dir}/${name}`, relPath: rel(name) })),
    resources: resources.map((name) => ({ name, path: `${dir}/${name}`, relPath: rel(name) })),
  };
}

const m = (folders: string[] = [], docs: string[] = [], exclude: string[] = []): LibraryMembers => ({
  folders,
  docs,
  exclude,
});

const ALL = [
  vol("", ["readme.md"]),
  vol("卷一", ["a.md", "b.md"], ["map.png"]),
  vol("卷一/番外", ["x.md"]),
  vol("资料", ["c.md", "d.md"], ["pic.png"]),
  vol("空", []),
];

describe("parentRel", () => {
  it("is the folder part, empty for root files", () => {
    expect(parentRel("a.md")).toBe("");
    expect(parentRel("卷一/a.md")).toBe("卷一");
    expect(parentRel("卷一/番外/x.md")).toBe("卷一/番外");
  });
});

describe("parseMembers", () => {
  it("reads arrays of strings, dedupes, drops junk", () => {
    expect(parseMembers({ folders: ["a", "a", 3], docs: "x" })).toEqual(m(["a"], [], []));
  });
  it("is null for a non-object", () => {
    expect(parseMembers(undefined)).toBeNull();
    expect(parseMembers("x")).toBeNull();
  });
});

describe("inferLegacyMembers", () => {
  it("takes the volumes whose order holds chapters", () => {
    const got = inferLegacyMembers({ "": ["readme.md"], 卷一: ["卷一/a.md"], 空: [], 图: [] });
    expect(got).toEqual(m(["", "卷一"]));
  });
  it("is empty for an empty order", () => {
    expect(inferLegacyMembers({})).toEqual(emptyMembers());
  });
});

describe("applyMembers", () => {
  it("shows nothing for an empty library", () => {
    expect(applyMembers(ALL, emptyMembers())).toEqual([]);
  });

  it("keeps a whole folder with its resources, not its subfolders", () => {
    const got = applyMembers(ALL, m(["卷一"]));
    expect(got.map((v) => v.relPath)).toEqual(["卷一"]);
    expect(got[0].chapters.map((c) => c.name)).toEqual(["a.md", "b.md"]);
    expect(got[0].resources.map((r) => r.name)).toEqual(["map.png"]);
    expect(got[0].partial).toBe(false);
  });

  it("drops excluded docs from a whole folder", () => {
    const got = applyMembers(ALL, m(["卷一"], [], ["卷一/a.md"]));
    expect(got[0].chapters.map((c) => c.name)).toEqual(["b.md"]);
  });

  it("shows picked docs alone, without resources, as partial", () => {
    const got = applyMembers(ALL, m([], ["资料/d.md"]));
    expect(got).toHaveLength(1);
    expect(got[0].relPath).toBe("资料");
    expect(got[0].chapters.map((c) => c.name)).toEqual(["d.md"]);
    expect(got[0].resources).toEqual([]);
    expect(got[0].partial).toBe(true);
  });

  it("handles the root and an empty folder", () => {
    const got = applyMembers(ALL, m(["", "空"]));
    expect(got.map((v) => v.relPath)).toEqual(["", "空"]);
  });

  it("ignores members that point at nothing", () => {
    expect(applyMembers(ALL, m(["gone"], ["gone/a.md", "资料/zz.md"]))).toEqual([]);
  });
});

describe("folderState / isDocMember", () => {
  const v1 = ALL[1];
  it("all / some / none", () => {
    expect(folderState(m(["卷一"]), v1)).toBe("all");
    expect(folderState(m(["卷一"], [], ["卷一/a.md"]), v1)).toBe("some");
    expect(folderState(m([], ["卷一/b.md"]), v1)).toBe("some");
    expect(folderState(m(), v1)).toBe("none");
  });
  it("docs follow their folder unless excluded", () => {
    expect(isDocMember(m(["卷一"]), "卷一/a.md")).toBe(true);
    expect(isDocMember(m(["卷一"], [], ["卷一/a.md"]), "卷一/a.md")).toBe(false);
    expect(isDocMember(m([], ["资料/c.md"]), "资料/c.md")).toBe(true);
    expect(isDocMember(m(), "资料/c.md")).toBe(false);
  });
});

describe("toggleFolder", () => {
  const v1 = ALL[1];
  it("none → all", () => {
    expect(toggleFolder(m(), v1)).toEqual(m(["卷一"]));
  });
  it("some (picked docs) → all, the picks folded in", () => {
    expect(toggleFolder(m([], ["卷一/a.md", "资料/c.md"]), v1)).toEqual(m(["卷一"], ["资料/c.md"]));
  });
  it("some (exclusions) → all, exclusions cleared", () => {
    expect(toggleFolder(m(["卷一"], [], ["卷一/a.md"]), v1)).toEqual(m(["卷一"]));
  });
  it("all → none", () => {
    expect(toggleFolder(m(["卷一", "资料"]), v1)).toEqual(m(["资料"]));
  });
  it("does not touch a subfolder's entries", () => {
    expect(toggleFolder(m([], ["卷一/番外/x.md"]), v1)).toEqual(m(["卷一"], ["卷一/番外/x.md"]));
  });
});

describe("setFolder", () => {
  it("removing a folder takes its exclusions with it", () => {
    expect(setFolder(m(["卷一"], [], ["卷一/a.md"]), "卷一", false)).toEqual(m());
  });
  it("adding is idempotent", () => {
    expect(setFolder(m(["卷一"]), "卷一", true)).toEqual(m(["卷一"]));
  });
});

describe("toggleDoc / addDoc / removeDoc", () => {
  it("inside a whole folder it excludes and un-excludes", () => {
    const out = toggleDoc(m(["卷一"]), "卷一/a.md");
    expect(out).toEqual(m(["卷一"], [], ["卷一/a.md"]));
    expect(toggleDoc(out, "卷一/a.md")).toEqual(m(["卷一"]));
  });
  it("elsewhere it picks and unpicks", () => {
    const out = toggleDoc(m(), "资料/c.md");
    expect(out).toEqual(m([], ["资料/c.md"]));
    expect(toggleDoc(out, "资料/c.md")).toEqual(m());
  });
  it("add / remove are idempotent", () => {
    expect(addDoc(m([], ["资料/c.md"]), "资料/c.md")).toEqual(m([], ["资料/c.md"]));
    expect(removeDoc(m(["卷一"], [], ["卷一/a.md"]), "卷一/a.md")).toEqual(m(["卷一"], [], ["卷一/a.md"]));
  });
});

describe("pruneMembers", () => {
  it("drops missing paths and contradictions", () => {
    const got = pruneMembers(
      m(["卷一", "gone"], ["卷一/a.md", "资料/c.md", "资料/gone.md"], ["卷一/b.md", "资料/d.md"]),
      ALL,
    );
    expect(got).toEqual(m(["卷一"], ["资料/c.md"], ["卷一/b.md"]));
  });
});

describe("membersEqual", () => {
  it("ignores order", () => {
    expect(membersEqual(m(["a", "b"]), m(["b", "a"]))).toBe(true);
    expect(membersEqual(m(["a"]), m(["a"], ["x"]))).toBe(false);
  });
});

describe("picker tree", () => {
  const tree = buildPickerTree(ALL);

  it("puts the root row first and nests subfolders", () => {
    expect(tree[0].vol.relPath).toBe("");
    expect(tree.map((n) => n.vol.relPath).sort()).toEqual(["", "卷一", "空", "资料"].sort());
    const v1 = tree.find((n) => n.vol.relPath === "卷一")!;
    expect(v1.children.map((c) => c.vol.relPath)).toEqual(["卷一/番外"]);
    expect(v1.docs.map((d) => d.name)).toEqual(["a.md", "b.md"]);
  });

  it("natural-sorts docs", () => {
    const [n] = buildPickerTree([vol("卷", ["第10章.md", "第2章.md"])]);
    expect(n.docs.map((d) => d.name)).toEqual(["第2章.md", "第10章.md"]);
  });

  it("filters by doc name and keeps the path to it", () => {
    const got = filterPickerTree(tree, "X.MD");
    expect(got.map((n) => n.vol.relPath)).toEqual(["卷一"]);
    expect(got[0].docs).toEqual([]);
    expect(got[0].children[0].docs.map((d) => d.name)).toEqual(["x.md"]);
  });

  it("a folder-name hit keeps the whole folder", () => {
    const got = filterPickerTree(tree, "资料");
    expect(got).toHaveLength(1);
    expect(got[0].docs).toHaveLength(2);
  });

  it("an empty query is the identity", () => {
    expect(filterPickerTree(tree, "  ")).toBe(tree);
  });

  it("folderSubtree / setFolders take the whole branch", () => {
    const v1 = tree.find((n) => n.vol.relPath === "卷一")!;
    expect(folderSubtree(v1)).toEqual(["卷一", "卷一/番外"]);
    expect(setFolders(m(), folderSubtree(v1), true)).toEqual(m(["卷一", "卷一/番外"]));
  });

  it("subtreeHasMembers sees a member below", () => {
    const v1 = tree.find((n) => n.vol.relPath === "卷一")!;
    expect(subtreeHasMembers(m(["卷一/番外"]), v1)).toBe(true);
    expect(subtreeHasMembers(m(["资料"]), v1)).toBe(false);
  });
});

describe("folderRelFromInput", () => {
  it("trims separators and whitespace, keeps nesting", () => {
    expect(folderRelFromInput(" 卷三/ ", "assets")).toBe("卷三");
    expect(folderRelFromInput("/卷三", "assets")).toBe("卷三");
    expect(folderRelFromInput("正文//卷三\\", "assets")).toBe("正文/卷三");
  });
  it("refuses empty, reserved and hidden names", () => {
    expect(folderRelFromInput(" / ", "assets")).toBeNull();
    expect(folderRelFromInput("assets", "assets")).toBeNull();
    expect(folderRelFromInput("正文/.draft", "assets")).toBeNull();
  });
});
