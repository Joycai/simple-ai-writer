import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Check, AlertCircle } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { authModesFor, familyOf, isCompatStandard, type ApiStandard, type AuthMode } from "../../../lib/ai/types";
import { DEFAULT_ANTHROPIC_BASE, DEFAULT_GEMINI_BASE, DEFAULT_OPENAI_BASE } from "../../../lib/ai/urls";
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

/**
 * What the Base URL field shows for each standard. The official ones are shown
 * read-only rather than hidden — an author staring at a 404 needs to see which
 * address the app is using before they can tell it is the wrong *standard* they
 * picked, not the wrong key. Compat starts empty because there is nothing to
 * guess. Only the compat value is ever stored (see handleSave).
 */
const STANDARD_ENDPOINTS: Record<ApiStandard, string> = {
  openai: DEFAULT_OPENAI_BASE,
  openai_compat: "",
  gemini: DEFAULT_GEMINI_BASE,
  gemini_compat: "",
  anthropic: DEFAULT_ANTHROPIC_BASE,
  anthropic_compat: "",
};

interface ProviderPreset {
  name: string;
  apiStandard: ApiStandard;
  baseUrl: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: "OpenAI", apiStandard: "openai", baseUrl: STANDARD_ENDPOINTS.openai },
  { name: "Google Gemini", apiStandard: "gemini", baseUrl: STANDARD_ENDPOINTS.gemini },
  { name: "DeepSeek", apiStandard: "openai_compat", baseUrl: "https://api.deepseek.com" },
  { name: "Anthropic", apiStandard: "anthropic", baseUrl: STANDARD_ENDPOINTS.anthropic },
  { name: "Ollama", apiStandard: "openai_compat", baseUrl: "http://localhost:11434/v1" },
  // Self-hosted, so there is no address to prefill — the preset exists to
  // answer "which standard do I pick for my relay", which is the part an
  // author has no way to guess.
  { name: "New API", apiStandard: "openai_compat", baseUrl: "" },
  { name: "MiniMax", apiStandard: "openai_compat", baseUrl: "https://api.minimaxi.com" },
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
    // An official provider stores no base URL, so fill the field from the
    // constant instead of leaving it blank.
    baseUrl:
      existing && !isCompatStandard(existing.apiStandard)
        ? STANDARD_ENDPOINTS[existing.apiStandard]
        : existing?.baseUrl ?? STANDARD_ENDPOINTS.openai,
    name: existing?.name ?? "",
    apiStandard: existing?.apiStandard ?? ("openai" as ApiStandard),
    apiKey: initialApiKey,
    authMode: existing?.authMode ?? ("default" as AuthMode),
    safetySettings: existing?.safetySettings ?? defaultSafetySettings(),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const apiStandardOptions = (
    ["openai", "openai_compat", "gemini", "gemini_compat", "anthropic", "anthropic_compat"] as const
  ).map((value) => ({ value: value as ApiStandard, label: t(`aiConfig.apiStandards.${value}`) }));

  // Local servers (Ollama, LM Studio) authenticate no requests, so the API key
  // is optional for them but required for everything else.
  const keyRequired = !isLocalEndpoint(form.baseUrl);
  const endpointLocked = !isCompatStandard(form.apiStandard);
  // One entry means the protocol has no choice to offer — don't render a
  // dropdown whose only option is "the way it already works".
  const authModes = authModesFor(form.apiStandard);

  const handleTest = async () => {
    if (!form.baseUrl || (keyRequired && !form.apiKey)) {
      setTestResult({ ok: false, message: t("aiConfig.providers.testMissingFields") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProviderConnection(
        form.baseUrl,
        form.apiKey,
        form.apiStandard,
        form.authMode,
      );
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
      const safetySettings = familyOf(form.apiStandard) === "gemini" ? form.safetySettings : undefined;
      // Official providers store nothing: the address is a constant of the
      // vendor's, and keeping it out of the database makes a vendor domain
      // change a code edit rather than a data migration.
      const baseUrl = endpointLocked ? "" : form.baseUrl.trim();
      // Store nothing for the protocol's own scheme, so a provider that never
      // touched this setting reads back exactly as it did before it existed.
      const authMode = form.authMode === "default" ? undefined : form.authMode;
      if (existing) {
        await updateProvider(
          { ...existing, name: form.name, baseUrl, apiStandard: form.apiStandard, safetySettings, authMode },
          form.apiKey,
        );
      } else {
        await addProvider(
          { name: form.name, baseUrl, apiStandard: form.apiStandard, safetySettings, authMode },
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
                setForm({
                  ...form,
                  apiStandard: standard,
                  baseUrl: STANDARD_ENDPOINTS[standard],
                  // Switching away from anthropic_compat would otherwise keep a
                  // mode the new standard can't use — including onto the
                  // official endpoint, which rejects two credentials.
                  authMode: authModesFor(standard).includes(form.authMode) ? form.authMode : "default",
                });
              }}>
              {apiStandardOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.providers.baseUrlLabel")}</label>
          <input className={`${styles.input} ${hub.mono}`} placeholder="https://api.openai.com/v1" value={form.baseUrl}
            readOnly={endpointLocked}
            aria-readonly={endpointLocked}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          {endpointLocked && (
            <div className={styles.hint}>{t("aiConfig.providers.baseUrlOfficialHint")}</div>
          )}
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>
            {t("aiConfig.providers.apiKeyLabel")}
            {!keyRequired && <span className={styles.hint}> · {t("aiConfig.providers.apiKeyOptional")}</span>}
          </label>
          <div className={styles.keyRow}>
            <input className={styles.input} type="password"
              placeholder={keyRequired ? "sk-…" : t("aiConfig.providers.apiKeyLocalPlaceholder")}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
            <button className={`${styles.btnSecondary} ${styles.testBtn}`} onClick={handleTest}
              disabled={!form.baseUrl || (keyRequired && !form.apiKey) || testing}>
              {testing ? t("aiConfig.providers.testing") : t("aiConfig.providers.testConnection")}
            </button>
          </div>
          {testResult && (
            <div className={testResult.ok ? styles.testResultOk : styles.testResultError}>
              {testResult.ok
                ? <Check size={14} className={styles.testResultIcon} />
                : <AlertCircle size={14} className={styles.testResultIcon} />}
              <span className={styles.testResultMessage}>{testResult.message}</span>
            </div>
          )}
        </div>

        {authModes.length > 1 && (
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.providers.authModeLabel")}</label>
            <select className={styles.select} value={form.authMode}
              onChange={(e) => setForm({ ...form, authMode: e.target.value as AuthMode })}>
              {authModes.map((mode) => (
                <option key={mode} value={mode}>{t(`aiConfig.providers.authModes.${mode}`)}</option>
              ))}
            </select>
            <div className={styles.hint}>{t("aiConfig.providers.authModeHint")}</div>
          </div>
        )}

        {familyOf(form.apiStandard) === "gemini" && (
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
    <div className={styles.safetyCard}>
      <div className={styles.safetyTitle}>{t("aiConfig.providers.safetyLabel")}</div>
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
