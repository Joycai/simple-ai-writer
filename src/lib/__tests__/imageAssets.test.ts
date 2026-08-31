/**
 * Where a document's illustrations land, and the markdown that points at them.
 *
 * Both halves are load-bearing in ways that only show up later: a link that
 * isn't relative breaks the moment the project moves machines, and a filename
 * built straight from a chapter title creates directories nobody asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const written: { path: string; bytes: Uint8Array }[] = [];
const dirs: string[] = [];
let existing = new Set<string>();

const renames: { from: string; to: string }[] = [];
const copies: { from: string; to: string }[] = [];
const removed: string[] = [];
const texts = new Map<string, string>();

vi.mock("../fs/fileio", () => ({
  makeDir: vi.fn(async (p: string) => void dirs.push(p)),
  writeBinaryFile: vi.fn(async (path: string, bytes: Uint8Array) => void written.push({ path, bytes })),
  fileExists: vi.fn(async (p: string) => existing.has(p)),
  renamePath: vi.fn(async (from: string, to: string) => {
    renames.push({ from, to });
    existing.delete(from);
    existing.add(to);
  }),
  copyPath: vi.fn(async (from: string, to: string) => {
    copies.push({ from, to });
    existing.add(to);
  }),
  removeDir: vi.fn(async (p: string) => void removed.push(p)),
  readFile: vi.fn(async (p: string) => texts.get(p) ?? ""),
  writeFile: vi.fn(async (p: string, c: string) => void texts.set(p, c)),
  readBinaryFile: vi.fn(async (p: string) => {
    if (!existing.has(p)) throw new Error(`ENOENT: ${p}`);
    return new Uint8Array([7, 7]);
  }),
}));

const {
  saveDocumentAsset, importDocumentAsset, imageMarkdown, assetDirFor, safeAssetName,
  moveDocumentAssets, copyDocumentAssets, discardDocumentAssets, relinkAssetBody, relinkAssetGroup,
} = await import("../image/assets");

beforeEach(() => {
  written.length = 0;
  dirs.length = 0;
  renames.length = 0;
  copies.length = 0;
  removed.length = 0;
  texts.clear();
  existing = new Set();
});

describe("saveDocumentAsset", () => {
  it("files the image beside the document, grouped by document name", async () => {
    const res = await saveDocumentAsset("/proj/writing/vol1/第三章.md", new Uint8Array([1]), "png");
    expect(dirs[0]).toBe("/proj/writing/vol1/assets/第三章");
    expect(res.absPath.startsWith("/proj/writing/vol1/assets/第三章/")).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("returns a path relative to the document, not an absolute one", async () => {
    // An absolute path in the markdown would break the moment the project is
    // opened from another folder or another machine.
    const res = await saveDocumentAsset("/proj/writing/ch1.md", new Uint8Array([1]), "png");
    expect(res.relPath).toMatch(/^assets\/ch1\/img-\d+\.png$/);
    expect(res.relPath.startsWith("/")).toBe(false);
  });

  it("strips characters a filename cannot hold", async () => {
    // "第三章：审判/终局" would otherwise create a nested directory. The `/`
    // really is in the input here — the old test replaced it with " or " and
    // so never exercised the branch it was named after.
    const res = await saveDocumentAsset("/proj/writing/第三章：审判 终局.md", new Uint8Array([1]), "png");
    expect(res.relPath).not.toMatch(/[:*?"<>|]/);
    expect(res.relPath.split("/")).toHaveLength(3); // assets / group / file
    expect(safeAssetName("第三章:审判/终局")).toBe("第三章_审判_终局");
  });

  it("picks another name rather than overwriting an existing file", async () => {
    const first = await saveDocumentAsset("/proj/writing/ch1.md", new Uint8Array([1]), "png");
    existing.add(first.absPath);
    const second = await saveDocumentAsset("/proj/writing/ch1.md", new Uint8Array([2]), "png");
    expect(second.absPath).not.toBe(first.absPath);
  });
});

describe("safeAssetName", () => {
  it("refuses names Windows cannot create", () => {
    // "第一章..md" → stem "第一章." → a directory Windows will not make, and
    // makeDir threw with nothing to catch it.
    expect(safeAssetName("第一章.")).toBe("第一章");
    expect(safeAssetName("trailing ")).toBe("trailing");
    expect(safeAssetName("..")).toBe("doc");
    expect(safeAssetName("..", "image")).toBe("image");
    expect(safeAssetName(".hidden")).toBe("hidden");
  });

  it("keeps two long titles that share a prefix apart", () => {
    // Routine for 公众号 / 标书 documents, which start with the same boilerplate
    // — truncation alone dropped both documents' pictures in one folder.
    const a = "关于进一步加强本年度市场推广工作的通知（第一批）——面向华东地区";
    const b = "关于进一步加强本年度市场推广工作的通知（第二批）——面向华南地区";
    expect(safeAssetName(a)).not.toBe(safeAssetName(b));
    expect(safeAssetName(a).startsWith("关于进一步加强")).toBe(true);
  });
});

describe("moveDocumentAssets", () => {
  it("brings the folder along and rewrites the links", async () => {
    existing.add("/proj/writing/ch1/assets/ch1");
    texts.set("/proj/writing/ch1/序章.md", "前文\n\n![图](assets/ch1/img-1.png)\n\n后文");

    await moveDocumentAssets("/proj/writing/ch1/ch1.md", "/proj/writing/ch1/序章.md");

    expect(renames).toEqual([{
      from: "/proj/writing/ch1/assets/ch1",
      to: "/proj/writing/ch1/assets/序章",
    }]);
    expect(texts.get("/proj/writing/ch1/序章.md")).toContain("assets/%E5%BA%8F%E7%AB%A0/img-1.png");
  });

  it("moves the folder unchanged when only the directory changed", async () => {
    // Same document name in a new folder: the relative links still read
    // `assets/ch1/…`, so nothing in the text needs touching.
    existing.add("/proj/writing/assets/ch1");
    await moveDocumentAssets("/proj/writing/ch1.md", "/proj/writing/vol1/ch1.md");
    expect(renames).toEqual([{
      from: "/proj/writing/assets/ch1",
      to: "/proj/writing/vol1/assets/ch1",
    }]);
  });

  it("leaves both galleries alone rather than merging them", async () => {
    existing.add("/proj/writing/assets/a");
    existing.add("/proj/writing/assets/b");
    await moveDocumentAssets("/proj/writing/a.md", "/proj/writing/b.md");
    expect(renames).toEqual([]);
  });

  it("does nothing when the document has no illustrations", async () => {
    await moveDocumentAssets("/proj/writing/a.md", "/proj/writing/b.md");
    expect(renames).toEqual([]);
  });
});

describe("copyDocumentAssets", () => {
  it("duplicates the folder for a same-folder numbered copy, rewriting the copy's links", async () => {
    // Without this the copy would SHARE the original's assets folder — and
    // deleting the original later would take the copy's pictures with it.
    existing.add("/proj/writing/assets/ch1");
    texts.set("/proj/writing/ch1 (1).md", "![图](assets/ch1/img-1.png)");

    await copyDocumentAssets("/proj/writing/ch1.md", "/proj/writing/ch1 (1).md");

    expect(copies).toEqual([{
      from: "/proj/writing/assets/ch1",
      to: "/proj/writing/assets/ch1 (1)",
    }]);
    expect(renames).toEqual([]); // the original keeps its own folder
    expect(texts.get("/proj/writing/ch1 (1).md")).toContain("img-1.png");
    expect(texts.get("/proj/writing/ch1 (1).md")).not.toContain("assets/ch1/");
  });

  it("duplicates the folder across directories, links untouched when the name survives", async () => {
    // Cross-folder copy under the same name: the relative `assets/ch1/…`
    // links are correct once a folder of that name sits beside the copy.
    existing.add("/proj/writing/assets/ch1");
    texts.set("/proj/backup/ch1.md", "![图](assets/ch1/img-1.png)");

    await copyDocumentAssets("/proj/writing/ch1.md", "/proj/backup/ch1.md");

    expect(copies).toEqual([{
      from: "/proj/writing/assets/ch1",
      to: "/proj/backup/assets/ch1",
    }]);
    expect(texts.get("/proj/backup/ch1.md")).toBe("![图](assets/ch1/img-1.png)");
  });

  it("leaves both galleries alone rather than merging them", async () => {
    existing.add("/proj/writing/assets/a");
    existing.add("/proj/writing/assets/b");
    await copyDocumentAssets("/proj/writing/a.md", "/proj/writing/b.md");
    expect(copies).toEqual([]);
  });

  it("does nothing when the source document has no illustrations", async () => {
    await copyDocumentAssets("/proj/writing/a.md", "/proj/writing/b.md");
    expect(copies).toEqual([]);
  });
});

describe("discardDocumentAssets", () => {
  it("files the pictures beside the backup so a restore is complete", async () => {
    existing.add(assetDirFor("/proj/writing/ch1.md"));
    await discardDocumentAssets("/proj/writing/ch1.md", "/proj/.ai-writer/backups/x-ch1.md");
    expect(renames).toEqual([{
      from: "/proj/writing/assets/ch1",
      to: "/proj/.ai-writer/backups/x-ch1.md.assets",
    }]);
    expect(removed).toEqual([]);
  });

  it("removes them outright when the delete was not backed up", async () => {
    existing.add(assetDirFor("/proj/writing/ch1.md"));
    await discardDocumentAssets("/proj/writing/ch1.md", null);
    expect(removed).toEqual(["/proj/writing/assets/ch1"]);
  });

  it("does nothing for a document that never had any", async () => {
    await discardDocumentAssets("/proj/writing/ch1.md", null);
    expect(removed).toEqual([]);
  });
});

describe("importDocumentAsset", () => {
  const SOURCE = "/Users/me/Pictures/外套参考.png";

  it("copies the file in beside the document, keeping the author's name", async () => {
    // The name is how they will recognise it in the folder, in list_files and
    // in the link — unlike a generated picture, this one already has one.
    existing.add(SOURCE);

    const res = await importDocumentAsset("/proj/writing/vol1/第三章.md", SOURCE);

    expect(dirs[0]).toBe("/proj/writing/vol1/assets/第三章");
    expect(res.absPath).toBe("/proj/writing/vol1/assets/第三章/外套参考.png");
    // Relative to the document, like every other illustration link.
    expect(res.relPath).toBe("assets/第三章/外套参考.png");
    expect(written[0].bytes).toEqual(new Uint8Array([7, 7]));
  });

  it("cleans a name the destination platform would refuse", async () => {
    // A macOS file called `a:b?.png` is unwriteable on Windows, which would
    // make the whole project uncheckoutable there.
    const messy = "/Users/me/Pictures/参考: 外套?.png";
    existing.add(messy);

    const res = await importDocumentAsset("/proj/writing/ch1.md", messy);

    expect(res.absPath).toBe("/proj/writing/assets/ch1/参考_ 外套_.png");
  });

  it("does not overwrite a picture already filed under that name", async () => {
    existing.add(SOURCE);
    existing.add("/proj/writing/assets/ch1/外套参考.png");

    const res = await importDocumentAsset("/proj/writing/ch1.md", SOURCE);

    expect(res.absPath).toBe("/proj/writing/assets/ch1/外套参考-2.png");
  });

  it("lowercases the extension so the link matches what is on disk", async () => {
    const shouty = "/Users/me/Pictures/REF.PNG";
    existing.add(shouty);

    const res = await importDocumentAsset("/proj/writing/ch1.md", shouty);

    expect(res.absPath).toBe("/proj/writing/assets/ch1/REF.png");
  });
});

describe("imageMarkdown", () => {
  it("stands the image on its own paragraph", () => {
    // Glued to the prose it renders inline mid-sentence, which no
    // illustration wants.
    expect(imageMarkdown("assets/ch1/a.png", "a knight")).toBe("\n\n![a knight](assets/ch1/a.png)\n\n");
  });

  it("percent-encodes each path segment but keeps the separators", () => {
    const md = imageMarkdown("assets/第三章/图 1.png", "x");
    expect(md).toContain("assets/");
    expect(md).not.toContain("图 1.png");
    expect(md).toContain("%20");
  });

  it("drops brackets from the alt text so the link cannot be broken", () => {
    expect(imageMarkdown("assets/a.png", "a [knight]")).toContain("![a knight](");
  });
});

describe("relinkAssetBody", () => {
  it("repoints both spellings of the link", () => {
    // `imageMarkdown` percent-encodes each segment; a link typed by hand (or
    // by a model) carries the characters as they are. Missing either spelling
    // leaves links that still render today and break at the next move.
    const body = [
      "![a](assets/%E6%97%A7/p1.png)",
      "![b](assets/旧/p2.png)",
    ].join("\n");
    const out = relinkAssetBody(body, "旧", "新");
    expect(out).toContain("assets/%E6%96%B0/p1.png");
    expect(out).toContain("assets/新/p2.png");
    expect(out).not.toContain("旧");
  });

  it("leaves a group whose name merely starts the same alone", () => {
    const body = "![a](assets/第一章 醒来 旧/p.png)";
    expect(relinkAssetBody(body, "第一章 醒来", "序章")).toBe(body);
  });

  it("is a no-op when the two names already agree", () => {
    const body = "![a](assets/序章/p.png)";
    expect(relinkAssetBody(body, "序章", "序章")).toBe(body);
  });
});

describe("relinkAssetGroup", () => {
  it("renames the folder AND rewrites the document in one go", async () => {
    // 修复前图片其实还是好的——正文指着旧文件夹，旧文件夹还在。所以只改名
    // 不改写，才是真正弄断它们的那一步：两半必须一起发生。
    existing.add("/p/卷一/assets/旧名");
    texts.set("/p/卷一/随笔.md", "![a](assets/旧名/p1.png)");
    await relinkAssetGroup("/p/卷一/assets/旧名", "/p/卷一/随笔.md");
    expect(renames).toEqual([{ from: "/p/卷一/assets/旧名", to: "/p/卷一/assets/随笔" }]);
    expect(texts.get("/p/卷一/随笔.md")).toBe("![a](assets/随笔/p1.png)");
  });

  it("refuses when the document already has a gallery", async () => {
    // 合并两个图库要逐文件处理冲突，还可能覆盖目标文档自己的图。
    existing.add("/p/卷一/assets/旧名");
    existing.add("/p/卷一/assets/随笔");
    await expect(relinkAssetGroup("/p/卷一/assets/旧名", "/p/卷一/随笔.md")).rejects.toThrow();
    expect(renames).toEqual([]);
  });

  it("refuses a folder that is not in the document's own assets/", async () => {
    // 改写出来的相对链接会指到文档目录外面去。
    existing.add("/p/别处/assets/旧名");
    await expect(relinkAssetGroup("/p/别处/assets/旧名", "/p/卷一/随笔.md")).rejects.toThrow();
    await expect(relinkAssetGroup("/p/卷一/旧名", "/p/卷一/随笔.md")).rejects.toThrow();
    expect(renames).toEqual([]);
  });

  it("refuses a target that keeps no illustrations at all", async () => {
    existing.add("/p/卷一/assets/旧名");
    await expect(relinkAssetGroup("/p/卷一/assets/旧名", "/p/卷一/合同.pdf")).rejects.toThrow();
  });
});
