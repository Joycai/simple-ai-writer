import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { familyOf, type ImageRoute } from "../../../lib/ai/types";
import {
  REASONING_EFFORTS, THINKING_DIALECTS, supportsTemperature, supportsThinkingLevel,
  type ReasoningEffort, type ThinkingDialect,
} from "../../../lib/ai/reasoning";
import {
  SERVER_TOOL_IDS, supportsServerTools, type ServerToolId,
} from "../../../lib/ai/serverTools";
import {
  defaultImageCaps, MAX_CONTEXT_SIZE, MAX_OUTPUT_SIZE, MAX_TEMPERATURE, TRANSLATE_FORMATS,
  type ModelType, type TranslateFormat,
} from "../../../lib/ai/configDb";
import type { ImageDialect } from "../../../lib/ai/imageDialects";
import { CONTEXT_SIZE_STOPS, formatContextSize } from "../../../lib/ai/contextSize";
import { ModelProbePanel } from "../ModelProbePanel";
import { Chip, ChipRow } from "./bits";
import { Select } from "../../common/Select";
import styles from "../settingsCommon.module.css";
import hub from "./ProvidersModels.module.css";

const MODEL_TYPES: ModelType[] = ["text", "multimodal", "image", "video"];

interface Props {
  /** The group this drawer was opened from — a model cannot change hands. */
  providerId: string;
  /** null = add a new model under `providerId`. */
  modelId: string | null;
  onClose: () => void;
}

export function ModelDrawer({ providerId, modelId, onClose }: Props) {
  const { t } = useTranslation();
  const { providers, models, addModel, updateModel, fetchAndImportModels } = useAiStore();
  const existing = modelId ? models.find((m) => m.id === modelId) : undefined;
  const provider = providers.find((p) => p.id === providerId);
  const family = provider ? familyOf(provider.apiStandard) : undefined;
  // Which dialects this family can be *offered*: Anthropic has four shapes
  // across generations; the OpenAI family has exactly one declared deviation
  // from the standard `reasoning_effort` — the bare `enable_thinking` switch
  // (Qwen on DashScope). Offering the other shapes there would be controls
  // the adapter ignores.
  const dialectChoices: ThinkingDialect[] | null =
    family === "anthropic" ? THINKING_DIALECTS
    : family === "openai" ? ["switch"]
    : null;

  const [form, setForm] = useState({
    modelId: existing?.modelId ?? "",
    name: existing?.name ?? "",
    type: existing?.type ?? ("text" as ModelType),
    priceIn: existing?.priceIn ? String(existing.priceIn) : "",
    priceCachedIn: existing?.priceCachedIn ? String(existing.priceCachedIn) : "",
    priceOut: existing?.priceOut ? String(existing.priceOut) : "",
    prefix: existing?.prefix ?? "",
    contextSize: existing?.contextSize ? String(existing.contextSize) : "",
    maxOutput: existing?.maxOutput ? String(existing.maxOutput) : "",
    // Not `existing.temperature ? …` — a stored 0 is a real setting and must
    // not render as the empty field that means "send nothing".
    temperature: existing?.temperature !== undefined ? String(existing.temperature) : "",
    pricePerImage: existing?.pricePerImage ? String(existing.pricePerImage) : "",
    capsSizes: (existing?.caps?.sizes ?? []).join(", "),
    capsRoute: existing?.caps?.route ?? "",
    // "" = generic (the free-form sizes list); otherwise a declared dialect.
    capsDialect: (existing?.caps?.dialect ?? "") as ImageDialect | "",
    reasoningEffort: existing?.reasoningEffort ?? ("default" as ReasoningEffort),
    // "" = 未声明，按协议族推导 —— 与存储上的 undefined 一一对应。
    thinkingDialect: (existing?.thinkingDialect ?? "") as ThinkingDialect | "",
    // 同样的 "" ↔ undefined 对应关系：空 = 一个普通模型。
    translateFormat: (existing?.translateFormat ?? "") as TranslateFormat | "",
  });
  // Whether a temperature this drawer stores would actually reach the wire.
  // Reads the adapter's own predicate rather than re-deriving the rule, and
  // reads it off the *form* so flipping the dialect below updates the row
  // immediately, before anything is saved.
  const temperatureReaches = provider
    ? supportsTemperature(provider.apiStandard, form.thinkingDialect || undefined)
    : true;
  // When the two limits came from a probe rather than the keyboard — kept out
  // of `form` because it is provenance, not something the author edits.
  const [probedAt, setProbedAt] = useState<number | undefined>(existing?.probedAt);
  // Out of `form` for a different reason: the price row below casts `form` to
  // Record<string, string> to index its fields, which a boolean would break.
  const [capsEdit, setCapsEdit] = useState(existing?.caps?.edit ?? false);
  // dashscope route only: the async submit-and-poll flow (wan text-to-image).
  const [capsAsync, setCapsAsync] = useState(existing?.caps?.asyncTask ?? false);
  // Same reason — a list is not a string. Endpoint-run tools the author grants
  // this model (lib/ai/serverTools).
  const [serverTools, setServerTools] = useState<ServerToolId[]>(existing?.serverTools ?? []);
  // Whether this model takes whole PDFs as message content (lib/ai/configDb).
  const [pdfInput, setPdfInput] = useState(existing?.pdfInput ?? false);
  const [fetching, setFetching] = useState(false);
  const [fetchedList, setFetchedList] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFetch = async () => {
    setFetching(true);
    setError(null);
    try {
      setFetchedList(await fetchAndImportModels(providerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const handleSave = async () => {
    if (!form.modelId) return;
    setSaving(true);
    setError(null);
    try {
      const parsedCtx = Math.min(MAX_CONTEXT_SIZE, Math.max(0, Math.floor(parseInt(form.contextSize, 10) || 0)));
      const contextSize = parsedCtx > 0 ? parsedCtx : undefined;
      const parsedOut = Math.min(MAX_OUTPUT_SIZE, Math.max(0, Math.floor(parseInt(form.maxOutput, 10) || 0)));
      const maxOutput = parsedOut > 0 ? parsedOut : undefined;
      // Empty stays empty (send nothing); anything parseable is clamped into
      // range. Written this way rather than `|| 0` because 0 is a value here.
      const parsedTemp = form.temperature.trim() === "" ? NaN : Number(form.temperature);
      const temperature = Number.isFinite(parsedTemp)
        ? Math.max(0, Math.min(MAX_TEMPERATURE, parsedTemp))
        : undefined;
      // Image-only settings. Cleared for other types so a model that used to be
      // an image model doesn't keep billing per image after being switched.
      const isImageModel = form.type === "image";
      const parsedPerImage = parseFloat(form.pricePerImage);
      const pricePerImage = isImageModel && parsedPerImage > 0 ? parsedPerImage : undefined;
      const sizes = form.capsSizes.split(",").map((s) => s.trim()).filter(Boolean);
      const caps = isImageModel
        ? {
            edit: capsEdit,
            ...(form.capsDialect ? { dialect: form.capsDialect as ImageDialect } : {}),
            // A dialect supersedes the free-form list, but an existing list is
            // kept so switching back to 通用 restores it untouched.
            ...(sizes.length ? { sizes } : {}),
            ...(form.capsRoute ? { route: form.capsRoute as ImageRoute } : {}),
            // Only meaningful on the dashscope route; dropped elsewhere so a
            // route change can't leave a stale flag steering the wrong client.
            ...(form.capsRoute === "dashscope" && capsAsync ? { asyncTask: true } : {}),
          }
        : undefined;
      const shared = {
        providerId,
        modelId: form.modelId,
        name: form.name || form.modelId,
        type: form.type,
        priceIn: parseFloat(form.priceIn) || 0,
        priceCachedIn: parseFloat(form.priceCachedIn) || 0,
        priceOut: parseFloat(form.priceOut) || 0,
        prefix: form.prefix.trim() || undefined,
        contextSize,
        maxOutput,
        temperature,
        probedAt,
        // "default" is stored as absent — one representation for "send
        // nothing", so a row never distinguishes never-set from set-to-default.
        reasoningEffort: form.reasoningEffort === "default" ? undefined : form.reasoningEffort,
        thinkingDialect: form.thinkingDialect || undefined,
        // Cleared for a protocol whose adapter would drop them, so switching a
        // model to another provider can't leave a permission that silently
        // does nothing behind. Empty stores as absent — one shape for "none".
        serverTools:
          provider && supportsServerTools(provider.apiStandard) && serverTools.length
            ? serverTools
            : undefined,
        // Same clearing rule: the declaration only survives where the wire has
        // a spelling for it (the OpenAI-family file content part), and only on
        // a model type that converses. False stores as absent.
        pdfInput: family === "openai" && !isImageModel && pdfInput ? true : undefined,
        // Cleared on the same rule, and the stakes are higher here than for the
        // two above: this one *removes* the model from every other picker, so a
        // declaration left behind on a model the author moved to another
        // protocol would hide it from the app with nothing on screen to say why.
        translateFormat:
          family === "openai" && !isImageModel && form.translateFormat
            ? form.translateFormat
            : undefined,
        pricePerImage,
        caps,
      };
      if (existing) {
        await updateModel({ ...existing, ...shared });
      } else {
        await addModel({ ...shared, enabled: true });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={hub.drawer} role="dialog" aria-label={t("aiConfig.models.addTitle")}>
      <div className={hub.drawerHead}>
        <div style={{ minWidth: 0 }}>
          <div className={hub.drawerTitle}>
            {existing ? t("aiConfig.models.editTitle") : t("aiConfig.models.addTitle")}
          </div>
          <div className={hub.drawerSub}>
            {t("aiConfig.hub.belongsTo", { provider: provider?.name ?? providerId })}
          </div>
        </div>
        <span className={hub.footSpacer} />
        <button className={hub.iconBtn} onClick={onClose} title={t("aiConfig.models.cancel")}>
          <X size={16} />
        </button>
      </div>

      <div className={hub.drawerBody}>
        {error && <div className={styles.errorNote}>{error}</div>}

        {!existing && (
          <div className={styles.fetchRow}>
            <button className={styles.fetchBtn} onClick={handleFetch} disabled={fetching}>
              {fetching ? t("aiConfig.models.fetching") : t("aiConfig.models.fetchBtn")}
            </button>
            {fetchedList.length > 0 && (
              <Select className={styles.fetchRowSelect}
                value={form.modelId}
                placeholder={t("aiConfig.models.selectOption")}
                options={fetchedList.map((m) => ({ value: m.id, label: m.name }))}
                ariaLabel={t("aiConfig.models.selectOption")}
                searchable
                searchPlaceholder={t("ai.modelPicker.search", { defaultValue: "搜索模型…" })}
                noResultsText={t("ai.modelPicker.noMatch", { defaultValue: "没有匹配的模型" })}
                onChange={(v) => {
                  const m = fetchedList.find((x) => x.id === v);
                  if (m) setForm((f) => ({ ...f, modelId: m.id, name: m.name }));
                }} />
            )}
          </div>
        )}

        <div className={styles.formRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.models.modelIdLabel")}</label>
            <input className={`${styles.input} ${hub.mono}`} placeholder="gpt-4o" value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.models.displayNameLabel")}</label>
            <input className={styles.input} placeholder="GPT-4o" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.models.typeLabel")}</label>
          <ChipRow>
            {MODEL_TYPES.map((type) => (
              <Chip
                key={type}
                label={t(`aiConfig.modelTypes.${type}`)}
                active={form.type === type}
                onClick={() => {
                  // Seed from the provider's protocol the first time this
                  // becomes an image model, so the common case needs no
                  // thought and the odd one is still overridable. The Gemini
                  // wire only serves Gemini image models, so the dialect is
                  // known there; elsewhere (dall-e vs gpt-image vs a relay)
                  // it stays the author's call.
                  const seedDialect =
                    type === "image" && !existing && !form.capsDialect && family === "gemini";
                  setForm({ ...form, type, ...(seedDialect ? { capsDialect: "nanobanana" as const } : {}) });
                  if (type === "image" && !existing && provider) {
                    setCapsEdit(defaultImageCaps(provider.apiStandard).edit ?? false);
                  }
                }}
              />
            ))}
          </ChipRow>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.models.billing")}</label>
          <div className={styles.formRow}>
            {[
              { key: "priceIn", label: t("aiConfig.models.priceInput") },
              { key: "priceCachedIn", label: t("aiConfig.models.priceCachedInput") },
              { key: "priceOut", label: t("aiConfig.models.priceOutput") },
            ].map(({ key, label }) => (
              <div key={key} className={styles.fieldGroup}>
                <input className={styles.input} type="number" min="0" step="0.01" placeholder="0.00"
                  value={(form as Record<string, string>)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                <span className={styles.label}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {form.type === "image" && (
          <>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.capsDialectLabel")}</label>
              <Select value={form.capsDialect}
                options={[
                  { value: "", label: t("aiConfig.models.capsDialectGeneric") },
                  { value: "nanobanana", label: t("aiConfig.models.capsDialectNanobanana") },
                  { value: "gpt-image-2", label: t("aiConfig.models.capsDialectGptImage2") },
                  { value: "wan2.7", label: t("aiConfig.models.capsDialectWan27") },
                ]}
                ariaLabel={t("aiConfig.models.capsDialectLabel")}
                onChange={(v) => {
                  setForm((f) => ({
                    ...f,
                    capsDialect: v as ImageDialect | "",
                    // Wan only exists behind DashScope's native protocol, so
                    // picking the dialect answers the route question too.
                    // Only fills a blank — an explicit route choice stands.
                    ...(v === "wan2.7" && !f.capsRoute ? { capsRoute: "dashscope" } : {}),
                  }));
                  // Every declared dialect belongs to models that take input
                  // images (Nano Banana natively, GPT-Image via /images/edits,
                  // Wan up to 9 refs) — seed the capability so the common
                  // case needs no thought.
                  if (v) setCapsEdit(true);
                }} />
              <div className={hub.fieldHint}>{t("aiConfig.models.capsDialectHint")}</div>
            </div>
            <div className={styles.formRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.pricePerImageLabel")}</label>
                <input className={styles.input} type="number" min="0" step="0.001" placeholder="0.00"
                  value={form.pricePerImage}
                  onChange={(e) => setForm({ ...form, pricePerImage: e.target.value })} />
                <div className={hub.fieldHint}>{t("aiConfig.models.pricePerImageHint")}</div>
              </div>
              {/* A declared dialect knows its sizes — the free-form list only
                  exists for the generic case, so it hides rather than compete. */}
              {!form.capsDialect && (
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>{t("aiConfig.models.capsSizesLabel")}</label>
                  <input className={styles.input} placeholder="1024x1024, 1536x1024"
                    value={form.capsSizes}
                    onChange={(e) => setForm({ ...form, capsSizes: e.target.value })} />
                  <div className={hub.fieldHint}>{t("aiConfig.models.capsSizesHint")}</div>
                </div>
              )}
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.capsRouteLabel")}</label>
              <Select value={form.capsRoute}
                options={[
                  { value: "", label: t("aiConfig.models.capsRouteAuto") },
                  { value: "images-api", label: t("aiConfig.models.capsRouteImages") },
                  { value: "chat", label: t("aiConfig.models.capsRouteChat") },
                  { value: "gemini", label: t("aiConfig.models.capsRouteGemini") },
                  { value: "dashscope", label: t("aiConfig.models.capsRouteDashscope") },
                ]}
                ariaLabel={t("aiConfig.models.capsRouteLabel")}
                onChange={(capsRoute) => {
                  setForm((f) => ({
                    ...f,
                    capsRoute,
                    // Seed DashScope's conventions once: its image models all
                    // edit, and sizes are written 宽*高. Only fills blanks —
                    // an author's own list is never overwritten.
                    ...(capsRoute === "dashscope" && !f.capsSizes
                      ? { capsSizes: "1024*1024, 1328*1328" }
                      : {}),
                  }));
                  if (capsRoute === "dashscope") setCapsEdit(true);
                }} />
              <div className={hub.fieldHint}>{t("aiConfig.models.capsRouteHint")}</div>
            </div>
            <div className={styles.fieldGroup}>
              <label className={hub.checkLabel}>
                <input type="checkbox" checked={capsEdit} onChange={(e) => setCapsEdit(e.target.checked)} />
                {t("aiConfig.models.capsEditLabel")}
              </label>
              <div className={hub.fieldHint}>{t("aiConfig.models.capsEditHint")}</div>
            </div>
            {form.capsRoute === "dashscope" && (
              <div className={styles.fieldGroup}>
                <label className={hub.checkLabel}>
                  <input type="checkbox" checked={capsAsync} onChange={(e) => setCapsAsync(e.target.checked)} />
                  {t("aiConfig.models.capsAsyncLabel")}
                </label>
                <div className={hub.fieldHint}>{t("aiConfig.models.capsAsyncHint")}</div>
              </div>
            )}
          </>
        )}

        {/* Context window, output cap, probing and the prefix prompt are all
            token-shaped concepts an image endpoint has no notion of. */}
        {form.type !== "image" && (
          <>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.contextSizeLabel")}</label>
              {/* Chips for the windows models actually ship with, plus a field
                  for the odd exact value (200k Claude, 64k local builds…). */}
              <ChipRow>
                <Chip
                  label={t("aiConfig.models.contextSizeUnset", { defaultValue: "未设置" })}
                  active={form.contextSize === ""}
                  onClick={() => setForm({ ...form, contextSize: "" })}
                />
                {CONTEXT_SIZE_STOPS.map((n) => (
                  <Chip
                    key={n}
                    label={formatContextSize(n)}
                    active={form.contextSize === String(n)}
                    onClick={() => setForm({ ...form, contextSize: String(n) })}
                  />
                ))}
                <input
                  className={hub.ctxExact}
                  type="number" min="0" max={MAX_CONTEXT_SIZE} step="1024"
                  placeholder={t("aiConfig.hub.exactValue")}
                  value={form.contextSize}
                  onChange={(e) => setForm({ ...form, contextSize: e.target.value })}
                  aria-label={t("aiConfig.models.contextSizeLabel")}
                />
              </ChipRow>
              <div className={hub.fieldHint}>{t("aiConfig.models.contextSizeHint")}</div>
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.maxOutputLabel")}</label>
              <input
                className={styles.input}
                type="number" min="0" max={MAX_OUTPUT_SIZE} step="512"
                placeholder={t("aiConfig.models.contextSizeUnset", { defaultValue: "未设置" })}
                value={form.maxOutput}
                onChange={(e) => setForm({ ...form, maxOutput: e.target.value })} />
              <div className={hub.fieldHint}>{t("aiConfig.models.maxOutputHint")}</div>
            </div>

            {/* Which shape of thinking parameter this model takes. Within a
                family the parameter changed between model generations (and
                between compat vendors), and on a relay the model id is free
                text, so the shape can't be derived — the author declares it.
                The choice set is per-family: see dialectChoices above. */}
            {provider && dialectChoices && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.thinkingDialectLabel")}</label>
                <ChipRow>
                  {["" as const, ...dialectChoices].map((d) => (
                    <Chip
                      key={d || "auto"}
                      label={
                        d === ""
                          ? t("aiConfig.models.thinkingDialectAuto")
                          : family === "openai"
                            ? t("aiConfig.models.thinkingDialectSwitchOpenai")
                            : t(`aiConfig.models.thinkingDialect${d[0].toUpperCase()}${d.slice(1)}`)
                      }
                      active={form.thinkingDialect === d}
                      onClick={() => setForm({ ...form, thinkingDialect: d })}
                    />
                  ))}
                </ChipRow>
                <div className={hub.fieldHint}>
                  {family === "openai"
                    ? t("aiConfig.models.thinkingDialectHintOpenai")
                    : t("aiConfig.models.thinkingDialectHint")}
                </div>
              </div>
            )}

            {/* Sampling temperature — below the dialect row because it depends
                on it. Shown only where the adapter can actually send it: the
                Messages API accepts temperature 1 alone while thinking is on,
                so a thinking Anthropic model would render a control that does
                nothing, which is the same thing `supportsThinkingLevel` exists
                to prevent. Any stored value survives while the row is hidden,
                so flipping the dialect back brings it out unchanged.

                Chips for the settings that mean something — 0 for a task that
                must stop being creative, 1 for the loose end most endpoints
                already default to — plus a field for an exact value. Unset
                sends nothing, which is what every model configured before this
                setting existed keeps doing. */}
            {temperatureReaches && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.temperatureLabel")}</label>
                <ChipRow>
                  <Chip
                    label={t("aiConfig.models.contextSizeUnset", { defaultValue: "未设置" })}
                    active={form.temperature === ""}
                    onClick={() => setForm({ ...form, temperature: "" })}
                  />
                  {["0", "0.3", "0.7", "1"].map((n) => (
                    <Chip
                      key={n}
                      label={n}
                      active={form.temperature === n}
                      onClick={() => setForm({ ...form, temperature: n })}
                    />
                  ))}
                  <input
                    className={hub.ctxExact}
                    type="number" min="0" max={MAX_TEMPERATURE} step="0.1"
                    placeholder={t("aiConfig.hub.exactValue")}
                    value={form.temperature}
                    onChange={(e) => setForm({ ...form, temperature: e.target.value })}
                    aria-label={t("aiConfig.models.temperatureLabel")}
                  />
                </ChipRow>
                <div className={hub.fieldHint}>{t("aiConfig.models.temperatureHint")}</div>
              </div>
            )}

            {/* Tools the endpoint runs itself. Anthropic-shaped endpoints and
                OpenAI compat (Qwen's enable_search — see supportsServerTools),
                and off by default: it is a standing permission for the model to
                reach the open web on every request, which is the author's call
                to make rather than something a model quietly gains. */}
            {provider && supportsServerTools(provider.apiStandard) && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.serverToolsLabel")}</label>
                <ChipRow>
                  {SERVER_TOOL_IDS.map((id) => (
                    <Chip
                      key={id}
                      label={t(`aiConfig.models.serverTool_${id}`)}
                      active={serverTools.includes(id)}
                      onClick={() =>
                        setServerTools((cur) =>
                          cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
                        )
                      }
                    />
                  ))}
                </ChipRow>
                <div className={hub.fieldHint}>
                  {family === "openai"
                    ? t("aiConfig.models.serverToolsHintOpenai")
                    : t("aiConfig.models.serverToolsHint")}
                </div>
              </div>
            )}

            {/* Whole-PDF input (the OpenAI file content part). Family-gated
                like the dialect chips above: no endpoint on the other wires is
                declared to take one here, so showing the checkbox there would
                promise a subagent that refuses at run time. */}
            {family === "openai" && (
              <div className={styles.fieldGroup}>
                <label className={hub.checkLabel}>
                  <input type="checkbox" checked={pdfInput} onChange={(e) => setPdfInput(e.target.checked)} />
                  {t("aiConfig.models.pdfInputLabel")}
                </label>
                <div className={hub.fieldHint}>{t("aiConfig.models.pdfInputHint")}</div>
              </div>
            )}

            {/* Dedicated translation models (Sakura). Family-gated for the same
                reason as the PDF checkbox — they are served by local
                OpenAI-compatible endpoints and nothing else — and hidden for
                image models, which have nothing to translate.

                This is the one control in this drawer that takes a capability
                *away*: a model declared here is a fixed 日→中 function that does
                not read instructions, so it stops being offered as the main
                model or as any other subagent's model. The hint has to say so —
                an author who ticks it and then cannot find their model in the
                chat picker would otherwise read that as a bug.

                Image models are already excluded by the enclosing block. */}
            {family === "openai" && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.translateFormatLabel")}</label>
                <ChipRow>
                  <Chip
                    label={t("aiConfig.models.translateFormatNone")}
                    active={form.translateFormat === ""}
                    onClick={() => setForm({ ...form, translateFormat: "" })}
                  />
                  {TRANSLATE_FORMATS.map((f) => (
                    <Chip
                      key={f}
                      label={t(`aiConfig.models.translateFormat_${f}`)}
                      active={form.translateFormat === f}
                      onClick={() => setForm({ ...form, translateFormat: f })}
                    />
                  ))}
                </ChipRow>
                <div className={hub.fieldHint}>
                  {form.translateFormat
                    ? t("aiConfig.models.translateFormatHintOn")
                    : t("aiConfig.models.translateFormatHint")}
                </div>
              </div>
            )}

            {/* Rendering this for a protocol whose adapter would ignore it
                would offer a setting that silently does nothing — the same
                reason defaultImageCaps refuses to promise an edit button.
                Widen as each family's mapping lands. */}
            {provider && supportsThinkingLevel(provider.apiStandard) && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.reasoningEffortLabel")}</label>
                <ChipRow>
                  {REASONING_EFFORTS.map((e) => (
                    <Chip
                      key={e}
                      label={t(`aiConfig.models.reasoningEffort${e[0].toUpperCase()}${e.slice(1)}`)}
                      active={form.reasoningEffort === e}
                      onClick={() => setForm({ ...form, reasoningEffort: e })}
                    />
                  ))}
                </ChipRow>
                <div className={hub.fieldHint}>{t("aiConfig.models.reasoningEffortHint")}</div>
              </div>
            )}

            <ModelProbePanel
              providerId={providerId}
              modelId={form.modelId}
              contextSize={form.contextSize}
              maxOutput={form.maxOutput}
              priceIn={form.priceIn}
              priceOut={form.priceOut}
              onApply={(v) => {
                // Only overwrite a field the probe actually resolved — a run that
                // learned nothing about output length must leave that value alone.
                setForm((f) => ({
                  ...f,
                  contextSize: v.contextSize !== undefined ? String(v.contextSize) : f.contextSize,
                  maxOutput: v.maxOutput !== undefined ? String(v.maxOutput) : f.maxOutput,
                }));
                setProbedAt(v.probedAt);
              }}
            />
            {probedAt && (
              <div className={hub.fieldHint}>
                {t("aiConfig.probe.probedAt", { date: new Date(probedAt).toLocaleString() })}
              </div>
            )}

            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.prefixLabel")}</label>
              <textarea
                className={`${styles.input} ${styles.textarea} ${hub.proseArea}`}
                rows={4}
                placeholder={t("aiConfig.models.prefixPlaceholder")}
                value={form.prefix}
                onChange={(e) => setForm({ ...form, prefix: e.target.value })}
              />
              <div className={hub.fieldHint}>{t("aiConfig.models.prefixHint")}</div>
            </div>
          </>
        )}
      </div>

      <div className={hub.drawerFoot}>
        <span className={hub.escHint}>{t("aiConfig.hub.escToClose")}</span>
        <span className={hub.footSpacer} />
        <button className={styles.btnSecondary} onClick={onClose}>{t("aiConfig.models.cancel")}</button>
        <button className={styles.btnPrimary} onClick={handleSave} disabled={!form.modelId || saving}>
          {saving
            ? (existing ? t("aiConfig.models.editing") : t("aiConfig.models.saving"))
            : (existing ? t("aiConfig.models.edit") : t("aiConfig.models.add"))}
        </button>
      </div>
    </div>
  );
}
