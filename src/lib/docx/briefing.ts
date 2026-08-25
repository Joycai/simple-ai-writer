/**
 * briefing 里的「可用排版格式」一段。
 *
 * 没有它，模型知道有 `export_docx` 却不知道有哪些格式可以点名——只能要么永远
 * 用默认，要么猜一个 id 然后吃一个错误。清单挂在固定头部（和工作流清单同一层、
 * 同一个理由），格式的**细节**不进上下文：那是 `read_doc_format` 的活。
 *
 * 关掉 Beta 返回空串，调用方把整段省掉——零成本，和 `workflowBriefingSection`
 * 一样。
 */

import i18n from "../../i18n";
import { formatOneLine, type DocFormatPreset } from "./format";
import { isDocxExportEnabled } from "./flag";

/** 清单最多几行。再多模型也读不出重点，而这是每一轮都付的固定成本。 */
const ROSTER_LIMIT = 12;

export function docxRoster(presets: readonly DocFormatPreset[], defaultId: string): string {
  return presets
    .slice(0, ROSTER_LIMIT)
    .map((p) => {
      const name = p.id === defaultId
        ? i18n.t("ai.instructions.docxFormatDefault", { label: p.label })
        : p.label;
      return `- ${p.id} · ${name} — ${formatOneLine(p.format)}`;
    })
    .join("\n");
}

/** 追加到 agent briefing 末尾的整段文本；Beta 关着或一套预设都没有时为空串。 */
export function docxBriefingSection(
  presets: readonly DocFormatPreset[],
  defaultId: string,
): string {
  if (!isDocxExportEnabled() || presets.length === 0) return "";
  return i18n.t("ai.instructions.docxFormats", { roster: docxRoster(presets, defaultId) });
}
