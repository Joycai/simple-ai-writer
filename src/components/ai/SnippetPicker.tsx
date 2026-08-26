/**
 * Quick-insert picker for snippet prompts — the take-up half of the snippet
 * library (the save half is `SnippetSaveMenu`).
 *
 * Structure is the model selector's, one for one: search row → filter chips →
 * sectioned list → footer. That is a design requirement rather than reuse for
 * its own sake — "一处学会两处都认得" (设计稿 1a) — so the two popovers share
 * the same idioms down to the selected row being *only* a 2px left rule with no
 * fill, which is what lets a keyboard cursor and a mouse hover coexist on
 * different rows without either being mistaken for the other.
 *
 * Two behaviours are fixed and must not drift:
 *   · Picking **inserts, never sends** — a snippet is a starting point the
 *     author completes, and an auto-send would fire it half-written.
 *   · Insertion **appends to the end** with a newline (see `appendSnippet`);
 *     it does not follow the caret and does not touch the selection.
 *
 * The entry button renders even with zero snippets: an invisible feature is an
 * undiscoverable one, and the empty popover is this feature's only chance to
 * introduce itself (设计稿 1e).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Search, Zap } from "lucide-react";
import type { Prompt } from "../../lib/ai/configDb";
import {
  appendSnippet,
  chipCounts,
  countPlaceholders,
  flatten,
  hitSlice,
  isSimpleLibrary,
  pickerSections,
  previewLine,
  snippetsOf,
  splitPlaceholders,
  type SnippetFilter,
} from "../../lib/ai/snippets";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { showSnippetTrace, useSnippetTrace } from "./snippetTrace";
import styles from "./SnippetPicker.module.css";

const FILTERS: SnippetFilter[] = ["all", "frequent", "ungrouped"];

interface Props {
  /** Current input-box text — the picker computes the appended result itself
   *  so the append rule lives in one place, not once per input surface. */
  value: string;
  /** Receives the whole next value. Also used to undo an insert. */
  onInsert: (next: string) => void;
  /** Called after an insert so the caller can restore focus to its textarea. */
  onAfterInsert?: () => void;
}

/** The preview line, with `{{…}}` marked and the search hit re-cut into view. */
function Preview({ content, query }: { content: string; query: string }) {
  const line = previewLine(content);
  const slice = hitSlice(line, query);
  if (!slice) {
    return (
      <span className={styles.preview}>
        {splitPlaceholders(line).map((p, i) =>
          p.placeholder
            ? <span key={i} className={styles.ph}>{p.text}</span>
            : <span key={i}>{p.text}</span>,
        )}
      </span>
    );
  }
  return (
    <span className={styles.preview}>
      {slice.leadEllipsis && "…"}
      {slice.before}
      <span className={styles.hit}>{slice.hit}</span>
      {slice.after}
    </span>
  );
}

/** A name with the search hit tinted in place (names are never re-cut — a name
 *  short enough to show is short enough to scan). */
function Name({ text, query }: { text: string; query: string }) {
  const slice = hitSlice(text, query, text.length);
  if (!slice) return <>{text}</>;
  return (
    <>
      {slice.before}
      <span className={styles.hit}>{slice.hit}</span>
      {slice.after}
    </>
  );
}

export function SnippetPicker({ value, onInsert, onAfterInsert }: Props) {
  const { t } = useTranslation();
  const prompts = useAiStore((s) => s.prompts);
  const noteSnippetUsed = useAiStore((s) => s.noteSnippetUsed);
  const openSettings = useAppStore((s) => s.openSettings);
  const trace = useSnippetTrace();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SnippetFilter>("all");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const snippets = useMemo(() => snippetsOf(prompts), [prompts]);
  /* ≤5 snippets: no search box, no chips, no section headers. Three rows that
     still demand a search box is ceremony added to a list (设计稿 1b). */
  const simple = isSimpleLibrary(snippets);
  const counts = useMemo(() => chipCounts(snippets), [snippets]);
  /* `pickerSections`, not `buildSections`: what simple mode does to the search,
     the chips and 「常用」 is one decision, and it belongs beside the rule it
     follows from rather than re-derived at this call site. */
  const sections = useMemo(
    () => pickerSections(snippets, { filter, query }),
    [snippets, filter, query],
  );
  const flat = useMemo(() => flatten(sections), [sections]);
  /* Where each section starts in `flat`. Walked rather than `flat.indexOf(s)`:
     a snippet repeated by 「常用」 is the *same object* in both sections, so
     indexOf hands both rows the first copy's index — one ↑↓ cursor would light
     two rows at once and the lower copy would be unreachable by keyboard. */
  const offsets = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const sec of sections) { out.push(n); n += sec.items.length; }
    return out;
  }, [sections]);

  useEffect(() => { if (!open) { setQuery(""); setFilter("all"); } }, [open]);
  useEffect(() => { setActive(0); }, [query, filter]);
  useEffect(() => { if (open && !simple) inputRef.current?.focus(); }, [open, simple]);

  // Close on an outside click or a scroll elsewhere, like every other popover
  // in the drawer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the keyboard cursor in view — sections make the list tall enough that
  // an off-screen cursor is easy to produce with two ↓ presses.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (s: Prompt) => {
    const before = value;
    onInsert(appendSnippet(value, s.content));
    void noteSnippetUsed(s.id);
    setOpen(false);
    onAfterInsert?.();
    showSnippetTrace({
      kind: "inserted",
      name: s.name,
      placeholders: countPlaceholders(s.content),
      undo: () => onInsert(before),
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    // ⌥←→ switches chips: the chip row is a filter, and reaching it with Tab
    // would cost the search box its focus.
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !simple) {
      e.preventDefault();
      const i = FILTERS.indexOf(filter);
      const next = e.key === "ArrowRight" ? i + 1 : i - 1;
      if (next >= 0 && next < FILTERS.length) setFilter(FILTERS[next]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Clamped, never wrapping: a cursor that jumps from the last row back to
      // the first reads as a lost keypress.
      setActive((i) => Math.min(i + 1, flat.length - 1));
      return;
    }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = flat[active] ?? flat[0];
      if (pick) choose(pick);
    }
  };

  const sectionLabel = (kind: string, group: string) =>
    kind === "frequent" ? t("ai.snippets.frequent", { defaultValue: "常用" })
    : kind === "ungrouped" ? t("ai.snippets.ungrouped", { defaultValue: "未分组" })
    : group;

  const chipLabel = (f: SnippetFilter) =>
    f === "all" ? t("ai.snippets.filterAll", { defaultValue: "全部" })
    : f === "frequent" ? t("ai.snippets.frequent", { defaultValue: "常用" })
    : t("ai.snippets.ungrouped", { defaultValue: "未分组" });

  const empty = snippets.length === 0;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.entry} ${open ? styles.entryOpen : ""} ${empty ? styles.entryEmpty : ""} ${trace ? styles.entryTraced : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={t("ai.snippets.hint")}
        aria-expanded={open}
      >
        <Zap size={11} strokeWidth={1.8} />
        {t("ai.snippets.button")}
        <ChevronDown size={11} strokeWidth={1.6} className={styles.entryChevron} />
      </button>

      {/* 存入 / 插入 的痕迹：一条赭石细线 + 一句话，1.6–2.4s 后自己褪去。 */}
      {trace && <SnippetTraceLine />}

      {open && (
        <div className={styles.popover} role="dialog" onKeyDown={onKeyDown}>
          {empty ? (
            <div className={styles.introBody}>
              <div className={styles.introTitle}>
                {t("ai.snippets.emptyTitle", { defaultValue: "把反复要敲的指令存成片段" })}
              </div>
              <p className={styles.introText}>
                {t("ai.snippets.emptyBody", {
                  defaultValue:
                    "「把这段改写得更冷一点，保留对话」这类句子，存一次，以后从这里点一下就填回输入框末尾。片段只往输入框里填，从不自动发送。",
                })}
              </p>
              <div className={styles.introHow}>
                {t("ai.snippets.emptyHowTitle", { defaultValue: "怎么存第一条" })}
              </div>
              <p className={styles.introText}>
                {t("ai.snippets.emptyHow", {
                  defaultValue:
                    "在输入框里选中那段指令 → 右键 →「存为片段」。对话里已经发出去的消息、AI 回复里的句子，同样可以选中右键存。",
                })}
              </p>
            </div>
          ) : (
            <>
              {!simple && (
                <>
                  <div className={styles.searchRow}>
                    <Search size={13} strokeWidth={1.7} className={styles.searchIcon} />
                    <input
                      ref={inputRef}
                      className={styles.searchInput}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("ai.snippets.search", { defaultValue: "搜索名字或正文" })}
                    />
                    <span className={styles.searchCount}>
                      {query ? `${flat.length} / ${snippets.length}` : snippets.length}
                    </span>
                  </div>
                  <div className={styles.filterRow}>
                    {FILTERS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`${styles.chip} ${filter === f ? styles.chipActive : ""}`}
                        onClick={() => setFilter(f)}
                      >
                        {chipLabel(f)} {counts[f]}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className={styles.list} ref={listRef}>
                {flat.length === 0 ? (
                  <div className={styles.noMatch}>
                    <div>{t("ai.snippets.noMatch", { defaultValue: "没有名字或正文里含「{{q}}」的片段。", q: query })}</div>
                    {/* No "create one" button here on purpose: saving has exactly
                        one door (right-click), and a second one would imply this
                        empty state can build a library. */}
                    <div className={styles.noMatchHow}>
                      {t("ai.snippets.noMatchHow", { defaultValue: "要新建，请在输入框里选中那段话右键。" })}
                    </div>
                  </div>
                ) : (
                  sections.map((sec, si) => (
                    <div key={sec.key} className={styles.section}>
                      {!simple && (
                        <div className={`${styles.sectionHead} ${sec.kind === "ungrouped" ? styles.sectionHeadWeak : ""}`}>
                          <span className={styles.sectionName}>{sectionLabel(sec.kind, sec.group)}</span>
                          {sec.kind !== "frequent" && (
                            <span className={styles.sectionCount}>
                              {query
                                ? `· ${t("ai.snippets.hits", { defaultValue: "{{n}} 条命中", n: sec.hits })}`
                                : `· ${sec.items.length}`}
                            </span>
                          )}
                        </div>
                      )}
                      {sec.items.map((s, i) => {
                        const idx = offsets[si] + i;
                        return (
                          <button
                            key={`${sec.key}:${s.id}`}
                            type="button"
                            data-idx={idx}
                            className={`${styles.item} ${idx === active ? styles.itemActive : ""}`}
                            onMouseEnter={() => setActive(idx)}
                            onClick={() => choose(s)}
                          >
                            <span className={styles.name} title={s.name}>
                              <Name text={s.name} query={simple ? "" : query} />
                            </span>
                            <Preview content={s.content} query={simple ? "" : query} />
                            {/* The usage column explains the 「常用」 section's
                                ordering. It stays out of the group sections so
                                the list is not reporting a number on every row. */}
                            {sec.kind === "frequent" && (
                              <span className={styles.uses}>
                                {t("ai.snippets.uses", { defaultValue: "{{n}} 次", n: s.useCount ?? 0 })}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          <div className={styles.footer}>
            {!empty && (
              <span className={styles.hint}>
                {simple || flat.length <= 1
                  ? t("ai.snippets.navInsert", { defaultValue: "⏎ 插入" })
                  : t("ai.snippets.nav", { defaultValue: "↑↓ 选 · ⏎ 插入 · esc 关" })}
              </span>
            )}
            {empty && <span className={styles.hint}>{t("ai.snippets.navClose", { defaultValue: "esc 关" })}</span>}
            <button
              type="button"
              className={styles.manageBtn}
              onClick={() => { setOpen(false); openSettings("prompts"); }}
            >
              {t("ai.snippets.manage", { defaultValue: "管理片段…" })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The confirmation line. Split out so its ⌘Z listener mounts and unmounts with
 *  the trace rather than living for the panel's whole life. */
function SnippetTraceLine() {
  const { t } = useTranslation();
  const trace = useSnippetTrace();

  useEffect(() => {
    const undo = trace?.undo;
    if (!undo) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [trace?.seq, trace?.undo]);

  if (!trace) return null;
  const text = trace.kind === "saved"
    ? t("ai.snippets.traceSaved", { defaultValue: "已存入「{{g}}」", g: trace.group })
    : trace.placeholders
      ? t("ai.snippets.traceInsertedPh", { n: trace.name, c: trace.placeholders })
      : t("ai.snippets.traceInserted", { defaultValue: "已插入「{{n}}」", n: trace.name });

  return (
    <span className={`${styles.trace} ${trace.leaving ? styles.traceLeaving : ""}`}>
      {trace.kind === "saved" && <span className={styles.tracePlus}>+1</span>}
      <span className={styles.traceText}>{text}</span>
      {trace.undo && <span className={styles.traceUndo}>⌘Z {t("ai.snippets.undo", { defaultValue: "撤销" })}</span>}
    </span>
  );
}
