import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore, useTerms } from "../../../stores/projectStore";
import { useAiStore } from "../../../stores/aiStore";
import { semanticPrefs, saveSemanticPrefs, type SemanticPrefs } from "../../../lib/context/semanticPrefs";
import { Select } from "../../common/Select";
import { SemanticIndexPanel } from "./SemanticIndexPanel";
import { Section, Row, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";
import styles from "./SemanticRetrieval.module.css";

export function SemanticRetrieval() {
  const project = useProjectStore((s) => s.projectPath);
  return <ProjectRetrieval key={project ?? "none"} project={project} />;
}
function ProjectRetrieval({ project }: { project: string | null }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [prefs, setPrefs] = useState(() => semanticPrefs(project));
  const models = useAiStore((s) => s.models);
  const providers = useAiStore((s) => s.providers);
  const update = (patch: Partial<SemanticPrefs>) => {
    if (!project) return;
    const next = { ...semanticPrefs(project), ...patch }; setPrefs(next); saveSemanticPrefs(project, next);
  };
  const options = (ranking: boolean, selected: string) => [
    { value: "", label: t("semantic.none") },
    ...models.filter((m) => m.enabled && providers.some((p) => p.id === m.providerId) && m.type === (ranking ? "rerank" : "embedding"))
      .map((m) => ({ value: m.id, label: `${m.name} · ${providers.find((p) => p.id === m.providerId)?.name ?? t("semantic.unavailableChannel")}` })),
    ...(selected && !models.some((m) => m.id === selected && m.enabled && providers.some((p) => p.id === m.providerId) && m.type === (ranking ? "rerank" : "embedding"))
      ? [{ value: selected, label: t("semantic.unavailableModel") }] : []),
  ];
  return <Section label={t("semantic.title", { kb: terms.kb })} action={<span className={ui.badge}>Beta</span>}>
    <section className={styles.group} aria-label={t("semantic.projectSettings")}>
    <header className={styles.groupHeader}>
      <div><h3 className={styles.groupTitle}>{t("semantic.projectSettings")}</h3>
        <p className={ui.rowDesc}>{project ? t("semantic.project", { name: project.split(/[\\/]/).pop() }) : t("semantic.noProject")}</p>
      </div>
      <span className={styles.scope}>{t("semantic.projectOnly")}</span>
    </header>
    <div className={styles.groupBody}>
    <Row title={t("semantic.enable")} desc={t("semantic.description", { kb: terms.kb })}
      last={!project || !prefs.enabled}>
      {project && <Toggle on={prefs.enabled} onChange={(enabled) => update({ enabled })} label={t("semantic.enable")} />}
    </Row>
    {project && prefs.enabled && <div className={styles.projectFields}>
      <Row title={t("semantic.embedding")} desc={t("semantic.embeddingHint")}>
        <Select value={prefs.embeddingModelId} options={options(false, prefs.embeddingModelId)} onChange={(embeddingModelId) => update({ embeddingModelId })} ariaLabel={t("semantic.embedding")} className={common.rowSelect} />
      </Row>
      <Row title={t("semantic.reranker")} desc={t("semantic.rerankerHint")}>
        <Select value={prefs.rerankerModelId} options={options(true, prefs.rerankerModelId)} onChange={(rerankerModelId) => update({ rerankerModelId })} ariaLabel={t("semantic.reranker")} className={common.rowSelect} />
      </Row>
      <Row title={t("semantic.threshold")} desc={t("semantic.thresholdHint")}>
        <input className={`${common.input} ${common.rowNumber}`} aria-label={t("semantic.threshold")} type="number" min={-1} max={1} step={0.05} defaultValue={prefs.minScore}
          onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) { const minScore = Math.max(-1, Math.min(1, n)); update({ minScore }); e.target.value = String(minScore); } }} />
      </Row>
      {prefs.embeddingModelId && <SemanticIndexPanel project={project} modelId={prefs.embeddingModelId} />}
      {!prefs.embeddingModelId && !prefs.rerankerModelId && <p className={ui.rowWarn}>{t("semantic.chooseModel")}</p>}
      <p className={ui.rowDesc}>{t("semantic.transferHint", { entry: terms.entry })}</p>
    </div>}
    </div>
    </section>
    <p className={ui.rowDesc}>{t("semantic.manageModelsHint")}</p>
  </Section>;
}
