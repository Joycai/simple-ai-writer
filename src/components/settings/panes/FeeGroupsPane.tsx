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
 *
 * 组多起来之后的整理（按厂商分段、搜索）——设计稿 05l 屏 2a/2b/2c。分段与
 * 过滤的规则不在这里，在 `lib/ai/feeGroupList`：搜不到和分错段都是静默错法，
 * 留在组件里就没有测试点。
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

import { useAiStore } from "../../../stores/aiStore";
import type { FeeGroup } from "../../../lib/ai/feeGroup";
import { feeTags, isPriced } from "../../../lib/ai/feeGroupLabel";
import { knownVendors, organizeFeeGroups } from "../../../lib/ai/feeGroupList";
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

  const [query, setQuery] = useState("");

  const boundCount = (id: string) => models.filter((m) => m.feeGroupId === id).length;
  const unbound = models.filter((m) => !m.feeGroupId).length;

  const q = query.trim();
  const sections = organizeFeeGroups(feeGroups, models, query);
  const shown = sections.reduce((n, sec) => n + sec.hits.length, 0);
  const vendors = knownVendors(feeGroups);
  const noVendor = feeGroups.filter((g) => !(g.vendor ?? "").trim()).length;

  /**
   * 空查询时那一行计数。
   *
   * 有厂商就按厂商说话（这一页现在的组织方式就是厂商），一个都没填时退回
   * 「N 个组 · M 个模型绑着它们」——和列表压根没有分段是同一条规则（见
   * `feeGroupOptions`：没人填厂商时不产生任何段首），说「0 个厂商」只是噪音。
   */
  const countLabel = () => {
    if (!vendors.length) {
      return t("aiConfig.fees.listLabel", { groups: feeGroups.length, models: models.length - unbound });
    }
    const base = { groups: feeGroups.length, vendors: vendors.length };
    return noVendor > 0
      ? t("aiConfig.fees.listCountNone", { ...base, none: noVendor })
      : t("aiConfig.fees.listCount", base);
  };

  /**
   * 命中的模型名太多会把一行撑爆，写头两个 + 一句「还有多少」。
   *
   * 两个数都递进去：中文「A / B 等 {{n}} 个」说的是**总数**，英文
   * "and {{more}} more" 说的是**还剩几个**。同一个数字放进两种句式会有一种
   * 是错的，而它不会报错——只会把 3 个模型说成 5 个。
   */
  const matchedLabel = (names: string[]) => {
    const shownNames = names.slice(0, 2);
    const models = shownNames.join(" / ");
    return names.length > shownNames.length
      ? t("aiConfig.fees.matchedModelsMore", {
          models, n: names.length, more: names.length - shownNames.length,
        })
      : t("aiConfig.fees.matchedModels", { models });
  };

  /** 一行。分段与不分段两条路共用同一段渲染。 */
  const renderRow = ({ group: g, matchedModels }: { group: FeeGroup; matchedModels: string[] }) => (
    <button type="button" className={s.row} key={g.id} onClick={() => setEditing({ group: g })}>
      <span className={`${s.mark} ${isPriced(g) ? s.markSet : ""}`} aria-hidden="true" />
      <span className={s.name}>
        <span className={s.nameText}>{g.name || t("aiConfig.fees.untitled")}</span>
        {/* 被模型命中的行要说出是哪个，否则它看起来没理由地出现在结果里；
            组名或厂商自己命中时不写，那只是噪音。 */}
        <span className={`${s.bind} ${matchedModels.length ? s.bindHit : ""}`}>
          {matchedModels.length
            ? matchedLabel(matchedModels)
            : t("aiConfig.fees.boundModels", { n: boundCount(g.id) })}
        </span>
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
  );

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
              vendors={knownVendors(feeGroups)}
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

      {feeGroups.length === 0 ? (
        <Section label={t("aiConfig.fees.listLabel", { groups: 0, models: 0 })}>
          <div className={ui.emptyNote}>{t("aiConfig.fees.empty")}</div>
        </Section>
      ) : (
        <>
          <div className={s.searchRow}>
            {/* 有内容时整个框换成强调色，并长出一个 ×：无结果那一屏有「清除搜索」，
                而有结果时同样需要一条回头路——否则只能一个字一个字删。 */}
            <div className={`${hub.searchWrap} ${q ? s.searchOn : ""}`}>
              <Search size={14} className={hub.searchIcon} />
              <input
                className={hub.searchInput}
                value={query}
                placeholder={t("aiConfig.fees.searchPlaceholder")}
                onChange={(e) => setQuery(e.target.value)}
              />
              {q && (
                <button
                  type="button"
                  className={s.searchClear}
                  aria-label={t("aiConfig.hub.clearSearch")}
                  title={t("aiConfig.hub.clearSearch")}
                  onClick={() => setQuery("")}
                >
                  ×
                </button>
              )}
            </div>
            {(q || vendors.length > 0) && (
              <div className={s.searchCount}>
                {q ? t("aiConfig.fees.searchCount", { query: q, n: shown }) : countLabel()}
              </div>
            )}
          </div>

          {sections.length === 0 ? (
            /* 搜不到不是错误，所以不用报警色——说清楚搜过了哪三样，并给一个回头路。 */
            <div className={hub.noResults}>
              {t("aiConfig.fees.noResults", { query: q })}
              <div className={s.foot}>{t("aiConfig.fees.noResultsHint")}</div>
              <div className={hub.btnRow}>
                <button className={ui.rowBtn} onClick={() => setQuery("")}>
                  {t("aiConfig.hub.clearSearch")}
                </button>
              </div>
            </div>
          ) : vendors.length === 0 ? (
            /* 一个厂商都没填 ⇒ 不分段：全是「未填厂商」等于没分段，凭空多一行
               段首只会让短列表看起来更长。和 feeGroupOptions 同一条规则。 */
            <Section label={t("aiConfig.fees.listLabel", { groups: feeGroups.length, models: models.length - unbound })}>
              {sections.flatMap((sec) => sec.hits).map(renderRow)}
              <div className={s.foot}>{t("aiConfig.fees.deleteFoot")}</div>
            </Section>
          ) : (
            <>
              {sections.map((sec) => (
                <Section
                  key={sec.vendor || "\u0000none"}
                  label={sec.vendor || t("aiConfig.fees.vendorNone")}
                  action={<span className={s.sectionCount}>{t("aiConfig.fees.sectionCount", { n: sec.hits.length })}</span>}
                >
                  {sec.hits.map(renderRow)}
                </Section>
              ))}
              <div className={s.foot}>{t("aiConfig.fees.deleteFoot")}</div>
            </>
          )}
        </>
      )}

      {unbound > 0 && (
        <Section label={t("aiConfig.fees.unboundLabel")}>
          <div className={s.foot}>{t("aiConfig.fees.unboundNote", { n: unbound })}</div>
        </Section>
      )}
    </Pane>
  );
}
