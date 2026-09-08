import { describe, it, expect } from "vitest";
import {
  assetsGroupOrphaned,
  extLabel,
  isSecondary,
  orphanedAssetGroups,
  pictureFolders,
  relinkCandidates,
  resolveRowKind,
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

describe("pictureFolders", () => {
  const dir = (name: string, children: unknown[] = []) =>
    ({ name, path: `/p/${name}`, is_dir: true, children }) as never;
  const file = (name: string) => ({ name, path: `/p/x/${name}`, is_dir: false }) as never;

  it("lets the content decide, not the name", () => {
    // 叫 images 却装着章节 —— 错标比漏标更糟：作者会以为那里面没有正文。
    expect(pictureFolders([dir("images", [file("第一章.md")])])).toEqual(new Set());
    // 叫「素材」不在任何名单的直觉里，但里面全是图。
    expect(pictureFolders([dir("素材", [file("封面.png"), file("插页.JPG")])]))
      .toEqual(new Set(["/p/素材"]));
  });

  it("only lets the name speak when there is no file to judge by", () => {
    expect(pictureFolders([dir("img")])).toEqual(new Set(["/p/img"]));
    expect(pictureFolders([dir("IMAGES")])).toEqual(new Set(["/p/IMAGES"]));
    expect(pictureFolders([dir("第三卷")])).toEqual(new Set());
  });

  it("drops the whole folder back on one stray non-image", () => {
    // 「全是图片」而不是「大部分是图片」：后者要数数，而这个模块不数数。
    // 宁可漏标不可错标，所以这条是断言，不是将来可以顺手放宽的默认值。
    expect(pictureFolders([dir("截图", [file("界面.png"), file("合同.pdf")])])).toEqual(new Set());
  });

  it("reads through nesting, and marks each level that qualifies", () => {
    const tree = [dir("插画", [
      { name: "第一章", path: "/p/插画/第一章", is_dir: true, children: [file("图一.png")] },
      { name: "第二章", path: "/p/插画/第二章", is_dir: true, children: [file("图二.webp")] },
    ])];
    expect(pictureFolders(tree)).toEqual(
      new Set(["/p/插画", "/p/插画/第一章", "/p/插画/第二章"]),
    );
  });

  it("never takes an assets group, however full of pictures it is", () => {
    // 抢走它就等于抢走失配提示与「重新关联到…」—— 那两样是这一种行的全部意义。
    const tree = [{
      name: "assets", path: "/p/assets", is_dir: true,
      children: [{ name: "第一章", path: "/p/assets/第一章", is_dir: true, children: [file("图.png")] }],
    }];
    expect(pictureFolders(tree as never)).toEqual(new Set());
  });
});

describe("resolveRowKind", () => {
  const pictures = new Set(["/p/截图"]);

  it("joins the subtree's answer onto the name's", () => {
    const folder = { name: "截图", path: "/p/截图", is_dir: true };
    expect(rowKind(folder.name, true, null)).toBe("folder");
    expect(resolveRowKind(folder, null, pictures)).toBe("pictures");
  });

  it("never overrides a kind that carries behaviour", () => {
    // 一个 assets 组即便进了那张表也还是 assets：它背后挂着修复动作。
    const group = { name: "截图", path: "/p/截图", is_dir: true };
    expect(resolveRowKind(group, "assets", pictures)).toBe("assets");
    const doc = { name: "截图", path: "/p/截图", is_dir: false };
    expect(resolveRowKind(doc, null, pictures)).toBe("original");
  });
});

describe("the picture folder row keeps out of the other columns", () => {
  it("stays one grey back and leaves the right column to its own word", () => {
    expect(isSecondary("pictures")).toBe(true);
    // 目录名里带点的情况下，后缀标签绝不能冒出来抢掉「图片」。
    expect(extLabel("2024.05", "pictures")).toBeNull();
  });
});
