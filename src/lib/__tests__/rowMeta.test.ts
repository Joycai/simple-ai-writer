import { describe, it, expect } from "vitest";
import {
  assetsGroupOrphaned,
  extLabel,
  isSecondary,
  orphanedAssetGroups,
  relinkCandidates,
  rowKind,
} from "../fs/rowMeta";

describe("rowKind", () => {
  it("tells the six kinds apart by name and by where the row sits", () => {
    expect(rowKind("第一卷", true, null)).toBe("folder");
    expect(rowKind("第一章 醒来", true, "assets")).toBe("assets");
    expect(rowKind("第一章.md", false, null)).toBe("doc");
    expect(rowKind("访谈.txt", false, null)).toBe("doc");
    expect(rowKind("提要.html", false, null)).toBe("deliverable");
    expect(rowKind("封面.PNG", false, null)).toBe("image");
    expect(rowKind("合同.pdf", false, null)).toBe("original");
    expect(rowKind("README", false, null)).toBe("original");
  });

  it("makes a folder an assets group by its parent, not by its name", () => {
    // An author may well have an ordinary group called 插图.
    expect(rowKind("插图", true, "素材")).toBe("folder");
    expect(rowKind("插图", true, "assets")).toBe("assets");
  });
});

describe("isSecondary", () => {
  it("puts the props one grey back and leaves what the author writes in front", () => {
    expect(["doc", "deliverable", "folder"].map((k) => isSecondary(k as never))).toEqual([false, false, false]);
    expect(["image", "original", "assets"].map((k) => isSecondary(k as never))).toEqual([true, true, true]);
  });
});

describe("extLabel", () => {
  it("prints the suffix in caps, except the one already hidden from the name", () => {
    expect(extLabel("第一章.md", "doc")).toBeNull();
    expect(extLabel("访谈.txt", "doc")).toBe("TXT");
    expect(extLabel("提要.html", "deliverable")).toBe("HTML");
    expect(extLabel("合同.pdf", "original")).toBe("PDF");
  });

  it("leaves the column to the document count on folders", () => {
    expect(extLabel("第一卷", "folder")).toBeNull();
    expect(extLabel("第一章 醒来", "assets")).toBeNull();
  });
});

describe("assetsGroupOrphaned", () => {
  it("matches a group against its document's stem", () => {
    expect(assetsGroupOrphaned("第一章 醒来", ["第一章 醒来.md", "大纲.md"])).toBe(false);
  });

  it("reports the group whose document was renamed away", () => {
    // The links inside the document point at the folder by name, so this is a
    // silent break — nothing else in the app would ever mention it.
    expect(assetsGroupOrphaned("第一章 醒来 旧", ["第一章 醒来.md"])).toBe(true);
  });

  it("compares against the sanitised name, the way the folder was created", () => {
    expect(assetsGroupOrphaned("第一章_醒来", ["第一章/醒来.md"])).toBe(false);
  });
});

describe("orphanedAssetGroups", () => {
  const tree = [
    { name: "第一卷", path: "/p/卷一", is_dir: true, children: [
      { name: "第一章 醒来.md", path: "/p/卷一/第一章 醒来.md", is_dir: false },
      { name: "assets", path: "/p/卷一/assets", is_dir: true, children: [
        { name: "第一章 醒来", path: "/p/卷一/assets/第一章 醒来", is_dir: true },
        { name: "第一章 醒来 旧", path: "/p/卷一/assets/第一章 醒来 旧", is_dir: true },
      ] },
    ] },
    // 同名的分组，但不在 assets 下面 —— 不该被检查，更不该报错。
    { name: "assets 的笔记", path: "/p/assets 的笔记", is_dir: true, children: [] },
  ];

  it("finds the group whose document is gone, and only that one", () => {
    expect(orphanedAssetGroups(tree)).toEqual(new Set(["/p/卷一/assets/第一章 醒来 旧"]));
  });

  it("checks each group against the documents beside its assets folder", () => {
    const moved = structuredClone(tree);
    moved[0].children![0].name = "序章.md";
    expect(orphanedAssetGroups(moved).size).toBe(2);
  });
});

describe("relinkCandidates", () => {
  const tree = [
    { name: "第一卷", path: "/p/卷一", is_dir: true, children: [
      { name: "第一章 醒来.md", path: "/p/卷一/第一章 醒来.md", is_dir: false },
      { name: "序章.md", path: "/p/卷一/序章.md", is_dir: false },
      { name: "合同.pdf", path: "/p/卷一/合同.pdf", is_dir: false },
      { name: "assets", path: "/p/卷一/assets", is_dir: true, children: [
        { name: "第一章 醒来", path: "/p/卷一/assets/第一章 醒来", is_dir: true },
        { name: "第一章 醒来 旧", path: "/p/卷一/assets/第一章 醒来 旧", is_dir: true },
      ] },
    ] },
  ];

  it("offers only the documents that have no gallery of their own", () => {
    // 第一章 醒来 已经有 assets/第一章 醒来/ —— 关联过去就是合并两个图库，
    // 而那需要逐文件处理冲突。不提供，而不是提供了再拒绝。
    const names = relinkCandidates(tree, "/p/卷一/assets/第一章 醒来 旧").map((n) => n.name);
    expect(names).toEqual(["序章.md"]);
  });

  it("leaves out anything that is not a document", () => {
    // 关联到一份 .pdf 会改掉文件夹名却改写不了任何链接（ownsAssets 只认 .md）。
    const names = relinkCandidates(tree, "/p/卷一/assets/第一章 醒来 旧").map((n) => n.name);
    expect(names).not.toContain("合同.pdf");
  });

  it("answers empty for a folder that is not in any assets/", () => {
    expect(relinkCandidates(tree, "/p/卷一/第一章 醒来.md")).toEqual([]);
    expect(relinkCandidates(tree, "/p/不存在")).toEqual([]);
  });
});
