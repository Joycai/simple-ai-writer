/**
 * Model picker for the assistant header.
 *
 * Closed it reads as a statement of fact — provider, model, context window —
 * with the provider deliberately quiet: the author changes models far more
 * often than providers, so the model name is the thing to look at.
 *
 * Open it is a searchable list grouped by provider. Two decisions carry the
 * design: qualifiers and namespaces are lifted out of the model name (see
 * lib/ai/modelLabel) so long names never need truncating, and the current
 * selection is marked with a rule down its left edge rather than a filled bar —
 * a highlight block would out-shout the list it sits in.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Search, ShieldAlert } from "lucide-react";
import type { Model, Provider } from "../../lib/ai/configDb";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { blockedModelIds, noteModelUsed, recentModelIds } from "../../lib/ai/modelHealth";
import { contextLabel, parseModelLabel } from "../../lib/ai/modelLabel";
import { MOD_KEY } from "../../lib/platform";
import styles from "./ModelSelector.module.css";

/** Context size at which a model is worth surfacing under 「长上下文」. */
const LONG_CONTEXT_MIN = 128_000;

type FilterId = "all" | "recent" | "local" | "long";

const FILTERS: { id: FilterId; labelKey: string; fallback: string }[] = [
  { id: "all",    labelKey: "ai.modelPicker.filterAll",    fallback: "全部" },
  { id: "recent", labelKey: "ai.modelPicker.filterRecent", fallback: "常用" },
  { id: "local",  labelKey: "ai.modelPicker.filterLocal",  fallback: "本地" },
  { id: "long",   labelKey: "ai.modelPicker.filterLong",   fallback: "长上下文" },
];

/** A provider is "local" when its endpoint resolves to this machine. */
function isLocalProvider(provider: Provider): boolean {
  if (!provider.baseUrl) return false;
  try {
    const host = new URL(provider.baseUrl).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host === "0.0.0.0" ||
      host.startsWith("127.") || host.endsWith(".local");
  } catch {
    return false;
  }
}

interface Row {
  model: Model;
  provider: Provider | undefined;
}

export function ModelSelector() {
  const { t } = useTranslation();
  const { models, providers, activeModelId, setActiveModel } = useAiStore();
  const openSettings = useAppStore((s) => s.openSettings);
  const modelPickerNonce = useAppStore((s) => s.modelPickerNonce);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Read once per opening: both are preference-backed and must not change
  // under the author mid-scroll (a pick would reorder 常用 beneath the cursor).
  const [recent, setRecent] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!open) return;
    setRecent(recentModelIds());
    setBlocked(blockedModelIds());
    setQuery("");
    setFilter("all");
    inputRef.current?.focus();
  }, [open]);

  // Someone elsewhere in the assistant asked for the picker — e.g. the failed
  // run's 换模型重试. Skips the initial render, whose nonce is the seed value.
  const seenNonce = useRef(modelPickerNonce);
  useEffect(() => {
    if (modelPickerNonce === seenNonce.current) return;
    seenNonce.current = modelPickerNonce;
    setOpen(true);
  }, [modelPickerNonce]);

  const activeModel = models.find((m) => m.id === activeModelId);
  const activeProvider = activeModel
    ? providers.find((p) => p.id === activeModel.providerId)
    : undefined;

  // ── Filtering ──────────────────────────────────────────────────────────────
  const allRows: Row[] = useMemo(
    () => models.map((model) => ({ model, provider: providers.find((p) => p.id === model.providerId) })),
    [models, providers],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter(({ model, provider }) => {
      if (filter === "recent" && !recent.includes(model.id)) return false;
      if (filter === "local" && !(provider && isLocalProvider(provider))) return false;
      if (filter === "long" && (model.contextSize ?? 0) < LONG_CONTEXT_MIN) return false;
      if (!q) return true;
      // Search the raw name too, so a qualifier lifted into a chip is still findable.
      return `${model.name} ${model.modelId} ${provider?.name ?? ""}`.toLowerCase().includes(q);
    });
  }, [allRows, query, filter, recent]);

  // ── Grouping by provider, in the providers' own order ──────────────────────
  const groups = useMemo(() => {
    const byProvider = new Map<string, { provider: Provider | undefined; rows: Row[] }>();
    for (const row of rows) {
      const key = row.provider?.id ?? "__none__";
      if (!byProvider.has(key)) byProvider.set(key, { provider: row.provider, rows: [] });
      byProvider.get(key)!.rows.push(row);
    }
    return [...byProvider.values()];
  }, [rows]);

  /** Flattened order, so ↑/↓ walk the list as it reads. */
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  useEffect(() => {
    // Land on the current model when opening; clamp when filtering shrinks the list.
    const current = flat.findIndex((r) => r.model.id === activeModelId);
    setActiveIndex(current >= 0 ? current : 0);
  }, [flat, activeModelId]);

  // Keep the highlighted row in view during keyboard traversal.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const choose = (model: Model) => {
    setActiveModel(model.id);
    noteModelUsed(model.id);
    setOpen(false);
  };

  // ── Keyboard ───────────────────────────────────────────────────────────────
  // Capture phase: Escape must close this popover *without* also closing the
  // drawer, whose handler sits on window in the bubble phase (see App.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Dismiss on outside click / focus leaving the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = flat[activeIndex];
      if (row) choose(row.model);
    }
  };

  const triggerLabel = activeModel ? parseModelLabel(activeModel.name, activeModel.modelId) : null;
  const triggerContext = contextLabel(activeModel?.contextSize);
  const modKeyM = MOD_KEY === "⌘" ? "⌘M" : "Ctrl M";

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeModel ? `${activeProvider?.name ?? ""} / ${activeModel.name}` : undefined}
      >
        <span className={`${styles.dot} ${activeModel ? styles.dotOn : ""}`} />
        {activeModel ? (
          <>
            {activeProvider && <span className={styles.triggerProvider}>{activeProvider.name}</span>}
            <span className={styles.triggerSep}>/</span>
            <span className={styles.triggerModel}>{triggerLabel?.title}</span>
            {triggerContext && <span className={styles.ctxBadge}>{triggerContext}</span>}
          </>
        ) : (
          <span className={styles.triggerEmpty}>{t("ai.panel.selectModel")}</span>
        )}
        <span className={styles.triggerRight}>
          <span className={styles.shortcut}>{modKeyM}</span>
          <ChevronDown size={13} strokeWidth={1.6} />
        </span>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" onKeyDown={onListKeyDown}>
          <div className={styles.searchRow}>
            <Search size={13} strokeWidth={1.7} className={styles.searchIcon} />
            <input
              ref={inputRef}
              className={styles.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ai.modelPicker.search", { defaultValue: "搜索模型…" })}
            />
            <span className={styles.searchCount}>
              {rows.length} / {models.length}
            </span>
          </div>

          <div className={styles.filterRow}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`${styles.filterChip} ${filter === f.id ? styles.filterChipActive : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {t(f.labelKey, { defaultValue: f.fallback })}
              </button>
            ))}
          </div>

          <div className={styles.list} ref={listRef}>
            {flat.length === 0 ? (
              <div className={styles.empty}>
                {models.length === 0
                  ? t("ai.panel.noProvider")
                  : t("ai.modelPicker.noMatch", { defaultValue: "没有匹配的模型" })}
              </div>
            ) : (
              groups.map((group) => {
                const local = group.provider && isLocalProvider(group.provider);
                return (
                  <div key={group.provider?.id ?? "__none__"} className={styles.group}>
                    <div className={styles.groupHead}>
                      <span className={styles.groupName}>
                        {group.provider?.name ?? t("ai.modelPicker.ungrouped", { defaultValue: "其他" })}
                        {local && (
                          <span className={styles.groupTag}>
                            · {t("ai.modelPicker.localTag", { defaultValue: "本地" })}
                          </span>
                        )}
                      </span>
                      <span className={styles.groupRule} />
                      <span className={styles.groupCount}>{group.rows.length}</span>
                    </div>
                    {group.rows.map((row) => {
                      const idx = flat.indexOf(row);
                      const label = parseModelLabel(row.model.name, row.model.modelId);
                      const ctx = contextLabel(row.model.contextSize);
                      const selected = row.model.id === activeModelId;
                      return (
                        <button
                          key={row.model.id}
                          data-idx={idx}
                          role="option"
                          aria-selected={selected}
                          className={`${styles.item} ${selected ? styles.itemSelected : ""} ${idx === activeIndex ? styles.itemActive : ""}`}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={() => choose(row.model)}
                        >
                          <span className={styles.itemMain}>
                            <span className={styles.itemTitleRow}>
                              <span className={styles.itemTitle}>{label.title}</span>
                              {label.badges.map((b) => (
                                <span key={b} className={styles.itemBadge}>{b}</span>
                              ))}
                            </span>
                            {label.subtitle && (
                              <span className={styles.itemSubtitle}>{label.subtitle}</span>
                            )}
                          </span>
                          {blocked.has(row.model.id) && (
                            <span
                              className={styles.itemWarn}
                              title={t("ai.modelPicker.safetyBlockedHint", {
                                defaultValue: "上次请求被该模型的安全过滤拦截",
                              })}
                            >
                              <ShieldAlert size={11} strokeWidth={1.8} />
                              {t("ai.modelPicker.safetyBlocked", { defaultValue: "上次被安全过滤" })}
                            </span>
                          )}
                          {ctx && <span className={styles.itemCtx}>{ctx}</span>}
                          <span className={styles.itemCheck}>
                            {selected && <Check size={13} strokeWidth={2} />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          <div className={styles.footer}>
            <span className={styles.hint}>
              ↑↓ {t("ai.modelPicker.navSelect", { defaultValue: "选择" })}
            </span>
            <span className={styles.hint}>
              ↵ {t("ai.modelPicker.navConfirm", { defaultValue: "确认" })}
            </span>
            <span className={styles.hint}>
              esc {t("ai.modelPicker.navClose", { defaultValue: "关闭" })}
            </span>
            <button
              className={styles.manageBtn}
              onClick={() => { setOpen(false); openSettings("providers-models"); }}
            >
              {t("ai.modelPicker.manageProviders", { defaultValue: "管理供应商" })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
