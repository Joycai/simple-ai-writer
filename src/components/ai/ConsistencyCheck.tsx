import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2, CheckCircle2 } from "lucide-react";
import styles from "./ConsistencyCheck.module.css";

type Severity = "conflict" | "warning" | "pass";

interface Issue {
  id: string;
  severity: Severity;
  title: string;
  category: string;
  current: string;
  reference: string;
  suggestion?: string;
}

/**
 * Consistency check is a future feature — wired into the AI drawer.
 * For now it shows a thoughtful empty state inviting the user to run a scan,
 * with a sample-style structure for when real issues land.
 */
export function ConsistencyCheck() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"all" | "character" | "place" | "item" | "time">("all");
  const [issues] = useState<Issue[]>([]); // populated by future scan action

  const counts = {
    all: issues.length,
    conflict: issues.filter((i) => i.severity === "conflict").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    pass: issues.filter((i) => i.severity === "pass").length,
  };

  const filtered = filter === "all" ? issues : issues;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className={styles.wrap}>
        <div className={styles.filterTabs}>
          {(["all", "character", "place", "item", "time"] as const).map((f) => (
            <button
              key={f}
              className={`${styles.filterTab} ${filter === f ? styles.filterTabActive : ""}`}
              onClick={() => setFilter(f)}
            >
              {t(`ai.consistency.filter.${f}`, {
                defaultValue: f === "all" ? "全部" : f === "character" ? "人物" : f === "place" ? "地点" : f === "item" ? "物品" : "时序",
              })}
              {f === "all" && counts.all > 0 && (
                <span className={styles.filterTabBadge} style={{ color: "var(--color-error)" }}>{counts.all}</span>
              )}
            </button>
          ))}
          <span className={styles.spacer} />
          <button className={styles.linkBtn}>⟳ {t("ai.consistency.rerun", { defaultValue: "重新检查" })}</button>
        </div>

        {filtered.length === 0 ? (
          <div className={styles.emptyState}>
            <CheckCircle2 size={40} strokeWidth={1.2} color="var(--color-success)" style={{ marginBottom: 16 }} />
            <div className={styles.emptyTitle}>
              {t("ai.consistency.emptyTitle", { defaultValue: "尚未运行一致性检查" })}
            </div>
            <div className={styles.emptyText}>
              {t("ai.consistency.emptyText", {
                defaultValue: "AI 会对照设定库核对本章的人物、地点、物品、时序，列出冲突与提醒。",
              })}
            </div>
            <button className={styles.emptyBtn}>
              <Wand2 size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {t("ai.consistency.run", { defaultValue: "开始检查" })}
            </button>
          </div>
        ) : (
          <div className={styles.issueList}>
            {filtered.map((it) => (
              <div
                key={it.id}
                className={`${styles.issue} ${
                  it.severity === "conflict" ? styles.issueConflict :
                  it.severity === "warning" ? styles.issueWarning : styles.issuePass
                }`}
              >
                <div className={styles.issueHead}>
                  <span className={`${styles.severityChip} ${
                    it.severity === "conflict" ? styles.sevConflict : styles.sevWarning
                  }`}>
                    {it.severity === "conflict" ? "冲突" : "提醒"}
                  </span>
                  <span className={styles.issueTitle}>{it.title}</span>
                  <span className={styles.issueMeta}>{it.category}</span>
                  <span className={styles.spacer} />
                  <button className={styles.linkBtn}>↗ 跳到原文</button>
                </div>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>本章</span>
                  <span className={
                    it.severity === "conflict" ? styles.highlight : styles.highlightWarn
                  }>{it.current}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>设定</span>
                  <span>{it.reference}</span>
                </div>
                {it.suggestion && (
                  <div className={styles.actions}>
                    <button className={styles.actBtnPrimary}>应用建议</button>
                    <button className={styles.actBtnSecondary}>保留</button>
                    <button className={styles.actBtnGhost}>忽略</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.footerHint}>
          {t("ai.consistency.footerHint", {
            defaultValue: "建议先解决冲突，再继续写作",
          })}
        </span>
        <button className={styles.actBtnGhost} disabled={filtered.length === 0}>
          {t("ai.consistency.ignoreAll", { defaultValue: "全部忽略" })}
        </button>
        <button className={styles.actBtnPrimary} disabled={filtered.length === 0}>
          {t("ai.consistency.applyAll", { defaultValue: "应用建议" })}
        </button>
      </div>
    </div>
  );
}
