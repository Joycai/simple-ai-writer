import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Key, ArrowRight, FolderOpen } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { BUILTIN_PROFILES, NOVEL_PROFILE, profileLabel } from "../../lib/profile";
import { MOD_KEY, MOD_K } from "../../lib/platform";
import { readPref, writePref } from "../../lib/prefs";
import type { ApiStandard } from "../../lib/ai/types";
import styles from "./Onboarding.module.css";

const ONBOARDING_DONE_KEY = "manuscript:onboarding-done";

type Provider = "anthropic" | "openai" | "ollama";

interface ProviderInfo {
  id: Provider;
  name: string;
  /** i18n key for the one-line hint under the name. */
  hintKey: string;
  recommended?: boolean;
  baseUrl: string;
  /**
   * Imported, not re-spelled: this used to be an inline copy of the union, so
   * adding a wire protocol left this list silently stale (and the `as any` on
   * the DB write below meant nothing caught it).
   */
  apiStandard: ApiStandard;
}

const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic · Claude", hintKey: "onboarding.providerAnthropicHint", recommended: true, baseUrl: "https://api.anthropic.com/v1", apiStandard: "anthropic" },
  { id: "openai",    name: "OpenAI · GPT",       hintKey: "onboarding.providerOpenaiHint",    baseUrl: "https://api.openai.com/v1", apiStandard: "openai" },
  { id: "ollama",    name: "Ollama",              hintKey: "onboarding.providerOllamaHint",    baseUrl: "http://localhost:11434/v1", apiStandard: "openai_compat" },
];

export function Onboarding() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language === "zh-CN";
  const { showOnboarding, setShowOnboarding } = useAppStore();
  const { providers, addProvider } = useAiStore();
  const { openProject } = useProjectStore();

  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState<Provider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  // The workspace type the project will be created as (Settings → 工作台 can
  // change it later). Novel is the historical default.
  const [workspaceId, setWorkspaceId] = useState(NOVEL_PROFILE.id);
  const [opening, setOpening] = useState(false);

  // Auto-show on first run if no provider configured
  useEffect(() => {
    const done = readPref(ONBOARDING_DONE_KEY) === "true";
    if (!done && providers.length === 0) {
      setShowOnboarding(true);
    }
  }, [providers.length, setShowOnboarding]);

  if (!showOnboarding) return null;

  const dismiss = () => {
    writePref(ONBOARDING_DONE_KEY, "true");
    setShowOnboarding(false);
  };

  const handleSaveProvider = async () => {
    const info = PROVIDERS.find((p) => p.id === selected)!;
    // Matches the "继续" button's own disabled check below: Ollama needs no
    // key, so an empty one there isn't "skip setup" the way it is for every
    // other provider — it must still create the provider, or a first-run
    // author who picks Ollama finishes onboarding with zero providers
    // configured and every AI action silently has nothing to run against.
    if (selected !== "ollama" && !apiKey.trim()) { setStep(2); return; }
    setSaving(true);
    try {
      await addProvider(
        {
          name: info.name,
          baseUrl: info.baseUrl,
          apiStandard: info.apiStandard,
        } as any,
        apiKey.trim(),
      );
      setStep(2);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handlePickFolder = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openProject();
      const store = useProjectStore.getState();
      // Dialog cancelled — nothing opened, stay on this step.
      if (!store.projectPath) return;
      // Apply the chosen workspace type, but never clobber a folder that
      // already declares one: an existing non-novel project keeps its own
      // profile.json regardless of what the chip row says.
      const picked = BUILTIN_PROFILES.find((p) => p.id === workspaceId);
      if (picked && picked.id !== store.profile.id && store.profile.id === NOVEL_PROFILE.id) {
        await store.setProfile(picked);
      }
      setStep(3);
    } catch (e) {
      console.error(e);
    } finally {
      setOpening(false);
    }
  };

  const stepNav = (back: number | null, onNext: () => void, nextLabel?: string) => (
    <div className={styles.stepNav}>
      <div className={styles.dots}>
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={`${styles.dot} ${n <= step ? styles.dotActive : ""}`} />
        ))}
      </div>
      <span className={styles.dotCount}>{step} / 4</span>
      <span className={styles.spacer} />
      {back !== null && (
        <button className={styles.backBtn} onClick={() => setStep(back)}>
          {t("onboarding.back")}
        </button>
      )}
      <button className={styles.nextBtn} onClick={onNext} disabled={saving || opening}>
        {nextLabel ?? t("onboarding.next")} <ArrowRight size={12} />
      </button>
    </div>
  );

  const renderStep = () => {
    if (step === 1) {
      return (
        <>
          <div className={styles.formEyebrow}>{t("onboarding.step1Eyebrow")}</div>
          <h2 className={styles.formTitle}>{t("onboarding.step1Title")}</h2>

          <div className={styles.providerList}>
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                className={`${styles.providerCard} ${selected === p.id ? styles.providerCardActive : ""}`}
                onClick={() => setSelected(p.id)}
              >
                <span className={`${styles.radio} ${selected === p.id ? styles.radioActive : ""}`}>
                  {selected === p.id && "✓"}
                </span>
                <div className={styles.providerInfo}>
                  <div className={styles.providerName}>{p.name}</div>
                  <div className={styles.providerHint}>{t(p.hintKey)}</div>
                </div>
                {p.recommended && (
                  <span className={styles.providerBadge}>{t("onboarding.providerRecommended")}</span>
                )}
              </div>
            ))}
          </div>

          <div className={styles.inputBlock}>
            <div className={styles.inputLabel}>API KEY</div>
            <div className={styles.inputWrap}>
              <Key size={13} color="var(--color-sienna)" strokeWidth={1.6} />
              <input
                className={styles.input}
                type="password"
                placeholder="sk-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className={styles.inputHint}>{t("onboarding.apiKeyHint")}</div>
          </div>

          <span className={styles.spacer} />

          <div className={styles.stepNav}>
            <div className={styles.dots}>
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={`${styles.dot} ${n === step ? styles.dotActive : ""}`} />
              ))}
            </div>
            <span className={styles.dotCount}>{step} / 4</span>
            <span className={styles.spacer} />
            <button
              className={styles.nextBtn}
              onClick={handleSaveProvider}
              disabled={saving || (selected !== "ollama" && !apiKey.trim())}
            >
              {saving ? t("onboarding.saving") : t("onboarding.next")} <ArrowRight size={12} />
            </button>
          </div>
        </>
      );
    }
    if (step === 2) {
      return (
        <>
          <div className={styles.formEyebrow}>{t("onboarding.step2Eyebrow")}</div>
          <h2 className={styles.formTitle}>{t("onboarding.step2Title")}</h2>

          {/* What kind of writing this project is — drives the knowledge-base
              layout, the AI tasks, and the UI vocabulary. */}
          <div className={styles.inputBlock}>
            <div className={styles.inputLabel}>{t("onboarding.workspaceLabel")}</div>
            <div className={styles.wsChips}>
              {BUILTIN_PROFILES.map((p) => (
                <button
                  key={p.id}
                  className={`${styles.wsChip} ${workspaceId === p.id ? styles.wsChipActive : ""}`}
                  onClick={() => setWorkspaceId(p.id)}
                >
                  {profileLabel(p, isZh)}
                </button>
              ))}
            </div>
            <div className={styles.inputHint}>{t("onboarding.workspaceHint")}</div>
          </div>

          <div className={styles.providerList}>
            <div className={styles.providerCard} onClick={() => void handlePickFolder()}>
              <FolderOpen size={18} color="var(--color-sienna)" />
              <div className={styles.providerInfo}>
                <div className={styles.providerName}>
                  {opening ? t("onboarding.opening") : t("onboarding.pickFolder")}
                </div>
                <div className={styles.providerHint}>{t("onboarding.pickFolderHint")}</div>
              </div>
            </div>
            <div className={styles.providerCard} onClick={() => setStep(3)}>
              <ArrowRight size={18} color="var(--color-text-muted)" />
              <div className={styles.providerInfo}>
                <div className={styles.providerName}>{t("onboarding.later")}</div>
                <div className={styles.providerHint}>{t("onboarding.laterHint")}</div>
              </div>
            </div>
          </div>

          <span className={styles.spacer} />
          {stepNav(1, () => setStep(3))}
        </>
      );
    }
    if (step === 3) {
      return (
        <>
          <div className={styles.formEyebrow}>{t("onboarding.step3Eyebrow")}</div>
          <h2 className={styles.formTitle}>{t("onboarding.step3Title")}</h2>

          <p style={{ font: "400 14px/1.7 var(--font-serif)", color: "var(--color-text-secondary)", maxWidth: 380, marginBottom: 32 }}>
            {t("onboarding.step3Text")}
          </p>

          <span className={styles.spacer} />
          {stepNav(2, () => setStep(4))}
        </>
      );
    }
    // step 4
    return (
      <div className={styles.final}>
        <div className={styles.finalTitle}>{t("onboarding.step4Title", { mod: MOD_KEY })}</div>
        <div className={styles.finalHint}>{t("onboarding.step4Hint", { mod: MOD_K })}</div>
        <div className={styles.shortcutCard}>
          <span className={styles.shortcutKey}>{MOD_KEY} K</span>
          <span className={styles.shortcutDesc}>{t("onboarding.shortcutCmdk")}</span>
        </div>
        <div className={styles.shortcutCard}>
          <span className={styles.shortcutKey}>{MOD_KEY} S</span>
          <span className={styles.shortcutDesc}>{t("onboarding.shortcutSave")}</span>
        </div>
        <div className={styles.shortcutCard}>
          <span className={styles.shortcutKey}>[[ ]]</span>
          <span className={styles.shortcutDesc}>{t("onboarding.shortcutBrackets")}</span>
        </div>
        <span className={styles.spacer} />
        <button className={styles.nextBtn} onClick={dismiss} style={{ marginTop: 24 }}>
          {t("onboarding.start")} <ArrowRight size={12} />
        </button>
      </div>
    );
  };

  return (
    <div className={styles.backdrop}>
      <div className={styles.modal}>
        <div className={styles.brandBand}>
          <span className={styles.brandLogo}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 2 L22 8 L12 14 L2 8 Z M2 16 L12 22 L22 16" />
            </svg>
          </span>
          <span className={styles.brandName}>Manuscript</span>
          <span className={styles.brandVer}>{t("onboarding.brandLocal")}</span>
          <span className={styles.brandSpacer} />
          <button className={styles.brandSkip} onClick={dismiss}>
            {t("onboarding.skip")}
          </button>
        </div>

        <div className={styles.body}>
          {step !== 4 && (
            <div className={styles.welcome}>
              <div className={styles.welcomeOrn1}>手</div>
              <div className={styles.welcomeOrn2}>稿</div>
              <div className={styles.eyebrow}>WELCOME</div>
              <h1 className={styles.welcomeTitle}>
                {t("onboarding.welcomeTitle1")}<br />{t("onboarding.welcomeTitle2")}
              </h1>
              <p className={styles.welcomeText}>{t("onboarding.welcomeText")}</p>
              <div className={styles.steps}>
                {[
                  { n: 1, label: t("onboarding.stepConnect"), hint: t("onboarding.stepConnectHint") },
                  { n: 2, label: t("onboarding.stepProject"), hint: "" },
                  { n: 3, label: t("onboarding.stepImport"), hint: "" },
                  { n: 4, label: t("onboarding.stepCmdk", { mod: MOD_KEY }), hint: "" },
                ].map((s) => (
                  <div key={s.n} className={styles.stepRow}>
                    <span className={`${styles.stepNum} ${step >= s.n ? styles.stepNumActive : styles.stepNumIdle}`}>
                      {s.n}
                    </span>
                    <span className={step === s.n ? styles.stepLabel : styles.stepLabelMuted}>
                      {s.label}
                      {s.hint && <span className={styles.stepHint}> · {s.hint}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={styles.form}>
            {renderStep()}
          </div>
        </div>
      </div>
    </div>
  );
}
