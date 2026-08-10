import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Pencil, Search, X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import type { Model, ModelType } from "../../../lib/ai/configDb";
import { ProviderDrawer } from "./ProviderDrawer";
import { ModelDrawer } from "./ModelDrawer";
import styles from "../settingsCommon.module.css";
import hub from "./ProvidersModels.module.css";

const TYPE_FILTERS: (ModelType | "all")[] = ["all", "text", "multimodal", "image", "video"];

/** Bucket for models whose provider is gone — a config import can leave those
 *  behind, and grouping by provider would otherwise hide them entirely. */
const ORPHAN_ID = "__orphan__";

type Drawer =
  | { kind: "provider"; providerId: string | null; apiKey: string }
  | { kind: "model"; providerId: string; modelId: string | null }
  | null;

interface Props {
  /** Lets the page route Escape to the drawer while one is open, and to the
   *  page itself otherwise. Called with null when nothing is intercepting. */
  onEscapeInterceptChange: (handler: (() => void) | null) => void;
}

export function ProvidersModelsPane({ onEscapeInterceptChange }: Props) {
  const { t } = useTranslation();
  const { providers, models, removeProvider, removeModel, getApiKey } = useAiStore();

  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ModelType | "all">("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onEscapeInterceptChange(drawer ? () => setDrawer(null) : null);
    return () => onEscapeInterceptChange(null);
  }, [drawer, onEscapeInterceptChange]);

  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const known = new Set(providers.map((p) => p.id));
    const orphans = models.filter((m) => !known.has(m.providerId));

    const rows: {
      id: string;
      name: string;
      std: string | null;
      url: string | null;
      all: Model[];
      shown: Model[];
      visible: boolean;
    }[] = [];

    const build = (id: string, name: string, std: string | null, url: string | null, all: Model[]) => {
      const nameMatch = !q || name.toLowerCase().includes(q) || (url ?? "").toLowerCase().includes(q);
      const shown = all.filter(
        (m) =>
          (typeFilter === "all" || m.type === typeFilter) &&
          (nameMatch || `${m.name} ${m.modelId}`.toLowerCase().includes(q)),
      );
      rows.push({
        id, name, std, url, all, shown,
        visible: shown.length > 0 || (nameMatch && typeFilter === "all"),
      });
    };

    for (const p of providers) {
      build(p.id, p.name, p.apiStandard, p.baseUrl || null, models.filter((m) => m.providerId === p.id));
    }
    if (orphans.length > 0) {
      build(ORPHAN_ID, t("aiConfig.hub.unknownProvider"), null, null, orphans);
    }
    return rows.filter((r) => r.visible);
  }, [providers, models, q, typeFilter, t]);

  const openProviderDrawer = async (providerId: string | null) => {
    setError(null);
    let apiKey = "";
    if (providerId) {
      try {
        apiKey = (await getApiKey(providerId)) ?? "";
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setDrawer({ kind: "provider", providerId, apiKey });
  };

  const handleDeleteProvider = (id: string, name: string, count: number) => {
    if (!window.confirm(t("aiConfig.hub.deleteProviderConfirm", { name, count }))) return;
    removeProvider(id);
  };

  const chip = (label: string, active: boolean, onClick: () => void, key: string) => (
    <button key={key} className={`${hub.chip} ${active ? hub.chipActive : ""}`} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div className={hub.hub}>
      <div className={hub.head}>
        <div className={hub.headRow}>
          <div>
            <div className={hub.headTitle}>{t("systemSettings.tabs.providersModels")}</div>
            <div className={hub.headSummary}>
              {t("aiConfig.hub.summary", { providers: providers.length, models: models.length })}
            </div>
          </div>
          <span className={hub.headSpacer} />
          <button className={styles.btnPrimary} onClick={() => openProviderDrawer(null)}>
            + {t("aiConfig.providers.add")}
          </button>
        </div>

        <div className={hub.toolbar}>
          <div className={hub.searchWrap}>
            <Search size={14} className={hub.searchIcon} />
            <input
              className={hub.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("aiConfig.hub.searchPlaceholder")}
            />
          </div>
          {TYPE_FILTERS.map((f) =>
            chip(
              f === "all" ? t("aiConfig.hub.filterAll") : t(`aiConfig.modelTypes.${f}`),
              typeFilter === f,
              () => setTypeFilter(f),
              f,
            ),
          )}
        </div>
      </div>

      <div className={hub.list}>
        {error && <div className={styles.errorNote}>{error}</div>}

        {providers.length === 0 && groups.length === 0 && !q && (
          <div className={styles.emptyNote}>{t("aiConfig.providers.empty")}</div>
        )}

        {groups.map((g) => {
          const isOrphan = g.id === ORPHAN_ID;
          // A search shows everything it matched — collapsing would hide the hit.
          const open = q ? true : !collapsed[g.id];
          return (
            <div key={g.id} className={hub.group}>
              <div
                className={hub.groupHead}
                onClick={() => setCollapsed((c) => ({ ...c, [g.id]: open }))}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setCollapsed((c) => ({ ...c, [g.id]: open }));
                  }
                }}
              >
                <span className={`${hub.chevron} ${open ? hub.chevronOpen : ""}`}>
                  <ChevronRight size={14} />
                </span>
                <span className={hub.groupName}>{g.name}</span>
                {g.std && <span className={hub.groupStd}>{g.std}</span>}
                {!isOrphan && (
                  <span className={hub.groupUrl}>{g.url ?? t("aiConfig.providers.defaultEndpoint")}</span>
                )}
                <span className={hub.groupSpacer} />
                {g.all.length > 0 && (
                  <span className={hub.groupCount}>{t("aiConfig.hub.modelCount", { count: g.all.length })}</span>
                )}
                {!isOrphan && (
                  <>
                    <button
                      className={hub.groupBtn}
                      title={t("aiConfig.hub.addModelTitle")}
                      onClick={(e) => { e.stopPropagation(); setDrawer({ kind: "model", providerId: g.id, modelId: null }); }}
                    >
                      + {t("aiConfig.hub.addModel")}
                    </button>
                    <button
                      className={hub.iconBtn}
                      title={t("aiConfig.hub.editProvider")}
                      onClick={(e) => { e.stopPropagation(); void openProviderDrawer(g.id); }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className={`${hub.iconBtn} ${hub.iconBtnDanger}`}
                      title={t("aiConfig.hub.deleteProvider")}
                      onClick={(e) => { e.stopPropagation(); handleDeleteProvider(g.id, g.name, g.all.length); }}
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>

              {open && (
                <div>
                  {g.shown.map((m) => (
                    <div
                      key={m.id}
                      className={hub.modelRow}
                      onClick={() => !isOrphan && setDrawer({ kind: "model", providerId: m.providerId, modelId: m.id })}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && !isOrphan) {
                          e.preventDefault();
                          setDrawer({ kind: "model", providerId: m.providerId, modelId: m.id });
                        }
                      }}
                    >
                      <span className={hub.modelName}>{m.name}</span>
                      <span className={hub.modelId}>{m.modelId}</span>
                      {m.contextSize ? (
                        <span className={hub.modelCtx}>{m.contextSize.toLocaleString()} ctx</span>
                      ) : null}
                      <span className={hub.groupSpacer} />
                      <span className={hub.modelType}>{t(`aiConfig.modelTypes.${m.type}`)}</span>
                      <button
                        className={`${hub.iconBtn} ${hub.iconBtnDanger}`}
                        title={t("aiConfig.hub.deleteModel")}
                        onClick={(e) => { e.stopPropagation(); removeModel(m.id); }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {g.all.length === 0 && !isOrphan && (
                    <div className={hub.groupEmpty}>
                      {t("aiConfig.hub.noModels")}{" "}
                      <button
                        className={hub.linkBtn}
                        onClick={() => setDrawer({ kind: "model", providerId: g.id, modelId: null })}
                      >
                        {t("aiConfig.hub.addFirstModel")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {groups.length === 0 && q && (
          <div className={hub.noResults}>
            {t("aiConfig.hub.noResults", { query })}
            <div className={hub.btnRow}>
              <button className={styles.btnSecondary} onClick={() => setQuery("")}>
                {t("aiConfig.hub.clearSearch")}
              </button>
            </div>
          </div>
        )}
      </div>

      {drawer && (
        <>
          <div className={hub.scrim} onClick={() => setDrawer(null)} />
          {drawer.kind === "provider" ? (
            <ProviderDrawer
              // Remount per target so the form seeds from the right provider.
              key={drawer.providerId ?? "new"}
              providerId={drawer.providerId}
              initialApiKey={drawer.apiKey}
              onClose={() => setDrawer(null)}
            />
          ) : (
            <ModelDrawer
              key={drawer.modelId ?? `new:${drawer.providerId}`}
              providerId={drawer.providerId}
              modelId={drawer.modelId}
              onClose={() => setDrawer(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
