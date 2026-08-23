/**
 * 工作流卡的目录扫描——本模块唯一碰盘的地方，逻辑全在 `cards.ts`。
 *
 * 目录不存在、某个文件读不出来，都不是错误：开箱即用的含义就是零文件时
 * 清单里站着全部内置卡。
 */

import { readDir, readFile } from "../fs/fileio";
import { mergeWorkflows, parseWorkflowFile, WORKFLOW_DIR, type WorkflowCard } from "./cards";

/** 项目的合并视图：内置卡 + `.ai-writer/workflows/*.md`。 */
export async function scanWorkflows(projectPath: string): Promise<WorkflowCard[]> {
  const dir = `${projectPath}/${WORKFLOW_DIR}`;
  const projectCards: WorkflowCard[] = [];

  try {
    const entries = await readDir(dir);
    for (const e of entries) {
      if (e.isDirectory || !e.name.endsWith(".md")) continue;
      const id = e.name.slice(0, -3);
      if (!id) continue;
      try {
        projectCards.push(parseWorkflowFile(id, await readFile(`${dir}/${e.name}`)));
      } catch {
        // 单个文件读不出来只是少一张卡，不拖垮整个清单。
      }
    }
  } catch {
    // 目录不存在 —— 没建过项目工作流，走纯内置。
  }

  return mergeWorkflows(projectCards);
}
