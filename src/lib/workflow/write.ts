/**
 * 工作流卡的写入层——管理 UI（Settings → 工作台）保存/删除项目卡的通道。
 *
 * 覆盖模型决定了这里只有一种写法：写 `.ai-writer/workflows/<id>.md`。停用一张
 * 内置卡 = 写一份带 `disabled: true` 的**全量副本**（frontmatter 只有一行的
 * "薄覆盖"会让合并出一张没名字没正文的卡——整张替换的规则是刻意的，见
 * cards.ts）；还原为内置 = 删掉覆盖文件。
 */

import { makeDir, removeFile, writeFile } from "../fs/fileio";
import { WORKFLOW_DIR } from "./cards";

export interface WorkflowFileMeta {
  name: string;
  description: string;
  body: string;
  disabled: boolean;
}

/**
 * YAML 双引号标量转义，与 lore/entity.ts 的 yamlQuote 同款同理由：name 和
 * description 是作者输入，裸换行会把行式 frontmatter 解析器搞乱。
 */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** 序列化成文件内容。`disabled` 只在为 true 时写那一行——和 lore 的 `dict` 同规则。 */
export function serializeWorkflowFile(meta: WorkflowFileMeta): string {
  return [
    "---",
    `name: ${yamlQuote(meta.name)}`,
    `description: ${yamlQuote(meta.description)}`,
    ...(meta.disabled ? ["disabled: true"] : []),
    "---",
    "",
    meta.body.trim(),
    "",
  ].join("\n");
}

/**
 * 从名字导出一个能当文件名用的 id。
 *
 * 中文名直接可用（文件系统没意见），只剥掉路径敌意字符；与现有 id 冲突时
 * 加序号。id 是文件身份，创建后不再改——改名改的是 frontmatter 的 name。
 */
export function suggestWorkflowId(name: string, existing: readonly string[]): string {
  const base = name.trim().replace(/[\\/:*?"<>|.]/g, "").slice(0, 40) || "workflow";
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/** 写（或覆盖）一张项目卡。 */
export async function saveWorkflowCard(
  projectPath: string,
  id: string,
  meta: WorkflowFileMeta,
): Promise<void> {
  const dir = `${projectPath}/${WORKFLOW_DIR}`;
  await makeDir(dir);
  await writeFile(`${dir}/${id}.md`, serializeWorkflowFile(meta));
}

/** 删一张项目卡。对覆盖内置的文件而言，这就是「还原为内置」。 */
export async function deleteWorkflowCard(projectPath: string, id: string): Promise<void> {
  await removeFile(`${projectPath}/${WORKFLOW_DIR}/${id}.md`);
}
