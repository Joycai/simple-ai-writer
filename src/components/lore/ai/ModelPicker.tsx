/**
 * Footer 模型选择 (设计稿 03 v4): 「模型」小签 + 触发器 + 1px 分隔线，六个
 * lore AI 模态的 footer 左端统一用它 — 模型选择从各自的 header/侧栏挪到
 * 动作发生的那一条。
 *
 * 触发器与菜单是 AI 助手同一个 `ModelSelector`（受控模式 + paper 皮 + 向上
 * 展开）：搜索、常用/本地/长上下文筛选、按供应商分组、上下文窗口徽标，一套
 * 语汇两处生效。「默认跟随全局设置」：每个模态持本地 modelId，初始取全局
 * activeModelId，改动只影响本次任务，不写回全局 —— 菜单脚注即这句承诺。
 */

import { useTranslation } from "react-i18next";
import type { Model, Provider } from "../../../lib/ai/configDb";
import { ModelSelector } from "../../ai/ModelSelector";
import styles from "./ModelPicker.module.css";

export function ModelPicker({ models, value, onChange, disabled, label }: {
  models: Model[];
  /** Kept for call-site compatibility — the selector reads providers itself. */
  providers?: Provider[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Overrides the default 模型 label (e.g. 出图模型). */
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <span className={styles.picker}>
      <span
        className={styles.pickerLabel}
        title={t("lore.run.modelFollowsGlobal", { defaultValue: "默认跟随全局设置" })}
      >
        {label ?? t("lore.run.modelLabel", { defaultValue: "模型" })}
      </span>
      <ModelSelector
        value={value}
        onChange={onChange}
        models={models}
        disabled={disabled}
        openUp
        paper
      />
      <span className={styles.pickerDivider} />
    </span>
  );
}
