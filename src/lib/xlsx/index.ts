/**
 * markdown 文档 → .xlsx 的编排层。
 *
 * 转换**不经过任何模型**：模型写的是 markdown 表格——这个 app 的原生格式，作者
 * 在预览里读得到、改得动——每个格子是数字还是文本由 `cells.ts` 的确定性规则
 * 判定。同 docx 的 I1。
 *
 * 一处和 pptx / docx 都不同、并且是有意的：工作簿**在提案时就建好**，落盘时不
 * 再读一次源文件。pptx 非得等批准后才能转（它要一个 DOM 来量版面），而这里
 * 「批准的」和「写下去的」可以严格是同一份——作者在卡片上核对的正是这些格子的
 * 类型判定，中间源文件再被改一笔，写出去的就不是他批的那本了。
 */

import { readFile } from "../fs/fileio";
import { parseFrontmatter } from "../fs/markdown";
import { buildWorkbook, type WorkbookPlan } from "./sheets";

export * from "./cells";
export * from "./flag";
export * from "./sheets";
export * from "./write";

/** "报价.md" → "报价.xlsx"。默认目的地，不是固定的。 */
export function xlsxPathFor(mdPath: string): string {
  return mdPath.replace(/\.(md|markdown|txt)$/i, "") + ".xlsx";
}

/** 读一份文档，规划出一本工作簿。frontmatter 是元数据，不是表格，先摘掉。 */
export async function planWorkbookFromFile(mdPath: string): Promise<WorkbookPlan> {
  const { content } = parseFrontmatter(await readFile(mdPath));
  return buildWorkbook(content);
}
