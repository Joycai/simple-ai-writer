import { useState, useEffect } from "react";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { useTranslation } from "react-i18next";
import { Key, ArrowRight, FolderOpen } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { MOD_KEY, MOD_K } from "../../lib/platform";
import styles from "./Onboarding.module.css";

const ONBOARDING_DONE_KEY = "manuscript:onboarding-done";

type Provider = "anthropic" | "openai" | "ollama";

interface ProviderInfo {
  id: Provider;
  name: string;
  hint: string;
  badge?: string;
  baseUrl: string;
  apiStandard: "openai" | "openai_compat" | "gemini";
}

const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic · Claude", hint: "推荐 · 长上下文 · 善中文", badge: "推荐", baseUrl: "https://api.anthropic.com/v1", apiStandard: "openai_compat" },
  { id: "openai",    name: "OpenAI · GPT",      hint: "通用 · 知名",              baseUrl: "https://api.openai.com/v1", apiStandard: "openai" },
  { id: "ollama",    name: "本地 · Ollama",     hint: "完全离线 · 适合敏感内容",   baseUrl: "http://localhost:11434/v1", apiStandard: "openai_compat" },
];

export function Onboarding() {
  useTranslation(); // ensure language updates trigger re-render
  const { showOnboarding, setShowOnboarding } = useAppStore();
  const { providers, addProvider } = useAiStore();
  const { openProject } = useProjectStore();

  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState<Provider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  // Auto-show on first run if no provider configured
  useEffect(() => {
    const done = localStorage.getItem(ONBOARDING_DONE_KEY) === "true";
    if (!done && providers.length === 0) {
      setShowOnboarding(true);
    }
  }, [providers.length, setShowOnboarding]);

  if (!showOnboarding) return null;

  const dismiss = () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true");
    setShowOnboarding(false);
  };

  const handleSaveProvider = async () => {
    const info = PROVIDERS.find((p) => p.id === selected)!;
    if (!apiKey.trim()) { setStep(2); return; }
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

  const renderStep = () => {
    if (step === 1) {
      return (
        <>
          <div className={styles.formEyebrow}>STEP 1 · 接入 AI</div>
          <h2 className={styles.formTitle}>选一个提供方</h2>

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
                  <div className={styles.providerHint}>{p.hint}</div>
                </div>
                {p.badge && <span className={styles.providerBadge}>{p.badge}</span>}
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
            <div className={styles.inputHint}>
              你的密钥不会离开本机 · 存储在系统密钥库
            </div>
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
              {saving ? "保存…" : "继续"} <ArrowRight size={12} />
            </button>
          </div>
        </>
      );
    }
    if (step === 2) {
      return (
        <>
          <div className={styles.formEyebrow}>STEP 2 · 项目</div>
          <h2 className={styles.formTitle}>建立或导入项目</h2>

          <div className={styles.providerList}>
            <div className={styles.providerCard} onClick={() => { openProject(); setStep(3); }}>
              <FolderOpen size={18} color="var(--color-sienna)" />
              <div className={styles.providerInfo}>
                <div className={styles.providerName}>选择本地文件夹</div>
                <div className={styles.providerHint}>系统将创建 writing/ 与 .ai-writer/ 子目录</div>
              </div>
            </div>
            <div className={styles.providerCard} onClick={() => setStep(3)}>
              <ArrowRight size={18} color="var(--color-text-muted)" />
              <div className={styles.providerInfo}>
                <div className={styles.providerName}>稍后再说</div>
                <div className={styles.providerHint}>之后可在左下角图标栏打开</div>
              </div>
            </div>
          </div>

          <span className={styles.spacer} />

          <div className={styles.stepNav}>
            <div className={styles.dots}>
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={`${styles.dot} ${n <= step ? styles.dotActive : ""}`} />
              ))}
            </div>
            <span className={styles.dotCount}>{step} / 4</span>
            <span className={styles.spacer} />
            <button className={styles.backBtn} onClick={() => setStep(1)}>返回</button>
            <button className={styles.nextBtn} onClick={() => setStep(3)}>
              继续 <ArrowRight size={12} />
            </button>
          </div>
        </>
      );
    }
    if (step === 3) {
      return (
        <>
          <div className={styles.formEyebrow}>STEP 3 · 设定库</div>
          <h2 className={styles.formTitle}>导入已有设定（可选）</h2>

          <p style={{ font: "400 14px/1.7 var(--font-serif)", color: "var(--color-text-secondary)", maxWidth: 380, marginBottom: 32 }}>
            如果你已有人物表、世界观笔记，可以拖入项目的 lore/ 目录，或稍后在设定库中创建。
          </p>

          <span className={styles.spacer} />

          <div className={styles.stepNav}>
            <div className={styles.dots}>
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={`${styles.dot} ${n <= step ? styles.dotActive : ""}`} />
              ))}
            </div>
            <span className={styles.dotCount}>{step} / 4</span>
            <span className={styles.spacer} />
            <button className={styles.backBtn} onClick={() => setStep(2)}>返回</button>
            <button className={styles.nextBtn} onClick={() => setStep(4)}>
              继续 <ArrowRight size={12} />
            </button>
          </div>
        </>
      );
    }
    // step 4
    return (
      <div className={styles.final}>
        <div className={styles.finalTitle}>认识 {MOD_KEY} K</div>
        <div className={styles.finalHint}>
          任何时候按下 {MOD_K}，召唤 AI、跳转章节、检索设定 — 一切的开始。
        </div>
        <div className={styles.shortcutCard}>
          <span className={styles.shortcutKey}>{MOD_KEY} K</span>
          <span className={styles.shortcutDesc}>命令面板 · 召唤 AI · 跳转</span>
        </div>
        <div className={styles.shortcutCard}>
          <span className={styles.shortcutKey}>{MOD_KEY} S</span>
          <span className={styles.shortcutDesc}>保存（自动保存到本地）</span>
        </div>
        <div className={styles.shortcutCard}>
          <span className={styles.shortcutKey}>[[ ]]</span>
          <span className={styles.shortcutDesc}>双方括号标设定 · 自动入设定库</span>
        </div>
        <span className={styles.spacer} />
        <button className={styles.nextBtn} onClick={dismiss} style={{ marginTop: 24 }}>
          开始写作 <ArrowRight size={12} />
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
          <span className={styles.brandVer}>· 本地 · v 2.0</span>
          <span className={styles.brandSpacer} />
          <button className={styles.brandSkip} onClick={dismiss}>
            跳过设置
          </button>
        </div>

        <div className={styles.body}>
          {step !== 4 && (
            <div className={styles.welcome}>
              <div className={styles.welcomeOrn1}>手</div>
              <div className={styles.welcomeOrn2}>稿</div>
              <div className={styles.eyebrow}>WELCOME</div>
              <h1 className={styles.welcomeTitle}>先把 AI 接进来<br />然后我们开始写。</h1>
              <p className={styles.welcomeText}>
                Manuscript 是本地写作工具。你的文稿、设定、密钥都只存在你这台机器上，永不上传。
              </p>
              <div className={styles.steps}>
                {[
                  { n: 1, label: "接入 AI", hint: "大概 1 分钟" },
                  { n: 2, label: "建立或导入项目", hint: "" },
                  { n: 3, label: "导入已有设定（可选）", hint: "" },
                  { n: 4, label: `认识 ${MOD_KEY} K · 一切的开始`, hint: "" },
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
