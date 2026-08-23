/**
 * briefing 里的「可用工作流」一段——两级渐进披露的第一级。
 *
 * 只有清单（一行一卡）进固定头部，正文留给 `read_workflow` 按需取。返回空串
 * 表示一张可用的卡都没有，调用方把整段（含头部说明）省掉——零卡零成本。
 *
 * 说明文字走 i18n（briefing 的其余部分也是按界面语言给的），卡片名和描述
 * 原样进清单，不翻译：它们是作者（或内置卡）写下的数据。
 */

import i18n from "../../i18n";
import { workflowRoster } from "./cards";
import { scanWorkflows } from "./scan";

/** 追加到 agent briefing 末尾的整段文本；没有可用卡时为空串。 */
export async function workflowBriefingSection(projectPath: string): Promise<string> {
  const roster = workflowRoster(await scanWorkflows(projectPath));
  if (!roster) return "";
  return i18n.t("ai.instructions.workflows", { roster });
}
