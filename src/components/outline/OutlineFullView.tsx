import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import type { FileNode } from "../../lib/project";
import styles from "./OutlineFullView.module.css";

interface Volume {
  name: string;
  path: string;
  chapters: { name: string; path: string; isDir: boolean }[];
}

/** Group manuscript files by top-level "volume" folder under writing/. */
function groupByVolume(tree: FileNode[]): Volume[] {
  // Find the writing/ folder
  const writingNode = tree.find((n) => n.is_dir && n.name === "writing");
  if (!writingNode || !writingNode.children) return [];

  const volumes: Volume[] = [];
  for (const child of writingNode.children) {
    if (child.is_dir) {
      volumes.push({
        name: child.name,
        path: child.path,
        chapters: (child.children ?? [])
          .filter((c) => !c.is_dir && c.name.endsWith(".md"))
          .map((c) => ({ name: c.name, path: c.path, isDir: false })),
      });
    }
  }

  // If no volume folders, treat top-level writing files as one default volume
  const topLevelFiles = writingNode.children.filter((c) => !c.is_dir && c.name.endsWith(".md"));
  if (topLevelFiles.length > 0 && volumes.length === 0) {
    volumes.push({
      name: writingNode.name,
      path: writingNode.path,
      chapters: topLevelFiles.map((c) => ({ name: c.name, path: c.path, isDir: false })),
    });
  }

  return volumes;
}

export function OutlineFullView() {
  const { t } = useTranslation();
  const { fileTree, activeFilePath, setActiveFilePath, wordCount } = useProjectStore();
  const setMainView = useAppStore((s) => s.setMainView);
  void useEditorStore; // reserved for future "AI suggest next chapter" integration

  const volumes = useMemo(() => groupByVolume(fileTree as any), [fileTree]);
  const allChaptersCount = volumes.reduce((s, v) => s + v.chapters.length, 0);
  const activeVolumeIdx = volumes.findIndex((v) => v.chapters.some((c) => c.path === activeFilePath));

  if (volumes.length === 0) {
    return (
      <div className={styles.view}>
        <div className={styles.header}>
          <div className={styles.headRow}>
            <div className={styles.title}>{t("sidebar.outline")}</div>
            <div className={styles.subtitle}>{t("titleBar.noProject")}</div>
          </div>
        </div>
        <div className={styles.empty}>
          {t("outline.empty", {
            defaultValue: "未发现卷/章节结构 — 在 writing/ 下创建子文件夹来组织卷",
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div className={styles.headRow}>
          <div className={styles.title}>{t("sidebar.outline")}</div>
          <div className={styles.subtitle}>
            {allChaptersCount} 章 · {wordCount.toLocaleString()} 字
          </div>
          <span className={styles.spacer} />
          <div className={styles.viewToggle}>
            <button className={`${styles.viewTab} ${styles.viewTabActive}`}>章节卡</button>
            <button className={styles.viewTab}>时间线</button>
            <button className={styles.viewTab}>看板</button>
          </div>
          <button className={styles.aiSuggestBtn}>
            <Sparkles size={10} strokeWidth={1.8} />
            AI 建议下一章
          </button>
        </div>
        <div className={styles.stats}>
          <span>
            <span className={styles.statValue}>{wordCount.toLocaleString()}</span> 字
          </span>
          <span className={styles.statSep} />
          <span><span className={styles.statDot} style={{ color: "var(--color-success)" }}>●</span> 完 {allChaptersCount}</span>
          <span style={{ margin: "0 10px" }} />
          <span><span className={styles.statDot} style={{ color: "var(--color-sienna)" }}>●</span> 在写 {activeFilePath ? 1 : 0}</span>
          <span className={styles.spacer} />
          <span>平均 <span className={styles.statValue}>{allChaptersCount > 0 ? Math.round(wordCount / allChaptersCount).toLocaleString() : 0}</span> 字 / 章</span>
        </div>
      </div>

      <div className={styles.columns}>
        {volumes.map((vol, vi) => {
          const isCurrent = vi === activeVolumeIdx;
          return (
            <div key={vol.path} className={`${styles.column} ${isCurrent ? styles.columnCurrent : ""}`}>
              <div className={styles.colHead}>
                <div>
                  <div className={isCurrent ? styles.colEyebrow : styles.colEyebrowMuted}>
                    VOL {vi + 1}{isCurrent ? " · CURRENT" : ""}
                  </div>
                  <div className={isCurrent ? styles.colTitle : styles.colTitleMuted}>
                    {vol.name}
                  </div>
                </div>
                <span className={`${styles.colCount} ${
                  isCurrent ? styles.colCountActive : styles.colCountDone
                }`}>
                  {vol.chapters.length} 章
                </span>
              </div>

              <div className={styles.chapters}>
                {vol.chapters.map((ch, ci) => {
                  const active = ch.path === activeFilePath;
                  const title = ch.name.replace(/\.md$/i, "");
                  return (
                    <div
                      key={ch.path}
                      className={`${styles.chapter} ${active ? styles.chapterActive : ""}`}
                      onClick={() => {
                        setActiveFilePath(ch.path);
                        setMainView("editor");
                      }}
                    >
                      <div className={styles.chapterTop}>
                        <span className={styles.chapterNum}>{String(ci + 1).padStart(2, "0")}</span>
                        <span className={styles.chapterName}>{title}</span>
                        {active && <span className={styles.chapterStatus}>在写</span>}
                      </div>
                    </div>
                  );
                })}

                {vol.chapters.length === 0 && (
                  <div className={styles.placeholderCard}>
                    <div>+ 待规划</div>
                    <div>AI 可基于现有伏笔生成大纲建议</div>
                  </div>
                )}
              </div>

              {!isCurrent && vi === volumes.length - 1 && (
                <div className={styles.aiCard}>
                  <div className={styles.aiCardHead}>
                    <Sparkles size={11} strokeWidth={1.8} />
                    AI · 下一章建议
                  </div>
                  <div className={styles.aiCardBody}>
                    点击上方"AI 建议下一章"获取基于现有伏笔的章节建议。
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
