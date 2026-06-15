import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAiStore } from "../../stores/aiStore";
import type { ApiStandard, ModelType } from "../../lib/aiConfig";
import styles from "./SettingsModal.module.css";

const BUILTIN_PROMPTS_CONFIG = [
  { scene: "system", instructionKey: "ai.instructions.system" },
  { scene: "continue", instructionKey: "ai.instructions.continue" },
  { scene: "polish", instructionKey: "ai.instructions.polish" },
  { scene: "rewrite", instructionKey: "ai.instructions.rewrite" },
  { scene: "summary", instructionKey: "ai.instructions.summary" },
  { scene: "lore", instructionKey: "ai.instructions.lore" },
];

const STANDARD_ENDPOINTS: Record<ApiStandard, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai_compat: "",
};

// ─── Providers Tab ────────────────────────────────────────────────────────────

function ProvidersTab() {
  const { t } = useTranslation();
  const apiStandardOptions = [
    { value: "openai" as ApiStandard, label: t("aiConfig.apiStandards.openai") },
    { value: "openai_compat" as ApiStandard, label: t("aiConfig.apiStandards.openai_compat") },
    { value: "gemini" as ApiStandard, label: t("aiConfig.apiStandards.gemini") },
  ];

  const { providers, addProvider, removeProvider } = useAiStore();
  const [form, setForm] = useState({ name: "", baseUrl: STANDARD_ENDPOINTS.openai, apiStandard: "openai" as ApiStandard, apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!form.name || !form.apiKey) return;
    setSaving(true);
    setError(null);
    try {
      await addProvider(
        { name: form.name, baseUrl: form.baseUrl, apiStandard: form.apiStandard },
        form.apiKey,
      );
      setForm({ name: "", baseUrl: STANDARD_ENDPOINTS.openai, apiStandard: "openai", apiKey: "" });
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("aiConfig.providers.configured")}</div>
        {providers.length === 0 && <div className={styles.emptyNote}>{t("aiConfig.providers.empty")}</div>}
        <div className={styles.itemList}>
          {providers.map((p) => (
            <div key={p.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <div className={styles.itemName}>{p.name}</div>
                <div className={styles.itemMeta}>{p.baseUrl || t("aiConfig.providers.defaultEndpoint")} · {p.apiStandard}</div>
              </div>
              <span className={styles.badge}>{p.apiStandard}</span>
              <button className={styles.deleteBtn} onClick={() => removeProvider(p.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>{t("aiConfig.providers.addTitle")}</div>
          {error && <div className={styles.errorNote}>{error}</div>}
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.providers.nameLabel")}</label>
              <input className={styles.input} placeholder="OpenAI" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.providers.apiStandardLabel")}</label>
              <select className={styles.select} value={form.apiStandard}
                onChange={(e) => {
                  const standard = e.target.value as ApiStandard;
                  setForm({ ...form, apiStandard: standard, baseUrl: STANDARD_ENDPOINTS[standard] });
                }}>
                {apiStandardOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.providers.baseUrlLabel")}</label>
            <input className={styles.input} placeholder="https://api.openai.com/v1" value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.providers.apiKeyLabel")}</label>
            <input className={styles.input} type="password" placeholder="sk-…" value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </div>
          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={() => { setShowForm(false); setError(null); }}>{t("aiConfig.providers.cancel")}</button>
            <button className={styles.btnPrimary} onClick={handleAdd}
              disabled={!form.name || !form.apiKey || saving}>
              {saving ? t("aiConfig.providers.saving") : t("aiConfig.providers.save")}
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.btnPrimary} onClick={() => setShowForm(true)}>+ {t("aiConfig.providers.add")}</button>
      )}
    </div>
  );
}

// ─── Models Tab ───────────────────────────────────────────────────────────────

function ModelsTab() {
  const { t } = useTranslation();
  const modelTypeOptions = [
    { value: "text" as ModelType, label: t("aiConfig.modelTypes.text") },
    { value: "multimodal" as ModelType, label: t("aiConfig.modelTypes.multimodal") },
    { value: "image" as ModelType, label: t("aiConfig.modelTypes.image") },
    { value: "video" as ModelType, label: t("aiConfig.modelTypes.video") },
  ];

  const { providers, models, addModel, removeModel, fetchAndImportModels } = useAiStore();
  const [form, setForm] = useState({ providerId: "", modelId: "", name: "", type: "text" as ModelType, priceIn: "", priceCachedIn: "", priceOut: "" });
  const [showForm, setShowForm] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchedList, setFetchedList] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFetch = async () => {
    if (!form.providerId) return;
    setFetching(true);
    setError(null);
    try {
      const list = await fetchAndImportModels(form.providerId);
      setFetchedList(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const handleAdd = async () => {
    if (!form.providerId || !form.modelId) return;
    setSaving(true);
    setError(null);
    try {
      await addModel({
        providerId: form.providerId,
        modelId: form.modelId,
        name: form.name || form.modelId,
        type: form.type,
        priceIn: parseFloat(form.priceIn) || 0,
        priceCachedIn: parseFloat(form.priceCachedIn) || 0,
        priceOut: parseFloat(form.priceOut) || 0,
        enabled: true,
      });
      setForm({ providerId: "", modelId: "", name: "", type: "text", priceIn: "", priceCachedIn: "", priceOut: "" });
      setShowForm(false);
      setFetchedList([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("aiConfig.models.configured")}</div>
        {models.length === 0 && <div className={styles.emptyNote}>{t("aiConfig.models.empty")}</div>}
        <div className={styles.itemList}>
          {models.map((m) => {
            const pname = providers.find((p) => p.id === m.providerId)?.name ?? m.providerId;
            return (
              <div key={m.id} className={styles.item}>
                <div className={styles.itemInfo}>
                  <div className={styles.itemName}>{m.name}</div>
                  <div className={styles.itemMeta}>{pname} · {m.modelId}</div>
                </div>
                <span className={styles.badge}>{m.type}</span>
                <button className={styles.deleteBtn} onClick={() => removeModel(m.id)}>✕</button>
              </div>
            );
          })}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>{t("aiConfig.models.addTitle")}</div>
          {error && <div className={styles.errorNote}>{error}</div>}
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.providerLabel")}</label>
              <select className={styles.select} value={form.providerId}
                onChange={(e) => { setForm({ ...form, providerId: e.target.value }); setFetchedList([]); }}>
                <option value="">{t("aiConfig.models.selectProvider")}</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.typeLabel")}</label>
              <select className={styles.select} value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ModelType })}>
                {modelTypeOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>

          {form.providerId && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className={styles.fetchBtn} onClick={handleFetch} disabled={fetching}>
                {fetching ? t("aiConfig.models.fetching") : t("aiConfig.models.fetchBtn")}
              </button>
              {fetchedList.length > 0 && (
                <select className={styles.select} style={{ flex: 1 }}
                  onChange={(e) => { const m = fetchedList.find(x => x.id === e.target.value); if (m) setForm(f => ({ ...f, modelId: m.id, name: m.name })); }}>
                  <option value="">{t("aiConfig.models.selectOption")}</option>
                  {fetchedList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              )}
            </div>
          )}

          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.modelIdLabel")}</label>
              <input className={styles.input} placeholder="gpt-4o" value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.displayNameLabel")}</label>
              <input className={styles.input} placeholder="GPT-4o" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
          </div>

          <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>{t("aiConfig.models.billing")}</div>
          <div className={styles.formRow}>
            {[
              { key: "priceIn", label: t("aiConfig.models.priceInput") },
              { key: "priceCachedIn", label: t("aiConfig.models.priceCachedInput") },
              { key: "priceOut", label: t("aiConfig.models.priceOutput") },
            ].map(({ key, label }) => (
              <div key={key} className={styles.fieldGroup}>
                <label className={styles.label}>{label}</label>
                <input className={styles.input} type="number" min="0" step="0.01" placeholder="0.00"
                  value={(form as Record<string, string>)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              </div>
            ))}
          </div>

          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={() => { setShowForm(false); setFetchedList([]); setError(null); }}>{t("aiConfig.models.cancel")}</button>
            <button className={styles.btnPrimary} onClick={handleAdd} disabled={!form.providerId || !form.modelId || saving}>
              {saving ? t("aiConfig.models.saving") : t("aiConfig.models.add")}
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.btnPrimary} onClick={() => setShowForm(true)}>+ {t("aiConfig.models.add")}</button>
      )}
    </div>
  );
}

// ─── Prompts Tab ──────────────────────────────────────────────────────────────

function PromptsTab() {
  const { t } = useTranslation();
  const { prompts, addPrompt, removePrompt } = useAiStore();
  const [form, setForm] = useState({ name: "", content: "", scene: "system" });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtinPrompts = BUILTIN_PROMPTS_CONFIG.map((b) => ({
    ...b,
    label: t(`ai.tasks.${b.scene}`),
    content: t(b.instructionKey),
  }));

  const handleAdd = async () => {
    if (!form.name || !form.content) return;
    setSaving(true);
    setError(null);
    try {
      await addPrompt(form);
      setForm({ name: "", content: "", scene: "system" });
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("aiConfig.prompts.builtinTitle")}</div>
        <div className={styles.itemList}>
          {builtinPrompts.map((b) => {
            const overridden = prompts.some((p) => p.scene === b.scene);
            return (
              <div key={b.scene} className={`${styles.item} ${styles.builtinItem}`}>
                <div className={styles.itemInfo}>
                  <div className={styles.itemName} style={{ opacity: overridden ? 0.4 : 1 }}>
                    {b.content}
                    {overridden && <span className={styles.overriddenTag}>{t("aiConfig.prompts.overridden")}</span>}
                  </div>
                </div>
                <span className={styles.badge}>{b.scene}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("aiConfig.prompts.customTitle")}</div>
        {prompts.length === 0 && <div className={styles.emptyNote}>{t("aiConfig.prompts.empty")}</div>}
        <div className={styles.itemList}>
          {prompts.map((p) => (
            <div key={p.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <div className={styles.itemName}>{p.name}</div>
                <div className={styles.itemMeta} style={{ maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.content}</div>
              </div>
              <span className={styles.badge}>{p.scene}</span>
              <button className={styles.deleteBtn} onClick={() => removePrompt(p.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>{t("aiConfig.prompts.addTitle")}</div>
          {error && <div className={styles.errorNote}>{error}</div>}
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.prompts.nameLabel")}</label>
              <input className={styles.input} placeholder={t("lore.generator.placeholder")} value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.prompts.sceneLabel")}</label>
              <select className={styles.select} value={form.scene}
                onChange={(e) => setForm({ ...form, scene: e.target.value })}>
                {["system", "continue", "polish", "rewrite", "summary", "lore"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.prompts.contentLabel")}</label>
            <textarea className={styles.input} rows={4} placeholder={t("ai.panel.customInstruction")}
              value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}
              style={{ resize: "vertical", fontFamily: "inherit" }} />
          </div>
          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={() => { setShowForm(false); setError(null); }}>{t("aiConfig.prompts.cancel")}</button>
            <button className={styles.btnPrimary} onClick={handleAdd} disabled={!form.name || !form.content || saving}>
              {saving ? t("aiConfig.prompts.saving") : t("aiConfig.prompts.add")}
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.btnPrimary} onClick={() => setShowForm(true)}>+ {t("aiConfig.prompts.add")}</button>
      )}
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("providers");

  const tabs = [
    { id: "providers", label: t("aiConfig.tabs.providers") },
    { id: "models", label: t("aiConfig.tabs.models") },
    { id: "prompts", label: t("aiConfig.tabs.prompts") },
  ];

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>{t("aiConfig.title")}</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.tabs}>
          {tabs.map((t) => (
            <button key={t.id} className={`${styles.tab} ${activeTab === t.id ? styles.active : ""}`}
              onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.content}>
          {activeTab === "providers" && <ProvidersTab />}
          {activeTab === "models" && <ModelsTab />}
          {activeTab === "prompts" && <PromptsTab />}
        </div>
      </div>
    </div>
  );
}
