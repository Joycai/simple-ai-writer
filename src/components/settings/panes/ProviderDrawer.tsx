import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Check, AlertCircle } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import type { ApiStandard } from "../../../lib/ai/types";
import {
  GEMINI_HARM_CATEGORIES,
  GEMINI_THRESHOLD_LEVELS,
  defaultSafetySettings,
  type GeminiSafetySettings,
  type GeminiHarmCategory,
} from "../../../lib/ai/safety";
import { testProviderConnection } from "../../../lib/ai/providerProbe";
import styles from "../settingsCommon.module.css";
import hub from "./ProvidersModels.module.css";

const STANDARD_ENDPOINTS: Record<ApiStandard, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1",
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
  { name: "Anthropic", apiStandard: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { name: "Ollama", apiStandard: "openai_compat", baseUrl: "http://localhost:11434/v1" },
];

/** A server on the local machine (Ollama, LM Studio) — these need no API key. */
function isLocalEndpoint(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url.trim());
}

interface Props {
  /** null = add a new provider. */
  providerId: string | null;
  /** The key is fetched by the pane before opening, so the drawer never has to
   *  render a half-populated form while the keyring call is in flight. */
  initialApiKey: string;
  onClose: () => void;
}

export function ProviderDrawer({ providerId, initialApiKey, onClose }: Props) {
  const { t } = useTranslation();
  const { providers, addProvider, updateProvider } = useAiStore();
  const existing = providerId ? providers.find((p) => p.id === providerId) : undefined;

  const [form, setForm] = useState({
    name: existing?.name ?? "",
    baseUrl: existing?.baseUrl ?? STANDARD_ENDPOINTS.openai,
    apiStandard: existing?.apiStandard ?? ("openai" as ApiStandard),
    apiKey: initialApiKey,
    safetySettings: existing?.safetySettings ?? defaultSafetySettings(),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const apiStandardOptions = [
    { value: "openai" as ApiStandard, label: t("aiConfig.apiStandards.openai") },
    { value: "openai_compat" as ApiStandard, label: t("aiConfig.apiStandards.openai_compat") },
    { value: "gemini" as ApiStandard, label: t("aiConfig.apiStandards.gemini") },
    { value: "anthropic" as ApiStandard, label: t("aiConfig.apiStandards.anthropic") },
  ];

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

  const handleSave = async () => {
    if (!form.name || (keyRequired && !form.apiKey)) return;
    setSaving(true);
    setError(null);
    try {
      const safetySettings = form.apiStandard === "gemini" ? form.safetySettings : undefined;
      if (existing) {
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
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={hub.drawer} role="dialog" aria-label={t("aiConfig.providers.addTitle")}>
      <div className={hub.drawerHead}>
        <div style={{ minWidth: 0 }}>
          <div className={hub.drawerTitle}>
            {existing ? t("aiConfig.providers.editTitle") : t("aiConfig.providers.addTitle")}
          </div>
          {existing && (
            <div className={hub.drawerSub}>
              {existing.baseUrl || t("aiConfig.providers.defaultEndpoint")}
            </div>
          )}
        </div>
        <span className={hub.footSpacer} />
        <button className={hub.iconBtn} onClick={onClose} title={t("aiConfig.providers.cancel")}>
          <X size={16} />
        </button>
      </div>

      <div className={hub.drawerBody}>
        {error && <div className={styles.errorNote}>{error}</div>}

        {!existing && (
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
          <input className={`${styles.input} ${hub.mono}`} placeholder="https://api.openai.com/v1" value={form.baseUrl}
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
          <button className={styles.btnSecondary} onClick={handleTest}
            disabled={!form.baseUrl || (keyRequired && !form.apiKey) || testing}>
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
      </div>

      <div className={hub.drawerFoot}>
        <span className={hub.escHint}>{t("aiConfig.hub.escToClose")}</span>
        <span className={hub.footSpacer} />
        <button className={styles.btnSecondary} onClick={onClose}>{t("aiConfig.providers.cancel")}</button>
        <button className={styles.btnPrimary} onClick={handleSave}
          disabled={!form.name || (keyRequired && !form.apiKey) || saving}>
          {saving
            ? (existing ? t("aiConfig.providers.editing") : t("aiConfig.providers.saving"))
            : (existing ? t("aiConfig.providers.edit") : t("aiConfig.providers.save"))}
        </button>
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
                className={styles.rangeSlider}
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
