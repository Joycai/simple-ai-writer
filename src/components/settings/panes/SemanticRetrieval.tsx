import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore, useTerms } from "../../../stores/projectStore";
import { useAiStore } from "../../../stores/aiStore";
import { semanticPrefs, saveSemanticPrefs, type SemanticPrefs } from "../../../lib/context/semanticPrefs";
import { Select } from "../../common/Select";
import { SemanticIndexPanel } from "./SemanticIndexPanel";
import { Pane, PaneHeader, Row, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";
import styles from "./SemanticRetrieval.module.css";

export function SemanticRetrieval() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.projectPath);
  return <Pane>
    <PaneHeader title={t("semantic.title")} sub={t("semantic.paneSub")} />
    <ProjectRetrieval key={project ?? "none"} project={project} />
  </Pane>;
}
function ProjectRetrieval({ project }: { project: string | null }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [prefs, setPrefs] = useState(() => semanticPrefs(project));
  const models = useAiStore((s) => s.models);
  const providers = useAiStore((s) => s.providers);
  const update = (patch: Partial<SemanticPrefs>) => {
    const next = { ...semanticPrefs(project), ...patch }; setPrefs(next); saveSemanticPrefs(project, next);
  };
  const options = (ranking: boolean, selected: string) => [
    { value: "", label: t("semantic.none") },
    ...models.filter((m) => m.enabled && providers.some((p) => p.id === m.providerId) && m.type === (ranking ? "rerank" : "embedding"))
      .map((m) => ({ value: m.id, label: `${m.name} · ${providers.find((p) => p.id === m.providerId)?.name ?? t("semantic.unavailableChannel")}` })),
    ...(selected && !models.some((m) => m.id === selected && m.enabled && providers.some((p) => p.id === m.providerId) && m.type === (ranking ? "rerank" : "embedding"))
      ? [{ value: selected, label: t("semantic.unavailableModel") }] : []),
  ];
  return <>
    <section className={styles.group} aria-label={t(project ? "semantic.projectSettings" : "semantic.defaultSettings")}>
    <header className={styles.groupHeader}>
      <div><h3 className={styles.groupTitle}>{t(project ? "semantic.projectSettings" : "semantic.defaultSettings")}</h3>
        <p className={ui.rowDesc}>{project ? t("semantic.project", { name: project.split(/[\\/]/).pop() }) : t("semantic.noProject")}</p>
      </div>
      <span className={styles.scope}>{t(project ? "semantic.projectOnly" : "semantic.defaultScope")}</span>
    </header>
    <div className={styles.groupBody}>
    <Row title={t(project ? "semantic.enable" : "semantic.defaultEnable")} desc={t("semantic.description", { kb: terms.kb })}>
      <Toggle on={prefs.enabled} onChange={(enabled) => update({ enabled })} label={t(project ? "semantic.enable" : "semantic.defaultEnable")} />
    </Row>
    <div className={styles.projectFields}>
      <Row title={t("semantic.embedding")} desc={t("semantic.embeddingHint")}>
        <Select value={prefs.embeddingModelId} options={options(false, prefs.embeddingModelId)} onChange={(embeddingModelId) => update({ embeddingModelId })} ariaLabel={t("semantic.embedding")} className={common.rowSelect} />
      </Row>
      <Row title={t("semantic.reranker")} desc={t("semantic.rerankerHint")}>
        <Select value={prefs.rerankerModelId} options={options(true, prefs.rerankerModelId)} onChange={(rerankerModelId) => update({ rerankerModelId })} ariaLabel={t("semantic.reranker")} className={common.rowSelect} />
      </Row>
      <Row title={t("semantic.documentEnable")} desc={t("semantic.documentHint")}>
        <Toggle on={prefs.documentEnabled === true} onChange={(documentEnabled) => update({ documentEnabled })} label={t("semantic.documentEnable")} />
      </Row>
      {(["cosineMinScore", "rerankerMinScore"] as const).map((field) => <Row key={field}
        title={t(`semantic.${field}`)} desc={t(`semantic.${field}Hint`)}>
        <input className={`${common.input} ${common.rowNumber}`} aria-label={t(`semantic.${field}`)}
          type="number" min={field === "cosineMinScore" ? -1 : undefined} max={field === "cosineMinScore" ? 1 : undefined}
          step="any" defaultValue={prefs[field] ?? prefs.minScore}
          onBlur={(e) => {
            const n = e.target.value.trim() ? Number(e.target.value) : NaN;
            const value = Number.isFinite(n) ? (field === "cosineMinScore" ? Math.max(-1, Math.min(1, n)) : n) : (prefs[field] ?? prefs.minScore);
            update({ [field]: value }); e.target.value = String(value);
          }} />
      </Row>)}
      {project && prefs.enabled && prefs.embeddingModelId && <SemanticIndexPanel project={project} modelId={prefs.embeddingModelId} />}
      {prefs.enabled && !prefs.embeddingModelId && !prefs.rerankerModelId && <p className={ui.rowWarn}>{t("semantic.chooseModel")}</p>}
      <p className={ui.rowDesc}>{t("semantic.transferHint", { entry: terms.entry })}</p>
    </div>
    </div>
    </section>
    <p className={ui.rowDesc}>{t("semantic.manageModelsHint")}</p>
  </>;
}
