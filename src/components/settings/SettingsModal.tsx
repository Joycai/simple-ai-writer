import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Pencil, Moon, Sun, Monitor, SlidersHorizontal, Server, Cpu, MessageSquare, Check, AlertCircle, FolderOpen } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore, type ThemeMode, type Language, type FontScheme } from "../../stores/appStore";
import { isApiLogEnabled, setApiLogEnabled, getApiLogRevealTarget } from "../../lib/ai/apiLog";
import type { ApiStandard } from "../../lib/ai/types";
import { MAX_CONTEXT_SIZE, type ModelType } from "../../lib/ai/configDb";
import { GEMINI_HARM_CATEGORIES, GEMINI_THRESHOLD_LEVELS, defaultSafetySettings, type GeminiSafetySettings, type GeminiHarmCategory } from "../../lib/ai/safety";
import { testProviderConnection } from "../../lib/ai/providerProbe";
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

interface ProviderPreset {
  name: string;
  apiStandard: ApiStandard;
  baseUrl: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: "OpenAI", apiStandard: "openai", baseUrl: "https://api.openai.com/v1" },
  { name: "Google Gemini", apiStandard: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { name: "DeepSeek", apiStandard: "openai_compat", baseUrl: "https://api.deepseek.com" },
  { name: "Anthropic", apiStandard: "openai_compat", baseUrl: "https://api.anthropic.com/v1" },
  { name: "Ollama", apiStandard: "openai_compat", baseUrl: "http://localhost:11434/v1" },
];

/** A server on the local machine (Ollama, LM Studio) — these need no API key. */
function isLocalEndpoint(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url.trim());
}

const THEMES: { value: ThemeMode; icon: React.ReactNode; labelKey: string }[] = [
  { value: "dark", icon: <Moon size={14} />, labelKey: "settings.dark" },
  { value: "light", icon: <Sun size={14} />, labelKey: "settings.light" },
  { value: "system", icon: <Monitor size={14} />, labelKey: "settings.system" },
];

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "English" },
];

// Preview stack per scheme mirrors the --font-serif override in tokens.css,
// so each option renders in the body font it selects.
const FONT_SCHEMES: { value: FontScheme; labelKey: string; sample: string; previewFont: string }[] = [
  { value: "manuscript", labelKey: "systemSettings.general.fontManuscript", sample: "文字 Aa", previewFont: '"Spectral", Georgia, "Songti SC", "Noto Serif CJK SC", serif' },
  { value: "song", labelKey: "systemSettings.general.fontSong", sample: "文字 Aa", previewFont: 'Georgia, Cambria, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, serif' },
  { value: "hei", labelKey: "systemSettings.general.fontHei", sample: "文字 Aa", previewFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
  { value: "kai", labelKey: "systemSettings.general.fontKai", sample: "文字 Aa", previewFont: '"Iowan Old Style", Georgia, "Kaiti SC", STKaiti, KaiTi, "Noto Serif CJK SC", serif' },
];

// ─── General Tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const { t } = useTranslation();
  const { theme, setTheme, language, setLanguage, fontScheme, setFontScheme } = useAppStore();
  const [apiLogOn, setApiLogOn] = useState(isApiLogEnabled());

  const toggleApiLog = (enabled: boolean) => {
    setApiLogEnabled(enabled);
    setApiLogOn(enabled);
  };

  const openApiLogs = async () => {
    try {
      await revealItemInDir(await getApiLogRevealTarget());
    } catch { /* best-effort */ }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.general.appearance")}</div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.themeLabel")}</label>
          <div className={styles.optionGroup}>
            {THEMES.map((th) => (
              <button
                key={th.value}
                className={`${styles.optionBtn} ${theme === th.value ? styles.optionBtnActive : ""}`}
                onClick={() => setTheme(th.value)}
              >
                {th.icon}
                {t(th.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.fontLabel")}</label>
          <div className={styles.safetyHint}>{t("systemSettings.general.fontHint")}</div>
          <div className={styles.fontGrid}>
            {FONT_SCHEMES.map((f) => (
              <button
                key={f.value}
                className={`${styles.fontCard} ${fontScheme === f.value ? styles.fontCardActive : ""}`}
                onClick={() => setFontScheme(f.value)}
              >
                <span className={styles.fontSample} style={{ fontFamily: f.previewFont }}>{f.sample}</span>
                <span className={styles.fontName}>{t(f.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.general.languageSection")}</div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.languageLabel")}</label>
          <div className={styles.optionGroup}>
            {LANGUAGES.map((lang) => (
              <button
                key={lang.value}
                className={`${styles.optionBtn} ${language === lang.value ? styles.optionBtnActive : ""}`}
                onClick={() => setLanguage(lang.value)}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.general.debugSection")}</div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.apiLogLabel")}</label>
          <div className={styles.safetyHint}>{t("systemSettings.general.apiLogHint")}</div>
          <div className={styles.debugControls}>
            <div className={styles.optionGroup}>
              <button
                className={`${styles.optionBtn} ${apiLogOn ? styles.optionBtnActive : ""}`}
                onClick={() => toggleApiLog(true)}
              >
                {t("systemSettings.general.apiLogOn")}
              </button>
              <button
                className={`${styles.optionBtn} ${!apiLogOn ? styles.optionBtnActive : ""}`}
                onClick={() => toggleApiLog(false)}
              >
                {t("systemSettings.general.apiLogOff")}
              </button>
            </div>
            <button className={`${styles.btnSecondary} ${styles.btnWithIcon}`} onClick={openApiLogs}>
              <FolderOpen size={14} /> {t("systemSettings.general.openApiLogs")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Gemini safety filtering editor ───────────────────────────────────────────

function GeminiSafetyEditor({
  value,
  onChange,
}: {
  value: GeminiSafetySettings;
  onChange: (next: GeminiSafetySettings) => void;
}) {
  const { t } = useTranslation();
  const maxIdx = GEMINI_THRESHOLD_LEVELS.length - 1;

  return (
    <div className={styles.fieldGroup}>
      <label className={styles.label}>{t("aiConfig.providers.safetyLabel")}</label>
      <div className={styles.safetyHint}>{t("aiConfig.providers.safetyHint")}</div>
      <div className={styles.safetyList}>
        {GEMINI_HARM_CATEGORIES.map((category: GeminiHarmCategory) => {
          const threshold = value[category] ?? "BLOCK_NONE";
          const idx = Math.max(0, GEMINI_THRESHOLD_LEVELS.indexOf(threshold));
          return (
            <div key={category} className={styles.safetyRow}>
              <span className={styles.safetyCategory}>{t(`aiConfig.providers.harmCategories.${category}`)}</span>
              <input
                type="range"
                className={styles.safetySlider}
                min={0}
                max={maxIdx}
                step={1}
                value={idx}
                onChange={(e) =>
                  onChange({ ...value, [category]: GEMINI_THRESHOLD_LEVELS[Number(e.target.value)] })
                }
              />
              <span className={styles.safetyThreshold}>{t(`aiConfig.providers.thresholds.${threshold}`)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Providers Tab ────────────────────────────────────────────────────────────

function ProvidersTab() {
  const { t } = useTranslation();
  const apiStandardOptions = [
    { value: "openai" as ApiStandard, label: t("aiConfig.apiStandards.openai") },
    { value: "openai_compat" as ApiStandard, label: t("aiConfig.apiStandards.openai_compat") },
    { value: "gemini" as ApiStandard, label: t("aiConfig.apiStandards.gemini") },
  ];

  const { providers, addProvider, updateProvider, removeProvider, getApiKey } = useAiStore();
  const [form, setForm] = useState({ name: "", baseUrl: STANDARD_ENDPOINTS.openai, apiStandard: "openai" as ApiStandard, apiKey: "", safetySettings: defaultSafetySettings() });
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const resetForm = () => {
    setForm({ name: "", baseUrl: STANDARD_ENDPOINTS.openai, apiStandard: "openai", apiKey: "", safetySettings: defaultSafetySettings() });
    setEditingId(null);
    setShowForm(false);
    setError(null);
    setTestResult(null);
  };

  // Local servers (Ollama, LM Studio) authenticate no requests, so the API key
  // is optional for them but required for everything else.
  const keyRequired = !isLocalEndpoint(form.baseUrl);

  const handleTest = async () => {
    if (!form.baseUrl || (keyRequired && !form.apiKey)) {
      setTestResult({ ok: false, message: t("aiConfig.providers.testMissingFields") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProviderConnection(form.baseUrl, form.apiKey, form.apiStandard);
      setTestResult({ ok: result.ok, message: result.ok ? result.message : result.error });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleEdit = async (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    const key = await getApiKey(id) ?? "";
    setForm({ name: p.name, baseUrl: p.baseUrl, apiStandard: p.apiStandard, apiKey: key, safetySettings: p.safetySettings ?? defaultSafetySettings() });
    setEditingId(id);
    setShowForm(true);
    setError(null);
  };

  const handleSave = async () => {
    if (!form.name || (keyRequired && !form.apiKey)) return;
    setSaving(true);
    setError(null);
    try {
      const safetySettings = form.apiStandard === "gemini" ? form.safetySettings : undefined;
      if (editingId) {
        const existing = providers.find((x) => x.id === editingId)!;
        await updateProvider(
          { ...existing, name: form.name, baseUrl: form.baseUrl, apiStandard: form.apiStandard, safetySettings },
          form.apiKey,
        );
      } else {
        await addProvider(
          { name: form.name, baseUrl: form.baseUrl, apiStandard: form.apiStandard, safetySettings },
          form.apiKey,
        );
      }
      resetForm();
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
              <button className={styles.editBtn} onClick={() => handleEdit(p.id)}><Pencil size={13} /></button>
              <button className={styles.deleteBtn} onClick={() => removeProvider(p.id)}><X size={13} /></button>
            </div>
          ))}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>{editingId ? t("aiConfig.providers.editTitle") : t("aiConfig.providers.addTitle")}</div>
          {!editingId && (
            <div className={styles.presetSection}>
              <div className={styles.label}>{t("aiConfig.providers.presetsLabel")}</div>
              <div className={styles.presetGrid}>
                {PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    className={styles.btnSecondary}
                    onClick={() => setForm({ ...form, name: preset.name, apiStandard: preset.apiStandard, baseUrl: preset.baseUrl })}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          )}
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
            <label className={styles.label}>
              {t("aiConfig.providers.apiKeyLabel")}
              {!keyRequired && <span className={styles.hint}> · {t("aiConfig.providers.apiKeyOptional")}</span>}
            </label>
            <input className={styles.input} type="password"
              placeholder={keyRequired ? "sk-…" : t("aiConfig.providers.apiKeyLocalPlaceholder")}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </div>
          <div className={styles.testRow}>
            <button className={styles.btnSecondary} onClick={handleTest} disabled={!form.baseUrl || (keyRequired && !form.apiKey) || testing}>
              {testing ? t("aiConfig.providers.testing") : t("aiConfig.providers.testConnection")}
            </button>
            {testResult && (
              <div className={testResult.ok ? styles.testResultOk : styles.testResultError}>
                {testResult.ok ? <Check size={14} /> : <AlertCircle size={14} />}
                <span className={styles.testResultMessage}>{testResult.message}</span>
              </div>
            )}
          </div>
          {form.apiStandard === "gemini" && (
            <GeminiSafetyEditor
              value={form.safetySettings}
              onChange={(safetySettings) => setForm({ ...form, safetySettings })}
            />
          )}
          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={resetForm}>{t("aiConfig.providers.cancel")}</button>
            <button className={styles.btnPrimary} onClick={handleSave}
              disabled={!form.name || (keyRequired && !form.apiKey) || saving}>
              {saving
                ? (editingId ? t("aiConfig.providers.editing") : t("aiConfig.providers.saving"))
                : (editingId ? t("aiConfig.providers.edit") : t("aiConfig.providers.save"))}
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

  const { providers, models, addModel, updateModel, removeModel, fetchAndImportModels } = useAiStore();
  const [form, setForm] = useState({ providerId: "", modelId: "", name: "", type: "text" as ModelType, priceIn: "", priceCachedIn: "", priceOut: "", prefix: "", contextSize: "" });
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchedList, setFetchedList] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setForm({ providerId: "", modelId: "", name: "", type: "text", priceIn: "", priceCachedIn: "", priceOut: "", prefix: "", contextSize: "" });
    setEditingId(null);
    setShowForm(false);
    setFetchedList([]);
    setError(null);
  };

  const handleEdit = (id: string) => {
    const m = models.find((x) => x.id === id);
    if (!m) return;
    setForm({
      providerId: m.providerId,
      modelId: m.modelId,
      name: m.name,
      type: m.type,
      priceIn: m.priceIn ? String(m.priceIn) : "",
      priceCachedIn: m.priceCachedIn ? String(m.priceCachedIn) : "",
      priceOut: m.priceOut ? String(m.priceOut) : "",
      prefix: m.prefix ?? "",
      contextSize: m.contextSize ? String(m.contextSize) : "",
    });
    setEditingId(id);
    setShowForm(true);
    setFetchedList([]);
    setError(null);
  };

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

  const handleSave = async () => {
    if (!form.providerId || !form.modelId) return;
    setSaving(true);
    setError(null);
    try {
      const parsedCtx = Math.min(MAX_CONTEXT_SIZE, Math.max(0, Math.floor(parseInt(form.contextSize, 10) || 0)));
      const contextSize = parsedCtx > 0 ? parsedCtx : undefined;
      if (editingId) {
        const existing = models.find((x) => x.id === editingId)!;
        await updateModel({
          ...existing,
          providerId: form.providerId,
          modelId: form.modelId,
          name: form.name || form.modelId,
          type: form.type,
          priceIn: parseFloat(form.priceIn) || 0,
          priceCachedIn: parseFloat(form.priceCachedIn) || 0,
          priceOut: parseFloat(form.priceOut) || 0,
          prefix: form.prefix.trim() || undefined,
          contextSize,
        });
      } else {
        await addModel({
          providerId: form.providerId,
          modelId: form.modelId,
          name: form.name || form.modelId,
          type: form.type,
          priceIn: parseFloat(form.priceIn) || 0,
          priceCachedIn: parseFloat(form.priceCachedIn) || 0,
          priceOut: parseFloat(form.priceOut) || 0,
          enabled: true,
          prefix: form.prefix.trim() || undefined,
          contextSize,
        });
      }
      resetForm();
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
                  <div className={styles.itemMeta}>
                    {pname} · {m.modelId}
                    {m.contextSize ? ` · ${m.contextSize.toLocaleString()} ctx` : ""}
                  </div>
                </div>
                <span className={styles.badge}>{m.type}</span>
                <button className={styles.editBtn} onClick={() => handleEdit(m.id)}><Pencil size={13} /></button>
                <button className={styles.deleteBtn} onClick={() => removeModel(m.id)}><X size={13} /></button>
              </div>
            );
          })}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>{editingId ? t("aiConfig.models.editTitle") : t("aiConfig.models.addTitle")}</div>
          {error && <div className={styles.errorNote}>{error}</div>}
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.providerLabel")}</label>
              <select className={styles.select} value={form.providerId} disabled={!!editingId}
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

          {form.providerId && !editingId && (
            <div className={styles.fetchRow}>
              <button className={styles.fetchBtn} onClick={handleFetch} disabled={fetching}>
                {fetching ? t("aiConfig.models.fetching") : t("aiConfig.models.fetchBtn")}
              </button>
              {fetchedList.length > 0 && (
                <select className={`${styles.select} ${styles.fetchRowSelect}`}
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

          <div className={styles.billingTitle}>{t("aiConfig.models.billing")}</div>
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

          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.models.contextSizeLabel")}</label>
            <input className={styles.input} type="number" min="0" max={MAX_CONTEXT_SIZE} step="1024" placeholder="8192"
              value={form.contextSize}
              onChange={(e) => setForm({ ...form, contextSize: e.target.value })} />
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6, fontStyle: "italic" }}>
              {t("aiConfig.models.contextSizeHint")}
            </div>
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.models.prefixLabel")}</label>
            <textarea
              className={styles.input}
              rows={4}
              placeholder={t("aiConfig.models.prefixPlaceholder")}
              value={form.prefix}
              onChange={(e) => setForm({ ...form, prefix: e.target.value })}
              style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6 }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6, fontStyle: "italic" }}>
              {t("aiConfig.models.prefixHint")}
            </div>
          </div>

          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={resetForm}>{t("aiConfig.models.cancel")}</button>
            <button className={styles.btnPrimary} onClick={handleSave} disabled={!form.providerId || !form.modelId || saving}>
              {saving
                ? (editingId ? t("aiConfig.models.editing") : t("aiConfig.models.saving"))
                : (editingId ? t("aiConfig.models.edit") : t("aiConfig.models.add"))}
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
                  <div className={`${styles.itemName} ${overridden ? styles.itemNameDimmed : ""}`}>
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
                <div className={styles.itemMetaTruncated}>{p.content}</div>
              </div>
              <span className={styles.badge}>{p.scene}</span>
              <button className={styles.deleteBtn} onClick={() => removePrompt(p.id)}><X size={13} /></button>
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
              <input className={styles.input} placeholder={t("aiConfig.prompts.namePlaceholder")} value={form.name}
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
            <textarea className={`${styles.input} ${styles.textarea}`} rows={4} placeholder={t("ai.panel.customInstruction")}
              value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
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

type TabId = "general" | "providers" | "models" | "prompts";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>("general");

  const navBtn = (id: TabId, icon: React.ReactNode, labelKey: string) => (
    <button
      key={id}
      className={`${styles.navItem} ${activeTab === id ? styles.navItemActive : ""}`}
      onClick={() => setActiveTab(id)}
    >
      {icon}
      {t(labelKey)}
    </button>
  );

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>{t("systemSettings.title")}</span>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div className={styles.modalBody}>
          <nav className={styles.nav}>
            {navBtn("general", <SlidersHorizontal size={15} />, "systemSettings.tabs.general")}
            <div className={styles.navGroupLabel}>{t("systemSettings.tabs.aiGroup")}</div>
            {navBtn("providers", <Server size={15} />, "systemSettings.tabs.providers")}
            {navBtn("models", <Cpu size={15} />, "systemSettings.tabs.models")}
            {navBtn("prompts", <MessageSquare size={15} />, "systemSettings.tabs.prompts")}
          </nav>

          <div className={styles.content}>
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "providers" && <ProvidersTab />}
            {activeTab === "models" && <ModelsTab />}
            {activeTab === "prompts" && <PromptsTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
