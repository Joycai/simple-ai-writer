/**
 * The model editor — 设计稿 05c · 模型编辑.
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
import { Fragment, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAiStore } from "../../../stores/aiStore";
import { feeSummary } from "../../../lib/ai/feeGroupLabel";
import { feeGroupOptions } from "../../../lib/ai/feeGroupList";
import { useFeeLabelWords } from "./feeWords";
import { familyOf, TEXT_VERBOSITIES, type ImageRoute, type ProtocolFamily, type TextVerbosity } from "../../../lib/ai/types";
import { isComfyUiEnabled } from "../../../lib/comfy/flag";
import {
  analyzeComfyWorkflow, parseComfyWorkflow, type ComfyParseError,
} from "../../../lib/comfy/workflow";
import { readFile } from "../../../lib/fs/fileio";
import {
  categoriesForFamily, effortForCategory, isOnOffCategory, onEffort, resolveThinkingCategory,
  thinkingIsOn, THINKING_CATEGORIES,
  type ReasoningEffort, type ThinkingCategoryId,
} from "../../../lib/ai/reasoning";
import {
  effectiveServerTools, normalizeServerTools, SERVER_TOOL_IDS, type ServerToolId,
} from "../../../lib/ai/serverTools";
import { platformModelCalibration, providerWire } from "../../../lib/ai/platforms";
import { capabilityVerdict, hasAnyServerTool, hasCapability, type CapabilityId } from "../../../lib/ai/capabilities";
import {
  activeFamily, channelEndpoints, ROUTE_LONG, ROUTE_SHORT, routeProfileOf, routeProvider,
  type RouteProfile,
} from "../../../lib/ai/routes";
import {
  jsonModeCeiling, knownJsonSchemaModel, STRUCTURED_OUTPUT_MODES, type StructuredOutputMode,
} from "../../../lib/ai/jsonMode";
import { isMeasured, wireSummary, type WireItem } from "../../../lib/ai/modelSummary";
import {
  canSeeImages, defaultImageCaps, MAX_CONTEXT_SIZE, MAX_OUTPUT_SIZE, MAX_TEMPERATURE, MODEL_TYPES,
  TRANSLATE_FORMATS, ASR_FORMATS,
  type Model, type ModelType, type TranslateFormat, type AsrFormat,
} from "../../../lib/ai/configDb";
import { clampVideoFps, MAX_VIDEO_FPS, MIN_VIDEO_FPS } from "../../../lib/ai/videoInput";
import { ASR_DEFAULT_MODEL_ID, asrIdMismatch } from "../../../lib/asr/formats";
import { SEEDREAM_DIALECTS, type ImageDialect } from "../../../lib/ai/imageDialects";
import { CONTEXT_SIZE_STOPS, formatContextSize } from "../../../lib/ai/contextSize";
import { ModelProbePanel } from "../ModelProbePanel";
import { ChipDivider, DashChip, Field, Fold, Hint, Note, Section, Subhead, ToggleField } from "./ModelDrawerBits";
import { Select } from "../../common/Select";
import styles from "../settingsCommon.module.css";
import hub from "./ProvidersModels.module.css";
import s from "./ModelDrawer.module.css";
import r from "./Routes.module.css";
import { CapabilityMatrix } from "./CapabilityMatrix";

/** i18n key per workflow-import parse failure (lib/comfy/workflow.ts). */
const COMFY_ERR_KEYS: Record<ComfyParseError, string> = {
  "not-json": "aiConfig.models.comfyErrNotJson",
  "ui-format": "aiConfig.models.comfyErrUiFormat",
  "empty": "aiConfig.models.comfyErrEmpty",
  "not-api-format": "aiConfig.models.comfyErrNotApi",
};

type SectionKey = "price" | "limits" | "think" | "caps" | "samp" | "image" | "asr";
const SECTION_KEYS: SectionKey[] = ["price", "limits", "think", "caps", "samp", "image", "asr"];

/** Every field with a 「为什么」, for the 全部说明 toggle. */
const WHY_KEYS = [
  "mid", "type", "price", "ctx", "maxOut", "cat", "effort", "budget", "tools", "extract", "imgText", "imgImage", "code", "pdf", "vlHiRes", "video", "videoFps", "so", "temp", "verb",
  "dialect", "route", "edit", "async", "comfy",
] as const;
type WhyKey = (typeof WHY_KEYS)[number];

/** A matrix row's name — the same words as the control it stands for. */
const MATRIX_ROW_KEY: Partial<Record<CapabilityId, string>> = {
  pdfInput: "aiConfig.models.pdfInputLabel",
  vlHighResolution: "aiConfig.models.vlHiResLabel",
  videoInput: "aiConfig.models.videoInputLabel",
  videoFps: "aiConfig.models.videoFpsLabel",
  structuredOutput: "aiConfig.models.soLabel",
  jsonSchema: "aiConfig.models.soJsonSchema",
  textVerbosity: "aiConfig.models.verbosityLabel",
};

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
  "qwen-image": "aiConfig.models.capsDialectQwenImage",
  "seedream-5-pro": "aiConfig.models.capsDialectSeedream5Pro",
  "seedream-5-lite": "aiConfig.models.capsDialectSeedream5Lite",
  "seedream-4": "aiConfig.models.capsDialectSeedream4",
};
const ROUTE_LABEL_KEY: Record<string, string> = {
  "": "aiConfig.models.capsRouteAuto",
  "images-api": "aiConfig.models.capsRouteImages",
  "chat": "aiConfig.models.capsRouteChat",
  "gemini": "aiConfig.models.capsRouteGemini",
  "dashscope": "aiConfig.models.capsRouteDashscope",
  "comfyui": "aiConfig.models.capsRouteComfyui",
  "ark": "aiConfig.models.capsRouteArk",
};

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
    price: add || !!m?.feeGroupId,
    limits: !!(m?.contextSize || m?.maxOutput),
    think: !!(m?.thinkingCategory || (m?.reasoningEffort && m.reasoningEffort !== "default") || m?.thinkingBudget),
    caps: !!(m?.serverTools?.length || m?.pdfInput || m?.vlHighResolution || m?.videoInput || m?.translateFormat || m?.asrFormat || m?.structuredOutput),
    samp: !!(m && (m.temperature !== undefined || m.prefix?.trim() || m.textVerbosity)),
    image: !!(caps && (caps.route || caps.dialect || caps.edit || caps.sizes?.length || caps.asyncTask || caps.comfy)),
    asr: m?.type === "asr",
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
  const { providers, models, feeGroups, addModel, updateModel, fetchAndImportModels } = useAiStore();
  const feeWords = useFeeLabelWords();
  const existing = modelId ? models.find((m) => m.id === modelId) : undefined;
  /**
   * 新建时预填渠道的默认计费组。只是预填：一旦写上，它就是这个模型自己的，
   * 改渠道默认不会追着改（`Provider.defaultFeeGroupId`）。
   */
  const defaultFeeGroupId = providers.find((p) => p.id === providerId)?.defaultFeeGroupId;
  /**
   * A second, cheaper source of the same seed: the provider already has a
   * ComfyUI model. An author adding their second workflow to the same instance
   * shouldn't have to re-find the route dropdown — and this needs no new state
   * anywhere (docs/feature/comfyui-plan.md §7.4).
   */
  const comfySeed = !existing
    && (comfy || models.some((m) => m.providerId === providerId && m.caps?.route === "comfyui"));
  // The channel, and the route this drawer is editing on (设计稿 05k 屏 04).
  // Everything below that asks a protocol question reads `provider` — the
  // channel as that route sees it (lib/ai/routes) — so the thinking chips,
  // the server tools, the structured-output modes and 「将发送」 all follow a
  // route switch without knowing routes exist.
  const channel = providers.find((p) => p.id === providerId);
  const channelRoutes: ProtocolFamily[] = channel ? channelEndpoints(channel).map((e) => e.family) : [];
  const [route, setRoute] = useState<ProtocolFamily | undefined>(() =>
    channel ? (existing ? activeFamily(existing, channel) : channelRoutes[0]) : undefined);
  const provider = channel ? routeProvider(channel, route) : undefined;
  const family = provider ? familyOf(provider.apiStandard) : undefined;
  // The other routes' fields, parked while this one is being edited
  // (Model.routes). Only the routes the channel still has are offered.
  const [parked, setParked] = useState<Partial<Record<ProtocolFamily, RouteProfile>>>(() => existing?.routes ?? {});
  // The route the author clicked, shown as a diff before the switch (屏 06).
  const [pendingRoute, setPendingRoute] = useState<ProtocolFamily | null>(null);
  const multiRoute = channelRoutes.length > 1;
  // The current route's wire. Whether a control exists is asked of the
  // capability table about this wire (lib/ai/capabilities.ts) — never of the
  // family here: a family check is how DashScope's private field once reached
  // 智谱. `family` below only picks spellings and wording.
  const curWire = provider ? providerWire(provider) : undefined;
  const can = (id: CapabilityId, m?: Parameters<typeof hasCapability>[2]) => !!curWire && hasCapability(id, curWire, m);
  // The wires with a whole-file content part the adapters map
  // (openai.ts `file`, responses.ts `input_file` — live on grok-4.5 / 4.6,
  // docs/api/landscape.md 第十一个样本), plus an Anthropic `document` block on
  // a platform that measured it reaching the model (火山方舟 Plan, 第十二个样本).
  const pdfWire = can("pdfInput");
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
    // Same "" ↔ undefined rule. A transcription model is billed per second of
    // audio, so it carries its own price cell and the token prices mean nothing.
    asrFormat: (existing?.asrFormat ?? "") as AsrFormat | "",
    pricePerSecond: existing?.pricePerSecond !== undefined ? String(existing.pricePerSecond) : "",
    /** 绑定的计费组 id；空串 ＝ 未绑定（一分不收，量照记）。 */
    feeGroupId: existing?.feeGroupId ?? defaultFeeGroupId ?? "",
    // "auto" ↔ stored undefined, like the category (lib/ai/jsonMode.ts).
    structuredOutput: (existing?.structuredOutput ?? "auto") as StructuredOutputMode | "auto",
    // "auto" ↔ stored undefined: nothing sent (Responses family only).
    textVerbosity: (existing?.textVerbosity ?? "auto") as TextVerbosity | "auto",
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
  const temperatureReaches = !curWire || hasCapability("temperature", curWire, { thinkingCategory: formCategory?.id });
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
  // DashScope high-resolution image reading (Model.vlHighResolution).
  const [vlHighResolution, setVlHighResolution] = useState(existing?.vlHighResolution ?? false);
  // Video clips as chat attachments (Model.videoInput / videoFps). The fps is
  // a string for the same reason temperature is: empty means "send nothing".
  const [videoInput, setVideoInput] = useState(existing?.videoInput ?? false);
  const [videoFpsText, setVideoFpsText] = useState(existing?.videoFps !== undefined ? String(existing.videoFps) : "");
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

  // The platform's own values for a model id it knows (platforms.ts
  // `ModelCalibration`), written into a *new* row's form when the author picks
  // or finishes typing the id. A field is ours to write only while it is
  // unset or still holds what the previous prefill put there — so correcting
  // a typo re-prefills, and anything the author chose by hand stays.
  // Keyed by the id it ran for: blurring the id field again without changing it
  // must not take back a field the author has since set to its unset value.
  const lastCalibration = useRef<{ id?: string; category?: ThinkingCategoryId; ctx?: string; out?: string; type?: ModelType; pdf?: boolean }>({});
  const applyCalibration = (modelId: string) => {
    if (existing || !provider) return;
    const id = modelId.trim().toLowerCase();
    if (id === lastCalibration.current.id) return;
    const cal = platformModelCalibration(providerWire(provider).platform, modelId) ?? {};
    // A category of another family would be refused by resolveThinkingCategory
    // anyway; don't show one the route can't send.
    const category = cal.thinkingCategory && THINKING_CATEGORIES[cal.thinkingCategory].family === family
      ? cal.thinkingCategory : undefined;
    const next = {
      id,
      category,
      ctx: cal.contextSize ? String(cal.contextSize) : undefined,
      out: cal.maxOutput ? String(cal.maxOutput) : undefined,
      type: cal.type as ModelType | undefined,
      pdf: cal.pdfInput,
    };
    const prev = lastCalibration.current;
    const ours = <T,>(cur: T, unset: T, prevVal: T | undefined) => cur === unset || (prevVal !== undefined && cur === prevVal);
    setForm((f) => {
      const thinkingCategory = ours<ThinkingCategoryId | "auto">(f.thinkingCategory, "auto", prev.category)
        ? (next.category ?? "auto") : f.thinkingCategory;
      return {
        ...f,
        thinkingCategory,
        // The same coercion as the category chips: an effort picked under the
        // previous category (glm-5.2's off) is a 400 under the new one (glm-5.3).
        reasoningEffort: thinkingCategory === f.thinkingCategory ? f.reasoningEffort
          : effortForCategory(thinkingCategory === "auto" ? undefined : THINKING_CATEGORIES[thinkingCategory], f.reasoningEffort),
        contextSize: ours(f.contextSize, "", prev.ctx) ? (next.ctx ?? "") : f.contextSize,
        maxOutput: ours(f.maxOutput, "", prev.out) ? (next.out ?? "") : f.maxOutput,
        type: ours<ModelType>(f.type, "text", prev.type) ? (next.type ?? "text") : f.type,
      };
    });
    setPdfInput((cur) => (ours(cur, false, prev.pdf) ? !!next.pdf : cur));
    lastCalibration.current = next;
  };

  const handleFetch = async () => {
    setFetching(true);
    setError(null);
    try {
      setFetchedList(await fetchAndImportModels(providerId, route));
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
  // A transcription-only row: 限额 / 思考 / 采样 fold to 「不适用」, 计费 becomes
  // one per-second cell, and 「将发送」 lists the file endpoint (设计稿 02f 屏 1b).
  // The type is the identity (configDb isAsrOnly); asrFormat only names the endpoint.
  const isAsrModel = form.type === "asr";
  // The three vision capabilities, asked of the table with the model's type:
  // each exists only for a model that reads pictures. Hi-res and clip fps are
  // DashScope's private knobs — 智谱 takes both and ignores them — and fps also
  // requires the clip part itself (capabilities.ts `requires`). A `video_url`
  // part is Chat Completions only (lib/ai/videoInput).
  // `text.verbosity` — the Responses family's field.
  const verbosityWire = can("textVerbosity");
  // The Sakura translation declaration: a text model on Chat Completions.
  const translateWire = can("translateFormat", { type: form.type });
  // Whether this wire has a JSON mode at all; with no channel yet every option is offered.
  const soWire = !curWire || hasCapability("structuredOutput", curWire);
  const vlHiResWire = can("vlHighResolution", { type: form.type });
  const videoWire = can("videoInput", { type: form.type });
  const videoFpsWire = can("videoFps", { type: form.type });
  const videoFps = videoFpsWire && videoInput ? clampVideoFps(videoFpsText) : undefined;
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
  // Server tools are asked of the provider's *platform* and family, not its
  // standard (lib/ai/platforms.ts): DeepSeek, a relay and DashScope all read
  // `openai_compat`, and only one of them has `enable_search`.
  const toolWire = curWire;
  const offersServerTool = (id: ServerToolId) =>
    !!toolWire && hasCapability(id, toolWire, { modelId: form.modelId.trim() });
  // What is *stored*: the author's grant, whole — kept even where this wire
  // can't say an id (the switch stays on and says 不发送), because the grant is
  // the author's and a provider can move platform under it (plan §7 invariant
  // 4). A transcription row keeps none: its request is the file endpoint's.
  const declaredServerTools = form.type !== "asr" ? normalizeServerTools(serverTools) : undefined;
  // What is *sent*: the grant cut to this wire, in canonical form (extraction
  // only beside search). The summary line and 将发送 read this one.
  const grantedServerTools = toolWire ? effectiveServerTools(toolWire, declaredServerTools, form.modelId.trim()) : undefined;
  // Shown: every id the wire offers, plus any the author switched on that it
  // doesn't — so a grant that isn't sent is visible and can be turned off.
  const shownServerTools = SERVER_TOOL_IDS.filter((id) => offersServerTool(id) || serverTools.includes(id));
  const platformName = toolWire ? t(`aiConfig.platforms.${toolWire.platform}`) : "";
  // An offered switch the table is unsure of: the platform hasn't been
  // measured passing a protocol tool on, or it has the tool and this model id
  // was never tried with it (capability-gating-plan §8.7). Either way it is sent.
  const unmeasuredToolHint = (id: ServerToolId) => {
    const modelId = form.modelId.trim();
    const v = toolWire ? capabilityVerdict(id, toolWire, { modelId }) : undefined;
    if (v?.status !== "unknown") return "";
    return v.reason === "model-unlisted"
      ? t("aiConfig.models.serverToolModelUnmeasured", { platform: platformName, model: modelId })
      : t("aiConfig.models.serverToolUnmeasured", { platform: platformName });
  };
  const structuredOutput = form.structuredOutput === "auto" || form.type === "asr" ? undefined : form.structuredOutput;
  const showEffortDial = !!formCategory && (formCategory.shape === "levels" || isOnOffCategory(formCategory));
  const showBudget = formCategory?.shape === "budget" && !!formCategory.budget;

  // The structured-output options this wire can honour (lib/ai/jsonMode.ts).
  // 严格档看能力表的 `jsonSchema` 格：实测会静默无视它的平台（智谱）不给这个
  // 选项——发出去只会降一档，选了等于没选。已经存了的声明照样显示，免得选中项消失。
  const soStrictNo = !!curWire && !hasCapability("jsonSchema", curWire);
  const soChoices: StructuredOutputMode[] = !soWire
    ? ["off"]
    : STRUCTURED_OUTPUT_MODES.filter((m) => m !== "json_schema" || !soStrictNo || form.structuredOutput === m);
  // 与 jsonMode.ts 的自动档同一条规则：线路**实测**收严格档（格子是 yes，不是 unknown）
  // 且 id 在名单上才抬升。
  const soAutoLifted = !!curWire && capabilityVerdict("jsonSchema", curWire).status === "yes"
    && knownJsonSchemaModel(form.modelId);

  const sizes = form.capsSizes.split(",").map((x) => x.trim()).filter(Boolean);

  /**
   * The current route's fields as they would be saved — what `handleSave`
   * writes into the flat columns, and what a route switch parks. One function
   * so the two can't clear by different rules.
   */
  const routeFieldsNow = (): RouteProfile => routeProfileOf({
    maxOutput: parsedOut > 0 ? parsedOut : undefined,
    temperature,
    reasoningEffort:
      form.reasoningEffort === "default"
      || (formCategory?.shape === "budget" && !isOnOffCategory(formCategory))
        ? undefined
        : form.reasoningEffort,
    thinkingCategory: form.thinkingCategory === "auto" ? undefined : form.thinkingCategory,
    thinkingBudget,
    structuredOutput: isImageModel ? undefined : structuredOutput,
    textVerbosity: verbosityWire && !isImageModel && form.textVerbosity !== "auto"
      ? form.textVerbosity
      : undefined,
    vlHighResolution: vlHiResWire && vlHighResolution ? true : undefined,
    probedAt: probed.at,
    probedContextSize: probed.ctx,
    probedMaxOutput: probed.out,
  });

  /**
   * Move the drawer to another route of the channel: this route's fields are
   * parked, the other one's loaded — or nothing, for a route never configured
   * (plan §7 invariant 3: nothing is copied across; a category is per family).
   */
  const switchRoute = (next: ProtocolFamily) => {
    if (!channel || !route || next === route) return;
    const nextProvider = routeProvider(channel, next);
    if (!nextProvider) return;
    const now = routeFieldsNow();
    const prof = parked[next] ?? {};
    setParked((p) => {
      const n = { ...p, [route]: now };
      delete n[next];
      return n;
    });
    setForm((f) => ({
      ...f,
      maxOutput: prof.maxOutput ? String(prof.maxOutput) : "",
      temperature: prof.temperature !== undefined ? String(prof.temperature) : "",
      reasoningEffort: prof.reasoningEffort ?? "default",
      thinkingCategory: (prof.thinkingCategory
        ?? (prof.thinkingDialect ? resolveThinkingCategory(prof, nextProvider.apiStandard).id : "auto")) as ThinkingCategoryId | "auto",
      thinkingBudget: prof.thinkingBudget != null ? String(prof.thinkingBudget) : "",
      structuredOutput: prof.structuredOutput ?? "auto",
      textVerbosity: prof.textVerbosity ?? "auto",
    }));
    setProbed({ at: prof.probedAt, ctx: prof.probedContextSize, out: prof.probedMaxOutput });
    setVlHighResolution(prof.vlHighResolution ?? false);
    setRoute(next);
    setPendingRoute(null);
  };

  /** The parked routes that survive a save: ones the channel still has, minus the current one. */
  const routesToSave = (): Model["routes"] => {
    const out: Partial<Record<ProtocolFamily, RouteProfile>> = {};
    for (const f of channelRoutes) if (f !== route && parked[f]) out[f] = parked[f];
    return Object.keys(out).length ? out : undefined;
  };

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
      const parsedPerSecond = Number(form.pricePerSecond) || 0;
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
            // Off comfyui the drawer has no control for the cap, so it keeps
            // the one the row came with (a starter row's 10 / 14) — rebuilding
            // without it silently lifted the input-image limit on every save.
            // Only while the row still speaks to the same endpoint the same
            // way: a comfyui row's LoadImage count, or lite's 14 on a row
            // switched to pro's dialect (10), would be a wrong limit, which is
            // worse than none — the endpoint's own 400 costs nothing.
            ...(!isComfy && existing?.caps?.maxRefs
              && existing.caps.route !== "comfyui"
              && (existing.caps.route ?? "") === form.capsRoute
              && (existing.caps.dialect ?? "") === form.capsDialect
              ? { maxRefs: existing.caps.maxRefs } : {}),
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
        feeGroupId: form.feeGroupId || undefined,
        // 旧的价格列不再被任何算钱的路径读（`lib/ai/configDb.feeOf`），
        // 只作为「这行搬过了」之前的原始值留在库里；保存时原样带过去。
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
        // The grant, whole — not cut to the wire (see declaredServerTools):
        // what this wire can't say is shown as 不发送 rather than dropped, and
        // the adapters cut it per request. Empty stores as absent.
        serverTools: declaredServerTools,
        // A declaration of the model's, kept whatever route it is on now —
        // a switch to ④ and back must not make the author declare it again
        // (plan §3). Whether it is usable is asked per route (`readsPdf`).
        // Only on a model type that converses; false stores as absent.
        pdfInput: !isImageModel && !isAsrModel && pdfInput ? true : undefined,
        // Same clearing rule: only where the switch is shown.
        vlHighResolution: vlHiResWire && vlHighResolution ? true : undefined,
        // A model declaration like the PDF one: kept across routes, and
        // honoured only where `canReadVideo` says (a seeing model on Chat
        // Completions). The fps goes with the switch (off = nothing kept).
        videoInput: canSeeImages(form) && videoInput ? true : undefined,
        videoFps: canSeeImages(form) && videoInput ? clampVideoFps(videoFpsText) : undefined,
        // Cleared on the same rule, and the stakes are higher here than for the
        // two above: this one *removes* the model from every other picker, so a
        // declaration left behind on a model the author moved to another
        // protocol would hide it from the app with nothing on screen to say why.
        // And only on a Text row (设计稿 05c 屏 2d ④): Sakura is a text model,
        // and a multimodal / vision row declared translate-only would silently
        // leave the vision subagent's candidates too.
        translateFormat:
          translateWire && form.translateFormat
            ? form.translateFormat
            : undefined,
        // "auto" stores as absent, like the category. An image model has no
        // structured tasks, so nothing is kept there either.
        structuredOutput: isImageModel ? undefined : structuredOutput,
        // Cleared off the Responses family, where no wire has the field.
        textVerbosity: verbosityWire && !isImageModel && form.textVerbosity !== "auto"
          ? form.textVerbosity
          : undefined,
        // Travels with the type and only with it: the type already says, on the
        // row's badge, that this model left the chat pickers, so unlike the
        // translate declaration there is nothing hidden to guard against.
        asrFormat: isAsrModel ? form.asrFormat || ASR_FORMATS[0] : undefined,
        pricePerSecond: isAsrModel && parsedPerSecond > 0 ? parsedPerSecond : undefined,
        pricePerImage,
        caps,
        // The route (plan §2.2). A model that never picked one keeps following
        // the channel's primary route while it still takes it.
        activeRoute: !existing?.activeRoute && route === channelRoutes[0] ? undefined : route,
        routes: routesToSave(),
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
  const boundFeeGroup = feeGroups.find((g) => g.id === form.feeGroupId) ?? null;
  // 这一节「有值」＝ 绑了组。全 0 的组（本机 Ollama）也算绑了：作者做过
  // 一个决定，只是那个决定是「不收钱」。
  const priceHas = !!form.feeGroupId;

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
    grantedServerTools?.includes("web_search") && t("aiConfig.models.mark_web"),
    grantedServerTools?.includes("web_extractor") && t("aiConfig.models.serverTool_web_extractor"),
    grantedServerTools?.includes("web_search_image") && t("aiConfig.models.serverTool_web_search_image"),
    grantedServerTools?.includes("image_search") && t("aiConfig.models.serverTool_image_search"),
    grantedServerTools?.includes("code_interpreter") && t("aiConfig.models.serverTool_code_interpreter"),
    pdfWire && pdfInput && "PDF",
    vlHiResWire && vlHighResolution && t("aiConfig.models.vlHiResShort"),
    videoWire && videoInput && (videoFps !== undefined
      ? t("aiConfig.models.videoInputShortFps", { fps: videoFps })
      : t("aiConfig.models.videoInputShort")),
    translateWire && form.translateFormat && t(`aiConfig.models.translateFormat_${form.translateFormat}`),
    structuredOutput && t(SO_LABEL_KEY[structuredOutput]),
  ].filter(Boolean) as string[];

  const verbositySet = verbosityWire && form.textVerbosity !== "auto";
  const sampHas = form.temperature.trim() !== "" || form.prefix.trim() !== "" || verbositySet;
  const sampSum = [
    form.temperature.trim() !== "" && `T ${form.temperature.trim()}`,
    verbositySet && t(`aiConfig.models.verbosity_${form.textVerbosity}`),
    form.prefix.trim() !== "" && t("aiConfig.models.prefixLabelShort"),
  ].filter(Boolean).join(" · ");

  const imageHas = !!form.capsDialect || !!form.capsRoute || capsEdit || sizes.length > 0 || capsAsync || !!comfyWorkflow;
  const imageSum = [
    t(DIALECT_LABEL_KEY[isComfy ? "" : form.capsDialect] ?? DIALECT_LABEL_KEY[""]),
    t(ROUTE_LABEL_KEY[form.capsRoute] ?? ROUTE_LABEL_KEY[""]),
    (isComfy ? !!comfyWorkflow : capsEdit) && t("aiConfig.models.sumEdit"),
  ].filter(Boolean).join(" · ");

  // ── The type is the drawer's shape (设计稿 05c 屏 2d ①②⑤) ─────────────────
  // A section that cannot apply to this type is absent, not folded to
  // 「不适用」: a transcription row is 身份 · 计费 · 转写, an image row
  // 身份 · 计费 · 出图, everything else the four text sections. The index and
  // the band's one-line description are both read off this list, so neither
  // can name a section the body doesn't show.
  const isTextLike = !isImageModel && !isAsrModel;
  const sectionIndex: { key: SectionKey; has: boolean }[] = [
    { key: "price", has: priceHas },
    ...(isTextLike
      ? [
          { key: "limits" as const, has: limitsHas },
          { key: "think" as const, has: thinkHas },
          { key: "caps" as const, has: capsNames.length > 0 },
          { key: "samp" as const, has: sampHas },
        ]
      : []),
    ...(isAsrModel ? [{ key: "asr" as const, has: true }] : []),
    ...(isImageModel ? [{ key: "image" as const, has: imageHas }] : []),
  ];
  const typeSections = [t("aiConfig.models.idx_identity"), ...sectionIndex.map((x) => t(`aiConfig.models.idx_${x.key}`))]
    .join(" · ");
  const typeLine = [
    isTextLike ? typeSections : t("aiConfig.models.typeLineOnly", { sections: typeSections }),
    vlHiResWire && t("aiConfig.models.typeLineHiRes"),
    form.type === "vision" && t("aiConfig.models.typeLineVision"),
  ].filter(Boolean).join(" · ");

  // ── 「将发送」 ─────────────────────────────────────────────────────────────
  // A transcription row never reaches the chat wire; what it sends is the file
  // endpoint's four parameters (lib/asr/client.ts submitBody), or the
  // synchronous endpoint's (lib/asr/sync.ts syncBody) — spelled out here rather
  // than through wireSummary, whose vocabulary is the chat request's. The sync
  // one does post to /chat/completions, but with one audio part and nothing a
  // chat request would carry.
  const asrFormatNow: AsrFormat = form.asrFormat || ASR_FORMATS[0];
  const asrWire: WireItem[] = asrFormatNow === "dashscope-sync"
    ? [
        { key: "POST", value: "/chat/completions" },
        { key: "model", value: form.modelId || "…" },
        { key: "input_audio", value: "(data URL ≤10MB · ≤5min)" },
        { key: "asr_options", value: "language · per run" },
      ]
    : [
        { key: "POST", value: "/services/audio/asr/transcription" },
        { key: "model", value: form.modelId || "…" },
        { key: "file_urls[]", value: "(oss, 48h)" },
        { key: "diarization_enabled", value: "per run" },
      ];
  // What the transcription field warns about: an id the chosen endpoint refuses
  // (both measured), else what that endpoint cannot do.
  const asrMismatch = asrIdMismatch(asrFormatNow, form.modelId);
  const asrWarn = asrMismatch === "not-filetrans"
    ? t("aiConfig.models.asrIdNotFiletrans", { id: form.modelId })
    : asrMismatch === "not-sync"
    ? t("aiConfig.models.asrIdNotSync", { id: form.modelId })
    : asrFormatNow === "dashscope-sync"
    ? t("aiConfig.models.asrSyncHintOn")
    : t("aiConfig.models.asrFormatHintOn");
  const wire = isAsrModel
    ? asrWire
    : provider
    ? wireSummary({
        type: form.type,
        modelId: form.modelId,
        maxOutput: parsedOut > 0 ? parsedOut : undefined,
        temperature,
        reasoningEffort: form.reasoningEffort === "default" ? undefined : form.reasoningEffort,
        thinkingCategory: form.thinkingCategory === "auto" ? undefined : form.thinkingCategory,
        thinkingBudget,
        serverTools: grantedServerTools,
        structuredOutput,
        vlHighResolution: vlHiResWire && vlHighResolution ? true : undefined,
        videoInput: videoWire && videoInput ? true : undefined,
        videoFps,
        prefix: form.prefix,
        caps: isImageModel
          ? {
              edit: capsEdit,
              ...(form.capsRoute ? { route: form.capsRoute as ImageRoute } : {}),
              ...(!isComfy && form.capsDialect ? { dialect: form.capsDialect as ImageDialect } : {}),
              ...(sizes.length ? { sizes } : {}),
            }
          : undefined,
      }, provider.apiStandard, provider.baseUrl, provider.platform)
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
  // What this endpoint has refused this session (lib/ai/jsonMode.ts memo): a
  // measurement, so it outranks the resolved-config note — the author sees
  // what is actually being sent, and that their pick did not take.
  const soCeiling = provider
    ? jsonModeCeiling({ standard: provider.apiStandard, baseUrl: provider.baseUrl, modelId: form.modelId })
    : undefined;
  const soNote = soCeiling
    ? {
        note: t("aiConfig.models.noteSoCeiling", {
          refused: t(SO_LABEL_KEY[soCeiling === "off" ? "json_object" : "json_schema"]),
          mode: t(SO_LABEL_KEY[soCeiling]),
        }),
        noteTone: "faint" as const,
      }
    : form.structuredOutput !== "auto" || !soWire
      ? undefined
      : soAutoLifted
        ? { note: t("aiConfig.models.noteSoSchema"), noteTone: "ok" as const }
        : { note: t("aiConfig.models.noteSoJson"), noteTone: "muted" as const };

  const inputCls = (unset: boolean, extra = "") => `${s.input} ${unset ? s.unset : ""} ${extra}`;

  // ── Routes (设计稿 05k 屏 04–06) ───────────────────────────────────────────
  // The scope tag on every per-route field, only when there is more than one
  // route to be confused between.
  const routeScope = multiRoute && route ? t("aiConfig.models.scopeRoute", { route: ROUTE_SHORT[route] }) : undefined;
  const routeWire = (f: ProtocolFamily) => {
    const p = channel ? routeProvider(channel, f) : undefined;
    return p ? providerWire(p) : undefined;
  };
  // Every tool some route of this channel spells, or the model declares — the
  // matrix rows (屏 05). Columns are the channel's routes.
  const matrixTools = multiRoute
    ? SERVER_TOOL_IDS.filter((id) => serverTools.includes(id)
      || channelRoutes.some((f) => { const w = routeWire(f); return !!w && hasCapability(id, w); }))
    : [];
  // The other matrices (屏 05, generalised): a row per capability some route
  // of this channel has, or the model declares — so a declaration a route
  // can't say is visible there too. Single-route channels have nothing to
  // compare; the switches' own hints speak for the one route.
  const matrixRows = (ids: readonly CapabilityId[], declared: Partial<Record<CapabilityId, boolean>>) => multiRoute
    ? ids.filter((id) => declared[id]
      || channelRoutes.some((f) => { const w = routeWire(f); return !!w && hasCapability(id, w, { type: form.type }); }))
    : [];
  const matrixInput = matrixRows(["pdfInput", "vlHighResolution", "videoInput", "videoFps"], {
    pdfInput, vlHighResolution, videoInput, videoFps: videoInput && videoFpsText.trim() !== "",
  });
  const matrixOutput = matrixRows(["structuredOutput", "jsonSchema", "textVerbosity"], {
    structuredOutput: form.structuredOutput !== "auto", jsonSchema: form.structuredOutput === "json_schema",
    textVerbosity: form.textVerbosity !== "auto",
  });
  const matrixProps = (current: ProtocolFamily) => ({
    routes: channelRoutes, current, wireFor: routeWire, modelId: form.modelId, type: form.type,
  });
  /** One route's fields as the diff card lines them up (屏 06); null = unset, sends nothing. */
  const describeRoute = (p: RouteProfile | undefined, f: ProtocolFamily): { key: string; value: string | null }[] => {
    const cat = p?.thinkingCategory;
    const effort = p?.reasoningEffort && p.reasoningEffort !== "default" ? effortLabel(p.reasoningEffort) : null;
    const w = routeWire(f);
    const tools = w ? effectiveServerTools(w, declaredServerTools, form.modelId.trim()) : undefined;
    return [
      {
        key: t("aiConfig.models.secThinking"),
        value: cat ? [t(THINKING_CATEGORIES[cat].labelKey), effort].filter(Boolean).join(" · ") : effort,
      },
      { key: t("aiConfig.models.maxOutLabel"), value: p?.maxOutput ? p.maxOutput.toLocaleString() : null },
      { key: t("aiConfig.models.soLabel"), value: p?.structuredOutput ? t(SO_LABEL_KEY[p.structuredOutput]) : null },
      { key: t("aiConfig.models.tempLabel"), value: p?.temperature !== undefined ? `T ${p.temperature}` : null },
      {
        key: t("aiConfig.models.capsGroupTools"),
        value: tools?.length ? tools.map((id) => t(`aiConfig.models.serverTool_${id}`)).join(" · ") : null,
      },
    ];
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

      {/* ── 线路条 (屏 04): the channel's routes; ink = this model's current
          one, a hairline = configured before, dashed + = offered and never
          configured. A click shows what changes (屏 06) before switching. Image
          and transcription rows pick a dedicated endpoint instead (plan §5.1.2),
          so the strip is for the conversational types only. ────────────── */}
      {channel && route && multiRoute && !isImageModel && !isAsrModel && (
        <div className={r.strip}>
          <div className={r.stripHead}>
            <span className={r.stripLabel}>{t("aiConfig.models.routeLabel")}</span>
            <span className={r.badges}>
              {channelRoutes.map((f) => {
                const on = f === route;
                const configured = !!parked[f];
                return (
                  <button
                    key={f}
                    type="button"
                    className={`${r.badge} ${on ? r.badgeOn : configured ? "" : r.badgeOffered}`}
                    aria-pressed={on}
                    title={on
                      ? t("aiConfig.models.routeCurrent")
                      : configured ? t("aiConfig.models.routeConfigured") : t("aiConfig.models.routeNew")}
                    onClick={() => setPendingRoute(on ? null : f)}
                  >
                    {on || configured ? ROUTE_LONG[f] : `+ ${ROUTE_LONG[f]}`}
                  </button>
                );
              })}
            </span>
          </div>
          {pendingRoute && (() => {
            const before = describeRoute(routeFieldsNow(), route);
            const after = describeRoute(parked[pendingRoute], pendingRoute);
            return (
              <div className={r.diff} role="group" aria-label={t("aiConfig.models.routeDiffTitle", { from: ROUTE_SHORT[route], to: ROUTE_SHORT[pendingRoute] })}>
                <div className={r.diffTitle}>
                  {t("aiConfig.models.routeDiffTitle", { from: ROUTE_SHORT[route], to: ROUTE_SHORT[pendingRoute] })}
                </div>
                {before.map((row, i) => (
                  <div key={row.key} className={r.diffRow}>
                    <span className={r.diffKey}>{row.key}</span>
                    <span className={row.value === null ? r.diffUnset : ""}>{row.value ?? t("aiConfig.models.routeUnset")}</span>
                    <span>→</span>
                    <span className={after[i].value === null ? r.diffUnset : ""}>{after[i].value ?? t("aiConfig.models.routeUnset")}</span>
                  </div>
                ))}
                {!parked[pendingRoute] && <div className={r.url}>{t("aiConfig.models.routeNoCopy")}</div>}
                <div className={r.diffActions}>
                  {parked[pendingRoute] && (
                    <button className={r.tinyBtn} onClick={() => {
                      setParked((p) => { const n = { ...p }; delete n[pendingRoute]; return n; });
                      setPendingRoute(null);
                    }}>
                      {t("aiConfig.models.routeForget")}
                    </button>
                  )}
                  <button className={r.tinyBtn} onClick={() => setPendingRoute(null)}>{t("aiConfig.models.cancel")}</button>
                  <button className={r.tinyBtn} onClick={() => switchRoute(pendingRoute)}>
                    {t("aiConfig.models.routeSwitch", { route: ROUTE_LONG[pendingRoute] })}
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── 模型类型 — the band that decides which sections exist ─────────── */}
      <div className={s.typeBand}>
        <div className={s.typeBandHead}>
          <span className={s.typeBandLabel}>{t("aiConfig.models.typeLabel")}</span>
          <div className={s.typeBandHint}>
            <Hint hint={t("aiConfig.models.briefType")} {...whyProps("type", t("aiConfig.models.whyType"))} />
          </div>
        </div>
        <div className={s.chips}>
          {MODEL_TYPES.map((type) => (
            <DashChip
              key={type}
              label={t(`aiConfig.modelTypes.${type}`)}
              active={form.type === type}
              swatch={`var(--color-type-${type}-fg)`}
              onClick={() => {
                // Seed from the provider's protocol the first time this
                // becomes an image model, so the common case needs no
                // thought and the odd one is still overridable. The Gemini
                // wire only serves Gemini image models, so the dialect is
                // known there; elsewhere (dall-e vs gpt-image vs a relay)
                // it stays the author's call.
                const seedDialect =
                  type === "image" && !existing && !form.capsDialect && family === "gemini";
                // Becoming a transcription model picks its (only) endpoint
                // and, when the identity fields are still empty, the
                // recommended DashScope id and a name; leaving it drops the
                // endpoint, since the type is what the format hangs off.
                const asrSeed = type === "asr"
                  ? {
                      asrFormat: form.asrFormat || ASR_FORMATS[0],
                      modelId: form.modelId || ASR_DEFAULT_MODEL_ID[form.asrFormat || ASR_FORMATS[0]],
                      name: form.name || t("aiConfig.models.asrDefaultName"),
                      translateFormat: "" as const,
                    }
                  : { asrFormat: "" as const };
                setForm({ ...form, type, ...asrSeed, ...(seedDialect ? { capsDialect: "nanobanana" as const } : {}) });
                if (type === "image" && !existing && provider) {
                  setCapsEdit(defaultImageCaps(provider.apiStandard).edit ?? false);
                }
                // A section swap the author asked for: show the new one.
                setOpen((o) => ({
                  ...o,
                  image: type === "image" ? true : o.image,
                  asr: type === "asr" ? true : o.asr,
                }));
              }}
            />
          ))}
        </div>
        <div className={s.typeLine}>{typeLine}</div>
      </div>

      <div className={s.meta}>
        {/* 节目录 — replaces 「N 节有值」: which sections this type has, which
            hold a value, and a click folds or unfolds that one. */}
        <span className={s.index}>
          {sectionIndex.map(({ key, has }) => (
            <span
              key={key}
              role="button"
              tabIndex={0}
              className={`${s.indexItem} ${open[key] ? s.indexItemOpen : ""}`}
              onClick={() => toggleSection(key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSection(key); } }}
              aria-expanded={open[key]}
            >
              <span className={`${s.indexMark} ${has ? s.indexMarkSet : ""}`} />
              {t(`aiConfig.models.idx_${key}`)}
            </span>
          ))}
        </span>
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
                      if (!m) return;
                      setForm((f) => ({ ...f, modelId: m.id, name: m.name }));
                      applyCalibration(m.id);
                    }} />
                )}
              </div>
            )}
            <input className={inputCls(false, s.mono)} placeholder="deepseek-flash" value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
              onBlur={(e) => applyCalibration(e.target.value)} />
          </Field>
          <Field label={t("aiConfig.models.displayNameLabel")} hint={t("aiConfig.models.briefName")}>
            <input className={inputCls(false)} placeholder={t("aiConfig.models.phNameSame")} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
        </Section>

        {/* ── 计费 ───────────────────────────────────────────────────────────── */}
        {/*
          价格不在这张表上，在组里（设计稿 05l 屏 1e）。这一节从「三格单价」
          变成「选一个组」：同一家十几个模型抄同一份价、改价要改十几处，那是
          这次改动要解决的问题本身。这个模型的历史用量一分不动——每一行都抄
          着当时的价（lib/ai/usageRow）。
        */}
        <Section
          label={t("aiConfig.models.secPricing")}
          open={open.price}
          onToggle={() => toggleSection("price")}
          summary={feeSummary(boundFeeGroup, feeWords)}
          unset={!boundFeeGroup}
        >
          <Field label={t("aiConfig.models.feeGroupLabel")} hint={
            boundFeeGroup ? t("aiConfig.models.feeGroupHint") : t("aiConfig.models.feeGroupHintUnbound")
          }>
            {/* 应用自己的下拉，不是原生 `<select>`：浏览器的弹出菜单没法主题化，
                而这个列表要按厂商分段、还要能搜。「未绑定」是一个 value 为空的
                **真选择**（不是 placeholder），所以它在列表里排第一。 */}
            <Select
              className={s.fieldSelect}
              value={form.feeGroupId}
              options={[
                { value: "", label: t("aiConfig.fees.unbound") },
                ...feeGroupOptions(
                  feeGroups,
                  (g) => `${g.name || t("aiConfig.fees.untitled")} — ${feeSummary(g, feeWords)}`,
                  t("aiConfig.fees.vendorNone"),
                ),
              ]}
              ariaLabel={t("aiConfig.models.feeGroupLabel")}
              searchable
              searchPlaceholder={t("aiConfig.fees.pickSearch")}
              noResultsText={t("aiConfig.fees.pickNoMatch")}
              onChange={(v) => setForm({ ...form, feeGroupId: v })}
            />
          </Field>
        </Section>

        {/* ── Text-model sections: 限额 / 思考 / 能力 / 采样 ──────────────────── */}
        <Fold open={isTextLike}>
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
            <Field label={t("aiConfig.models.maxOutLabel")} scope={routeScope} sub={t("aiConfig.models.unitTokens")}
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
            <Field label={t("aiConfig.models.probeLabel")} scope={routeScope} hint={t("aiConfig.models.briefProbe")}>
              <ModelProbePanel
                providerId={providerId}
                route={route}
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
            scope={routeScope}
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
                presets wrap freely (设计稿 05c · 问题 7). */}
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
                        onClick={() => setForm((f) => ({
                          ...f,
                          thinkingCategory: c,
                          // A stale `medium` can't survive onto e.g. a GLM model (low/high/max only).
                          reasoningEffort: effortForCategory(c === "auto" ? undefined : THINKING_CATEGORIES[c], f.reasoningEffort),
                        }))}
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
            {/* Tools the endpoint runs itself — which ones is the provider's
                platform's call, per family (lib/ai/platforms.ts; DashScope's
                enable_search / Responses built-ins, the protocol-native
                web_search elsewhere), and off by default: it is
                a standing permission for the model to reach the open web on
                every request, which is the author's call to make rather than
                something a model quietly gains. Extraction is shown only where
                the wire can spell it, and is tied to search both ways — the
                endpoint refuses it alone (normalizeServerTools). */}
            {/* Four groups (设计稿 05c 屏 2d ③): what the endpoint runs · what
                goes in · what comes out · what narrows the model to one use.
                The standing-grant sentence is the tools group's head, said
                once instead of under every switch. */}
            <Fold open={(!!toolWire && hasAnyServerTool(toolWire)) || shownServerTools.length > 0 || matrixTools.length > 0}>
              <Subhead label={t("aiConfig.models.capsGroupTools")} hint={t("aiConfig.models.briefTools")} />
              {/* Offered ids, plus any switched on that this wire can't send
                  (shownServerTools). The code interpreter is per model id
                  (the code_interpreter cells in lib/ai/capabilities): an id
                  measured refusing it gets no switch, one never measured gets
                  the switch and says so. */}
              {shownServerTools.map((id) => (
                <ToggleField
                  key={id}
                  title={t("aiConfig.models.serverToolsToggle", { tool: t(`aiConfig.models.serverTool_${id}`) })}
                  hint={!offersServerTool(id)
                    // Two reasons, said apart: the platform has no spelling,
                    // or it has one this model id doesn't run (the code
                    // interpreter's per-model gate).
                    ? t(toolWire && hasCapability(id, toolWire)
                      ? "aiConfig.models.serverToolNotForModel"
                      : "aiConfig.models.serverToolNotSent", { platform: platformName, model: form.modelId.trim() })
                    : unmeasuredToolHint(id)}
                  on={serverTools.includes(id)}
                  onChange={(next) =>
                    setServerTools((cur) => {
                      const rest = cur.filter((x) => x !== id);
                      if (next) return id === "web_extractor" ? [...rest.filter((x) => x !== "web_search"), "web_search", id] : [...rest, id];
                      return id === "web_search" ? rest.filter((x) => x !== "web_extractor") : rest;
                    })
                  }
                  {...(id === "web_extractor"
                    ? whyProps("extract", t("aiConfig.models.serverToolsHintExtractor"))
                    : id === "web_search_image"
                      ? whyProps("imgText", t("aiConfig.models.serverToolsHintWebSearchImage"))
                      : id === "image_search"
                        ? whyProps("imgImage", t("aiConfig.models.serverToolsHintImageSearch"))
                        : id === "code_interpreter"
                          ? whyProps("code", t(family === "responses"
                            ? "aiConfig.models.serverToolsHintCodeInterpreterResponses"
                            : "aiConfig.models.serverToolsHintCodeInterpreter"))
                          : whyProps("tools", family === "openai"
                          ? t("aiConfig.models.serverToolsHintOpenai")
                          : family === "responses"
                            ? t("aiConfig.models.serverToolsHintResponses")
                            : t("aiConfig.models.serverToolsHint")))}
                />
              ))}
              {/* 可用性矩阵 (屏 05): the switches above are the author's grant,
                  the same on every route; whether a route can *say* each one is
                  the platform's, per route. The current route's column is the
                  one the switches' hints speak for. */}
              {route && (
                <CapabilityMatrix label={t("aiConfig.models.matrixLabel")} ids={matrixTools}
                  rowLabel={(id) => t(`aiConfig.models.serverTool_${id}`)} {...matrixProps(route)} />
              )}
            </Fold>

            {/* Whole-PDF input (Chat Completions `file` / Responses `input_file`).
                Family-gated like the category chips above: Anthropic and Gemini
                have no mapping for the part here, so showing the switch there
                would promise a subagent that refuses at run time. */}
            <Fold open={pdfWire || vlHiResWire || pdfInput || (videoInput && canSeeImages(form))}>
              <Subhead label={t("aiConfig.models.capsGroupInput")} />
            </Fold>
            {/* Shown where the wire has a spelling, and also where it doesn't
                but the model declares it — the declaration is the model's and
                outlives a route switch, so it must stay visible (and able to be
                turned off), with the reason it isn't sent here. */}
            <Fold open={pdfWire || pdfInput}>
              <ToggleField
                title={t("aiConfig.models.pdfInputLabel")}
                hint={pdfWire ? t("aiConfig.models.briefPdf") : t("aiConfig.models.declNotOnRoute", { route: route ? ROUTE_LONG[route] : "" })}
                on={pdfInput}
                onChange={setPdfInput}
                {...whyProps("pdf", t("aiConfig.models.pdfInputHint"))}
              />
            </Fold>

            {/* DashScope `vl_high_resolution_images` — only for a model that
                reads pictures, on the one family whose adapter sends it. */}
            <Fold open={vlHiResWire}>
              <ToggleField
                title={t("aiConfig.models.vlHiResLabel")}
                hint={t("aiConfig.models.briefVlHiRes")}
                on={vlHighResolution}
                onChange={setVlHighResolution}
                {...whyProps("vlHiRes", t("aiConfig.models.vlHiResHint"))}
              />
            </Fold>

            {/* Video clips as chat @-attachments — same gate as the hi-res
                switch. The fps field appears under it when on; empty = dashed
                = no `fps` on the part = the endpoint's own ≈2. */}
            <Fold open={videoWire || (videoInput && canSeeImages(form))}>
              <ToggleField
                title={t("aiConfig.models.videoInputLabel")}
                hint={videoWire ? t("aiConfig.models.briefVideo") : t("aiConfig.models.declNotOnRoute", { route: route ? ROUTE_LONG[route] : "" })}
                on={videoInput}
                onChange={setVideoInput}
                {...whyProps("video", t("aiConfig.models.videoInputHint"))}
              />
            </Fold>
            <Fold open={videoFpsWire && videoInput}>
              <Field label={t("aiConfig.models.videoFpsLabel")} hint={t("aiConfig.models.briefVideoFps")}
                {...whyProps("videoFps", t("aiConfig.models.videoFpsHint"))}>
                <div className={s.numRow}>
                  <input
                    className={inputCls(videoFpsText.trim() === "", s.num)}
                    type="number" min={MIN_VIDEO_FPS} max={MAX_VIDEO_FPS} step="0.5"
                    placeholder={t("aiConfig.models.phNotSent")}
                    value={videoFpsText}
                    onChange={(e) => setVideoFpsText(e.target.value)}
                    aria-label={t("aiConfig.models.videoFpsLabel")}
                  />
                </div>
              </Field>
            </Fold>
            {route && (
              <CapabilityMatrix label={t("aiConfig.models.matrixLabelInput")} ids={matrixInput}
                rowLabel={(id) => t(MATRIX_ROW_KEY[id] ?? id)} {...matrixProps(route)} />
            )}

            {/* How this model is asked for JSON on a structured task
                (lib/ai/jsonMode.ts). Only the modes this family can honour are
                offered; on Anthropic that is 自动 · 关闭, and the hint says why
                rather than the row hiding. The note under 自动 shows what it
                resolves to, same as the thinking category's. */}
            <Subhead label={t("aiConfig.models.capsGroupOutput")} />
            <Field label={t("aiConfig.models.soLabel")} scope={routeScope} hint={soHint} {...soNote}
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
            {route && (
              <CapabilityMatrix label={t("aiConfig.models.matrixLabelOutput")} ids={matrixOutput}
                rowLabel={(id) => t(MATRIX_ROW_KEY[id] ?? id)} {...matrixProps(route)} />
            )}

            {/* Dedicated translation models (Sakura). Family-gated for the same
                reason as the PDF switch — they are served by local
                OpenAI-compatible endpoints and nothing else — and Text-only
                (屏 2d ④): Sakura is a text model, and on a multimodal / vision
                row the declaration would also take it out of the vision
                subagent's candidates.

                This is the one control in this drawer that takes a capability
                *away*: a model declared here is a fixed 日→中 function that does
                not read instructions, so it stops being offered as the main
                model or as any other subagent's model. The warning has to say
                so — an author who ticks it and then cannot find their model in
                the chat picker would otherwise read that as a bug. */}
            <Fold open={translateWire}>
              <Subhead label={t("aiConfig.models.capsGroupDedicated")} hint={t("aiConfig.models.capsGroupDedicatedHint")} />
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
              <Field label={t("aiConfig.models.tempLabel")} scope={routeScope} hint={t("aiConfig.models.briefTemp")}
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
            {/* text.verbosity — the Responses family is the only wire with the
                field, so the row exists only there. 自动 = dashed, nothing sent. */}
            <Fold open={verbosityWire}>
              <Field label={t("aiConfig.models.verbosityLabel")} scope={routeScope} hint={t("aiConfig.models.briefVerbosity")}
                {...whyProps("verb", t("aiConfig.models.verbosityHint"))}>
                <div className={s.chips}>
                  <DashChip
                    label={t("aiConfig.models.verbosityAuto")}
                    active={form.textVerbosity === "auto"}
                    auto
                    onClick={() => setForm({ ...form, textVerbosity: "auto" })}
                  />
                  {TEXT_VERBOSITIES.map((v) => (
                    <DashChip
                      key={v}
                      label={t(`aiConfig.models.verbosity_${v}`)}
                      active={form.textVerbosity === v}
                      onClick={() => setForm({ ...form, textVerbosity: v })}
                    />
                  ))}
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

        {/* ── 转写 — replaces the four text sections for an Audio ASR model ── */}
        {/* Transcription endpoint (设计稿 02f 屏 1b; its own section since 05c
            屏 2d ②). The row became a transcription model by its type chip,
            which also pre-filled the id and name; this only picks which
            endpoint it speaks. */}
        <Fold open={isAsrModel}>
          <Section
            label={t("aiConfig.models.secAsr")}
            open={open.asr}
            onToggle={() => toggleSection("asr")}
            summary={t(`aiConfig.models.asrFormat_${asrFormatNow}`)}
            unset={false}
          >
            <Field label={t("aiConfig.models.asrLabel")} hint={t("aiConfig.models.briefAsr")} warn={asrWarn}>
              <div className={s.chips}>
                {ASR_FORMATS.map((f) => (
                  <DashChip
                    key={f}
                    label={t(`aiConfig.models.asrFormat_${f}`)}
                    active={asrFormatNow === f}
                    onClick={() => {
                      // The format decides the path, so it also decides the
                      // sensible id: an id / name still at the other endpoint's
                      // default (or empty) follows the switch; one the author
                      // typed stays, and the warning above says if it no
                      // longer fits.
                      const nameOf = (x: AsrFormat) =>
                        t(x === "dashscope-sync" ? "aiConfig.models.asrDefaultNameSync" : "aiConfig.models.asrDefaultName");
                      const idIsDefault = !form.modelId || form.modelId === ASR_DEFAULT_MODEL_ID[asrFormatNow];
                      const nameIsDefault = !form.name || form.name === nameOf(asrFormatNow);
                      setForm({
                        ...form,
                        asrFormat: f,
                        modelId: idIsDefault ? ASR_DEFAULT_MODEL_ID[f] : form.modelId,
                        name: nameIsDefault ? nameOf(f) : form.name,
                      });
                    }}
                  />
                ))}
              </div>
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
                <Select className={s.fieldSelect} value={form.capsDialect}
                  options={[
                    { value: "", label: t("aiConfig.models.capsDialectGeneric") },
                    { value: "nanobanana", label: t("aiConfig.models.capsDialectNanobanana") },
                    { value: "gpt-image-2", label: t("aiConfig.models.capsDialectGptImage2") },
                    { value: "wan2.7", label: t("aiConfig.models.capsDialectWan27") },
                    { value: "qwen-image", label: t("aiConfig.models.capsDialectQwenImage") },
                    { value: "seedream-5-pro", label: t("aiConfig.models.capsDialectSeedream5Pro") },
                    { value: "seedream-5-lite", label: t("aiConfig.models.capsDialectSeedream5Lite") },
                    { value: "seedream-4", label: t("aiConfig.models.capsDialectSeedream4") },
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
                      // Same for Seedream: its body only exists on the ark route.
                      ...(SEEDREAM_DIALECTS.includes(v as ImageDialect) && !f.capsRoute ? { capsRoute: "ark" } : {}),
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
              <Select className={s.fieldSelect} value={form.capsRoute}
                options={[
                  { value: "", label: t("aiConfig.models.capsRouteAuto") },
                  { value: "images-api", label: t("aiConfig.models.capsRouteImages") },
                  { value: "chat", label: t("aiConfig.models.capsRouteChat") },
                  { value: "gemini", label: t("aiConfig.models.capsRouteGemini") },
                  { value: "dashscope", label: t("aiConfig.models.capsRouteDashscope") },
                  { value: "ark", label: t("aiConfig.models.capsRouteArk") },
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
                  // Every Seedream version takes reference images (10–14).
                  if (capsRoute === "dashscope" || capsRoute === "ark") setCapsEdit(true);
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
              {w.scope === "video" && <span className={s.wireScope}> · {t("aiConfig.models.wireVideoScope")}</span>}
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
