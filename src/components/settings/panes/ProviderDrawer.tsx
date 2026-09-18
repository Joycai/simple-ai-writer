import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Check, AlertCircle } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import type { Model, Provider } from "../../../lib/ai/configDb";
import { authModesFor, type AuthMode, type ProtocolFamily } from "../../../lib/ai/types";
import { anthropicUrl, defaultBaseFor, geminiUrl, openaiUrl } from "../../../lib/ai/urls";
import {
  GEMINI_HARM_CATEGORIES,
  GEMINI_THRESHOLD_LEVELS,
  defaultSafetySettings,
  type GeminiSafetySettings,
  type GeminiHarmCategory,
} from "../../../lib/ai/safety";
import { testComfyUiConnection, testProviderConnection } from "../../../lib/ai/providerProbe";
import {
  PLATFORM_IDS, platformDefaultPath, platformEndpoints, platformForAddress, platformOrigin, serverToolStatus,
  type PlatformId,
} from "../../../lib/ai/platforms";
import {
  activeFamily, channelEndpoints, channelHost, endpointBaseUrl, newChannelEndpoints, normalizeChannel,
  ROUTE_FAMILIES, ROUTE_LONG, ROUTE_SHORT, standardOf, type Endpoint,
} from "../../../lib/ai/routes";
import { SERVER_TOOL_IDS } from "../../../lib/ai/serverTools";
import { Select } from "../../common/Select";
import styles from "../settingsCommon.module.css";
import hub from "./ProvidersModels.module.css";
import r from "./Routes.module.css";

/**
 * The channel drawer — 设计稿 05k 屏 02 (添加渠道 · 选平台) and 屏 03 (线路表).
 *
 * A channel is one key on one platform (docs/feature/channel-model-route-plan.md
 * §2.1). Adding one starts from the **platform**, not the protocol: the
 * platform says which routes exist, where each one lives and which server tools
 * each one spells, so the author picks it, sees that preview, and types a key.
 * The routes are then a table — one row per protocol family the platform
 * serves, each with its own path (the platform's convention unless changed),
 * auth header and connection test. The host is typed once.
 *
 * What replaced the old preset buttons: a preset was a form fill that vanished
 * once applied. The platform stays on the row, so its routes, paths and tools
 * keep following `lib/ai/platforms.ts` as it learns more (§4 rule 3).
 */

/**
 * The fields a starter row declares; everything else takes the row default.
 *
 * `type` is here because a capability the author has to *discover* is one most
 * of them never turn on: nothing in a model id says whether the endpoint will
 * look at a picture, and a row left at the "text" default has `read_image`,
 * the vision subagent and chat attachments all silently unavailable. A preset
 * that already knows the answer for its own catalogue should answer it.
 */
type StarterModel = Pick<Model, "modelId" | "name"> &
  Partial<Pick<Model, "contextSize" | "maxOutput" | "thinkingCategory" | "type" | "videoInput">>;

/**
 * OrcaRouter's free tier (2026-09): rate-limited, billed at $0, and — verified
 * live — all three stream on `/v1/chat/completions` with reasoning arriving in
 * `reasoning_content` and usage on the final chunk. Context sizes are the
 * relay's own model pages; the DeepSeek row also names its output cap (384K).
 * The DeepSeek page lists `thinking` among its accepted parameters, which is
 * the `deepseek` category's dialect, so the author gets the on/off switch;
 * the other two stay on the family default (`reasoning_effort`, which the
 * relay translates per model).
 */
const ORCAROUTER_FREE_MODELS: StarterModel[] = [
  { modelId: "deepseek/deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)", contextSize: 1_000_000, maxOutput: 384_000, thinkingCategory: "deepseek" },
  { modelId: "qwen/qwen3.8-27b-free", name: "Qwen3.8 27B (Free)", contextSize: 65_536 },
  { modelId: "tencent/hy3-free", name: "Hunyuan Hy3 (Free)", contextSize: 262_144 },
];

/**
 * DeepSeek's own catalogue (api-docs.deepseek.com 模型 & 价格, 2026-09): two
 * models, both 1M window / 384K cap, both on the `deepseek` thinking dialect
 * (`thinking:{type:disabled}` to turn it off — the Flash page calls this
 * "非思考模式").
 *
 * The row that matters is `deepseek-flash` (DeepSeek-V4.1-Flash) being
 * **multimodal**: it reads pictures through the plain OpenAI `image_url` part
 * this app already sends, so the entire gap between "the app can do this" and
 * "the author can do this" was one type chip nobody knew to click. `-pro` has
 * no vision and stays text — the same measurement that says so is quoted in
 * docs/api/landscape.md §千问 (which probed `deepseek-v4-pro-0813`).
 *
 * The older `deepseek-chat` / `deepseek-reasoner` ids are deliberately absent:
 * they still resolve, but a starter list is a recommendation, not an archive.
 */
const DEEPSEEK_MODELS: StarterModel[] = [
  { modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextSize: 1_048_576, maxOutput: 393_216, thinkingCategory: "deepseek", type: "multimodal" },
  { modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextSize: 1_048_576, maxOutput: 393_216, thinkingCategory: "deepseek" },
];

/**
 * DashScope's image-reading models, typed so the author does not have to know
 * which ids look at pictures (measured 2026-09-14, docs/api/landscape.md §6):
 * qwen3.8-flash is a general model that also reads images (multimodal); the
 * qwen3-vl pair and the OCR model are the specialists (vision). Window and cap
 * are filled only where the model page states them (qwen3-vl-plus 262K / 32K).
 *
 * Only on the domestic compatible-mode preset: the international host's
 * catalogue was not checked, and qwen3-vl-plus refuses the Responses wire.
 */
const DASHSCOPE_MODELS: StarterModel[] = [
  // videoInput: all three read an mp4 / mov / webm clip on compatible-mode
  // (docs/api/landscape.md §7 第六个样本「视觉理解」, 2026-09-14).
  { modelId: "qwen3.8-flash", name: "Qwen3.8 Flash", type: "multimodal", videoInput: true },
  { modelId: "qwen3-vl-plus", name: "Qwen3-VL Plus", contextSize: 262_144, maxOutput: 32_768, type: "vision", videoInput: true },
  { modelId: "qwen3-vl-flash", name: "Qwen3-VL Flash", type: "vision", videoInput: true },
  { modelId: "qwen-vl-ocr-latest", name: "Qwen-VL OCR", type: "vision" },
];

/** Starter rows a new channel on a platform brings along (only on creation). */
const STARTER_MODELS: Partial<Record<PlatformId, StarterModel[]>> = {
  deepseek: DEEPSEEK_MODELS,
  dashscope: DASHSCOPE_MODELS,
  orcarouter: ORCAROUTER_FREE_MODELS,
};

/** Platforms whose routes are the vendor's own constants — no host, no path to type. */
const isOfficialPlatform = (p: PlatformId): boolean =>
  platformEndpoints(p).every((e) => e.official);

/** A server on the local machine (Ollama, LM Studio) — these need no API key. */
function isLocalEndpoint(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url.trim());
}

/** The request one route's chat call actually goes to — the adapters' own URL functions (§5.1.1). */
function requestUrl(ep: Endpoint, base: string): string {
  const b = base || defaultBaseFor(standardOf(ep));
  switch (ep.family) {
    case "anthropic": return anthropicUrl(b, "/messages");
    case "gemini": return geminiUrl(b, "/models/{model}:streamGenerateContent");
    case "responses": return openaiUrl(b, "/responses");
    default: return openaiUrl(b, "/chat/completions");
  }
}

interface Props {
  /** null = add a new channel. */
  providerId: string | null;
  /** The key is fetched by the pane before opening, so the drawer never has to
   *  render a half-populated form while the keyring call is in flight. */
  initialApiKey: string;
  onClose: () => void;
  /**
   * Called instead of onClose when a brand-new ComfyUI channel is saved, so
   * the pane can open the model drawer on it right away. A channel alone
   * generates nothing — the workflow import is the step that matters
   * (docs/feature/comfyui-plan.md §7.2).
   */
  onComfyCreated?: (providerId: string) => void;
}

interface Form {
  name: string;
  apiKey: string;
  platform: PlatformId;
  host: string;
  /** Enabled routes, primary first. */
  endpoints: Endpoint[];
}

export function ProviderDrawer({ providerId, initialApiKey, onClose, onComfyCreated }: Props) {
  const { t } = useTranslation();
  const { providers, models, addProvider, updateProvider, addModel, updateModel } = useAiStore();
  const existing = providerId ? providers.find((p) => p.id === providerId) : undefined;

  const [form, setForm] = useState<Form | null>(() =>
    existing
      ? {
          name: existing.name,
          apiKey: initialApiKey,
          platform: existing.platform ?? "custom",
          host: channelHost(existing),
          endpoints: channelEndpoints(existing),
        }
      : null,
  );
  /**
   * The author chose the platform themselves (the select, or a stored platform
   * the host doesn't name). Then editing the host leaves it alone; otherwise
   * the platform follows the host — pasting DashScope's address means DashScope.
   */
  const [platformPinned, setPlatformPinned] = useState(
    () => !!existing?.platform && !isOfficialPlatform(existing.platform)
      && platformForAddress(existing.platform, channelHost(existing), "openai_compat") !== existing.platform,
  );
  const [starterModels, setStarterModels] = useState<StarterModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<ProtocolFamily | "comfy" | null>(null);
  const [testResult, setTestResult] = useState<{ route: ProtocolFamily | "comfy"; ok: boolean; message: string } | null>(null);

  const pickPlatform = (platform: PlatformId) => {
    setPlatformPinned(platform === "newapi" || platform === "custom");
    setStarterModels(STARTER_MODELS[platform] ?? []);
    setTestResult(null);
    setForm((f) => ({
      name: f && f.name && !PLATFORM_IDS.some((id) => t(`aiConfig.platforms.${id}`) === f.name)
        ? f.name
        : t(`aiConfig.platforms.${platform}`),
      apiKey: f?.apiKey ?? "",
      platform,
      host: platformOrigin(platform),
      endpoints: newChannelEndpoints(platform),
    }));
  };

  // ── Add, step 1: the platform grid with its preview ───────────────────────
  if (!form) {
    return (
      <div className={hub.drawer} role="dialog" aria-label={t("aiConfig.providers.addTitle")}>
        <DrawerHead title={t("aiConfig.providers.addTitle")} onClose={onClose} />
        <div className={hub.drawerBody}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.providers.platformPickLabel")}</label>
            <div className={styles.hint}>{t("aiConfig.providers.platformPickHint")}</div>
          </div>
          <PlatformGrid current={null} onPick={pickPlatform} />
        </div>
      </div>
    );
  }

  const comfyMode = form.platform === "comfyui"
    || (!!existing && models.some((m) => m.providerId === existing.id && m.caps?.route === "comfyui"));
  // Asked of the routes, not the platform: a compat row whose host happens to
  // be a vendor's (an openai_compat row on api.openai.com) is on the `openai`
  // platform but has a typed address — treating it as official would drop its host.
  const official = form.endpoints.length > 0 && form.endpoints.every((e) => e.official);
  // The draft as a channel: every address below is read off it, through the
  // same functions a request uses, so the table can't show one URL and the
  // request go to another.
  const draft: Provider = normalizeChannel({
    id: existing?.id ?? "draft",
    name: form.name,
    baseUrl: "",
    apiStandard: standardOf(form.endpoints[0]),
    platform: comfyMode ? "comfyui" : form.platform,
    host: official ? "" : form.host.trim(),
    endpoints: form.endpoints,
    createdAt: existing?.createdAt ?? 0,
  });
  const keyRequired = !comfyMode && !isLocalEndpoint(draft.host ?? "");
  const offered: ProtocolFamily[] = ROUTE_FAMILIES.filter((f) =>
    platformEndpoints(form.platform).some((e) => e.family === f) || form.endpoints.some((e) => e.family === f));
  /** Models on this channel that take `family` as their route — a route in use can't be switched off. */
  const usersOf = (family: ProtocolFamily): number => existing
    ? models.filter((m) => m.providerId === existing.id && activeFamily(m, existing) === family).length
    : 0;

  const setEndpoint = (family: ProtocolFamily, patch: Partial<Endpoint> | null) => {
    setForm((f) => {
      if (!f) return f;
      const idx = f.endpoints.findIndex((e) => e.family === family);
      if (patch === null) return { ...f, endpoints: f.endpoints.filter((e) => e.family !== family) };
      if (idx < 0) {
        const spec = platformEndpoints(f.platform).find((e) => e.family === family);
        const ep: Endpoint = {
          family,
          // Official only beside official routes — never a vendor constant on a relay.
          official: spec?.official === true && f.endpoints.every((e) => e.official),
          ...(spec?.authMode ? { authMode: spec.authMode } : {}),
          ...(family === "gemini" ? { safetySettings: defaultSafetySettings() } : {}),
          ...patch,
        };
        // Appended in family order after the primary, so the table and the
        // badges read the same way everywhere.
        const rest = [...f.endpoints.slice(1), ep].sort(
          (a, b) => ROUTE_FAMILIES.indexOf(a.family) - ROUTE_FAMILIES.indexOf(b.family));
        return { ...f, endpoints: [f.endpoints[0], ...rest] };
      }
      const next = [...f.endpoints];
      const merged = { ...next[idx], ...patch } as Endpoint;
      for (const k of Object.keys(merged) as (keyof Endpoint)[]) if (merged[k] === undefined) delete merged[k];
      next[idx] = merged;
      return { ...f, endpoints: next };
    });
  };
  const makePrimary = (family: ProtocolFamily) => setForm((f) => f && {
    ...f,
    endpoints: [
      ...f.endpoints.filter((e) => e.family === family),
      ...f.endpoints.filter((e) => e.family !== family),
    ],
  });

  const test = async (family: ProtocolFamily | "comfy") => {
    setTesting(family);
    setTestResult(null);
    try {
      if (family === "comfy") {
        const res = await testComfyUiConnection(draft.baseUrl);
        setTestResult({ route: family, ok: res.ok, message: res.ok ? res.message : res.error });
        return;
      }
      const ep = form.endpoints.find((e) => e.family === family)!;
      const base = endpointBaseUrl(draft, ep) || defaultBaseFor(standardOf(ep));
      if (!base || (keyRequired && !form.apiKey)) {
        setTestResult({ route: family, ok: false, message: t("aiConfig.providers.testMissingFields") });
        return;
      }
      const res = await testProviderConnection(base, form.apiKey, standardOf(ep), ep.authMode ?? "default");
      setTestResult({ route: family, ok: res.ok, message: res.ok ? res.message : res.error });
    } catch (e) {
      setTestResult({ route: family, ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(null);
    }
  };

  const handleSave = async () => {
    if (!form.name || (keyRequired && !form.apiKey) || form.endpoints.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const channel: Provider = { ...draft, name: form.name.trim() };
      if (existing) {
        // A model that never picked a route follows the primary one; moving the
        // primary would carry it to another protocol with fields set for the
        // old one (invariant 3). Pin those to the route they were on first.
        const oldPrimary = channelEndpoints(existing)[0].family;
        if (channel.endpoints![0].family !== oldPrimary) {
          for (const m of models) {
            if (m.providerId === existing.id && !m.activeRoute) await updateModel({ ...m, activeRoute: oldPrimary });
          }
        }
        await updateProvider({ ...existing, ...channel, id: existing.id, createdAt: existing.createdAt }, form.apiKey);
      } else {
        const { id: _draftId, createdAt: _draftAt, ...rest } = channel;
        const newId = await addProvider(rest, form.apiKey);
        // Sequential on purpose: addModel is also where the first model ever
        // added becomes the active one, and two rows racing for that would
        // leave the author with whichever resolved second.
        for (const m of starterModels) {
          await addModel({
            providerId: newId,
            modelId: m.modelId,
            name: m.name,
            type: m.type ?? "text",
            priceIn: 0,
            priceCachedIn: 0,
            priceOut: 0,
            enabled: true,
            contextSize: m.contextSize,
            maxOutput: m.maxOutput,
            thinkingCategory: m.thinkingCategory,
            videoInput: m.videoInput,
          });
        }
        if (comfyMode && onComfyCreated) {
          onComfyCreated(newId);
          return;
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const resultFor = (route: ProtocolFamily | "comfy") => testResult?.route === route && (
    <div className={testResult.ok ? styles.testResultOk : styles.testResultError}>
      {testResult.ok
        ? <Check size={14} className={styles.testResultIcon} />
        : <AlertCircle size={14} className={styles.testResultIcon} />}
      <span className={styles.testResultMessage}>{testResult.message}</span>
    </div>
  );
  const gemini = form.endpoints.find((e) => e.family === "gemini");

  return (
    <div className={hub.drawer} role="dialog" aria-label={existing ? t("aiConfig.providers.editTitle") : t("aiConfig.providers.addTitle")}>
      <DrawerHead
        title={existing ? t("aiConfig.providers.editTitle") : t("aiConfig.providers.addTitle")}
        sub={t(`aiConfig.platforms.${comfyMode ? "comfyui" : form.platform}`)}
        onClose={onClose}
      />

      <div className={hub.drawerBody}>
        {error && <div className={styles.errorNote}>{error}</div>}

        {!existing && (
          <>
            <PlatformGrid current={form.platform} onPick={pickPlatform} />
            <PlatformPreview platform={form.platform} starters={starterModels} />
          </>
        )}

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.providers.nameLabel")}</label>
          <input className={styles.input} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>

        {/* The platform: which private fields this server takes beyond its
            protocol, and which routes it serves. Fixed on an official one
            (the vendor *is* the platform); otherwise it follows the host as
            it is typed, and the select covers what no host names — a
            self-hosted New API, a DashScope-shaped proxy. */}
        {existing && !comfyMode && !official && (
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.providers.platformLabel")}</label>
            <Select value={form.platform}
              options={PLATFORM_IDS.filter((id) => id !== "comfyui" && !isOfficialPlatform(id))
                .map((id) => ({ value: id, label: t(`aiConfig.platforms.${id}`) }))}
              ariaLabel={t("aiConfig.providers.platformLabel")}
              onChange={(v) => {
                setPlatformPinned(true);
                setForm({ ...form, platform: v as PlatformId });
              }} />
            <div className={styles.hint}>{t("aiConfig.providers.platformHint")}</div>
          </div>
        )}

        {!official && (
          <div className={styles.fieldGroup}>
            <label className={styles.label}>
              {comfyMode ? t("aiConfig.providers.comfyHostLabel") : t("aiConfig.providers.hostLabel")}
            </label>
            <input className={`${styles.input} ${hub.mono}`} placeholder="https://relay.example.com" value={form.host}
              onChange={(e) => {
                const host = e.target.value;
                setForm({
                  ...form,
                  host,
                  platform: platformPinned || comfyMode
                    ? form.platform
                    : platformForAddress(form.platform, host, "openai_compat"),
                });
              }} />
            <div className={styles.hint}>
              {comfyMode ? t("aiConfig.providers.comfyBaseUrlHint") : t("aiConfig.providers.hostHint")}
            </div>
          </div>
        )}

        <div className={styles.fieldGroup}>
          <label className={styles.label}>
            {comfyMode ? t("aiConfig.providers.comfyCheckLabel") : t("aiConfig.providers.apiKeyLabel")}
            {!comfyMode && !keyRequired && <span className={styles.hint}> · {t("aiConfig.providers.apiKeyOptional")}</span>}
          </label>
          {comfyMode ? (
            <>
              <div className={styles.keyRow}>
                <button className={`${styles.btnSecondary} ${styles.testBtn}`} onClick={() => void test("comfy")}
                  disabled={!draft.baseUrl || testing !== null}>
                  {testing === "comfy" ? t("aiConfig.providers.testing") : t("aiConfig.providers.testConnection")}
                </button>
              </div>
              <div className={styles.hint}>{t("aiConfig.providers.comfyCheckHint")}</div>
              {resultFor("comfy")}
            </>
          ) : (
            <input className={styles.input} type="password"
              placeholder={keyRequired ? "sk-…" : t("aiConfig.providers.apiKeyLocalPlaceholder")}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          )}
        </div>

        {!comfyMode && (
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.providers.routesLabel")}</label>
            <div className={styles.hint}>{t(official ? "aiConfig.providers.routesHintOfficial" : "aiConfig.providers.routesHint")}</div>
            <div className={r.table}>
              {offered.map((family) => {
                const ep = form.endpoints.find((e) => e.family === family);
                const on = !!ep;
                const primary = form.endpoints[0]?.family === family;
                const users = usersOf(family);
                const def = platformDefaultPath(form.platform, family);
                const std = standardOf(ep ?? { family, official });
                const authModes = authModesFor(std);
                const base = ep ? endpointBaseUrl(draft, ep) : "";
                const absolute = !!ep?.path && /^[a-z][a-z0-9+.-]*:\/\//i.test(ep.path);
                const blockOff = primary && form.endpoints.length === 1
                  ? t("aiConfig.providers.routeLastOne")
                  : users > 0 ? t("aiConfig.providers.routeInUse", { count: users }) : null;
                return (
                  <div key={family} className={`${r.row} ${on ? "" : r.rowOff}`}>
                    <div className={r.rowHead}>
                      <input type="checkbox" checked={on}
                        aria-label={t("aiConfig.providers.routeEnable", { route: ROUTE_LONG[family] })}
                        disabled={on && !!blockOff}
                        title={on && blockOff ? blockOff : undefined}
                        onChange={(e) => setEndpoint(family, e.target.checked ? {} : null)} />
                      <span className={`${r.badge} ${users > 0 ? r.badgeOn : on ? "" : r.badgeOffered}`}>{ROUTE_SHORT[family]}</span>
                      <span className={r.rowName}>{ROUTE_LONG[family]}</span>
                      {primary && <span className={r.tag}>{t("aiConfig.providers.routePrimary")}</span>}
                      {users > 0 && <span className={r.tag}>{t("aiConfig.providers.routeUsers", { count: users })}</span>}
                      <span className={r.rowSpacer} />
                      {on && !primary && (
                        <button className={r.tinyBtn} onClick={() => makePrimary(family)}>
                          {t("aiConfig.providers.routeMakePrimary")}
                        </button>
                      )}
                      {on && (
                        <button className={r.tinyBtn} onClick={() => void test(family)} disabled={testing !== null}>
                          {testing === family ? t("aiConfig.providers.testing") : t("aiConfig.providers.routeTest")}
                        </button>
                      )}
                    </div>
                    {on && ep && (
                      <>
                        {ep.official ? (
                          <div className={r.pathRow}>
                            <span className={r.tag}>{t("aiConfig.providers.routeOfficialPath")}</span>
                          </div>
                        ) : (
                          <div className={r.pathRow}>
                            <span className={r.hostCell}>
                              {absolute ? t("aiConfig.providers.routeOwnHostCell") : (draft.host || "—")}
                            </span>
                            <input
                              className={`${styles.input} ${r.pathInput} ${ep.path === undefined ? r.pathInputDefault : ""}`}
                              value={ep.path ?? ""}
                              placeholder={def || "/"}
                              aria-label={t("aiConfig.providers.routePathLabel", { route: ROUTE_LONG[family] })}
                              onChange={(e) => setEndpoint(family, { path: e.target.value })}
                              // An override equal to the convention is the
                              // convention: stored as nothing, so it keeps
                              // following the platform (§5.1.1).
                              onBlur={(e) => { if (e.target.value === def || e.target.value === "") setEndpoint(family, { path: undefined }); }}
                            />
                          </div>
                        )}
                        {!ep.official && (
                          <div className={r.pathRow}>
                            <span className={`${r.tag} ${ep.path !== undefined ? r.tagSet : ""}`}>
                              {ep.path === undefined
                                ? t("aiConfig.providers.routeDefaultTag", { path: def || t("aiConfig.providers.routeRoot") })
                                : absolute
                                  ? t("aiConfig.providers.routeOwnHost")
                                  : t("aiConfig.providers.routeChangedTag", { path: def || t("aiConfig.providers.routeRoot") })}
                            </span>
                            <button className={r.tinyBtn} disabled={ep.path === undefined}
                              onClick={() => setEndpoint(family, { path: undefined })}>
                              {t("aiConfig.providers.routeRestore")}
                            </button>
                          </div>
                        )}
                        {authModes.length > 1 && (
                          <div className={r.pathRow}>
                            <span className={r.hostCell}>{t("aiConfig.providers.authModeLabel")}</span>
                            <Select value={ep.authMode ?? "default"}
                              options={authModes.map((mode) => ({ value: mode, label: t(`aiConfig.providers.authModes.${mode}`) }))}
                              ariaLabel={t("aiConfig.providers.authModeLabel")}
                              onChange={(v) => setEndpoint(family, { authMode: v === "default" ? undefined : v as AuthMode })} />
                          </div>
                        )}
                        <div className={r.url}>POST {requestUrl(ep, base)}</div>
                        {resultFor(family)}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {offered.some((f) => form.endpoints.some((e) => e.family === f && authModesFor(standardOf(e)).length > 1)) && (
              <div className={styles.hint}>{t("aiConfig.providers.authModeHint")}</div>
            )}
          </div>
        )}

        {!comfyMode && gemini && (
          <GeminiSafetyEditor
            value={gemini.safetySettings ?? defaultSafetySettings()}
            onChange={(safetySettings) => setEndpoint("gemini", { safetySettings })}
          />
        )}
      </div>

      <div className={hub.drawerFoot}>
        <span className={hub.escHint}>{t("aiConfig.hub.escToClose")}</span>
        <span className={hub.footSpacer} />
        <button className={styles.btnSecondary} onClick={onClose}>{t("aiConfig.providers.cancel")}</button>
        <button className={styles.btnPrimary} onClick={handleSave}
          disabled={!form.name || (keyRequired && !form.apiKey) || form.endpoints.length === 0 || saving}>
          {saving
            ? (existing ? t("aiConfig.providers.editing") : t("aiConfig.providers.saving"))
            : existing
              ? t("aiConfig.providers.edit")
              : comfyMode
                ? t("aiConfig.providers.saveAndAddWorkflow")
                : t("aiConfig.providers.save")}
        </button>
      </div>
    </div>
  );
}

function DrawerHead({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={hub.drawerHead}>
      <div style={{ minWidth: 0 }}>
        <div className={hub.drawerTitle}>{title}</div>
        {sub && <div className={hub.drawerSub}>{sub}</div>}
      </div>
      <span className={hub.footSpacer} />
      <button className={hub.iconBtn} onClick={onClose} title={t("aiConfig.providers.cancel")}>
        <X size={16} />
      </button>
    </div>
  );
}

/** The platform cards (屏 02): name + the routes it would create. */
function PlatformGrid({ current, onPick }: { current: PlatformId | null; onPick: (p: PlatformId) => void }) {
  const { t } = useTranslation();
  return (
    <div className={r.platformGrid}>
      {PLATFORM_IDS.map((id) => (
        <button key={id} type="button"
          className={`${r.platformCard} ${current === id ? r.platformCardOn : ""}`}
          aria-pressed={current === id}
          onClick={() => onPick(id)}>
          <span className={r.platformName}>{t(`aiConfig.platforms.${id}`)}</span>
          {id !== "comfyui" && (
            <span className={r.badges}>
              {newChannelEndpoints(id).map((e) => (
                <span key={e.family} className={r.badge}>{ROUTE_SHORT[e.family]}</span>
              ))}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** What picking this platform will create (屏 02 right side): routes, their tools, starter rows. */
function PlatformPreview({ platform, starters }: { platform: PlatformId; starters: StarterModel[] }) {
  const { t } = useTranslation();
  if (platform === "comfyui") return null;
  const routes = newChannelEndpoints(platform);
  return (
    <div className={r.preview}>
      <div className={r.previewRow}>
        <span className={r.previewLabel}>{t("aiConfig.providers.previewRoutes")}</span>
        <span className={r.badges}>
          {routes.map((e) => <span key={e.family} className={r.badge}>{ROUTE_LONG[e.family]}</span>)}
        </span>
      </div>
      {routes.map((e) => {
        const wire = { platform, standard: standardOf(e) };
        const tools = SERVER_TOOL_IDS.filter((id) => serverToolStatus(wire, id) !== "no");
        return (
          <div key={e.family} className={r.previewRow}>
            <span className={r.previewLabel}>{ROUTE_SHORT[e.family]}</span>
            <span>
              {tools.length
                ? tools.map((id) => t(`aiConfig.models.serverTool_${id}`)
                  + (serverToolStatus(wire, id) === "unknown" ? ` (${t("aiConfig.providers.previewUnmeasured")})` : "")).join(" · ")
                : t("aiConfig.providers.previewNoTools")}
            </span>
          </div>
        );
      })}
      {starters.length > 0 && (
        <div className={r.previewRow}>
          <span className={r.previewLabel}>{t("aiConfig.providers.previewStarters")}</span>
          <span>{starters.map((m) => m.name).join(" · ")}</span>
        </div>
      )}
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
