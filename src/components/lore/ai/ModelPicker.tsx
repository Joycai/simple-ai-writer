/**
 * Footer 模型选择 (设计稿 03 v4): 「模型」小签 + 描边 chip 触发器 + 1px 分隔线，
 * 六个 lore AI 模态的 footer 左端统一用它 — 模型选择从各自的 header/侧栏
 * 挪到动作发生的那一条。菜单是共享 Select（portal + 键盘导航，贴近底部时
 * 自动向上展开，即设计稿屏 10 的上拉形态），按供应商分组、行内只写模型名。
 *
 * 「默认跟随全局设置」：每个模态持本地 modelId，初始取全局 activeModelId，
 * 改动只影响本次任务，不写回全局 —— 这句承诺放在 label 的悬浮提示里。
 */

import { useTranslation } from "react-i18next";
import type { Model, Provider } from "../../../lib/ai/configDb";
import { Select } from "../../common/Select";
import styles from "./ModelPicker.module.css";

export function ModelPicker({ models, providers, value, onChange, disabled, label }: {
  models: Model[];
  providers: Provider[];
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
      <Select
        className={styles.pickerChip}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={t("lore.generator.selectModel", { defaultValue: "选择模型…" })}
        options={models.map((m) => ({
          value: m.id,
          label: m.name,
          group: providers.find((p) => p.id === m.providerId)?.name ?? "",
        }))}
        ariaLabel={label ?? t("lore.run.modelLabel", { defaultValue: "模型" })}
      />
      <span className={styles.pickerDivider} />
    </span>
  );
}
