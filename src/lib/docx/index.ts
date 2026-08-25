/**
 * markdown 文档 → .docx 的编排层：读盘、取图、调转换、写盘、汇报降级。
 *
 * 转换本身**不经过任何模型**（01-agent-design I1）——模型写的是 markdown，
 * 版面全部来自 `DocFormat`。这一层只是把三样东西凑齐：源文、格式、插图。
 */

import { readBinaryFile, readFile, writeBinaryFile } from "../fs/fileio";
import { parseFrontmatter } from "../fs/markdown";
import { readImageHeader } from "../image/imageSize";
import { dirName, resolveLinkPath } from "../paths";
import { markdownToBlocks } from "./blocks";
import { blocksToDocx, type ResolvedImage } from "./write";
import type { DocFormat } from "./format";

export * from "./blocks";
export * from "./flag";
export * from "./format";
export * from "./resolve";

export interface DocxExportResult {
  path: string;
  /** 写出去的块数——一个「导出成功」之外能拿来核对的数字。 */
  blocks: number;
  /** 没有原样带过去的东西。空数组表示干净。 */
  degraded: string[];
}

/** "周报.md" → "周报.docx"。默认目的地，不是固定的。 */
export function docxPathFor(mdPath: string): string {
  return mdPath.replace(/\.(md|markdown|txt)$/i, "") + ".docx";
}

const IMAGE_TYPES: Record<string, ResolvedImage["type"]> = {
  png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", bmp: "bmp",
};

export async function exportMarkdownToDocx(
  mdPath: string,
  format: DocFormat,
  outPath: string = docxPathFor(mdPath),
): Promise<DocxExportResult> {
  const raw = await readFile(mdPath);
  // frontmatter 是这个 app 的元数据，不是正文——原样印进 Word 里是一堆 `---`。
  const { content } = parseFrontmatter(raw);
  const { blocks, degraded } = markdownToBlocks(content);

  const baseDir = dirName(mdPath);
  const { images, notes } = await loadImages(blocks, baseDir);

  const bytes = await blocksToDocx(blocks, format, images);
  await writeBinaryFile(outPath, bytes);

  return { path: outPath, blocks: blocks.length, degraded: [...degraded, ...notes] };
}

async function loadImages(
  blocks: ReturnType<typeof markdownToBlocks>["blocks"],
  baseDir: string,
): Promise<{ images: Map<string, ResolvedImage>; notes: string[] }> {
  const images = new Map<string, ResolvedImage>();
  const notes: string[] = [];
  const srcs = [...new Set(blocks.flatMap((b) => (b.kind === "image" ? [b.src] : [])))];

  for (const src of srcs) {
    // 远程图不下载：导出是本地的确定性操作，不该在这里发网络请求，也不该因为
    // 一个 404 让整份文稿导不出来。
    if (/^(https?:|data:|blob:)/i.test(src)) {
      notes.push(`远程图片没有嵌入，落成了替代文字：${src}`);
      continue;
    }
    const ext = src.split(".").pop()?.toLowerCase() ?? "";
    const type = IMAGE_TYPES[ext];
    if (!type) {
      // webp / svg：Word 对它们的支持随版本变，嵌进去可能在对方机器上是个红叉。
      notes.push(`Word 不收 .${ext || "?"} 图片，落成了替代文字：${src}`);
      continue;
    }
    try {
      const data = await readBinaryFile(resolveLinkPath(baseDir, src));
      const header = readImageHeader(data);
      if (!header) {
        notes.push(`读不出尺寸，图片没有嵌入：${src}`);
        continue;
      }
      images.set(src, { data, type, widthPx: header.width, heightPx: header.height });
    } catch {
      // 缺一张图不该沉掉整份导出——它落成替代文字，作者看得见那个洞在哪。
      notes.push(`文件读不到，图片没有嵌入：${src}`);
    }
  }
  return { images, notes };
}
