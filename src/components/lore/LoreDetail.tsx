import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Sparkles, FolderOpen, ExternalLink } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { LORE_CATEGORIES, type LoreEntity } from "../../lib/lore";
import { useProjectStore } from "../../stores/projectStore";
import { readFile } from "../../lib/fileio";
import { LoreImproveModal } from "./LoreImproveModal";
import styles from "./LoreDetail.module.css";

interface Props {
  entity: LoreEntity;
  onBack: () => void;
}

const TABS = [
  { id: "summary", label: "概要" },
  { id: "relations", label: "关系" },
  { id: "appearances", label: "出场" },
  { id: "history", label: "历史" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export function LoreDetail({ entity, onBack }: Props) {
  const { t } = useTranslation();
  const { setActiveFilePath } = useProjectStore();
  const [tab, setTab] = useState<Tab>("summary");
  const [content, setContent] = useState<string>("");
  const [showImprove, setShowImprove] = useState(false);

  useEffect(() => {
    const indexPath = `${entity.dirPath}/index.md`;
    readFile(indexPath)
      .then((raw) => {
        // strip frontmatter
        const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
        setContent(m ? raw.slice(m[0].length) : raw);
      })
      .catch(() => setContent(""));
  }, [entity.dirPath]);

  const cat = LORE_CATEGORIES.find((c) => c.id === entity.category);

  const openInEditor = () => {
    setActiveFilePath(`${entity.dirPath}/index.md`);
  };
  const reveal = async () => {
    try { await revealItemInDir(entity.dirPath); } catch { /* best-effort */ }
  };

  return (
    <div className={styles.detail}>
      {showImprove && (
        <LoreImproveModal entity={entity} onClose={() => setShowImprove(false)} />
      )}

      <div className={styles.topBar}>
        <button className={styles.back} onClick={onBack}>
          <ArrowLeft size={11} strokeWidth={1.8} />
          {t("common.back", { defaultValue: "返回" })}
        </button>
        <span className={styles.crumb}>
          LORE <span className={styles.crumbBold}>/</span>
          {cat?.labelZh ?? entity.category} <span className={styles.crumbBold}>/</span>
          <span className={styles.crumbBold}>{entity.name}</span>
        </span>
        <span className={styles.spacer} />
        <button className={styles.actionBtn} onClick={() => setShowImprove(true)}>
          <Sparkles size={11} /> {t("lore.panel.aiImprove")}
        </button>
        <button className={styles.actionBtn} onClick={openInEditor}>
          <ExternalLink size={11} /> {t("lore.form.save", { defaultValue: "在编辑器中打开" })}
        </button>
        <button className={styles.actionBtn} onClick={reveal}>
          <FolderOpen size={11} /> {t("lore.panel.showInBrowser")}
        </button>
      </div>

      <div className={styles.hero}>
        <div className={styles.avatar}>{entity.name.charAt(0)}</div>
        <div className={styles.heroText}>
          <div className={styles.eyebrow}>{cat?.labelEn ?? entity.category}</div>
          <div className={styles.heroName}>{entity.name}</div>
          {entity.aliases.length > 0 && (
            <div className={styles.heroAliases}>
              {entity.aliases.map((a) => (
                <span key={a} className={styles.alias}>{a}</span>
              ))}
            </div>
          )}
          {entity.summary && <div className={styles.heroSummary}>"{entity.summary}"</div>}
        </div>
      </div>

      <div className={styles.tabs}>
        {TABS.map((tt) => (
          <button
            key={tt.id}
            className={`${styles.tab} ${tab === tt.id ? styles.tabActive : ""}`}
            onClick={() => setTab(tt.id)}
          >
            {tt.label}
          </button>
        ))}
      </div>

      <div className={styles.body}>
        {tab === "summary" ? (
          content
            ? <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0 }}>{content}</pre>
            : <div className={styles.notLoaded}>无内容</div>
        ) : (
          <div className={styles.notLoaded}>
            {tab === "relations" && "关系图谱 — 待接入"}
            {tab === "appearances" && "出场记录 — 待接入"}
            {tab === "history" && "编辑历史 — 待接入"}
          </div>
        )}
      </div>
    </div>
  );
}
