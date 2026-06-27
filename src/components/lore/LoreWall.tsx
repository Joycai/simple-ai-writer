import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Sparkles, Plus } from "lucide-react";
import { useLoreStore } from "../../stores/loreStore";
import { LORE_CATEGORIES, type LoreEntity } from "../../lib/lore";
import { useAppStore } from "../../stores/appStore";
import { LoreGenerator } from "./LoreGenerator";
import { LoreDetail } from "./LoreDetail";
import styles from "./LoreWall.module.css";

// Per-category accent dot color
const CAT_COLOR: Record<string, string> = {
  characters: "var(--color-sienna)",
  world:      "var(--color-success)",
  items:      "var(--color-amber)",
  factions:   "var(--color-text-primary)",
  skills:     "#7BA8A6",
  custom:     "var(--color-text-muted)",
};

// Stable, deterministic small rotation per entity id
function rotationFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const r = ((h % 9) - 4) * 0.1; // -0.4 .. +0.4 deg
  return Number(r.toFixed(2));
}

export function LoreWall() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { index } = useLoreStore();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);

  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showGenerator, setShowGenerator] = useState(false);
  const [detailEntity, setDetailEntity] = useState<LoreEntity | null>(null);

  // Flatten + filter
  const allEntities = useMemo(() => {
    const flat: LoreEntity[] = [];
    for (const cat of LORE_CATEGORIES) {
      for (const e of (index[cat.id] ?? [])) flat.push(e);
    }
    return flat;
  }, [index]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: allEntities.length };
    for (const cat of LORE_CATEGORIES) {
      out[cat.id] = (index[cat.id] ?? []).length;
    }
    return out;
  }, [allEntities, index]);

  const filtered = useMemo(() => {
    let list = allEntities;
    if (filter !== "all") list = list.filter((e) => e.category === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.aliases.some((a) => a.toLowerCase().includes(q)) ||
          e.summary.toLowerCase().includes(q),
      );
    }
    return list;
  }, [allEntities, filter, search]);

  const totalRelations = 0; // future

  if (detailEntity) {
    return <LoreDetail entity={detailEntity} onBack={() => setDetailEntity(null)} />;
  }

  return (
    <div className={styles.wall}>
      {showGenerator && <LoreGenerator onClose={() => setShowGenerator(false)} />}

      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.eyebrow}>LORE LIBRARY</div>
          <div className={styles.title}>{t("sidebar.lore")}</div>
          <div className={styles.subtitle}>
            {counts.all} 条 · {totalRelations} 关系
          </div>
          <span className={styles.spacer} />

          <div className={styles.search}>
            <Search size={12} color="var(--color-text-muted)" strokeWidth={1.6} />
            <input
              className={styles.searchInput}
              placeholder={t("sidebar.projectSearch")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className={styles.searchKey} onClick={() => setShowCommandPalette(true)} style={{ cursor: "pointer" }}>⌘ K</span>
          </div>

          <button className={styles.btnSecondary} onClick={() => setShowGenerator(true)}>
            <Sparkles size={12} strokeWidth={1.6} />
            AI 提取
          </button>
          <button className={styles.btnPrimary}>
            <Plus size={12} strokeWidth={2.5} />
            {t("lore.panel.newEntry")}
          </button>
        </div>

        <div className={styles.filters}>
          <span
            className={`${styles.chip} ${filter === "all" ? styles.chipActive : ""}`}
            onClick={() => setFilter("all")}
          >
            {isZh ? "全部" : "All"}
            <span className={styles.chipCount}>{counts.all}</span>
          </span>
          {LORE_CATEGORIES.map((cat) => (
            <span
              key={cat.id}
              className={`${styles.chip} ${filter === cat.id ? styles.chipActive : ""}`}
              onClick={() => setFilter(cat.id)}
            >
              <span className={styles.chipDot} style={{ background: CAT_COLOR[cat.id] }} />
              {isZh ? cat.labelZh : cat.labelEn}
              <span className={styles.chipCount}>{counts[cat.id] ?? 0}</span>
            </span>
          ))}
        </div>
      </div>

      <div className={styles.gridWrap}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            {search.trim()
              ? "未找到匹配的设定"
              : "设定库为空 — 用 AI 提取或新建条目开始构建你的世界观"}
          </div>
        ) : (
          <div className={styles.grid}>
            {filtered.map((e, idx) => {
              const featured = idx === 0 && filter === "all";
              const rot = rotationFor(e.id);
              const cat = LORE_CATEGORIES.find((c) => c.id === e.category);
              return (
                <div
                  key={e.id}
                  className={`${styles.card} ${featured ? styles.cardFeatured : ""}`}
                  style={{ transform: `rotate(${rot}deg)` }}
                  onClick={() => setDetailEntity(e)}
                >
                  <div className={styles.cardTop}>
                    <span className={styles.cardLabel}>
                      {(isZh ? cat?.labelZh : cat?.labelEn) ?? e.category}
                    </span>
                  </div>
                  <div className={styles.cardHeader}>
                    <div
                      className={styles.cardAvatar}
                      style={{ background: CAT_COLOR[e.category] }}
                    >
                      {e.name.charAt(0)}
                    </div>
                    <div>
                      <div className={styles.cardName}>{e.name}</div>
                      <div className={styles.cardMeta}>{e.aliases.slice(0, 2).join(" · ")}</div>
                    </div>
                  </div>
                  <div className={styles.cardSummary}>
                    {e.summary || "—"}
                  </div>
                  {e.aliases.length > 0 && (
                    <div className={styles.cardTags}>
                      {e.aliases.slice(0, 4).map((a) => (
                        <span key={a} className={styles.cardTag}>{a}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* + new card */}
            <div className={styles.newCard} onClick={() => setShowGenerator(true)}>
              <Plus size={22} color="var(--color-sienna)" strokeWidth={1.6} />
              <div className={styles.newCardLabel}>新设定</div>
              <div className={styles.newCardHint}>手填或从手稿提取</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
