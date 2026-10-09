import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore, useTerms } from "../../../stores/projectStore";
import { useAiStore } from "../../../stores/aiStore";
import { semanticPrefs, saveSemanticPrefs, type SemanticPrefs } from "../../../lib/context/semanticPrefs";
import { RETRIEVAL_PATHS, validRetrievalPath, type RetrievalConfig } from "../../../lib/ai/retrievalConfig";
import { attachFees, type Model } from "../../../lib/ai/configDb";
import { Select } from "../../common/Select";
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
  const [editing, setEditing] = useState<string | null>(null);
  const update = (patch: Partial<SemanticPrefs>) => {
    if (!project) return;
    const next = { ...prefs, ...patch }; setPrefs(next); saveSemanticPrefs(project, next);
  };
  const options = (ranking: boolean, selected: string) => [
    { value: "", label: t("semantic.none") },
    ...models.filter((m) => m.enabled && m.retrieval && (m.retrieval.format === "cohere-rerank") === ranking)
      .map((m) => ({ value: m.id, label: m.name })),
    ...(selected && !models.some((m) => m.id === selected && m.enabled && m.retrieval && (m.retrieval.format === "cohere-rerank") === ranking)
      ? [{ value: selected, label: t("semantic.unavailableModel") }] : []),
  ];
  return <Section label={t("semantic.title", { kb: terms.kb })} action={<span className={ui.badge}>Beta</span>}>
    <Row title={t("semantic.enable")} desc={t("semantic.description", { kb: terms.kb })}
      foot={<div className={ui.rowDesc}>{project ? t("semantic.project", { name: project.split(/[\\/]/).pop() }) : t("semantic.noProject")}</div>}>
      {project && <Toggle on={prefs.enabled} onChange={(enabled) => update({ enabled })} label={t("semantic.enable")} />}
    </Row>
    {project && prefs.enabled && <>
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
      {!prefs.embeddingModelId && !prefs.rerankerModelId && <p className={ui.rowWarn}>{t("semantic.chooseModel")}</p>}
      <p className={ui.rowDesc}>{t("semantic.transferHint", { entry: terms.entry })}</p>
    </>}
    <Row title={t("semantic.models")} desc={t("semantic.modelsHint")} last>
      <button className={common.btnSecondary} onClick={() => setEditing("new")}>{t("semantic.add")}</button>
    </Row>
    {models.filter((m) => m.retrieval).map((m) => <Row key={m.id} title={m.name} desc={t(`semantic.format.${m.retrieval!.format}`)}>
      <button className={common.btnSecondary} onClick={() => setEditing(m.id)}>{t("semantic.edit")}</button>
    </Row>)}
    {editing && <RetrievalEditor key={editing} existing={models.find((m) => m.id === editing)} onClose={() => setEditing(null)} />}
  </Section>;
}

function RetrievalEditor({ existing, onClose }: { existing?: Model; onClose: () => void }) {
  const { t } = useTranslation();
  const providers = useAiStore((s) => s.providers);
  const feeGroups = useAiStore((s) => s.feeGroups);
  const [providerId, setProvider] = useState(existing?.providerId ?? providers[0]?.id ?? "");
  const [modelId, setModelId] = useState(existing?.modelId ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [feeGroupId, setFeeGroup] = useState(existing?.feeGroupId ?? "");
  const [config, setConfig] = useState<RetrievalConfig>(existing?.retrieval ?? { format: "openai-embedding", path: RETRIEVAL_PATHS["openai-embedding"] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = !!providerId && providers.some((p) => p.id === providerId) && !!modelId.trim() && validRetrievalPath(config.path);
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      const model: Model = { ...existing, id: existing?.id ?? "", providerId, modelId: modelId.trim(), name: name.trim() || modelId.trim(),
        type: "text", enabled: existing?.enabled ?? true, priceIn: existing?.priceIn ?? 0, priceCachedIn: existing?.priceCachedIn ?? 0, priceOut: existing?.priceOut ?? 0, retrieval: config, feeGroupId: feeGroupId || undefined };
      const priced = attachFees([model], feeGroups)[0];
      if (existing) await useAiStore.getState().updateModel(priced);
      else await useAiStore.getState().addModel(priced);
      onClose();
    } catch { setError(t("semantic.saveFailed")); } finally { setBusy(false); }
  };
  const field = (label: string, value: string, change: (s: string) => void, placeholder?: string) => <label className={common.fieldGroup}>
    <span className={common.label}>{t(`semantic.${label}`)}</span>
    <input className={common.input} value={value} onChange={(e) => change(e.target.value)} placeholder={placeholder} />
  </label>;
  return <form className={styles.editor} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <div className={styles.heading}>{t(existing ? "semantic.edit" : "semantic.add")}</div>
    <div className={common.fieldGroup}><span className={common.label}>{t("semantic.channel")}</span>
      <Select value={providerId} options={providers.map((p) => ({ value: p.id, label: p.name }))} onChange={setProvider} ariaLabel={t("semantic.channel")} />
      {!providers.length && <p className={ui.rowWarn}>{t("semantic.noChannel")}</p>}
    </div>
    <div className={styles.grid}>
      {field("modelId", modelId, setModelId)}
      {field("name", name, setName)}
    </div>
    <div className={common.fieldGroup}><span className={common.label}>{t("semantic.protocol")}</span>
      <Select value={config.format} options={Object.keys(RETRIEVAL_PATHS).map((value) => ({ value, label: t(`semantic.format.${value}`) }))}
        onChange={(value) => { const format = value as RetrievalConfig["format"]; setConfig({ ...config, format, path: RETRIEVAL_PATHS[format] }); }} ariaLabel={t("semantic.protocol")} />
    </div>
    {field("path", config.path, (path) => setConfig({ ...config, path }))}
    <p className={ui.rowDesc}>{t("semantic.pathHint")}</p>
    {config.format !== "cohere-rerank" && <div className={styles.grid}>
      {field("queryPrefix", config.queryPrefix ?? "", (queryPrefix) => setConfig({ ...config, queryPrefix }))}
      {field("documentPrefix", config.documentPrefix ?? "", (documentPrefix) => setConfig({ ...config, documentPrefix }))}
    </div>}
    <div className={common.fieldGroup}><span className={common.label}>{t("semantic.feeGroup")}</span>
      <Select value={feeGroupId} options={[{ value: "", label: t("semantic.none") }, ...feeGroups.map((g) => ({ value: g.id, label: g.name }))]} onChange={setFeeGroup} ariaLabel={t("semantic.feeGroup")} />
    </div>
    {error && <p role="alert" className={ui.rowWarn}>{error}</p>}
    <div className={styles.actions}>
      <button type="button" className={common.btnSecondary} onClick={onClose} disabled={busy}>{t("semantic.cancel")}</button>
      <button type="submit" className={common.btnPrimary} disabled={!valid || busy}>{t("semantic.save")}</button>
    </div>
  </form>;
}
