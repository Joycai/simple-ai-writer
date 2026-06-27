import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Sparkles, CheckCircle2, BookOpen } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { useAiTaskStore } from "../../stores/aiTaskStore";
import { LORE_CATEGORIES, type LoreEntity } from "../../lib/lore";
import styles from "./CommandPalette.module.css";

interface LoreHit { kind: "lore"; entity: LoreEntity; }
interface TextHit { kind: "text"; filePath: string; lineNum: number; preview: string; chapterTitle: string; }
interface ActionHit { kind: "action"; id: "ask" | "check"; label: string; }

type Hit = LoreHit | TextHit | ActionHit;

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className={styles.itemHl}>{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

export function CommandPalette() {
  const { t } = useTranslation();
  const { showCommandPalette, setShowCommandPalette, setShowAiDrawer } = useAppStore();
  const { index: loreIndex } = useLoreStore();
  const { fileTree, setActiveFilePath } = useProjectStore();
  const { content } = useEditorStore();
  const setSelection = useAiTaskStore((s) => s.setSelection);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showCommandPalette) {
      setQuery("");
      setActive(0);
      // Focus after mount
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [showCommandPalette]);

  // Flatten lore for searching
  const allLore = useMemo(() => {
    const out: LoreEntity[] = [];
    for (const cat of LORE_CATEGORIES) {
      for (const e of (loreIndex[cat.id] ?? [])) out.push(e);
    }
    return out;
  }, [loreIndex]);

  // Cross-doc text search would walk fileTree; today only the active editor content is searched.
  void fileTree;

  const hits = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // Show top lore entries
      const top: Hit[] = allLore.slice(0, 6).map((e) => ({ kind: "lore" as const, entity: e }));
      return top;
    }
    const ql = q.toLowerCase();
    const out: Hit[] = [];

    // Lore matches
    for (const e of allLore) {
      if (
        e.name.toLowerCase().includes(ql) ||
        e.aliases.some((a) => a.toLowerCase().includes(ql))
      ) {
        out.push({ kind: "lore", entity: e });
      }
      if (out.length >= 8) break;
    }

    // Text matches in current editor content
    const lines = content.split("\n");
    let textHits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(ql)) {
        out.push({
          kind: "text",
          filePath: "current",
          lineNum: i + 1,
          preview: lines[i].slice(0, 80),
          chapterTitle: t("editor.untitled"),
        });
        textHits++;
        if (textHits >= 5) break;
      }
    }

    // AI actions
    out.push({ kind: "action", id: "ask", label: `问 AI："${q}"` });
    out.push({ kind: "action", id: "check", label: `核对一致性 · 关于 ${q}` });

    return out;
  }, [query, allLore, content, t]);

  // Reset active when hits change
  useEffect(() => { setActive(0); }, [query]);

  const runHit = (h: Hit) => {
    if (h.kind === "lore") {
      setActiveFilePath(`${h.entity.dirPath}/index.md`);
      setShowCommandPalette(false);
    } else if (h.kind === "text") {
      // Just close — line jump would require editor API
      setShowCommandPalette(false);
    } else if (h.kind === "action") {
      if (h.id === "check") {
        setShowAiDrawer(true, "consistency");
      } else {
        setSelection(query);
        setShowAiDrawer(true, "generate");
      }
      setShowCommandPalette(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hits[active]) runHit(hits[active]);
    }
  };

  if (!showCommandPalette) return null;

  const loreHits = hits.filter((h): h is LoreHit => h.kind === "lore");
  const textHits = hits.filter((h): h is TextHit => h.kind === "text");
  const actionHits = hits.filter((h): h is ActionHit => h.kind === "action");

  return (
    <div className={styles.backdrop} onClick={() => setShowCommandPalette(false)}>
      <div className={styles.palette} onClick={(e) => e.stopPropagation()}>
        <div className={styles.inputRow}>
          <Search size={16} color="var(--color-sienna)" strokeWidth={1.6} />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("sidebar.projectSearch")}
          />
          <span className={styles.scopeChip}>/ 设定</span>
          <span className={styles.scopeChip}>? AI</span>
          <span className={styles.escKey}>esc</span>
        </div>

        <div className={styles.results}>
          {hits.length === 0 ? (
            <div className={styles.empty}>无匹配结果</div>
          ) : (
            <>
              {loreHits.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>设定 · {loreHits.length} 项</div>
                  {loreHits.map((h, i) => {
                    const idx = hits.indexOf(h);
                    return (
                      <div
                        key={h.entity.id}
                        className={`${styles.item} ${idx === active ? styles.itemActive : ""}`}
                        onClick={() => runHit(h)}
                        onMouseEnter={() => setActive(idx)}
                      >
                        <div className={styles.itemIcon}>
                          <BookOpen size={11} color="var(--color-card)" strokeWidth={1.6} />
                        </div>
                        <div className={styles.itemMain}>
                          <div className={styles.itemTitle}>{highlight(h.entity.name, query)}</div>
                          <div className={styles.itemSub}>{h.entity.summary || h.entity.aliases.join(" · ")}</div>
                        </div>
                        {i === 0 && idx === active && (
                          <>
                            <span className={styles.itemAction}>↗ 打开</span>
                            <span className={styles.itemKey}>↵</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {textHits.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>正文 · {textHits.length} 处</div>
                  {textHits.map((h) => {
                    const idx = hits.indexOf(h);
                    return (
                      <div
                        key={`${h.filePath}-${h.lineNum}`}
                        className={`${styles.item} ${idx === active ? styles.itemActive : ""}`}
                        onClick={() => runHit(h)}
                        onMouseEnter={() => setActive(idx)}
                      >
                        <span className={styles.itemIconLine}>{String(h.lineNum).padStart(2, "0")}</span>
                        <div className={styles.itemMain}>
                          <div className={styles.itemTitle}>第 {h.lineNum} 行</div>
                          <div className={styles.itemSub}>"{highlight(h.preview, query)}"</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {actionHits.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>AI · 操作</div>
                  {actionHits.map((h) => {
                    const idx = hits.indexOf(h);
                    return (
                      <div
                        key={h.id}
                        className={`${styles.item} ${idx === active ? styles.itemActive : ""}`}
                        onClick={() => runHit(h)}
                        onMouseEnter={() => setActive(idx)}
                      >
                        <div
                          className={styles.itemIcon}
                          style={{
                            background: "var(--color-card)",
                            border: "1px solid var(--color-border-strong)",
                            color: "var(--color-sienna)",
                          }}
                        >
                          {h.id === "check"
                            ? <CheckCircle2 size={11} strokeWidth={1.8} />
                            : <Sparkles size={11} strokeWidth={1.8} />}
                        </div>
                        <div className={styles.itemMain}>
                          <div className={styles.itemTitle}>{h.label}</div>
                        </div>
                        <span className={styles.itemKey}>⌘ ⏎</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <span><span className={styles.footerKey}>↑ ↓</span>导航</span>
          <span><span className={styles.footerKey}>↵</span>打开</span>
          <span><span className={styles.footerKey}>⌘↵</span>问 AI</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontStyle: "italic" }}>
            前缀 <span style={{ color: "var(--color-sienna)", fontFamily: "var(--font-mono)" }}>/ ?</span> 限定范围
          </span>
        </div>
      </div>
    </div>
  );
}
