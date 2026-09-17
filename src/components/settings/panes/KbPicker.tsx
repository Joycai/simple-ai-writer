import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useSyncStore } from "../../../stores/syncStore";
import type { RemoteKb } from "../../../lib/sync/client";
import { useImeGuard } from "../../../lib/ime";
import {
  KB_SORTS,
  filterKbs,
  recommendKb,
  relativeAge,
  sortKbs,
  type KbSort,
} from "../../../lib/sync/kbPicker";
import ui from "../settingsUi.module.css";
import sp from "./syncPane.module.css";

const SORT_KEY: Record<KbSort, string> = {
  recent: "sync.kbSortRecent",
  name: "sync.kbSortName",
  entries: "sync.kbSortEntries",
};

/**
 * 已连接、未绑定时的选库区(设计稿「同步与备份 UX 优化」方案 A)。
 *
 * 一张推荐卡 + 搜索/排序 + **定高**的单行列表 + 常驻底栏。定高是这块的
 * 全部意义:库再多,绑定按钮也停在列表正下方,而不是被推到页底。
 * 过滤、排序、推荐、相对时间都在 `lib/sync/kbPicker`,这里只管画。
 */
export function KbPicker({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const { t, i18n } = useTranslation();
  const sync = useSyncStore();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<KbSort>("recent");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // Both inputs take CJK names: an Enter/Esc that commits or dismisses a
  // candidate must not create a base or clear the field.
  const searchIme = useImeGuard();
  const createIme = useImeGuard();

  const total = sync.kbs.length;
  const searching = query.trim().length > 0;
  const shown = useMemo(
    () => sortKbs(filterKbs(sync.kbs, query), sort, i18n.language),
    [sync.kbs, query, sort, i18n.language],
  );
  const rec = useMemo(
    () => recommendKb(sync.kbs, projectName, sync.device),
    [sync.kbs, projectName, sync.device],
  );
  const selectedKb = sync.kbs.find((k) => k.id === selected) ?? null;
  // Roving tabindex: the whole list is one Tab stop — the choice, or the first row.
  const tabStop = shown.some((k) => k.id === selected) ? selected : (shown[0]?.id ?? null);
  const hasSelf = !!sync.device && sync.kbs.some((k) => k.lastDevice === sync.device);

  const openCreate = (name: string) => {
    setNewName(name);
    setCreating(true);
  };

  const create = async () => {
    const kb = await sync.createKb(newName.trim());
    if (kb) {
      setSelected(kb.id);
      setQuery("");
      setNewName("");
      setCreating(false);
    }
  };

  const bind = (kb: RemoteKb) => void sync.bind(projectPath, kb);

  // role="radiogroup": arrows move the choice, as a native radio group would.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (shown.length === 0) return;
    e.preventDefault();
    // Move from the row that has focus (the tab stop), not from `selected`:
    // a search can hide the selection, and then the two differ.
    const radios = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? [])];
    let at = radios.findIndex((r) => r === document.activeElement);
    if (at < 0) at = shown.findIndex((k) => k.id === tabStop);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = at < 0 ? 0 : Math.min(shown.length - 1, Math.max(0, at + step));
    setSelected(shown[next].id);
    radios[next]?.focus();
  };

  return (
    <>
      <div className={sp.kbListLabel}>{t("sync.aKbPick", { name: projectName })}</div>

      {total === 0 && !creating && (
        <div className={sp.recEmpty}>
          {t("sync.aKbEmpty")} <span>{t("sync.aKbEmptyHint")}</span>
        </div>
      )}

      {rec && !searching && (
        <div className={sp.recCard}>
          <div className={sp.recCardMain}>
            <div className={sp.recCardTop}>
              <span className={sp.recCardTag}>
                {t(rec.reason === "same-name" ? "sync.kbRecSameName" : "sync.kbRecThisDevice")}
              </span>
              <span className={sp.recCardName} title={rec.kb.name}>
                {rec.kb.name}
              </span>
            </div>
            <div className={sp.kbMeta}>{kbSubtitle(rec.kb, sync.device, t)}</div>
          </div>
          <button
            className={ui.primaryBtn}
            disabled={sync.busy}
            onClick={() => bind(rec.kb)}
          >
            {t("sync.kbRecBind")}
          </button>
        </div>
      )}

      {total > 0 && (
        <>
          <div className={sp.kbTools}>
            <input
              className={sp.kbSearch}
              type="search"
              value={query}
              placeholder={t("sync.kbSearchPh", { n: total })}
              aria-label={t("sync.kbSearchPh", { n: total })}
              onChange={(e) => setQuery(e.target.value)}
              {...searchIme.imeProps}
              onKeyDown={(e) => {
                if (searchIme.isComposing(e)) return;
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
            <div className={sp.kbSort} role="group" aria-label={t("sync.kbSortLabel")}>
              {KB_SORTS.map((s) => (
                <button
                  key={s}
                  className={`${sp.kbSortBtn} ${sort === s ? sp.kbSortBtnOn : ""}`}
                  aria-pressed={sort === s}
                  onClick={() => setSort(s)}
                >
                  {t(SORT_KEY[s])}
                </button>
              ))}
            </div>
          </div>

          <div className={sp.kbTable}>
            <div className={`${sp.kbGrid} ${sp.kbThead}`} aria-hidden>
              <span />
              <span>{t("sync.kbColName")}</span>
              <span className={sp.kbNum}>{t("sync.kbColEntries")}</span>
              <span>{t("sync.kbColUpdated")}</span>
              <span>{t("sync.kbColFrom")}</span>
            </div>
            <div
              ref={listRef}
              className={sp.kbScroll}
              role="radiogroup"
              aria-label={t("sync.aKbPick", { name: projectName })}
              onKeyDown={onListKey}
            >
              {shown.map((kb) => {
                const on = kb.id === selected;
                const self = !!sync.device && kb.lastDevice === sync.device;
                return (
                  <button
                    key={kb.id}
                    role="radio"
                    aria-checked={on}
                    tabIndex={kb.id === tabStop ? 0 : -1}
                    className={`${sp.kbGrid} ${sp.kbRow} ${on ? sp.kbRowOn : ""}`}
                    title={`${kb.name}\n${kbSubtitle(kb, sync.device, t, true)}`}
                    onClick={() => setSelected(kb.id)}
                  >
                    <span className={`${sp.radio} ${on ? sp.radioOn : ""}`}>
                      {on && <span className={sp.radioDot} />}
                    </span>
                    <span className={sp.kbName}>{kb.name}</span>
                    <span className={`${sp.kbCell} ${sp.kbNum}`}>{kb.entryCount}</span>
                    <span className={sp.kbCell}>{ageText(kb.updatedAtMs, t)}</span>
                    <span className={`${sp.kbCell} ${self ? sp.kbCellSelf : ""}`}>
                      {self ? t("sync.aRecSelf") : (kb.lastDevice ?? "—")}
                    </span>
                  </button>
                );
              })}
            </div>
            {searching && shown.length === 0 && (
              <div className={sp.kbNoMatch}>
                <span>{t("sync.kbNoMatch", { q: query.trim() })}</span>
                {!creating && (
                  <button className={ui.rowBtn} onClick={() => openCreate(query.trim())}>
                    {t("sync.kbCreateFromQuery", { q: query.trim() })}
                  </button>
                )}
              </div>
            )}
            <div className={sp.kbStatus}>
              <span>
                {searching
                  ? t("sync.kbCountMatch", { m: shown.length, n: total })
                  : t("sync.kbCountAll", { n: total })}
              </span>
              {hasSelf && <span className={sp.kbStatusLegend}>{t("sync.kbLegendSelf")}</span>}
            </div>
          </div>
        </>
      )}

      {creating && (
        <div className={sp.kbCreate}>
          <label className={sp.kbCreateLabel} htmlFor="kb-create-name">
            {t("sync.kbNewLabel")}
          </label>
          <input
            id="kb-create-name"
            className={sp.kbCreateInput}
            autoFocus
            value={newName}
            placeholder={t("sync.newKbName")}
            onChange={(e) => setNewName(e.target.value)}
            {...createIme.imeProps}
            onKeyDown={(e) => {
              if (createIme.isComposing(e)) return;
              if (e.key === "Enter" && newName.trim() && !sync.busy) void create();
              if (e.key === "Escape") {
                e.stopPropagation();
                setCreating(false);
              }
            }}
          />
          <button className={ui.rowBtn} onClick={() => setCreating(false)}>
            {t("common.cancel")}
          </button>
          <button
            className={ui.primaryBtn}
            disabled={!newName.trim() || sync.busy}
            onClick={() => void create()}
          >
            {t("sync.kbCreateAndSelect")}
          </button>
        </div>
      )}

      <div className={sp.kbFoot}>
        <div className={sp.kbFootHint}>{t("sync.aBindHint")}</div>
        {!creating && (
          <button className={ui.rowBtn} onClick={() => openCreate(projectName)}>
            {t("sync.aKbNew")}
          </button>
        )}
        <button
          className={`${ui.primaryBtn} ${sp.kbBindBtn}`}
          disabled={!selectedKb || sync.busy}
          title={selectedKb ? selectedKb.name : undefined}
          onClick={() => selectedKb && bind(selectedKb)}
        >
          {selectedKb ? t("sync.bindTo", { name: selectedKb.name }) : t("sync.kbPickFirst")}
        </button>
      </div>
    </>
  );
}

function ageText(ms: number, t: TFunction): string {
  const age = relativeAge(ms);
  switch (age.unit) {
    case "never":
      return "—";
    case "today":
      return t("sync.ageToday");
    case "yesterday":
      return t("sync.ageYesterday");
    case "days":
      return t("sync.ageDays", { n: age.n });
    case "months":
      return t("sync.ageMonths", { n: age.n });
    case "years":
      return t("sync.ageYears", { n: age.n });
  }
}

/**
 * "128 条 · 3 天前 · 来自 本机" — the line that tells the author which of several
 * knowledge bases is the one they have been writing into. Each clause is
 * dropped when the server has nothing to say. `full` swaps the relative age for
 * the timestamp, for the tooltip.
 */
function kbSubtitle(kb: RemoteKb, device: string, t: TFunction, full = false): string {
  const parts = [t("sync.entryCount", { n: kb.entryCount })];
  if (kb.updatedAtMs > 0) {
    parts.push(
      full
        ? t("sync.kbUpdated", { when: new Date(kb.updatedAtMs).toLocaleString() })
        : ageText(kb.updatedAtMs, t),
    );
  }
  if (kb.lastDevice) {
    const self = !!device && kb.lastDevice === device;
    parts.push(t(self ? "sync.kbFromSelf" : "sync.kbFrom", { device: kb.lastDevice }));
  }
  return parts.join(" · ");
}
