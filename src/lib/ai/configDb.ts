/**
 * SQLite-backed AI configuration storage: providers, models, and prompt
 * templates, plus the legacy plaintext-key migration helpers used by keyStore.
 */

import Database from "@tauri-apps/plugin-sql";

import type { ComfyWorkflowConfig } from "../comfy/workflow";
import type { SqlStatement } from "../sqlTx";
import type { GeminiSafetySettings } from "./safety";
import {
  authModesFor, parseTextVerbosity, type ApiStandard, type AuthMode, type ImageRoute, type TextVerbosity,
} from "./types";
import type { ImageDialect } from "./imageDialects";
import {
  parseReasoningEffort, parseThinkingCategory, parseThinkingDialect,
  type ReasoningEffort, type ThinkingCategoryId, type ThinkingDialect,
} from "./reasoning";
import { parseServerTools, type ServerToolId } from "./serverTools";
import { parsePlatform, platformToStore, providerWire, wireReadsPdf, type PlatformId } from "./platforms";
import {
  legacyColumnsDiverged, legacyEndpoint, normalizeChannel, parseEndpoints, parseRouteFamily, parseRouteProfiles,
  standardOf, writtenBaseOf,
  type Endpoint, type RouteProfile,
} from "./routes";
import type { ProtocolFamily } from "./types";
import { parseStructuredOutputMode, type StructuredOutputMode } from "./jsonMode";
import { migrateLegacyStandard } from "./urls";
import { clampVideoFps } from "./videoInput";

/**
 * What a model row *is*, for the app's forms and candidate lists — never sent.
 *
 * `multimodal` and `vision` both read pictures (`canSeeImages`); `vision` is the
 * specialist that is not offered as a writer. `image` / `video` *generate*.
 * `asr` transcribes and never converses (`isAsrOnly`).
 */
export type ModelType = "text" | "multimodal" | "vision" | "image" | "video" | "asr";

/**
 * The fixed prompt format a dedicated translation model was trained on.
 *
 * A union rather than a boolean because the format *is* the identity: Sakura's
 * system message and user template are frozen at training time, so "this is a
 * translation model" and "these exact strings" are the same fact. A second
 * entry here (GalTransl, say) would arrive as a second template in
 * `lib/translate/`, not as a new branch anywhere else.
 */
export type TranslateFormat = "sakura";

/**
 * The transcription protocol a dedicated speech-to-text model speaks.
 *
 * Same shape as `TranslateFormat`, for the same reason: the format *is* the
 * identity. `dashscope-filetrans` is DashScope's async 录音文件识别 —
 * upload to temporary storage, submit, poll, download (lib/asr/client.ts).
 * A second entry (a local Whisper server, say) would arrive as a second
 * client in `lib/asr/`, not as a branch elsewhere.
 */
/**
 * Which transcription endpoint an `asr` row speaks — the model row picks the
 * path, there is no routing between two rows. `dashscope-filetrans` is the
 * async upload → submit → poll one (any length, timestamps, speakers);
 * `dashscope-sync` is compatible-mode `/chat/completions` with the audio inline
 * (≤5 min / ≤10MB, one plain string back). docs/feature/asr/00-research.md §1.3.
 */
export type AsrFormat = "dashscope-filetrans" | "dashscope-sync";

/**
 * What an image model's endpoint can actually do. Declared rather than probed:
 * a capability probe against an image endpoint costs a real generation, so the
 * author states it once (defaults guessed from the API standard) and the
 * runtime degrades visibly when a request proves the declaration wrong.
 */
export interface ImageCaps {
  /** Accepts input images — editing / img2img. False for generate-only endpoints. */
  edit?: boolean;
  /**
   * Which parameter language the model speaks (lib/ai/imageDialects.ts):
   * "nanobanana" = Gemini's aspectRatio/imageSize, "gpt-image-2" = OpenAI's
   * size/quality. Absent = generic — the free-form `sizes` list below, which a
   * declared dialect supersedes.
   */
  dialect?: ImageDialect;
  /** Sizes the endpoint accepts (e.g. ["1024x1024"]). Empty ⇒ send no size at all. */
  sizes?: string[];
  /** How many reference images one edit request may carry. */
  maxRefs?: number;
  /**
   * Which endpoint serves this model's images. Unset ⇒ derived from the
   * provider's API standard, which is right for first-party endpoints and
   * wrong for relays hosting a Gemini image model behind an OpenAI protocol.
   */
  route?: ImageRoute;
  /**
   * "dashscope" route only: submit as an async task and poll /tasks/{id}.
   * Wan text-to-image (wan2.7-image*) is async-only; qwen-image* and
   * z-image-turbo answer synchronously and leave this unset. Declared, not
   * sniffed from the model id — same rule as every other capability here.
   */
  asyncTask?: boolean;
  /**
   * "comfyui" route only: the author's imported API-format workflow. Lives in
   * caps rather than its own column so it rides the existing JSON storage and
   * the config backup/sync path with zero migration. One Model row = one
   * workflow — placeholder nodes are re-identified from this JSON at request
   * time, never resolved to node ids at import (lib/comfy/workflow.ts).
   */
  comfy?: ComfyWorkflowConfig;
}

/**
 * Default capabilities for a newly added image model, by wire protocol.
 * `openai_compat` is the conservative case: relays and xAI commonly expose
 * /images/generations but no /images/edits, and guessing "yes" there would
 * promise the author an edit button that always errors.
 */
export function defaultImageCaps(standard: ApiStandard): ImageCaps {
  switch (standard) {
    case "openai":
    case "openai_responses":
      // Same host, same `/images/generations` and `/images/edits` below the
      // same base — which protocol the *chat* half speaks says nothing about
      // the image endpoints, so the official Responses standard gets the
      // official OpenAI answer. Its compat half lands in `default` with the
      // other relays.
      return { edit: true, maxRefs: 16 };
    case "gemini":
    case "gemini_compat":
      // Compat gets the optimistic default here, unlike the OpenAI side,
      // because of *how* Gemini expresses an edit: input images are extra parts
      // on the same `:generateContent` call. There is no second endpoint for a
      // relay to be missing — anything that can serve generation can serve an
      // edit, so assuming otherwise would hide a button that works.
      return { edit: true, maxRefs: 3 };
    case "anthropic":
      // Claude generates no images at all, so an image model configured under
      // an Anthropic provider is already a mistake — but the switch still has
      // to answer, and "no editing" is the honest answer.
      return { edit: false };
    default:
      // `openai_compat` lands here on purpose: OpenAI puts editing behind a
      // *separate* endpoint (`/images/edits`, multipart), and relays and xAI
      // commonly expose `/images/generations` without it — so promising an edit
      // button there would promise one that errors. Also covers a DB row
      // carrying a value the union never anticipated, which would otherwise
      // fall out of the switch as `undefined` and crash every caller that
      // trusts the return type.
      return { edit: false };
  }
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiStandard: ApiStandard;
  /** Gemini-only: per-request safety filter thresholds. */
  safetySettings?: GeminiSafetySettings;
  /**
   * Anthropic-compat only: which header carries the key. Undefined — every
   * provider configured before this setting existed — means the protocol's own
   * scheme, so an upgrade never changes how an existing provider authenticates.
   */
  authMode?: AuthMode;
  /**
   * Which server this is, beyond its protocol — the key into the platform
   * profiles (`lib/ai/platforms.ts`) that decide which private fields, server
   * tools above all, this row's requests may carry. Absent = inferred from the
   * address on every read (`resolvePlatform`); `listProviders` fills it in, so
   * rows read from the database always carry one. Written by the provider
   * drawer. docs/feature/channel-model-route-plan.md §4.
   */
  platform?: PlatformId;
  /**
   * `scheme://host[:port]` every route of this channel hangs off, typed once
   * (plan §5.1.1). Empty on an official platform, whose routes are vendor
   * constants. Absent only on a hand-built row; `listProviders` fills it.
   */
  host?: string;
  /**
   * The channel's routes, primary first — one per protocol family, each an
   * address below `host` (`lib/ai/routes.ts`). The flat `baseUrl` /
   * `apiStandard` / `authMode` / `safetySettings` above are always the
   * primary route's (`normalizeChannel`); a model on another route reads its
   * channel through `providerFor`. Absent only on a hand-built row, where the
   * flat fields are the one route.
   */
  endpoints?: Endpoint[];
  /**
   * Position in the provider list, written by the reorder buttons (see
   * `lib/ai/providerOrder`). Undefined — every provider never explicitly
   * moved — sorts *after* all ordered rows, by `createdAt`: a new provider
   * appends at the bottom without any write, and a pre-feature config keeps
   * its familiar order. The first move rewrites positions for the whole list.
   */
  sortOrder?: number;
  createdAt: number;
}

export interface Model {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  type: ModelType;
  priceIn: number;      // USD per 1M input tokens
  priceCachedIn: number;
  priceOut: number;     // USD per 1M output tokens
  enabled: boolean;
  /** Optional model-scoped prefix prompt, prepended to every request as a leading system instruction. */
  prefix?: string;
  /**
   * Optional context window size in tokens (max 2,000,000). When set, requests
   * whose estimated prompt size exceeds it are blocked with a user-facing
   * notice before sending, instead of being silently truncated by the server.
   */
  contextSize?: number;
  /**
   * Optional cap on how many tokens this model can emit in one reply.
   *
   * Mostly a planning input: the context budget stops reserving window the model
   * could never fill (see context/budget.ts), which hands that space back to the
   * prompt. It *is* sent to the provider on the Anthropic path, where the
   * Messages API requires `max_tokens` on every request and has no server-side
   * default to fall back on (see ai/anthropic.ts).
   */
  maxOutput?: number;
  /**
   * Sampling temperature for this model, or absent to send nothing and leave
   * the endpoint's own default alone.
   *
   * Per-model and author-declared, like everything else here, but it exists for
   * a reason the other settings don't have: a *local* endpoint's default is set
   * by whoever packaged the weights, not by the app. ollama serves gemma4 at
   * `temperature 1 / top_k 64 / top_p 0.95` — Gemma's own recommendation for
   * creative writing, and a high-variance setting for picking one tool out of
   * thirty-nine. Until this existed there was no way to lower it from inside
   * the app at all; `extraBody` is an internal escape hatch with no UI.
   *
   * Absent, not 0-means-unset: 0 is a legal and useful temperature (it is the
   * one an author reaches for when a task must stop being creative), so it
   * cannot double as the empty value.
   */
  temperature?: number;
  /**
   * When the endpoint was last probed (ms epoch), or undefined for values the
   * author typed in. Measurements age — a relay can re-route the same model
   * name to a different upstream tomorrow — so the UI dates them rather than
   * presenting them as permanent facts.
   */
  probedAt?: number;
  /**
   * The values the probe wrote at `probedAt`, kept **beside** `contextSize` /
   * `maxOutput` rather than replacing them: the author may overwrite a
   * measured value by hand, and the editor then says so ("手填 · 覆盖 08-30
   * 实测 131,072") instead of presenting the typed number as a measurement.
   * A field the probe did not resolve stays absent. See 设计稿 05c · 实测值的
   * 标记规则.
   */
  probedContextSize?: number;
  probedMaxOutput?: number;
  /**
   * How hard this model should think, in this app's own vocabulary — the
   * adapters translate (see `lib/ai/reasoning.ts`).
   *
   * Per-model rather than per-provider because the levels a model accepts, and
   * whether it can think at all, vary between models served by one endpoint:
   * a relay hosts a reasoning model and a plain one behind the same base URL.
   *
   * Absent (and `"default"`) means send nothing.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Which thinking-parameter **category** this model uses — the author-facing
   * choice (a per-vendor preset carrying its own legal effort menu). Absent =
   * the `auto` state, which `resolveThinkingCategory` turns into the family
   * default. See `THINKING_CATEGORIES` in `lib/ai/reasoning.ts`.
   */
  thinkingCategory?: ThinkingCategoryId;
  /**
   * Token budget for a budget-shape category (Claude 4.5- `budget_tokens`,
   * Qwen `thinking_budget`). Absent leaves the endpoint/adapter default.
   */
  thinkingBudget?: number;
  /**
   * Legacy: the coarse thinking *shape*, superseded by `thinkingCategory`. Kept
   * only so `resolveThinkingCategory` can migrate a model configured before
   * categories existed; new saves write `thinkingCategory` and null this out.
   */
  thinkingDialect?: ThinkingDialect;
  /**
   * Tools this model may have the **endpoint** run for it — `web_search`, and
   * `web_extractor` only beside it (see `lib/ai/serverTools.ts` for which wire
   * spells which).
   *
   * Per-model and declared, for the same reason as everything else here: it is
   * a property of what the author bought (MiniMax-M3 serves it; the M2.x models
   * behind the same base URL do not), and no probe can ask an endpoint which
   * server tools it offers. Absent means none, which is what every model
   * configured before this setting existed sends.
   */
  serverTools?: ServerToolId[];
  /**
   * How this model is asked for JSON when a task needs a structured reply —
   * `off` / `json_object` / `json_schema` (see `lib/ai/jsonMode.ts`).
   *
   * Declared rather than derived, same as `serverTools` above: within one
   * family, and behind one base URL, some models take the strict `json_schema`
   * mode, most take only `json_object`, and a relay may reject `response_format`
   * altogether — none of which the protocol family can tell. Absent means
   * **auto**: the family default, lifted to `json_schema` for model ids known
   * to accept it — which for every model configured before this existed is
   * byte-identical to what it sent before.
   */
  structuredOutput?: StructuredOutputMode;
  /**
   * Whether this endpoint accepts whole PDF files as message content (the
   * OpenAI `file` content part — today Qwen3.8-Max on DashScope
   * compatible-mode; see `docs/api/landscape.md` §7 第六个样本).
   *
   * Declared rather than derived, same as `serverTools` above: it is a
   * property of what the author bought — one model behind a DashScope endpoint
   * reads PDFs, the rest behind the same base URL do not — and no probe can
   * ask without spending a real document run. The PDF subagent's eligibility
   * check reads this. Absent means no, which is what every model configured
   * before this setting existed sends.
   */
  pdfInput?: boolean;
  /**
   * Ask DashScope to read pictures at high resolution —
   * `vl_high_resolution_images: true` on the Chat Completions wire.
   *
   * Measured on qwen3-vl-plus (docs/api/landscape.md §6): an image costs about
   * one token per 32×32 pixels, capped near 2,500 tokens by default; with this
   * on the cap rises to 16,384 (a 4096² picture: 2,502 → 16,386 tokens). Worth
   * it for dense small text, expensive everywhere else, so it is declared per
   * model and off by default. Only a model that can see and only the `openai`
   * family carry it; `detail` does nothing on this endpoint (same measurement).
   */
  vlHighResolution?: boolean;
  /**
   * Whether a chat `@` attachment may put a video clip on this model's
   * request, as a `video_url` part (docs/feature/video-input.md).
   *
   * Declared rather than derived, same as `pdfInput`: qwen3-vl-plus,
   * qwen3-vl-flash and qwen3.8-flash read video behind a DashScope endpoint
   * where other vision models may not, and no probe can ask without spending
   * a real clip. Honoured only where `canReadVideo` (lib/ai/videoInput) says —
   * a model that can see, on the `openai` family. Absent means no.
   */
  videoInput?: boolean;
  /**
   * Frames per second the endpoint should sample from an attached clip — the
   * part's `fps` field. Absent sends nothing, which the endpoint treats as
   * about 2. Measured on a 60 s 720p clip: 0.5 → 8,912 tokens in 20 s,
   * default → 35,642 in 125 s, 4 → 71,282. Stored clamped to 0.1–10
   * (`clampVideoFps`); only 0.5–4 were measured. Not a `ConnOptions` field:
   * it rides on the content part, built where the message is composed.
   */
  videoFps?: number;
  /**
   * How long and expansive the answer should be — the Responses family's
   * `text.verbosity` (GPT-5.x; measured on gpt-5.6-terra, `low` visibly
   * shortens the same answer — docs/api/responses.md §10).
   *
   * Only that family has the field, so the drawer offers it there alone and
   * clears it everywhere else. Absent sends nothing, like every declaration.
   */
  textVerbosity?: TextVerbosity;
  /**
   * Which fixed translation prompt format this model was trained on, if it is a
   * dedicated translation model rather than a general one.
   *
   * Declared rather than derived, same as `serverTools` and `pdfInput` above:
   * it is a property of the weights the author loaded, the model id behind a
   * local endpoint is free text they typed, and no probe can ask.
   *
   * Setting it is a *narrowing*, not a capability: `sakura` is one-way 日→中
   * and does not read instructions at all — asked a question it paraphrases it
   * back — so a model carrying this must never appear as a candidate for the
   * main model, or for any subagent other than `translate`. See
   * docs/feature/translate/01-execution-plan.md §1 不变量 2.
   *
   * Absent means "an ordinary model", which is what every row configured
   * before this existed reads as.
   */
  translateFormat?: TranslateFormat;
  /**
   * Which transcription protocol an `asr`-type model speaks.
   *
   * The *identity* — "this row cannot hold a conversation, keep it out of
   * every chat picker" — is `type: "asr"` (`isAsrOnly`); this field only picks
   * the endpoint. The two always travel together: `normalizeAsrIdentity`
   * upgrades a row saved before the type existed (format set, type `text`)
   * and fills the format on an `asr` row missing one. See
   * docs/feature/asr/01-execution-plan.md §1 不变量 1.
   */
  asrFormat?: AsrFormat;
  /**
   * Price per second of audio, in the same currency column as everything
   * else (`token_usage.cost_usd`). Transcription bills by duration, not by
   * token, so the token prices above mean nothing for such a row; this is
   * what `lib/asr` multiplies the billed seconds by. Absent = unknown, and
   * the usage page cannot account for the run.
   */
  pricePerSecond?: number;
  /**
   * USD per generated image. The billing shape image endpoints usually use;
   * token pricing (priceIn/priceOut) still applies on top for the providers
   * that bill image generation as tokens. See `imageCostFor`.
   */
  pricePerImage?: number;
  /** Image-model capabilities. Meaningless (and unset) for text models. */
  caps?: ImageCaps;
  /**
   * Which of its channel's routes this model's requests take (plan §2.2).
   * Absent = the channel's primary route. The route fields above
   * (`ROUTE_PROFILE_KEYS`: thinking, output cap, temperature, structured
   * output, verbosity, hi-res, the probe's readings) are always *this* route's.
   */
  activeRoute?: ProtocolFamily;
  /**
   * The route fields of every other route this model has been configured on,
   * parked by family. Switching route swaps them with the flat fields
   * (`switchModelRoute`); a family with no entry was never configured and
   * sends nothing (invariant 3).
   */
  routes?: Partial<Record<ProtocolFamily, RouteProfile>>;
}

/**
 * 这个模型是不是一个只会翻译的模型。
 *
 * 一个函数而不是散在各处的 `!m.translateFormat`，因为它是一条**不变量**的
 * 判据（见 docs/feature/translate/01-execution-plan.md §1 第 2 条），而不变量
 * 需要一个可以被引用的名字。
 */
export function isTranslateOnly(m: Model): boolean {
  return m.translateFormat !== undefined;
}

/**
 * 这个模型是不是一个只会转写的模型（docs/feature/asr/01-execution-plan.md §1
 * 不变量 1）。同 `isTranslateOnly`：一个有名字的判据，不是散在各处的类型比较。
 *
 * 判据是**类型**，不是 `asrFormat`：00-research.md §4.1 原先只加标记、不加类型，
 * 后来为了列表能按类型筛、徽标能一眼认出而改成了类型即身份（同文 §4.1 补记）。
 * `asrFormat` 仍在，但只回答「走哪种转写接口」。
 */
export function isAsrOnly(m: Pick<Model, "type">): boolean {
  return m.type === "asr";
}

/**
 * 这个模型能不能看图 —— 请求里能不能放 base64 图片、读图工具能不能在场、看图
 * 子代理能不能绑它，问的都是这一个问题。
 *
 * 两个类型都算：「多模态」是会看图的通用对话模型（qwen3.8-flash、deepseek-flash），
 * 「视觉理解」是专门看图的模型（qwen3-vl-*、qwen-vl-ocr）。两者在线上完全一样
 * （同一个 `image_url` 片段，docs/api/landscape.md §6），区别只在 app 里：视觉
 * 理解模型不当写手（`subAgentModel` 的 writer 分支）。一个有名字的判据而不是散在
 * 二十处的 `type === "multimodal"`，因为漏改一处就是一个看得见图却被当成纯文本
 * 的模型，而且什么都不报。
 */
export function canSeeImages(m: Pick<Model, "type">): boolean {
  return m.type === "multimodal" || m.type === "vision";
}

/**
 * 这个模型在这条线路上能不能收整份 PDF。
 *
 * `pdfInput` 是模型上的声明（作者买的是这个模型读 PDF 的能力），但只有两族一定有拼法：
 * Chat Completions 的 `file` 片段与 Responses 的 `input_file`（openai.ts / responses.ts）。
 * Anthropic 族的 `document` 块多数兼容端会换成占位符静默吞掉，只有平台画像实测过的
 * （`pdfFamilies`，如火山方舟 Plan）才算数——所以这里按渠道的平台 × 线路问 `wireReadsPdf`。
 * 模型能在渠道的几条线路之间切换以后，声明就不能再在保存时按「当前线路」清掉——
 * 切到 ④ 族再切回来，作者不该重填一遍（channel-model-route-plan.md §3）。所以声明
 * 留着，能不能用在这里按线路回答；PDF 子代理的资格、委派时的拦截都问这一句。
 * 不给渠道（手里没有渠道列表的界面）时只看声明。
 */
export function readsPdf(
  m: Pick<Model, "pdfInput">,
  provider?: Pick<Provider, "apiStandard" | "baseUrl" | "platform">,
): boolean {
  if (!m.pdfInput) return false;
  if (!provider) return true;
  return wireReadsPdf(providerWire(provider));
}

/**
 * 读进来的一行（数据库或备份）在「转写身份」上的规范形。
 *
 * 类型是身份、`asrFormat` 是接口，两者必须同时成立：
 * - 带 `asrFormat` 的行一律是 `asr` 类型 —— 这是「转写模型 = 类型」之前的数据
 *   （当时身份在 `asrFormat` 上，类型存的是 `text`），不升级它就会回到对话列表里；
 * - `asr` 类型缺格式时补上默认格式（filetrans，`ASR_FORMATS[0]`）—— 否则转写连接无从选接口；
 *   同步格式是后来加的，缺格式的行只可能来自那之前。
 * 反方向（`asrFormat` 留在非 `asr` 行上）由保存路径清掉，这里不必管。
 */
export function normalizeAsrIdentity(m: Model): Model {
  if (m.asrFormat !== undefined && m.type !== "asr") return { ...m, type: "asr" };
  if (m.type === "asr" && m.asrFormat === undefined) return { ...m, asrFormat: ASR_FORMATS[0] };
  return m;
}

/**
 * 能拿来对话的模型 —— 任何"选一个模型来干活"的列表都该走这里。
 *
 * 翻译模型被排除掉，而且**排除是无条件的**：Sakura 问它「你是什么模型」会把
 * 问题改写一遍还回来（实测 E1），给它中译日会输出中文（E2）——都不报错，
 * 都看起来像结果。绑错它的代价不是一次失败，是一批看不出问题的坏输出。
 *
 * 不含 `enabled` 过滤：调用方对"停用的模型要不要出现"各有各的答案（设置里
 * 要，选择器里不要），而这个函数只回答"它能不能对话"这一个问题。
 */
export function conversationalModels(models: readonly Model[]): Model[] {
  // 转写模型同样无条件排除：它的端点收的是一个音频 URL，不是 messages，作为
  // 主模型会让对话在第一轮就死掉（asr 执行方案 §1 不变量 1）。
  return models.filter((m) => !isTranslateOnly(m) && !isAsrOnly(m));
}

/**
 * USD cost of one completion, accounting for the model's cheaper cached-input
 * rate. `cachedTokens` is a subset of `inputTokens` — both OpenAI's and
 * Gemini's usage reporting count it that way — so only the uncached
 * remainder bills at the full input rate.
 */
export function costFor(
  model: Model,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
): number {
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  return (
    (uncachedInput * model.priceIn + cachedTokens * model.priceCachedIn + outputTokens * model.priceOut) /
    1_000_000
  );
}

/**
 * USD cost of one image run. Two billing shapes exist and a model may use
 * either, so both are summed rather than switched between: `pricePerImage`
 * covers the per-image endpoints (xAI, Imagen), and the token terms cover the
 * providers that meter image generation as tokens (OpenAI's image models) and
 * report usage on the response. A model configures whichever applies; the
 * unset side contributes zero.
 *
 * Deliberately separate from `costFor` — folding two billing units into one
 * function makes both call sites read as if they know something they don't.
 */
export function imageCostFor(
  model: Model,
  images: number,
  usage?: { inputTokens: number; outputTokens: number },
): number {
  const perImage = (model.pricePerImage ?? 0) * Math.max(0, images);
  const perToken = usage
    ? (usage.inputTokens * model.priceIn + usage.outputTokens * model.priceOut) / 1_000_000
    : 0;
  return perImage + perToken;
}

/** Upper bound for the per-model context size setting (tokens). */
export const MAX_CONTEXT_SIZE = 2_000_000;

/** Upper bound for the per-model max-output setting (tokens). */
export const MAX_OUTPUT_SIZE = 262_144;

/**
 * Upper bound for the per-model sampling temperature.
 *
 * 2 rather than 1: OpenAI Chat Completions, Gemini and every OpenAI-compatible
 * relay accept up to 2, and the Anthropic path (whose own ceiling is 1) clamps
 * on its way to the wire rather than having the field refuse a legal value for
 * a model configured elsewhere.
 */
export const MAX_TEMPERATURE = 2;

export interface Prompt {
  id: string;
  name: string;
  content: string;
  /**
   * 'system' (selectable system prompt), a task id (overrides that task's
   * built-in instruction), or SNIPPET_SCENE (a reusable snippet the input
   * boxes offer for quick insertion — never auto-applied to anything).
   */
  scene: string;
  /**
   * Snippets only: the one section this snippet files under, or "" for the
   * 「未分组」 inbox that right-click saves land in. A *single* group rather
   * than tags — the picker reuses the model selector's section list, so the
   * organising axis costs no chip row, and the author answers one question
   * ("which shelf") instead of inventing a taxonomy. See
   * `docs/feature/prompt-snippets-ui-brief.md` → 开放问题 1.
   */
  group?: string;
  /** Snippets only: how many times it has been inserted (drives 「常用」). */
  useCount?: number;
  /** Snippets only: epoch ms of the last insertion; 0 / absent = never used. */
  lastUsedAt?: number;
}

/**
 * Scene value for quick-insert snippets. Deliberately not a task id — a
 * prompt with this scene overrides nothing; the input surfaces (自定义 task
 * box, chat) list it in their snippet picker instead.
 */
export const SNIPPET_SCENE = "snippet";

/**
 * `ALTER TABLE … ADD COLUMN`, skipped when the column is already there and
 * tolerant of losing the race to add it.
 *
 * "Read the columns, then add the missing ones" is not atomic, and this schema
 * check has historically run from more than one place. A second process (or a
 * second window) that added the column between the read and the write makes
 * SQLite answer `duplicate column name`, which is the outcome this function
 * was trying to produce anyway — so it is success, not failure.
 */
async function addColumn(
  db: Awaited<ReturnType<typeof Database.load>>,
  existing: { name: string }[],
  table: string,
  column: string,
  type: string,
): Promise<void> {
  if (existing.some((c) => c.name === column)) return;
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e))) throw e;
  }
}

export async function ensureAiSchema(db: Awaited<ReturnType<typeof Database.load>>) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_standard TEXT NOT NULL DEFAULT 'openai',
      safety_settings TEXT,
      auth_mode TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Migrations: columns added to providers after the table shipped.
  const providerCols = await db.select<{ name: string }[]>(`PRAGMA table_info(providers)`);
  await addColumn(db, providerCols, "providers", "safety_settings", "TEXT");
  await addColumn(db, providerCols, "providers", "auth_mode", "TEXT");
  await addColumn(db, providerCols, "providers", "sort_order", "INTEGER");
  // NULL = never saved since platforms existed; read as inferred from the
  // address (resolvePlatform), written the next time the drawer saves the row.
  await addColumn(db, providerCols, "providers", "platform", "TEXT");
  // Routes (channel-model-route-plan.md P1). NULL on a row saved before them:
  // read as the one route its base_url / api_standard describe (legacyEndpoint).
  await addColumn(db, providerCols, "providers", "host", "TEXT");
  await addColumn(db, providerCols, "providers", "endpoints", "TEXT");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      price_in REAL NOT NULL DEFAULT 0,
      price_cached_in REAL NOT NULL DEFAULT 0,
      price_out REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      prefix TEXT
    )
  `);

  // Migration: columns added to models after the table's first shipped shape.
  const modelCols = await db.select<{ name: string }[]>(`PRAGMA table_info(models)`);
  await addColumn(db, modelCols, "models", "prefix", "TEXT");
  await addColumn(db, modelCols, "models", "context_size", "INTEGER");
  await addColumn(db, modelCols, "models", "max_output", "INTEGER");
  await addColumn(db, modelCols, "models", "probed_at", "INTEGER");
  await addColumn(db, modelCols, "models", "price_per_image", "REAL");
  await addColumn(db, modelCols, "models", "caps", "TEXT");
  await addColumn(db, modelCols, "models", "reasoning_effort", "TEXT");
  await addColumn(db, modelCols, "models", "thinking_dialect", "TEXT");
  await addColumn(db, modelCols, "models", "thinking_category", "TEXT");
  await addColumn(db, modelCols, "models", "thinking_budget", "INTEGER");
  await addColumn(db, modelCols, "models", "server_tools", "TEXT");
  await addColumn(db, modelCols, "models", "pdf_input", "INTEGER");
  await addColumn(db, modelCols, "models", "temperature", "REAL");
  await addColumn(db, modelCols, "models", "translate_format", "TEXT");
  await addColumn(db, modelCols, "models", "structured_output", "TEXT");
  await addColumn(db, modelCols, "models", "asr_format", "TEXT");
  await addColumn(db, modelCols, "models", "price_per_second", "REAL");
  await addColumn(db, modelCols, "models", "probed_context_size", "INTEGER");
  await addColumn(db, modelCols, "models", "probed_max_output", "INTEGER");
  await addColumn(db, modelCols, "models", "text_verbosity", "TEXT");
  await addColumn(db, modelCols, "models", "vl_high_resolution", "INTEGER");
  await addColumn(db, modelCols, "models", "video_input", "INTEGER");
  await addColumn(db, modelCols, "models", "video_fps", "REAL");
  // P2: the route this model takes, and the other routes' parked fields.
  await addColumn(db, modelCols, "models", "active_route", "TEXT");
  await addColumn(db, modelCols, "models", "routes", "TEXT");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      scene TEXT NOT NULL DEFAULT 'system'
    )
  `);

  // Migration: the snippet library's three columns. `group` is a SQL keyword,
  // hence `grp` — the app-side field keeps the readable name.
  const promptCols = await db.select<{ name: string }[]>(`PRAGMA table_info(prompts)`);
  await addColumn(db, promptCols, "prompts", "grp", "TEXT");
  await addColumn(db, promptCols, "prompts", "use_count", "INTEGER");
  await addColumn(db, promptCols, "prompts", "last_used_at", "INTEGER");

}

// ─── Legacy plaintext key storage (migration only) ────────────────────────────
// Keys used to be stored in plaintext in the `api_keys` table. They now live in
// the OS keyring (see keyStore.ts). These helpers only exist so keyStore can
// migrate old rows out of the DB; no code path writes new keys here.

export async function loadLegacyKeyFromDb(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId: string,
): Promise<string | null> {
  const rows = await db.select<{ api_key: string }[]>(
    `SELECT api_key FROM api_keys WHERE provider_id = ?`,
    [providerId],
  );
  return rows[0]?.api_key ?? null;
}

export async function deleteLegacyKeyFromDb(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId: string,
): Promise<void> {
  await db.execute(`DELETE FROM api_keys WHERE provider_id = ?`, [providerId]);
}

/**
 * Every remaining plaintext key row.
 *
 * The per-provider lookup above only migrates a key when something asks for
 * that provider, so a provider the author stopped using keeps its key in
 * plaintext indefinitely — including after they deleted the provider from the
 * UI, since that path deletes the row it knows about and not one for an id it
 * no longer lists. Reading the whole table is what lets the migration finish
 * instead of trailing off (see `migrateLegacyKeys` in keyStore).
 */
export async function listLegacyKeyRows(
  db: Awaited<ReturnType<typeof Database.load>>,
): Promise<{ providerId: string; apiKey: string }[]> {
  const rows = await db.select<{ provider_id: string; api_key: string }[]>(
    `SELECT provider_id, api_key FROM api_keys`,
  );
  return rows
    .filter((r) => typeof r.provider_id === "string" && typeof r.api_key === "string" && r.api_key)
    .map((r) => ({ providerId: r.provider_id, apiKey: r.api_key }));
}

/**
 * Remove the legacy table itself.
 *
 * Emptying it is not enough: a deleted SQLite row leaves its bytes in the page
 * until something overwrites them, so the keys stay recoverable from the file
 * with a hex editor. Dropping the table and vacuuming rewrites the database
 * without them. VACUUM cannot run inside a transaction and may fail on a
 * database another window holds open — that is a cleanup shortfall, not a
 * migration failure, so it is tolerated separately.
 */
export async function dropLegacyKeyTable(
  db: Awaited<ReturnType<typeof Database.load>>,
): Promise<void> {
  await db.execute(`DROP TABLE IF EXISTS api_keys`);
  try {
    await db.execute("VACUUM");
  } catch (e) {
    console.warn("[configDb] dropped api_keys but could not VACUUM:", e);
  }
}

export async function listProviders(db: Awaited<ReturnType<typeof Database.load>>): Promise<Provider[]> {
  // Explicitly ordered rows first, in their order; never-moved rows (NULL)
  // after them, oldest first — see Provider.sortOrder.
  const rows = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, base_url, api_standard, safety_settings, auth_mode, sort_order, platform, host, endpoints, created_at FROM providers ORDER BY (sort_order IS NULL) ASC, sort_order ASC, created_at ASC"
  );
  return rows.map(rowToProvider);
}

/**
 * One stored provider row → a normalized channel. Shared with the config
 * restore's reader in spirit (it builds the same shape from a backup and runs
 * the same `readChannel`), so a pre-routes row and a pre-routes backup become
 * the same channel.
 */
function rowToProvider(r: Record<string, unknown>): Provider {
  const baseUrl = typeof r.base_url === "string" ? r.base_url : "";
  const apiStandard = migrateLegacyStandard(parseApiStandard(r.api_standard), baseUrl);
  return readChannel({
    id: r.id as string,
    name: r.name as string,
    baseUrl,
    // Re-labels pre-split rows (see migrateLegacyStandard); the row itself is
    // rewritten only when the author next saves the provider.
    apiStandard,
    safetySettings: parseSafetySettings(r.safety_settings),
    authMode: parseAuthMode(r.auth_mode, apiStandard),
    platform: parsePlatform(r.platform),
    host: typeof r.host === "string" ? r.host : undefined,
    endpoints: parseEndpoints(r.endpoints),
    sortOrder: typeof r.sort_order === "number" ? r.sort_order : undefined,
    createdAt: r.created_at as number,
  }, writtenBaseOf(r.endpoints));
}

/**
 * The read-side normalization of a channel, from whatever it was stored as.
 *
 * Three shapes arrive here: a row with routes; a row from before routes (no
 * `endpoints`) — its one route is the legacy columns (`legacyEndpoint`), with
 * the path stored only where it differs from the platform's convention, so no
 * request changes (plan §5.2); and a row with routes that an **older build**
 * edited since — it rewrote base_url / api_standard and knows nothing of
 * routes, so its edit is the newer truth for the primary route, which is
 * rebuilt from the columns while the other routes stay.
 */
export function readChannel(p: Provider, writtenBase?: string): Provider {
  let endpoints = p.endpoints;
  let host = p.host;
  // With the marker, "diverged" means the columns changed since this build
  // wrote them — not that today's platform table computes another address,
  // which is exactly what a route with no stored path is supposed to follow.
  const diverged = endpoints?.length
    ? writtenBase !== undefined
      ? writtenBase !== p.baseUrl || standardOf(endpoints[0]) !== p.apiStandard
      : legacyColumnsDiverged({ ...p, host }, endpoints)
    : false;
  if (endpoints?.length && diverged) {
    const legacy = legacyEndpoint(p);
    endpoints = [legacy.endpoint, ...endpoints.slice(1).filter((e) => e.family !== legacy.endpoint.family)];
    host = legacy.host || host;
  }
  return normalizeChannel({ ...p, host, endpoints });
}

const API_STANDARDS: ApiStandard[] = [
  "openai",
  "openai_compat",
  "openai_responses",
  "openai_responses_compat",
  "gemini",
  "gemini_compat",
  "anthropic",
  "anthropic_compat",
];

/**
 * Narrow a stored `api_standard` to the union instead of asserting it.
 *
 * The column is free text: rows predate the current names, backups and hand
 * edits land here unchecked, and a bare `as ApiStandard` hands the rest of the
 * app a value no `switch` covers. Anything unrecognised becomes
 * `openai_compat`, which is where the dispatch sent it anyway (everything
 * that is not `gemini` takes the OpenAI adapter) — so this narrows the type
 * without changing which adapter a provider talks to.
 */
function parseApiStandard(raw: unknown): ApiStandard {
  return API_STANDARDS.includes(raw as ApiStandard) ? (raw as ApiStandard) : "openai_compat";
}

/**
 * Narrow a stored `auth_mode`, and drop one the standard can't use.
 *
 * The second half matters when a provider is switched from compat back to
 * official: the row keeps its old `bearer`, and honouring that on
 * api.anthropic.com sends a credential it rejects. Reading it against the
 * standard means the stale value is inert rather than breaking the request.
 */
function parseAuthMode(raw: unknown, standard: ApiStandard): AuthMode | undefined {
  const allowed = authModesFor(standard);
  return allowed.includes(raw as AuthMode) ? (raw as AuthMode) : undefined;
}

function parseSafetySettings(raw: unknown): GeminiSafetySettings | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw) as GeminiSafetySettings;
  } catch {
    return undefined;
  }
}

/**
 * The write for one provider, as a statement rather than an execution.
 *
 * Split out so the config restore can hand the whole batch to `sqlTransaction`
 * (which runs it on one connection, atomically) without restating the columns
 * — the schema stays described in exactly one place. Same for the model and
 * prompt builders below.
 */
export function providerUpsert(p: Provider): SqlStatement {
  const c = normalizeChannel(p);
  // A real upsert, NOT `INSERT OR REPLACE`: that is a DELETE followed by an
  // INSERT, and `models.provider_id` declares `ON DELETE CASCADE`. sqlx (which
  // backs tauri-plugin-sql) connects with `foreign_keys = ON` by default, so
  // renaming a provider — or importing a config over an existing one — would
  // take every model configured under it with it. `created_at` is deliberately
  // left out of the update: editing a provider must not re-date it.
  return {
    sql: `INSERT INTO providers (id, name, base_url, api_standard, safety_settings, auth_mode, sort_order, platform, host, endpoints, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       base_url = excluded.base_url,
       api_standard = excluded.api_standard,
       safety_settings = excluded.safety_settings,
       auth_mode = excluded.auth_mode,
       sort_order = excluded.sort_order,
       platform = excluded.platform,
       host = excluded.host,
       endpoints = excluded.endpoints`,
    values: [
      c.id,
      c.name,
      // The legacy columns hold the primary route, always — an older build
      // reading this row talks to exactly what this one's primary route does.
      c.baseUrl,
      c.apiStandard,
      c.safetySettings ? JSON.stringify(c.safetySettings) : null,
      c.authMode ?? null,
      c.sortOrder ?? null,
      // Only a platform the address doesn't already name (platformToStore):
      // an inferred one is left NULL so it keeps following the table.
      platformToStore(c) ?? null,
      c.host ?? null,
      // The primary route carries the base_url written beside it, so a read can
      // tell an older build's edit to the columns (they no longer match) from a
      // platform convention that moved since (they still do) — routes.ts
      // `writtenBaseOf`.
      JSON.stringify(c.endpoints!.map((e, i) => (i === 0 ? { ...e, writtenBase: c.baseUrl } : e))),
      c.createdAt,
    ],
  };
}

/**
 * One provider's new list position. The reorder actions batch these — one per
 * provider, whole list at once — through `sqlTransaction`, so a crash mid-way
 * can't leave two providers claiming one slot.
 */
export function providerOrderUpdate(id: string, sortOrder: number): SqlStatement {
  return {
    sql: `UPDATE providers SET sort_order = ? WHERE id = ?`,
    values: [sortOrder, id],
  };
}

export async function saveProvider(
  db: Awaited<ReturnType<typeof Database.load>>,
  p: Provider
): Promise<void> {
  const { sql, values } = providerUpsert(p);
  await db.execute(sql, values);
}

export async function deleteProvider(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
  // Delete the dependent model rows explicitly rather than relying on the
  // declared `ON DELETE CASCADE`: whether SQLite enforces it depends on a
  // per-connection `PRAGMA foreign_keys`, which nothing in this app sets — it
  // is whatever the driver happens to default to. Doing it here makes the
  // outcome the same either way, instead of leaving orphan rows that reappear
  // on the next launch if the default ever changes.
  await db.execute("DELETE FROM models WHERE provider_id = ?", [id]);
  await db.execute("DELETE FROM providers WHERE id = ?", [id]);
}

export async function listModels(
  db: Awaited<ReturnType<typeof Database.load>>,
  providerId?: string
): Promise<Model[]> {
  const sql = providerId
    ? "SELECT * FROM models WHERE provider_id = ? ORDER BY name ASC"
    : "SELECT * FROM models ORDER BY name ASC";
  const args = providerId ? [providerId] : [];
  const rows = await db.select<Record<string, unknown>[]>(sql, args);
  return rows.map(rowToModel);
}

export function modelUpsert(m: Model): SqlStatement {
  return {
    sql: `INSERT OR REPLACE INTO models
      (id, provider_id, model_id, name, type, price_in, price_cached_in, price_out, enabled, prefix, context_size, max_output, probed_at, price_per_image, caps, reasoning_effort, thinking_dialect, thinking_category, thinking_budget, server_tools, pdf_input, temperature, translate_format, structured_output, probed_context_size, probed_max_output, asr_format, price_per_second, text_verbosity, vl_high_resolution, video_input, video_fps, active_route, routes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // The flat columns are the current route's (lib/ai/routes.ts), which is
    // also all an older build reads; the other routes ride in `routes`.
    values: [m.id, m.providerId, m.modelId, m.name, m.type, m.priceIn, m.priceCachedIn, m.priceOut, m.enabled ? 1 : 0, m.prefix ?? null, m.contextSize ?? null, m.maxOutput ?? null, m.probedAt ?? null, m.pricePerImage ?? null, m.caps ? JSON.stringify(m.caps) : null, m.reasoningEffort ?? null, m.thinkingDialect ?? null, m.thinkingCategory ?? null, m.thinkingBudget ?? null, m.serverTools?.length ? JSON.stringify(m.serverTools) : null, m.pdfInput ? 1 : null, m.temperature ?? null, m.translateFormat ?? null, m.structuredOutput ?? null, m.probedContextSize ?? null, m.probedMaxOutput ?? null, m.asrFormat ?? null, m.pricePerSecond ?? null, m.textVerbosity ?? null, m.vlHighResolution ? 1 : null, m.videoInput ? 1 : null, m.videoFps ?? null, m.activeRoute ?? null, m.routes && Object.keys(m.routes).length ? JSON.stringify(m.routes) : null],
  };
}

export async function saveModel(
  db: Awaited<ReturnType<typeof Database.load>>,
  m: Model
): Promise<void> {
  const { sql, values } = modelUpsert(m);
  await db.execute(sql, values);
}

export async function deleteModel(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
  await db.execute("DELETE FROM models WHERE id = ?", [id]);
}

export async function listPrompts(
  db: Awaited<ReturnType<typeof Database.load>>
): Promise<Prompt[]> {
  const rows = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, content, scene, grp, use_count, last_used_at FROM prompts ORDER BY name ASC"
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    content: r.content as string,
    scene: r.scene as string,
    group: (r.grp as string | null) ?? "",
    useCount: (r.use_count as number | null) ?? 0,
    lastUsedAt: (r.last_used_at as number | null) ?? 0,
  }));
}

export function promptUpsert(p: Prompt): SqlStatement {
  return {
    sql: `INSERT OR REPLACE INTO prompts (id, name, content, scene, grp, use_count, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    values: [p.id, p.name, p.content, p.scene, p.group ?? "", p.useCount ?? 0, p.lastUsedAt ?? 0],
  };
}

export async function savePrompt(
  db: Awaited<ReturnType<typeof Database.load>>,
  p: Prompt
): Promise<void> {
  const { sql, values } = promptUpsert(p);
  await db.execute(sql, values);
}

export async function deletePrompt(
  db: Awaited<ReturnType<typeof Database.load>>,
  id: string
): Promise<void> {
  await db.execute("DELETE FROM prompts WHERE id = ?", [id]);
}

function rowToModel(r: Record<string, unknown>): Model {
  return normalizeAsrIdentity({
    id: r.id as string,
    providerId: r.provider_id as string,
    modelId: r.model_id as string,
    name: r.name as string,
    type: parseModelType(r.type),
    priceIn: r.price_in as number,
    priceCachedIn: r.price_cached_in as number,
    priceOut: r.price_out as number,
    enabled: (r.enabled as number) === 1,
    prefix: (r.prefix as string | null) ?? undefined,
    contextSize: (r.context_size as number | null) ?? undefined,
    maxOutput: (r.max_output as number | null) ?? undefined,
    // Absent unless a real number is stored — see Model.temperature on why 0
    // must survive as a value rather than collapsing into "unset".
    temperature: typeof r.temperature === "number" ? r.temperature : undefined,
    probedAt: (r.probed_at as number | null) ?? undefined,
    probedContextSize: typeof r.probed_context_size === "number" ? r.probed_context_size : undefined,
    probedMaxOutput: typeof r.probed_max_output === "number" ? r.probed_max_output : undefined,
    pricePerImage: (r.price_per_image as number | null) ?? undefined,
    caps: parseImageCaps(r.caps),
    reasoningEffort: parseReasoningEffort(r.reasoning_effort),
    thinkingDialect: parseThinkingDialect(r.thinking_dialect),
    thinkingCategory: parseThinkingCategory(r.thinking_category),
    thinkingBudget: typeof r.thinking_budget === "number" ? r.thinking_budget : undefined,
    serverTools: parseServerTools(r.server_tools),
    // Absent for anything but an explicit 1 — the column is free-typed like
    // the rest, and "no declaration" must stay one representation.
    pdfInput: r.pdf_input === 1 ? true : undefined,
    vlHighResolution: r.vl_high_resolution === 1 ? true : undefined,
    videoInput: r.video_input === 1 ? true : undefined,
    videoFps: clampVideoFps(r.video_fps),
    textVerbosity: parseTextVerbosity(r.text_verbosity),
    translateFormat: parseTranslateFormat(r.translate_format),
    structuredOutput: parseStructuredOutputMode(r.structured_output),
    asrFormat: parseAsrFormat(r.asr_format),
    pricePerSecond: typeof r.price_per_second === "number" ? r.price_per_second : undefined,
    activeRoute: parseRouteFamily(r.active_route),
    routes: parseRouteProfiles(r.routes),
  });
}

/**
 * Every type, in the order the drawer's chips and the list filter show them.
 * One list: the drawer, the filter and both readers (this file, configTransfer)
 * used to keep their own copies, and a type added to one of four is a row that
 * saves fine and reads back as "text".
 */
export const MODEL_TYPES: readonly ModelType[] = ["text", "multimodal", "vision", "image", "video", "asr"];

/**
 * Narrow a stored `type` to the union instead of asserting it, for the same
 * reason `parseApiStandard` exists next door: the column is free text, and an
 * unrecognised value made the model vanish from *both* the text and the image
 * pickers with nothing on screen to say why. "text" is where a model with no
 * declared type belonged before the column existed.
 *
 * An older build reading a newer row therefore sees `vision` as `text` (it
 * loses image input until retyped) and `asr` as `text` — which stays out of the
 * chat pickers there anyway, because that build still keys on `asrFormat`.
 */
export function parseModelType(raw: unknown): ModelType {
  return MODEL_TYPES.includes(raw as ModelType) ? (raw as ModelType) : "text";
}

/** Every declared format, for the settings drawer to render. */
export const TRANSLATE_FORMATS: readonly TranslateFormat[] = ["sakura"];

/**
 * Narrow a stored `translate_format`, same as `parseModelType` next door — but
 * the fallback is the opposite direction. An unrecognised value must read as
 * "not a translation model", never as a guess: getting it wrong the other way
 * would silently exclude an ordinary model from every picker in the app.
 */
export function parseTranslateFormat(raw: unknown): TranslateFormat | undefined {
  return TRANSLATE_FORMATS.includes(raw as TranslateFormat) ? (raw as TranslateFormat) : undefined;
}

/**
 * Every declared transcription format, for the settings drawer to render.
 * The first one is the default `normalizeAsrIdentity` fills into a formatless
 * `asr` row — it stays filetrans, because every such row predates the sync
 * format and was bound to a *-filetrans id.
 */
export const ASR_FORMATS: readonly AsrFormat[] = ["dashscope-filetrans", "dashscope-sync"];

/**
 * Same direction as `parseTranslateFormat`: an unrecognised value must read as
 * "not a transcription model" — wrong that way it becomes a usable ordinary
 * model, wrong the other way it vanishes from every picker.
 */
export function parseAsrFormat(raw: unknown): AsrFormat | undefined {
  return ASR_FORMATS.includes(raw as AsrFormat) ? (raw as AsrFormat) : undefined;
}

/**
 * The values this build can honour. Records rather than arrays so that adding a
 * member to either union fails `tsc` here until it is listed — an unlisted value
 * would otherwise be dropped from every stored model the day it ships.
 */
const IMAGE_ROUTES: Record<ImageRoute, true> = {
  "images-api": true, chat: true, gemini: true, dashscope: true, comfyui: true,
};
const IMAGE_DIALECT_IDS: Record<ImageDialect, true> = {
  nanobanana: true, "gpt-image-2": true, "wan2.7": true, "qwen-image": true,
};

const listed = (table: object, v: unknown): boolean =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(table, v);

/**
 * Narrow an image model's `caps` — the stored JSON text, or the object a backup
 * carries — field by field. Shared by the DB read and `parseConfigBundle`.
 *
 * Every consumer reads these fields without a second check (`caps.sizes.join`
 * in the model drawer, `.map` in the image modal, `comfy.workflow` parsed as
 * text), so a cast here turned a hand-edited backup into a crash on a page far
 * from the restore. A field this build cannot read degrades to absent on its
 * own; nothing readable at all → no caps. See config-backup-plan.md §5.5.
 */
export function parseImageCaps(raw: unknown): ImageCaps | undefined {
  let value = raw;
  if (typeof raw === "string") {
    if (!raw) return undefined;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;

  const caps: ImageCaps = {};
  if (typeof r.edit === "boolean") caps.edit = r.edit;
  if (listed(IMAGE_DIALECT_IDS, r.dialect)) caps.dialect = r.dialect as ImageDialect;
  // An empty list is kept: it means "send no size", which absent does not.
  if (Array.isArray(r.sizes)) {
    caps.sizes = r.sizes.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  if (typeof r.maxRefs === "number" && Number.isInteger(r.maxRefs) && r.maxRefs > 0) {
    caps.maxRefs = r.maxRefs;
  }
  if (listed(IMAGE_ROUTES, r.route)) caps.route = r.route as ImageRoute;
  if (typeof r.asyncTask === "boolean") caps.asyncTask = r.asyncTask;
  const comfy = r.comfy as Record<string, unknown> | null | undefined;
  if (comfy && typeof comfy === "object" && typeof comfy.workflow === "string") {
    caps.comfy = { workflow: comfy.workflow };
  }
  return Object.keys(caps).length ? caps : undefined;
}
