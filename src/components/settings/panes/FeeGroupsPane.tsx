/**
 * 设置 → AI 配置 → 计费组 — 设计稿 05l 屏 1a。
 *
 * 一组价格，被任意多个模型共用。在这一页之前价格是模型行上的五个列：同一家
 * 十几个模型抄同一份价、改价要改十几处，而「按张」「按秒」各占一列，一次
 * 请求该读哪一列没有答案。
 *
 * 这一页只说三件事，每一件都写在界面上而不是文档里：改一次价对绑着它的
 * 模型同时生效、**已经记下的用量一分不动**（行自带价）、没绑组的模型照样
 * 记数量但算不出钱。
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAiStore } from "../../../stores/aiStore";
import type { FeeGroup } from "../../../lib/ai/feeGroup";
import { feeTags, isPriced } from "../../../lib/ai/feeGroupLabel";
import { useFeeLabelWords } from "./feeWords";
import { FeeGroupDrawer } from "./FeeGroupDrawer";
import { Pane, PaneHeader, Section } from "./bits";
import hub from "./ProvidersModels.module.css";
import s from "./FeeGroups.module.css";
import ui from "../settingsUi.module.css";

export function FeeGroupsPane() {
  const { t } = useTranslation();
  const words = useFeeLabelWords();
  const feeGroups = useAiStore((st) => st.feeGroups);
  const models = useAiStore((st) => st.models);
  const saveFeeGroup = useAiStore((st) => st.saveFeeGroup);
  const removeFeeGroup = useAiStore((st) => st.removeFeeGroup);

  // null ＝ 抽屉关着；{ group: null } ＝ 新建。
  const [editing, setEditing] = useState<{ group: FeeGroup | null } | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  // 关闭走 160ms 退场再卸载，和渠道抽屉同一节奏。
  const close = () => {
    if (closeTimer.current !== null) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setClosing(false);
      setEditing(null);
    }, 160);
  };

  const boundCount = (id: string) => models.filter((m) => m.feeGroupId === id).length;
  const unbound = models.filter((m) => !m.feeGroupId).length;

  const onDelete = (g: FeeGroup) => {
    const n = boundCount(g.id);
    if (!globalThis.confirm(t("aiConfig.fees.deleteConfirm", { name: g.name, n }))) return;
    void removeFeeGroup(g.id);
  };

  return (
    <Pane
      width="wide"
      drawer={
        editing && (
          <div className={`${hub.drawerLayer} ${closing ? hub.drawerLayerClosing : ""}`}>
            <div className={hub.scrim} onClick={close} />
            <FeeGroupDrawer
              key={editing.group?.id ?? "new"}
              group={editing.group}
              boundModels={editing.group ? boundCount(editing.group.id) : 0}
              onSave={async (g) => {
                await saveFeeGroup(
                  editing.group ? { ...g, id: editing.group.id, createdAt: editing.group.createdAt } : g,
                );
              }}
              onClose={close}
            />
          </div>
        )
      }
    >
      <PaneHeader
        title={t("systemSettings.tabs.fees")}
        sub={t("aiConfig.fees.paneSub")}
        action={
          <button className={ui.primaryBtn} onClick={() => setEditing({ group: null })}>
            {t("aiConfig.fees.addTitle")}
          </button>
        }
      />

      <Section label={t("aiConfig.fees.listLabel", { groups: feeGroups.length, models: models.length - unbound })}>
        {feeGroups.length === 0 ? (
          <div className={ui.emptyNote}>{t("aiConfig.fees.empty")}</div>
        ) : (
          <>
            {feeGroups.map((g) => (
              <button type="button" className={s.row} key={g.id} onClick={() => setEditing({ group: g })}>
                <span className={`${s.mark} ${isPriced(g) ? s.markSet : ""}`} aria-hidden="true" />
                <span className={s.name}>
                  <span className={s.nameText}>{g.name || t("aiConfig.fees.untitled")}</span>
                  <span className={s.bind}>{t("aiConfig.fees.boundModels", { n: boundCount(g.id) })}</span>
                </span>
                <span className={s.tags}>
                  {feeTags(g, words).map((tag, i) => (
                    <span className={`${s.tag} ${tag.derived ? s.tagDerived : ""}`} key={i}>
                      {tag.text}
                    </span>
                  ))}
                </span>
                <span className={s.rowActions}>
                  <span
                    className={s.act}
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); onDelete(g); }}
                  >
                    {t("common.delete")}
                  </span>
                </span>
              </button>
            ))}
            <div className={s.foot}>{t("aiConfig.fees.deleteFoot")}</div>
          </>
        )}
      </Section>

      {unbound > 0 && (
        <Section label={t("aiConfig.fees.unboundLabel")}>
          <div className={s.foot}>{t("aiConfig.fees.unboundNote", { n: unbound })}</div>
        </Section>
      )}
    </Pane>
  );
}
