/**
 * The model editor — 设计稿 19 · 模型编辑.
 *
 * One drawer serves three authors: the one on an official endpoint who fills an
 * id and a name and leaves; the one on a relay or a local server, for whom this
 * drawer exists (the endpoint tells the app nothing — capabilities, limits and
 * thinking parameters are what *they* know they bought); and the one configuring
 * an image model, whose form is a different one. Three rules reconcile them:
 *
 *   1. **Sections fold by "has a value"**, decided once when the drawer opens
 *      (a section the author is typing in must not snap shut when they clear a
 *      field). Identity never folds; 计费 also opens for a new model.
 *   2. **Dashed = nothing sent.** The invariant every relay depends on is that
 *      an unset field sends nothing, so "unset" has to look different from
 *      "set to 0": an empty input, a selected 自动 / 跟随默认 chip, an off
 *      toggle and a folded empty section all wear a dashed edge.
 *   3. **The hint stays one line; 「为什么」 unfolds the full text.** The full
 *      texts are the only documentation the relay author has, so none of them
 *      went away — they just stopped being the default height of the drawer.
 *
 * The 「将发送」 line above the buttons is built by `lib/ai/modelSummary` from
 * the adapters' own body functions, so it cannot drift from the request.
 */
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAiStore } from "../../../stores/aiStore";
import { familyOf, type ImageRoute } from "../../../lib/ai/types";
import { isComfyUiEnabled } from "../../../lib/comfy/flag";
import {
  analyzeComfyWorkflow, parseComfyWorkflow, type ComfyParseError,
} from "../../../lib/comfy/workflow";
import { readFile } from "../../../lib/fs/fileio";
import {
  categoriesForFamily, isOnOffCategory, onEffort, resolveThinkingCategory,
  supportsTemperature, thinkingIsOn, THINKING_CATEGORIES,
  type ReasoningEffort, type ThinkingCategoryId,
} from "../../../lib/ai/reasoning";
import {
  SERVER_TOOL_IDS, supportsServerTools, type ServerToolId,
} from "../../../lib/ai/serverTools";
import {
  knownJsonSchemaModel, STRUCTURED_OUTPUT_MODES, type StructuredOutputMode,
} from "../../../lib/ai/jsonMode";
import { isMeasured, wireSummary } from "../../../lib/ai/modelSummary";
import {
  defaultImageCaps, MAX_CONTEXT_SIZE, MAX_OUTPUT_SIZE, MAX_TEMPERATURE, TRANSLATE_FORMATS,
  type Model, type ModelType, type TranslateFormat,
} from "../../../lib/ai/configDb";
import type { ImageDialect } from "../../../lib/ai/imageDialects";
import { CONTEXT_SIZE_STOPS, formatContextSize } from "../../../lib/ai/contextSize";
import { ModelProbePanel } from "../ModelProbePanel";
import { ChipDivider, DashChip, Field, Fold, Note, Section, ToggleField } from "./ModelDrawerBits";
import { Select } from "../../common/Select";
import styles from "../settingsCommon.module.css";
import hub from "./ProvidersModels.module.css";
import s from "./ModelDrawer.module.css";

const MODEL_TYPES: ModelType[] = ["text", "multimodal", "image", "video"];

/** i18n key per workflow-import parse failure (lib/comfy/workflow.ts). */
const COMFY_ERR_KEYS: Record<ComfyParseError, string> = {
  "not-json": "aiConfig.models.comfyErrNotJson",
  "ui-format": "aiConfig.models.comfyErrUiFormat",
  "empty": "aiConfig.models.comfyErrEmpty",
  "not-api-format": "aiConfig.models.comfyErrNotApi",
};

type SectionKey = "price" | "limits" | "think" | "caps" | "samp" | "image";
const SECTION_KEYS: SectionKey[] = ["price", "limits", "think", "caps", "samp", "image"];

/** Every field with a 「为什么」, for the 全部说明 toggle. */
const WHY_KEYS = [
  "mid", "type", "price", "ctx", "maxOut", "cat", "effort", "budget", "tools", "pdf", "so", "temp",
  "dialect", "route", "edit", "async", "comfy",
] as const;
type WhyKey = (typeof WHY_KEYS)[number];

const SO_LABEL_KEY: Record<StructuredOutputMode, string> = {
  off: "aiConfig.models.soOff",
  json_object: "aiConfig.models.soJsonObject",
  json_schema: "aiConfig.models.soJsonSchema",
};

const DIALECT_LABEL_KEY: Record<string, string> = {
  "": "aiConfig.models.capsDialectGeneric",
  "nanobanana": "aiConfig.models.capsDialectNanobanana",
  "gpt-image-2": "aiConfig.models.capsDialectGptImage2",
  "wan2.7": "aiConfig.models.capsDialectWan27",
};
const ROUTE_LABEL_KEY: Record<string, string> = {
  "": "aiConfig.models.capsRouteAuto",
  "images-api": "aiConfig.models.capsRouteImages",
  "chat": "aiConfig.models.capsRouteChat",
  "gemini": "aiConfig.models.capsRouteGemini",
  "dashscope": "aiConfig.models.capsRouteDashscope",
  "comfyui": "aiConfig.models.capsRouteComfyui",
};

/** "Has a value" — the fold rule's one predicate. 0 and "" are both unset here. */
const isSet = (v: string): boolean => v.trim() !== "" && Number(v) !== 0;

const shortDate = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Which sections a stored row opens with. Computed from the *row*, once, and
 * never from the live form — see rule 1 in the file header.
 */
function initialOpen(existing: Model | undefined, add: boolean): Record<SectionKey, boolean> {
  const m = existing;
  const caps = m?.caps;
  return {
    price: add || !!(m && (m.priceIn || m.priceCachedIn || m.priceOut || m.pricePerImage)),
    limits: !!(m?.contextSize || m?.maxOutput),
    think: !!(m?.thinkingCategory || (m?.reasoningEffort && m.reasoningEffort !== "default") || m?.thinkingBudget),
    caps: !!(m?.serverTools?.length || m?.pdfInput || m?.translateFormat || m?.structuredOutput),
    samp: !!(m && (m.temperature !== undefined || m.prefix?.trim())),
    image: !!(caps && (caps.route || caps.dialect || caps.edit || caps.sizes?.length || caps.asyncTask || caps.comfy)),
  };
}

interface Props {
  /** The group this drawer was opened from — a model cannot change hands. */
  providerId: string;
  /** null = add a new model under `providerId`. */
  modelId: string | null;
  /**
   * Seed a NEW row as a ComfyUI one — image type, comfyui route, straight to
   * the workflow import. Set by the provider drawer's hand-off; ignored when
   * editing, where the stored caps are the truth.
   */
  comfy?: boolean;
  onClose: () => void;
}

export function ModelDrawer({ providerId, modelId, comfy, onClose }: Props) {
  const { t } = useTranslation();
  const { providers, models, addModel, updateModel, fetchAndImportModels } = useAiStore();
  const existing = modelId ? models.find((m) => m.id === modelId) : undefined;
  /**
   * A second, cheaper source of the same seed: the provider already has a
   * ComfyUI model. An author adding their second workflow to the same instance
   * shouldn't have to re-find the route dropdown — and this needs no new state
   * anywhere (docs/feature/comfyui-plan.md §7.4).
   */
  const comfySeed = !existing
    && (comfy || models.some((m) => m.providerId === providerId && m.caps?.route === "comfyui"));
  const provider = providers.find((p) => p.id === providerId);
  const family = provider ? familyOf(provider.apiStandard) : undefined;
  // The thinking-parameter categories offered for this family (each a
  // per-vendor preset with its own legal effort menu); the drawer prepends the
  // fixed 自动 · 关闭 pair itself. Null when there is no provider yet.
  const categoryChoices: ThinkingCategoryId[] | null = family
    ? categoriesForFamily(family).filter((c) => c !== "off")
    : null;

  const [form, setForm] = useState({
    // ComfyUI takes no model id on the wire (it takes a whole node graph), but
    // the column is required and the save button gates on it — so seed it
    // rather than making the author invent a value that is never sent.
    modelId: existing?.modelId ?? (comfySeed ? "comfyui" : ""),
    name: existing?.name ?? (comfySeed ? t("aiConfig.models.comfyDefaultName") : ""),
    type: existing?.type ?? ((comfySeed ? "image" : "text") as ModelType),
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
    capsRoute: existing?.caps?.route ?? (comfySeed ? "comfyui" : ""),
    // "" = generic (the free-form sizes list); otherwise a declared dialect.
    capsDialect: (existing?.caps?.dialect ?? "") as ImageDialect | "",
    reasoningEffort: existing?.reasoningEffort ?? ("default" as ReasoningEffort),
    // "auto" ↔ stored undefined. A model configured before categories existed
    // (a legacy dialect, no category) shows its migrated category so the author
    // sees what it resolves to; a truly unset model shows "auto".
    thinkingCategory: (existing?.thinkingCategory
      ?? (existing?.thinkingDialect && provider
        ? resolveThinkingCategory(existing, provider.apiStandard).id
        : "auto")) as ThinkingCategoryId | "auto",
    thinkingBudget: existing?.thinkingBudget != null ? String(existing.thinkingBudget) : "",
    // 同样的 "" ↔ undefined 对应关系：空 = 一个普通模型。
    translateFormat: (existing?.translateFormat ?? "") as TranslateFormat | "",
    // "auto" ↔ stored undefined, like the category (lib/ai/jsonMode.ts).
    structuredOutput: (existing?.structuredOutput ?? "auto") as StructuredOutputMode | "auto",
  });
  // The category the current form selection resolves to (auto → family
  // default). The source of truth for the effort dial, the budget field, and
  // temperature — read off the form so flipping the picker updates all three
  // immediately, before anything is saved.
  const formCategory = provider
    ? resolveThinkingCategory(
        { thinkingCategory: form.thinkingCategory === "auto" ? undefined : form.thinkingCategory },
        provider.apiStandard,
      )
    : undefined;
  const temperatureReaches = provider
    ? supportsTemperature(provider.apiStandard, formCategory?.id)
    : true;
  // What the probe wrote, and when — kept out of `form` because it is
  // provenance, not something the author edits. The values stay when the
  // author overwrites the field, so the badge can say what was measured.
  const [probed, setProbed] = useState<{ at?: number; ctx?: number; out?: number }>({
    at: existing?.probedAt, ctx: existing?.probedContextSize, out: existing?.probedMaxOutput,
  });
  // Out of `form` for a different reason: the price row below casts `form` to
  // Record<string, string> to index its fields, which a boolean would break.
  const [capsEdit, setCapsEdit] = useState(existing?.caps?.edit ?? false);
  // dashscope route only: the async submit-and-poll flow (wan text-to-image).
  const [capsAsync, setCapsAsync] = useState(existing?.caps?.asyncTask ?? false);
  // comfyui route only: the imported API-format workflow JSON, verbatim.
  const [comfyWorkflow, setComfyWorkflow] = useState(existing?.caps?.comfy?.workflow ?? "");
  // Import feedback — errors only; a healthy import renders its summary from
  // the workflow itself, so the two can never disagree.
  const [comfyError, setComfyError] = useState<string | null>(null);
  // Same reason — a list is not a string. Endpoint-run tools the author grants
  // this model (lib/ai/serverTools).
  const [serverTools, setServerTools] = useState<ServerToolId[]>(existing?.serverTools ?? []);
  // Whether this model takes whole PDFs as message content (lib/ai/configDb).
  const [pdfInput, setPdfInput] = useState(existing?.pdfInput ?? false);
  const [fetching, setFetching] = useState(false);
  const [fetchedList, setFetchedList] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fold state (rule 1) and the 「为什么」 blocks (rule 3) ──────────────────
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(() => initialOpen(existing, !existing));
  const toggleSection = (k: SectionKey) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const expandAll = () => setOpen(Object.fromEntries(SECTION_KEYS.map((k) => [k, true])) as Record<SectionKey, boolean>);
  const [why, setWhy] = useState<Partial<Record<WhyKey, boolean>>>({});
  const [whyAll, setWhyAll] = useState(false);
  const whyOpen = (k: WhyKey): boolean => (whyAll ? why[k] !== false : why[k] === true);
  const toggleWhy = (k: WhyKey) => () => {
    if (whyAll) {
      // Leaving "all open" by closing one: the rest stay open explicitly.
      setWhyAll(false);
      setWhy(Object.fromEntries(WHY_KEYS.map((x) => [x, x !== k])) as Record<WhyKey, boolean>);
    } else {
      setWhy((w) => ({ ...w, [k]: !w[k] }));
    }
  };
  const toggleWhyAll = () => { setWhyAll((v) => !v); setWhy({}); };
  const whyProps = (k: WhyKey, text: string) => ({ why: text, whyOpen: whyOpen(k), onWhy: toggleWhy(k) });

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

  const handleImportWorkflow = async () => {
    setComfyError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const text = await readFile(picked);
      const parsed = parseComfyWorkflow(text);
      if ("error" in parsed) {
        setComfyError(t(COMFY_ERR_KEYS[parsed.error]));
        return;
      }
      // Refused at import rather than at run time: a workflow the app cannot
      // put a prompt into would only fail later with a wordier error.
      if (!analyzeComfyWorkflow(parsed.graph).positive) {
        setComfyError(t("aiConfig.models.comfyNoPositive"));
        return;
      }
      setComfyWorkflow(text);
    } catch (e) {
      setComfyError(e instanceof Error ? e.message : String(e));
    }
  };

  /** What the stored workflow contains — recomputed from the JSON each render. */
  const comfySummary = (): string | null => {
    if (!comfyWorkflow) return null;
    const parsed = parseComfyWorkflow(comfyWorkflow);
    if ("error" in parsed) return t(COMFY_ERR_KEYS[parsed.error]);
    const a = analyzeComfyWorkflow(parsed.graph);
    return t("aiConfig.models.comfySummary", {
      nodes: a.nodeCount,
      via: a.positive
        ? t(a.positive.via === "title" ? "aiConfig.models.comfyViaTitle" : "aiConfig.models.comfyViaSampler")
        : "—",
      seeds: a.seedNodes.length,
      latent: a.latent ? "✓" : "—",
      negative: a.negative ? "✓" : "—",
      refs: a.loadImageNodes.length,
    });
  };

  // ── Derived facts the sections, the summaries and the wire line share ──────
  const isImageModel = form.type === "image";
  const isComfy = isImageModel && form.capsRoute === "comfyui";
  const parsedCtx = Math.min(MAX_CONTEXT_SIZE, Math.max(0, Math.floor(parseInt(form.contextSize, 10) || 0)));
  const parsedOut = Math.min(MAX_OUTPUT_SIZE, Math.max(0, Math.floor(parseInt(form.maxOutput, 10) || 0)));
  // Empty stays empty (send nothing); anything parseable is clamped into
  // range. Written this way rather than `|| 0` because 0 is a value here.
  const parsedTemp = form.temperature.trim() === "" ? NaN : Number(form.temperature);
  const temperature = Number.isFinite(parsedTemp)
    ? Math.max(0, Math.min(MAX_TEMPERATURE, parsedTemp))
    : undefined;
  const thinkingBudget = (() => {
    if (formCategory?.shape !== "budget") return undefined;
    const n = Math.round(Number(form.thinkingBudget));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  const serverToolsOn = !!provider && supportsServerTools(provider.apiStandard) && serverTools.length > 0;
  const structuredOutput = form.structuredOutput === "auto" ? undefined : form.structuredOutput;
  const showEffortDial = !!formCategory && (formCategory.shape === "levels" || isOnOffCategory(formCategory));
  const showBudget = formCategory?.shape === "budget" && !!formCategory.budget;

  // The structured-output options this family can honour (lib/ai/jsonMode.ts).
  const soChoices: StructuredOutputMode[] = family === "anthropic"
    ? ["off"]
    : family === "gemini"
      ? STRUCTURED_OUTPUT_MODES.filter((m) => m !== "json_schema")
      : STRUCTURED_OUTPUT_MODES;
  const soAutoLifted = (family === "openai" || family === "responses") && knownJsonSchemaModel(form.modelId);

  const sizes = form.capsSizes.split(",").map((x) => x.trim()).filter(Boolean);

  const handleSave = async () => {
    if (!form.modelId) return;
    setSaving(true);
    setError(null);
    try {
      const contextSize = parsedCtx > 0 ? parsedCtx : undefined;
      const maxOutput = parsedOut > 0 ? parsedOut : undefined;
      // A comfyui model without its workflow cannot generate anything — refuse
      // here with the fix named, rather than at the first run with less context.
      if (isComfy && !comfyWorkflow) {
        setError(t("aiConfig.models.comfyMissing"));
        return;
      }
      const parsedPerImage = parseFloat(form.pricePerImage);
      const pricePerImage = isImageModel && parsedPerImage > 0 ? parsedPerImage : undefined;
      // comfyui: input-image support is a fact of the imported workflow — the
      // LoadImage count — not a declaration. Derived here instead of a
      // checkbox, so it cannot disagree with the graph it describes.
      const comfySlots = isComfy
        ? (() => {
            const parsed = parseComfyWorkflow(comfyWorkflow);
            return "graph" in parsed ? analyzeComfyWorkflow(parsed.graph).loadImageNodes.length : 0;
          })()
        : 0;
      // Image-only settings. Cleared for other types so a model that used to be
      // an image model doesn't keep billing per image after being switched.
      const caps = isImageModel
        ? {
            edit: isComfy ? comfySlots > 0 : capsEdit,
            ...(isComfy && comfySlots > 0 ? { maxRefs: comfySlots } : {}),
            // A dialect belongs to cloud parameter vocabularies; on comfyui
            // the free-form sizes list is the whole story.
            ...(!isComfy && form.capsDialect ? { dialect: form.capsDialect as ImageDialect } : {}),
            // A dialect supersedes the free-form list, but an existing list is
            // kept so switching back to 通用 restores it untouched.
            ...(sizes.length ? { sizes } : {}),
            ...(form.capsRoute ? { route: form.capsRoute as ImageRoute } : {}),
            // Only meaningful on the dashscope route; dropped elsewhere so a
            // route change can't leave a stale flag steering the wrong client.
            ...(form.capsRoute === "dashscope" && capsAsync ? { asyncTask: true } : {}),
            // The workflow travels only while the route is comfyui — same
            // clearing rule as asyncTask above.
            ...(isComfy ? { comfy: { workflow: comfyWorkflow } } : {}),
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
        probedAt: probed.at,
        probedContextSize: probed.ctx,
        probedMaxOutput: probed.out,
        // "default" is stored as absent — one representation for "send
        // nothing", so a row never distinguishes never-set from set-to-default.
        // A non-on/off budget category (Claude extended) has no effort dial and
        // ignores the value on the wire, so a stale effort left behind by a
        // migrated model is cleared rather than persisted.
        reasoningEffort:
          form.reasoningEffort === "default"
          || (formCategory?.shape === "budget" && !isOnOffCategory(formCategory))
            ? undefined
            : form.reasoningEffort,
        thinkingCategory: form.thinkingCategory === "auto" ? undefined : form.thinkingCategory,
        // Legacy shape is superseded by the category; clear it so a resaved
        // model stops carrying the field resolveThinkingCategory reads only for
        // one-time migration.
        thinkingDialect: undefined,
        // Only meaningful for a budget-shape category; parsed, positive, else absent.
        thinkingBudget,
        // Cleared for a protocol whose adapter would drop them, so switching a
        // model to another provider can't leave a permission that silently
        // does nothing behind. Empty stores as absent — one shape for "none".
        serverTools: serverToolsOn ? serverTools : undefined,
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
        // "auto" stores as absent, like the category. An image model has no
        // structured tasks, so nothing is kept there either.
        structuredOutput: isImageModel ? undefined : structuredOutput,
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

  // ── Section summaries (what a folded header says) ──────────────────────────
  const priceHas = isSet(form.priceIn) || isSet(form.priceCachedIn) || isSet(form.priceOut)
    || (isImageModel && isSet(form.pricePerImage));
  const priceSum = `$${form.priceIn || "0"} / ${form.priceCachedIn || "0"} / ${form.priceOut || "0"}`
    + (isImageModel && isSet(form.pricePerImage) ? ` · ${form.pricePerImage}/img` : "");

  const limitsHas = parsedCtx > 0 || parsedOut > 0;
  const limitsSum = [
    parsedCtx > 0 && (CONTEXT_SIZE_STOPS.includes(parsedCtx) ? formatContextSize(parsedCtx) : parsedCtx.toLocaleString()),
    parsedOut > 0 && parsedOut.toLocaleString(),
  ].filter(Boolean).join(" · ");

  const catLabel = form.thinkingCategory === "auto"
    ? t("aiConfig.models.thinkingCatAuto")
    : t(THINKING_CATEGORIES[form.thinkingCategory].labelKey);
  const effortLabel = (e: ReasoningEffort) =>
    t(`aiConfig.models.reasoningEffort${e[0].toUpperCase()}${e.slice(1)}`);
  const thinkHas = form.thinkingCategory !== "auto" || form.reasoningEffort !== "default" || thinkingBudget !== undefined;
  const thinkSum = [
    catLabel,
    showEffortDial && form.reasoningEffort !== "default" && effortLabel(form.reasoningEffort),
    showBudget && thinkingBudget !== undefined && thinkingBudget.toLocaleString(),
  ].filter(Boolean).join(" · ");

  const capsNames = [
    serverToolsOn && t("aiConfig.models.mark_web"),
    family === "openai" && pdfInput && "PDF",
    family === "openai" && form.translateFormat && t(`aiConfig.models.translateFormat_${form.translateFormat}`),
    structuredOutput && t(SO_LABEL_KEY[structuredOutput]),
  ].filter(Boolean) as string[];

  const sampHas = form.temperature.trim() !== "" || form.prefix.trim() !== "";
  const sampSum = [
    form.temperature.trim() !== "" && `T ${form.temperature.trim()}`,
    form.prefix.trim() !== "" && t("aiConfig.models.prefixLabelShort"),
  ].filter(Boolean).join(" · ");

  const imageHas = !!form.capsDialect || !!form.capsRoute || capsEdit || sizes.length > 0 || capsAsync || !!comfyWorkflow;
  const imageSum = [
    t(DIALECT_LABEL_KEY[isComfy ? "" : form.capsDialect] ?? DIALECT_LABEL_KEY[""]),
    t(ROUTE_LABEL_KEY[form.capsRoute] ?? ROUTE_LABEL_KEY[""]),
    (isComfy ? !!comfyWorkflow : capsEdit) && t("aiConfig.models.sumEdit"),
  ].filter(Boolean).join(" · ");

  const setCount = [
    priceHas,
    !isImageModel && limitsHas,
    !isImageModel && thinkHas,
    !isImageModel && capsNames.length > 0,
    !isImageModel && sampHas,
    isImageModel && imageHas,
  ].filter(Boolean).length;

  // ── 「将发送」 ─────────────────────────────────────────────────────────────
  const wire = provider
    ? wireSummary({
        type: form.type,
        modelId: form.modelId,
        maxOutput: parsedOut > 0 ? parsedOut : undefined,
        temperature,
        reasoningEffort: form.reasoningEffort === "default" ? undefined : form.reasoningEffort,
        thinkingCategory: form.thinkingCategory === "auto" ? undefined : form.thinkingCategory,
        thinkingBudget,
        serverTools: serverToolsOn ? serverTools : undefined,
        structuredOutput,
        prefix: form.prefix,
        caps: isImageModel
          ? {
              edit: capsEdit,
              ...(form.capsRoute ? { route: form.capsRoute as ImageRoute } : {}),
              ...(!isComfy && form.capsDialect ? { dialect: form.capsDialect as ImageDialect } : {}),
              ...(sizes.length ? { sizes } : {}),
            }
          : undefined,
      }, provider.apiStandard)
    : [];

  // ── Measured badges (实测 vs 手填) ─────────────────────────────────────────
  const measuredNote = (value: number, probedValue: number | undefined) => {
    if (probedValue === undefined || !probed.at) return {};
    return isMeasured(value, probedValue)
      ? { note: t("aiConfig.models.measuredAt", { date: new Date(probed.at).toLocaleString() }), noteTone: "ok" as const }
      : {
          note: t("aiConfig.models.manualOverrides", { date: shortDate(probed.at), value: probedValue.toLocaleString() }),
          noteTone: "faint" as const,
        };
  };

  const soHint = family === "anthropic"
    ? t("aiConfig.models.briefSoAnthropic")
    : family === "gemini"
      ? t("aiConfig.models.briefSoGemini")
      : t("aiConfig.models.briefSoOpenai");
  const soNote = form.structuredOutput !== "auto" || family === "anthropic"
    ? undefined
    : soAutoLifted
      ? { note: t("aiConfig.models.noteSoSchema"), noteTone: "ok" as const }
      : { note: t("aiConfig.models.noteSoJson"), noteTone: "muted" as const };

  const inputCls = (unset: boolean, extra = "") => `${s.input} ${unset ? s.unset : ""} ${extra}`;

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

      <div className={s.meta}>
        <span>{t("aiConfig.models.metaOpenCount", { count: setCount })}</span>
        <span className={s.metaSpacer} />
        <button type="button" className={s.metaLink} onClick={expandAll}>{t("aiConfig.models.expandAll")}</button>
        <button type="button" className={s.metaLink} onClick={toggleWhyAll}>
          {whyAll ? t("aiConfig.models.hideNotes") : t("aiConfig.models.allNotes")}
        </button>
      </div>

      <div className={s.body}>
        {error && <div className={`${styles.errorNote} ${s.error}`}>{error}</div>}

        {/* ── 身份 — never folds ─────────────────────────────────────────────── */}
        <Section label={t("aiConfig.models.secIdentity")} open summary="" unset={false}>
          <Field label="Model ID" hint={t("aiConfig.models.briefModelId")} {...whyProps("mid", t("aiConfig.models.whyModelId"))}>
            {!existing && !isComfy && (
              <div className={s.fetchRow}>
                <button className={styles.fetchBtn} onClick={handleFetch} disabled={fetching}>
                  {fetching ? t("aiConfig.models.fetching") : t("aiConfig.models.fetchBtn")}
                </button>
                {fetchedList.length > 0 && (
                  <Select className={s.fetchSelect}
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
            <input className={inputCls(false, s.mono)} placeholder="deepseek-v4-flash" value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
          </Field>
          <Field label={t("aiConfig.models.displayNameLabel")} hint={t("aiConfig.models.briefName")}>
            <input className={inputCls(false)} placeholder={t("aiConfig.models.phNameSame")} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t("aiConfig.models.typeLabel")} hint={t("aiConfig.models.briefType")} {...whyProps("type", t("aiConfig.models.whyType"))}>
            <div className={s.chips}>
              {MODEL_TYPES.map((type) => (
                <DashChip
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
                    // A section swap the author asked for: show the new one.
                    setOpen((o) => ({ ...o, image: type === "image" ? true : o.image }));
                  }}
                />
              ))}
            </div>
          </Field>
        </Section>

        {/* ── 计费 ───────────────────────────────────────────────────────────── */}
        <Section
          label={t("aiConfig.models.secPricing")}
          open={open.price}
          onToggle={() => toggleSection("price")}
          summary={priceHas ? priceSum : t("aiConfig.models.secPricingUnset")}
          unset={!priceHas}
        >
          <Field label={t("aiConfig.models.priceLabel")} sub={t("aiConfig.models.unitUsdPerM")}
            hint={t("aiConfig.models.briefPrice")} {...whyProps("price", t("aiConfig.models.whyPrice"))}>
            <div className={s.triple}>
              {([
                ["priceIn", t("aiConfig.models.priceInput")],
                ["priceCachedIn", t("aiConfig.models.priceCachedInput")],
                ["priceOut", t("aiConfig.models.priceOutput")],
              ] as const).map(([key, label]) => (
                <div key={key} className={s.tripleCell}>
                  <input className={inputCls(!isSet(form[key]))} type="number" min="0" step="0.01" placeholder="0"
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                  <div className={s.tripleSub}>{label}</div>
                </div>
              ))}
            </div>
          </Field>
          <Fold open={isImageModel}>
            <Field label={t("aiConfig.models.pricePerImageLabel")} hint={t("aiConfig.models.briefPricePerImage")}>
              <div className={s.numRow}>
                <input className={inputCls(!isSet(form.pricePerImage), s.num)} type="number" min="0" step="0.001"
                  placeholder={t("aiConfig.models.phNotSent")}
                  value={form.pricePerImage}
                  onChange={(e) => setForm({ ...form, pricePerImage: e.target.value })} />
                <span className={s.unit}>USD</span>
              </div>
            </Field>
          </Fold>
        </Section>

        {/* ── Text-model sections: 限额 / 思考 / 能力 / 采样 ──────────────────── */}
        <Fold open={!isImageModel}>
          <Section
            label={t("aiConfig.models.secLimits")}
            open={open.limits}
            onToggle={() => toggleSection("limits")}
            summary={limitsHas ? limitsSum : t("aiConfig.models.secLimitsUnset")}
            unset={!limitsHas}
          >
            <Field label={t("aiConfig.models.ctxLabel")} sub={t("aiConfig.models.unitTokens")}
              hint={t("aiConfig.models.briefCtx")} {...whyProps("ctx", t("aiConfig.models.contextSizeHint"))}
              {...measuredNote(parsedCtx, probed.ctx)}>
              <div className={s.chips}>
                {/* The windows models actually ship with; the active one clears
                    on a second click, so unset is one click away. */}
                {CONTEXT_SIZE_STOPS.map((n) => (
                  <DashChip
                    key={n}
                    label={formatContextSize(n)}
                    active={parsedCtx === n}
                    onClick={() => setForm({ ...form, contextSize: parsedCtx === n ? "" : String(n) })}
                  />
                ))}
                <input
                  className={inputCls(parsedCtx === 0, s.exact)}
                  type="number" min="0" max={MAX_CONTEXT_SIZE} step="1024"
                  placeholder={t("aiConfig.hub.exactValue")}
                  value={form.contextSize}
                  onChange={(e) => setForm({ ...form, contextSize: e.target.value })}
                  aria-label={t("aiConfig.models.ctxLabel")}
                />
              </div>
            </Field>
            <Field label={t("aiConfig.models.maxOutLabel")} sub={t("aiConfig.models.unitTokens")}
              hint={t("aiConfig.models.briefMaxOut")} {...whyProps("maxOut", t("aiConfig.models.maxOutputHint"))}
              {...measuredNote(parsedOut, probed.out)}>
              <div className={s.numRow}>
                <input
                  className={inputCls(parsedOut === 0, s.num)}
                  type="number" min="0" max={MAX_OUTPUT_SIZE} step="512"
                  placeholder={t("aiConfig.models.phAppDefault")}
                  value={form.maxOutput}
                  onChange={(e) => setForm({ ...form, maxOutput: e.target.value })} />
              </div>
            </Field>
            <Field label={t("aiConfig.models.probeLabel")} hint={t("aiConfig.models.briefProbe")}>
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
                  setProbed({ at: v.probedAt, ctx: v.contextSize, out: v.maxOutput });
                }}
              />
              {/* A row probed before the values were kept alongside: the date
                  is all that is known, so it is said here rather than on a field. */}
              {probed.at && probed.ctx === undefined && probed.out === undefined && (
                <Note text={t("aiConfig.probe.probedAt", { date: new Date(probed.at).toLocaleString() })} tone="ok" />
              )}
            </Field>
          </Section>

          <Section
            label={t("aiConfig.models.secThinking")}
            open={open.think}
            onToggle={() => toggleSection("think")}
            summary={thinkHas ? thinkSum : t("aiConfig.models.secThinkingUnset")}
            unset={!thinkHas}
          >
            {/* Which thinking-parameter category this model uses — a per-vendor
                preset carrying its own legal effort menu. The parameter changed
                between generations and between compat vendors, and on a relay
                the model id is free text, so it can't be derived — the author
                declares it. 自动 · 关闭 are pinned first, then the family's
                presets wrap freely (设计稿 19 · 问题 7). */}
            {provider && categoryChoices && formCategory && (
              <Field label={t("aiConfig.models.catLabel")} hint={t("aiConfig.models.briefCat")}
                {...whyProps("cat", form.thinkingCategory === "auto"
                  ? t("aiConfig.models.thinkingCatAutoHint")
                  : t(THINKING_CATEGORIES[form.thinkingCategory].hintKey))}
                {...(form.thinkingCategory === "auto"
                  ? { note: t("aiConfig.models.noteCatAuto", { cat: t(THINKING_CATEGORIES[formCategory.id].labelKey) }) }
                  : {})}>
                <div className={s.chips}>
                  {(["auto", "off", ...categoryChoices] as (ThinkingCategoryId | "auto")[]).map((c, i) => (
                    <Fragment key={c}>
                      {i === 2 && <ChipDivider />}
                      <DashChip
                        label={c === "auto" ? t("aiConfig.models.thinkingCatAuto") : t(THINKING_CATEGORIES[c].labelKey)}
                        active={form.thinkingCategory === c}
                        auto={c === "auto"}
                        onClick={() => setForm((f) => {
                          // Coerce an effort the new category's menu doesn't offer
                          // back to a safe value, so a stale `medium` can't survive
                          // onto e.g. a GLM model (low/high/max only). The fallback
                          // is the category's own default, else "default" (send
                          // nothing → endpoint default) — never `menu[0]`, which is
                          // "off" for most categories and would silently disable
                          // thinking the moment the author switched category.
                          const next = c === "auto" ? undefined : THINKING_CATEGORIES[c];
                          const menu = next?.menu ?? [];
                          const keep = f.reasoningEffort === "default" || menu.includes(f.reasoningEffort);
                          return {
                            ...f,
                            thinkingCategory: c,
                            reasoningEffort: keep
                              ? f.reasoningEffort
                              : (next?.defaultEffort ?? ("default" as ReasoningEffort)),
                          };
                        })}
                      />
                    </Fragment>
                  ))}
                </div>
              </Field>
            )}

            {/* The depth dial, rendered from the selected category's own menu:
                level chips (its `menu`), or on/off for a switch-style category,
                each with 跟随默认 pinned first as the dashed "send nothing".
                Budget-only categories (Claude extended) carry their depth in the
                token field below, so they show no dial here. */}
            <Fold open={showEffortDial}>
              {formCategory && (
                <Field label={t("aiConfig.models.effortLabel")} hint={t("aiConfig.models.briefEffort")}
                  {...whyProps("effort", t("aiConfig.models.reasoningEffortHint"))}>
                  <div className={s.chips}>
                    <DashChip
                      label={t("aiConfig.models.reasoningEffortDefault")}
                      active={form.reasoningEffort === "default"}
                      auto
                      onClick={() => setForm({ ...form, reasoningEffort: "default" })}
                    />
                    {isOnOffCategory(formCategory) ? (
                      <>
                        <DashChip
                          label={t("aiConfig.models.reasoningEffortOn")}
                          active={thinkingIsOn(formCategory, form.reasoningEffort)}
                          onClick={() => setForm({
                            ...form,
                            reasoningEffort: onEffort(formCategory) ?? ("default" as ReasoningEffort),
                          })}
                        />
                        <DashChip
                          label={t("aiConfig.models.reasoningEffortOff")}
                          active={form.reasoningEffort === "off"}
                          onClick={() => setForm({ ...form, reasoningEffort: "off" })}
                        />
                      </>
                    ) : (
                      formCategory.menu.map((e) => (
                        <DashChip
                          key={e}
                          label={effortLabel(e)}
                          active={form.reasoningEffort === e}
                          onClick={() => setForm({ ...form, reasoningEffort: e })}
                        />
                      ))
                    )}
                  </div>
                </Field>
              )}
            </Fold>

            {/* Token budget, only for a budget-shape category (Claude extended,
                Qwen). Placeholder shows the default the adapter uses when blank. */}
            <Fold open={showBudget}>
              {formCategory?.budget && (
                <Field label={t("aiConfig.models.budgetLabel")} sub={t("aiConfig.models.unitTokens")}
                  hint={t("aiConfig.models.briefBudget")} {...whyProps("budget", t("aiConfig.models.thinkingBudgetHint"))}>
                  <div className={s.numRow}>
                    <input
                      className={inputCls(thinkingBudget === undefined, s.num)}
                      type="number"
                      min={formCategory.budget.min}
                      max={formCategory.budget.max}
                      step="256"
                      placeholder={t("aiConfig.models.phBudgetDefault")}
                      value={form.thinkingBudget}
                      onChange={(e) => setForm({ ...form, thinkingBudget: e.target.value })}
                    />
                  </div>
                </Field>
              )}
            </Fold>
          </Section>

          <Section
            label={t("aiConfig.models.secCaps")}
            open={open.caps}
            onToggle={() => toggleSection("caps")}
            summary={capsNames.length ? capsNames.join(" · ") : t("aiConfig.models.secCapsUnset")}
            unset={capsNames.length === 0}
          >
            {/* Tools the endpoint runs itself. Anthropic-shaped endpoints and
                OpenAI compat (Qwen's enable_search — see supportsServerTools),
                and off by default: it is a standing permission for the model to
                reach the open web on every request, which is the author's call
                to make rather than something a model quietly gains. */}
            <Fold open={!!provider && supportsServerTools(provider.apiStandard)}>
              {SERVER_TOOL_IDS.map((id) => (
                <ToggleField
                  key={id}
                  title={t("aiConfig.models.serverToolsToggle", { tool: t(`aiConfig.models.serverTool_${id}`) })}
                  hint={t("aiConfig.models.briefTools")}
                  on={serverTools.includes(id)}
                  onChange={(next) =>
                    setServerTools((cur) => (next ? [...cur.filter((x) => x !== id), id] : cur.filter((x) => x !== id)))
                  }
                  {...whyProps("tools", family === "openai"
                    ? t("aiConfig.models.serverToolsHintOpenai")
                    : t("aiConfig.models.serverToolsHint"))}
                />
              ))}
            </Fold>

            {/* Whole-PDF input (the OpenAI file content part). Family-gated
                like the category chips above: no endpoint on the other wires is
                declared to take one here, so showing the switch there would
                promise a subagent that refuses at run time. */}
            <Fold open={family === "openai"}>
              <ToggleField
                title={t("aiConfig.models.pdfInputLabel")}
                hint={t("aiConfig.models.briefPdf")}
                on={pdfInput}
                onChange={setPdfInput}
                {...whyProps("pdf", t("aiConfig.models.pdfInputHint"))}
              />
            </Fold>

            {/* Dedicated translation models (Sakura). Family-gated for the same
                reason as the PDF switch — they are served by local
                OpenAI-compatible endpoints and nothing else.

                This is the one control in this drawer that takes a capability
                *away*: a model declared here is a fixed 日→中 function that does
                not read instructions, so it stops being offered as the main
                model or as any other subagent's model. The warning has to say
                so — an author who ticks it and then cannot find their model in
                the chat picker would otherwise read that as a bug. */}
            <Fold open={family === "openai"}>
              <Field label={t("aiConfig.models.translateLabel")} hint={t("aiConfig.models.briefTranslate")}
                warn={form.translateFormat ? t("aiConfig.models.translateFormatHintOn") : undefined}>
                <div className={s.chips}>
                  <DashChip
                    label={t("aiConfig.models.translateFormatNone")}
                    active={form.translateFormat === ""}
                    auto
                    onClick={() => setForm({ ...form, translateFormat: "" })}
                  />
                  {TRANSLATE_FORMATS.map((f) => (
                    <DashChip
                      key={f}
                      label={t(`aiConfig.models.translateFormat_${f}`)}
                      active={form.translateFormat === f}
                      onClick={() => setForm({ ...form, translateFormat: f })}
                    />
                  ))}
                </div>
              </Field>
            </Fold>

            {/* How this model is asked for JSON on a structured task
                (lib/ai/jsonMode.ts). Only the modes this family can honour are
                offered; on Anthropic that is 自动 · 关闭, and the hint says why
                rather than the row hiding. The note under 自动 shows what it
                resolves to, same as the thinking category's. */}
            <Field label={t("aiConfig.models.soLabel")} hint={soHint} {...soNote}
              {...whyProps("so", t("aiConfig.models.whySo"))}>
              <div className={s.chips}>
                <DashChip
                  label={t("aiConfig.models.soAuto")}
                  active={form.structuredOutput === "auto"}
                  auto
                  onClick={() => setForm({ ...form, structuredOutput: "auto" })}
                />
                {soChoices.map((m) => (
                  <DashChip
                    key={m}
                    label={t(SO_LABEL_KEY[m])}
                    active={form.structuredOutput === m}
                    onClick={() => setForm({ ...form, structuredOutput: m })}
                  />
                ))}
              </div>
            </Field>
          </Section>

          <Section
            label={t("aiConfig.models.secSampling")}
            open={open.samp}
            onToggle={() => toggleSection("samp")}
            summary={sampHas ? sampSum : t("aiConfig.models.secSamplingUnset")}
            unset={!sampHas}
          >
            {/* Sampling temperature — shown only where the adapter can actually
                send it: the Messages API accepts temperature 1 alone while
                thinking is on, so a thinking Anthropic model would render a
                control that does nothing. Any stored value survives while the
                row is folded, so flipping the category back brings it out
                unchanged. Empty = dashed + 不发; 0 = solid + 确定性, because the
                two used to look the same and mean opposite things. */}
            <Fold open={temperatureReaches}>
              <Field label={t("aiConfig.models.tempLabel")} hint={t("aiConfig.models.briefTemp")}
                {...whyProps("temp", t("aiConfig.models.temperatureHint"))}>
                <div className={s.numRow}>
                  <input
                    className={inputCls(form.temperature.trim() === "", s.num)}
                    type="number" min="0" max={MAX_TEMPERATURE} step="0.1"
                    placeholder={t("aiConfig.models.phNotSent")}
                    value={form.temperature}
                    onChange={(e) => setForm({ ...form, temperature: e.target.value })}
                    aria-label={t("aiConfig.models.tempLabel")}
                  />
                  {temperature === 0 && <span className={s.tag}>{t("aiConfig.models.tempDeterministic")}</span>}
                </div>
              </Field>
            </Fold>
            <Field label={t("aiConfig.models.prefixLabelShort")} hint={t("aiConfig.models.briefPrefix")}>
              <textarea
                className={inputCls(form.prefix.trim() === "", s.textarea)}
                rows={4}
                placeholder={t("aiConfig.models.phNoPrefix")}
                value={form.prefix}
                onChange={(e) => setForm({ ...form, prefix: e.target.value })}
              />
            </Field>
          </Section>
        </Fold>

        {/* ── 出图 — replaces the four text sections for an image model ────── */}
        <Fold open={isImageModel}>
          <Section
            label={t("aiConfig.models.secImage")}
            open={open.image}
            onToggle={() => toggleSection("image")}
            summary={imageHas ? imageSum : t("aiConfig.models.secImageUnset")}
            unset={!imageHas}
          >
            {/* Cloud parameter dialects mean nothing to a local workflow — the
                free-form sizes list is comfyui's whole vocabulary. */}
            <Fold open={!isComfy}>
              <Field label={t("aiConfig.models.capsDialectLabel")} hint={t("aiConfig.models.briefDialect")}
                {...whyProps("dialect", t("aiConfig.models.capsDialectHint"))}>
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
              </Field>
            </Fold>
            <Field label={t("aiConfig.models.capsRouteLabel")} hint={t("aiConfig.models.briefRoute")}
              {...whyProps("route", t("aiConfig.models.capsRouteHint"))}>
              <Select value={form.capsRoute}
                options={[
                  { value: "", label: t("aiConfig.models.capsRouteAuto") },
                  { value: "images-api", label: t("aiConfig.models.capsRouteImages") },
                  { value: "chat", label: t("aiConfig.models.capsRouteChat") },
                  { value: "gemini", label: t("aiConfig.models.capsRouteGemini") },
                  { value: "dashscope", label: t("aiConfig.models.capsRouteDashscope") },
                  // Behind the Beta flag — but a model already declared onto
                  // this route keeps its option, so flipping the flag off never
                  // turns an imported workflow into unviewable dead data.
                  ...(isComfyUiEnabled() || form.capsRoute === "comfyui"
                    ? [{ value: "comfyui", label: t("aiConfig.models.capsRouteComfyui") }]
                    : []),
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
            </Field>
            {/* PR1 of the comfyui route cannot take input images — the
                declaration is forced false on save, so the switch would lie. */}
            <Fold open={!isComfy}>
              <ToggleField
                title={t("aiConfig.models.capsEditLabel")}
                hint={t("aiConfig.models.briefEdit")}
                on={capsEdit}
                onChange={setCapsEdit}
                {...whyProps("edit", t("aiConfig.models.capsEditHint"))}
              />
            </Fold>
            {/* A declared dialect knows its sizes — the free-form list only
                exists for the generic case, so it folds rather than compete.
                comfyui is always generic: a stored dialect is ignored there. */}
            <Fold open={!form.capsDialect || isComfy}>
              <Field label={t("aiConfig.models.capsSizesLabel")} hint={t("aiConfig.models.briefSizes")}>
                <input className={inputCls(sizes.length === 0, s.mono)} placeholder={t("aiConfig.models.phNoSize")}
                  value={form.capsSizes}
                  onChange={(e) => setForm({ ...form, capsSizes: e.target.value })} />
              </Field>
            </Fold>
            <Fold open={form.capsRoute === "dashscope"}>
              <ToggleField
                title={t("aiConfig.models.capsAsyncLabel")}
                hint={t("aiConfig.models.briefAsync")}
                on={capsAsync}
                onChange={setCapsAsync}
                {...whyProps("async", t("aiConfig.models.capsAsyncHint"))}
              />
            </Fold>
            <Fold open={isComfy}>
              <Field label={t("aiConfig.models.comfyWorkflowLabel")} hint={t("aiConfig.models.briefComfy")}
                {...whyProps("comfy", t("aiConfig.models.comfyWorkflowHint"))}
                {...(comfyError ? { warn: comfyError } : {})}>
                <div className={s.comfyRow}>
                  <button className={styles.fetchBtn} onClick={handleImportWorkflow}>
                    {comfyWorkflow
                      ? t("aiConfig.models.comfyReimportBtn")
                      : t("aiConfig.models.comfyImportBtn")}
                  </button>
                  <span className={s.comfySum}>
                    {comfyWorkflow ? comfySummary() : t("aiConfig.models.comfyNotImported")}
                  </span>
                </div>
              </Field>
            </Fold>
          </Section>
        </Fold>
      </div>

      {/* 「将发送」 — what this row adds to a request, in the wire's own words.
          Empty is a statement too: only model + messages. */}
      <div className={s.wire}>
        <span className={s.wireLabel}>{t("aiConfig.models.willSend")}</span>
        {wire.length === 0 ? (
          <span className={s.wireEmpty}><span className={s.dashMark} />{t("aiConfig.models.willSendEmpty")}</span>
        ) : (
          wire.map((w) => (
            <span key={w.key} className={s.wireItem}>
              {w.scope === "prefix"
                ? `${w.key} ${t("aiConfig.models.wirePrefix")}`
                : `${w.key} ${w.value}`}
              {w.scope === "structured" && <span className={s.wireScope}> · {t("aiConfig.models.wireStructuredScope")}</span>}
            </span>
          ))
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
