/**
 * What each platform was measured to do, keyed platform × protocol family ×
 * capability, with model-id rows as the third axis — and what each platform
 * knows about its own model ids (the values a new row of that id starts with).
 * Where each entry comes from is the platform's `source` line in `platforms.ts`.
 */

import type { ProtocolFamily } from "../../types";
import type { PlatformId } from "../../platforms";
import type { CapabilityId, ValueFactId, ValueFactMap } from "../facts";
import { bySpecificity, eq, rawModelKey, rowSetting, type ModelPattern } from "../modelId";

/**
 * A family block's answer for a capability, for every model on the wire:
 * `true` = measured working, `false` = measured absent (refused, or accepted
 * and ignored).
 *
 * `"per-model"`: the platform runs it for the ids its `models` rows name
 * (`true`) and not for the ids they refuse (`false`). An id no row names is
 * `unknown / model-unlisted` — offered and sent, the drawer saying it is
 * unmeasured (capability-gating-plan §8.7: the platform has the tool, so a
 * model the list hasn't caught up with gets the switch rather than losing it).
 * With no id typed yet the answer is `yes`: the platform does run it.
 *
 * A block with rows for a capability and no value for it only singles ids out:
 * an id a row refuses is `no / model`, every other id — or a blank one — falls
 * to the protocol rule, as if the block said nothing (§8.10).
 */
type FlagCell = boolean | "per-model";

/** What a platform knows about one of its model ids besides its capabilities. */
type PlatformValueFacts = Partial<ValueFactMap>;

/**
 * The values a model row should start with when the author adds that id. The
 * model drawer writes these into the form (only into fields the author has not
 * touched), and since capability-resolution P6 the same values are also the
 * runtime default of a row that leaves the field unset
 * (`capability/values.ts`, D1) — so a row saved before a platform's rows
 * existed gets them too.
 *
 * It exists because the family default is wrong for a whole platform: on 智谱
 * the ① family's `reasoning_effort` fails silently on every one of eleven
 * models, in three different ways (docs/api/zhipu-plan.md G11).
 */
interface ModelCalibration extends PlatformValueFacts {
  /** Absent = the drawer's own default (`text`). */
  type?: "multimodal";
  pdfInput?: true;
}

/**
 * One model-id row. Platform rows match {@link rawModelKey} — the id as the
 * platform serves it, namespace included (`openai/gpt-6-astra`).
 */
interface PlatformModelRow {
  match: ModelPattern;
  /** Capabilities for these ids (`true` runs, `false` refused or ignored), and the ids' values. */
  set: Partial<Record<CapabilityId, boolean>> & PlatformValueFacts;
  /**
   * Prefill-only declarations: `type` has no "unset" on a model row, and
   * `pdfInput` is the author's declaration rather than a wire capability — as a
   * capability row it would turn these ids' verdict reason from `protocol` to
   * `measured`.
   */
  prefill?: { type?: "multimodal"; pdfInput?: true };
}

type FamilyCells = Partial<Record<CapabilityId, FlagCell>> & {
  /** Model-id rows, consulted in `bySpecificity` order. */
  models?: readonly PlatformModelRow[];
  /**
   * Responses only: `include` entries the route must ask for. Only for what a
   * platform withholds unless asked: xAI returns a reasoning item's
   * `encrypted_content` only on request, and the echo without it still 200s —
   * the next turn just silently starts its reasoning over (landscape.md §7
   * 第十一个样本). Absent = send no `include`, which is what the relays that
   * attach it unasked were measured with (responses.md §2.4).
   */
  responsesInclude?: readonly string[];
};

interface PlatformCells {
  /**
   * No host of its own — the author types the address, and whatever is behind
   * it may be any of the platforms above. Private fields marked `relay` are
   * offered at `unknown` here.
   */
  relay?: true;
  /** `all` applies to every family and is overridden by a family's own entry. */
  families?: Partial<Record<ProtocolFamily | "all", FamilyCells>>;
}

/** A released id's tail: nothing, a date stamp, a four-digit snapshot, or `-preview`. */
const SNAPSHOT = String.raw`(?:-(?:\d{4}-\d{2}-\d{2}|\d{4}|preview))?`;

const refuses = (id: CapabilityId, patterns: readonly RegExp[]): PlatformModelRow[] =>
  patterns.map((match) => ({ match, set: { [id]: false } }));
const runs = (id: CapabilityId, patterns: readonly RegExp[]): PlatformModelRow[] =>
  patterns.map((match) => ({ match, set: { [id]: true } }));

/**
 * Which model ids run DashScope's code interpreter, per wire — the vendor's
 * list (developer-guides/tool-calling/code-interpreter) as id patterns,
 * corrected by a sweep over the live model list on 2026-09-17 (landscape.md §7
 * 第六个样本「代码解释器」).
 *
 *   - **Both wires**: `qwen3-max` and its dated snapshots (not
 *     `qwen3-max-preview` — refused on Responses, silently ignored on Chat
 *     Completions); the 3.5 / 3.6 / 3.7 generation's plus / max / flash; the
 *     3.5 open-weight models (`qwen3.5-397b-a17b`, `qwen3.5-27b`).
 *   - **Responses only**: the 3.8 generation (Chat Completions answers
 *     `does not support the code_interpreter tool` for qwen3.8-flash / -max /
 *     -27b), the 3.6 open-weight models except `qwen3.6-27b` (`Unsupported
 *     model`), and DeepSeek V4 as DashScope serves it.
 *
 * The running patterns are deliberately anchored: `qwen3.5-omni-plus`,
 * `qwen3-vl-plus`, `qwen3.8-livetranslate-flash-realtime` share a prefix and
 * are not in them. The refusing rows hold only what a sample saw fail — a 400,
 * `Unsupported model`, or (Chat Completions) a silent ignore — and are listed
 * first, so a refusal wins over a pattern that also matches. Everything else,
 * including a generation after 3.8, is `unknown`: the switch is offered and
 * says it is unmeasured. The running patterns grow when the vendor's page adds
 * a model to its list (plan §8.7); where that page and a sample disagree, the
 * sample wins.
 */
const DASHSCOPE_CODE_INTERPRETER: Record<"openai" | "responses", readonly PlatformModelRow[]> = {
  openai: [
    ...refuses("code_interpreter", [
      // Silently ignored — the reason this wire is gated by id at all.
      /^qwen3-max-preview$/, /^qwen-max$/, /^qwen3\.5-omni-plus$/,
      // `does not support the code_interpreter tool` for flash, max and 27b alike.
      /^qwen3\.8-/,
    ]),
    ...runs("code_interpreter", [
      /^qwen3-max(?:-\d{4}-\d{2}-\d{2})?$/,
      new RegExp(`^qwen3\\.[5-7]-(?:plus|max|flash)${SNAPSHOT}$`),
      /^qwen3\.5-\d+b(?:-a\d+b)?$/,
    ]),
  ],
  responses: [
    ...refuses("code_interpreter", [
      /^qwen3-max-preview$/, /^qwen3\.6-27b$/, /^qwen-plus$/, /^qwen3\.5-omni-plus$/,
      /^qwen3-vl-plus$/, /^qwen3-235b-a22b-thinking-2507$/,
    ]),
    ...runs("code_interpreter", [
      /^qwen3-max(?:-\d{4}-\d{2}-\d{2})?$/,
      new RegExp(`^qwen3\\.[5-8]-(?:plus|max|flash)${SNAPSHOT}$`),
      /^qwen3\.(?:5|8)-[\d.]+[bt](?:-a\d+b)?$/,
      /^qwen3\.6-(?!27b$)\d+b(?:-a\d+b)?$/,
      /^deepseek-v4(?:\.\d+)?-(?:pro|flash)(?:-\d{4})?$/,
    ]),
  ],
};

/**
 * DashScope's private vocabulary, shared by the domestic and international
 * deployments. Measured on the domestic host; the international host serves the
 * same compatible-mode and `/responses` surfaces.
 */
const DASHSCOPE: PlatformCells = {
  families: {
    // `enable_search` (+ `search_options.search_strategy: agent_max` for page
    // reading) and `enable_code_interpreter` — top-level body fields.
    openai: {
      // The platform's own list (Qwen 3.7 / 3.8), and GLM / DeepSeek / Kimi
      // strict on this host too (qianwen-compat-plan.md P7).
      jsonSchema: true,
      web_search: true,
      web_extractor: true,
      code_interpreter: "per-model",
      vlHighResolution: true,
      // A clip read, and `fps` changes the bill (第六个样本「视觉理解」, 第十九个样本).
      videoInput: true,
      videoFps: true,
      models: DASHSCOPE_CODE_INTERPRETER.openai,
    },
    // Built-in `tools[]` entries; the two image searches exist on this wire only.
    responses: {
      web_search: true,
      web_extractor: true,
      web_search_image: true,
      image_search: true,
      code_interpreter: "per-model",
      models: DASHSCOPE_CODE_INTERPRETER.responses,
    },
  },
};

/** A calibration row: one exact id, its values, and what the drawer prefills beside them. */
const cal = (
  id: string,
  set: PlatformValueFacts,
  prefill?: PlatformModelRow["prefill"],
): PlatformModelRow => ({ match: eq(id), set, ...(prefill ? { prefill } : {}) });
const MULTIMODAL = { type: "multimodal" } as const;
const MULTIMODAL_PDF = { type: "multimodal", pdfInput: true } as const;

/**
 * 智谱's eleven chat models, all measured 2026-09-19 (landscape.md §7 第十四个样本
 * 「逐模型校准」). Three thinking controls: the 5.3 generation cannot stop and
 * takes low/high/max (`glm`); 5.2 stops only via the switch and has two real
 * levels (`glm-effort`); everything older ignores reasoning_effort (`glm-switch`).
 * Output caps are the measured `max_tokens` bounds, except glm-4.5 — it
 * accepts 131,072 but its documented cap is 96K, and the lower number never 400s.
 */
const GLM_1M = 1_048_576;
const GLM_200K = 204_800;
const GLM_128K = 131_072;
const ZHIPU_MODELS: readonly PlatformModelRow[] = [
  cal("glm-5.3", { thinkingCategory: "glm", contextSize: GLM_1M, maxOutput: 131_072 }),
  cal("glm-5.3-flash", { thinkingCategory: "glm", contextSize: GLM_1M, maxOutput: 131_072 }, MULTIMODAL_PDF),
  cal("glm-5.3-flashx", { thinkingCategory: "glm", contextSize: GLM_1M, maxOutput: 131_072 }, MULTIMODAL_PDF),
  cal("glm-5.2", { thinkingCategory: "glm-effort", contextSize: GLM_1M, maxOutput: 131_072 }),
  cal("glm-5.1", { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 }),
  cal("glm-5", { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 }),
  cal("glm-5-turbo", { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 }),
  cal("glm-4.7", { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 }),
  cal("glm-4.6", { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 }),
  cal("glm-4.5", { thinkingCategory: "glm-switch", contextSize: GLM_128K, maxOutput: 98_304 }),
  cal("glm-4.5-air", { thinkingCategory: "glm-switch", contextSize: GLM_128K, maxOutput: 98_304 }),
];

/**
 * DeepSeek's two listed models (landscape.md §2.1, `/models` 2026-09-17). The
 * `deepseek` category is the point: the family default spells off as
 * `reasoning_effort:"none"`, which DeepSeek does not read as off — its off is
 * the `thinking:{type:"disabled"}` switch (qianwen-compat-plan.md P1). Without
 * this a hand-added row thought on after the author pressed 关.
 */
const DEEPSEEK_MODELS: readonly PlatformModelRow[] = [
  cal("deepseek-flash", { thinkingCategory: "deepseek", contextSize: 1_048_576, maxOutput: 393_216 }, MULTIMODAL),
  cal("deepseek-v4-pro", { thinkingCategory: "deepseek", contextSize: 1_048_576, maxOutput: 393_216 }),
];

/**
 * OrcaRouter's ten paid models measured 2026-09-26 / -27 (landscape.md §7
 * 第十八个样本, its 再补测 and GPT 全家补测). Context and output caps are the
 * catalog's own `context_length` / `max_completion_tokens` (`GET /v1/models`).
 * Every one lists `file` among its input modalities; PDF was read end to end on
 * all six GPT ids (① ②), sonnet-5 and opus-5.5 (④) and gemini-3.8-flash (③).
 * No thinking category: each route's family default is the one the sample
 * measured with. The free tier is not here: its values are the relay's own
 * model pages, not a sample, so they stay starter-row recommendations
 * (ProviderDrawer.tsx) — calibration rows are only for ids a sample measured.
 */
const ORCA_OPENAI = { contextSize: 1_050_000, maxOutput: 128_000 } as const;
const ORCA_CLAUDE = { contextSize: 1_000_000, maxOutput: 128_000 } as const;
const ORCAROUTER_MODELS: readonly PlatformModelRow[] = [
  ...["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]
    .map((id) => cal(`openai/${id}`, ORCA_OPENAI, MULTIMODAL_PDF)),
  ...["claude-sonnet-5", "claude-opus-5.5", "claude-fable-5.1"]
    .map((id) => cal(`anthropic/${id}`, ORCA_CLAUDE, MULTIMODAL_PDF)),
  cal("google/gemini-3.8-flash", { contextSize: 1_048_576, maxOutput: 65_536 }, MULTIMODAL_PDF),
];

/**
 * 火山方舟 Agent / Coding Plan's Doubao Seed trio (套餐概览, 2026-09-17: 256k
 * window; 128k cap, 256k for 2.1-turbo). All three are typed multimodal and
 * declared PDF readers because the sample read a picture and a PDF on both of
 * the plan's routes (docs/api/landscape.md §7 第十二个样本). Their thinking is the
 * `doubao` category on Chat and `doubao-switch` on the Anthropic route (that
 * family's block): the endpoint defaults to thinking, so without a declared off
 * the author could not turn it down on either.
 */
const DOUBAO: readonly (readonly [id: string, maxOutput: number])[] = [
  ["doubao-seed-2.0-lite", 131_072],
  ["doubao-seed-2.0-mini", 131_072],
  ["doubao-seed-2.1-turbo", 262_144],
];

/**
 * `newapi` and `custom` alike: a New API relay lands on `custom` unless the
 * author picks New API. What differs is the upstream behind each model, which
 * {@link UPSTREAM_CELLS} answers. A cell here would hold for every
 * upstream; the relay's Chat→Messages conversion has two such gaps
 * (`response_format` dropped, `reasoning_effort: "max"` = no thinking), but one
 * New API was sampled, so they wait for a second
 * (docs/issues/relay-claude-channel-gating.md).
 */
const RELAY: PlatformCells = { relay: true };

/** A local server: the protocol's own tools are known absent, not unmeasured. */
const LOCAL: PlatformCells = {
  families: { all: { web_search: false } },
};

/**
 * The platforms' side — only what a sample measured. Where each entry comes
 * from is the platform's `source` line in `platforms.ts`.
 *
 * An absent cell is not "no": it falls to {@link CAPABILITY_RULES} (protocol
 * default for a native capability, `no` for a private one). Write `false` only
 * for something measured absent.
 */
export const PLATFORM_CELLS: Record<PlatformId, PlatformCells> = {
  // Chat Completions: no server tool (official rejects unknown top-level fields).
  // `effortWithTools`: from GPT-5.4 on (OpenAI's own words, reached through
  // OrcaRouter's verbatim route — 第十八个样本「GPT 全家补测」; responses.md §7).
  openai: {
    families: {
      all: { jsonSchema: true },
      openai: {
        web_search: false,
        models: refuses("effortWithTools", [/^gpt-5\.[4-9](?:[.-]|$)/]),
      },
      // `temperature`: gpt-5.6-sol's Responses refuses it outright (`Unsupported
      // parameter: 'temperature' is not supported with this model.`) — the same
      // OpenAI body OrcaRouter hands back verbatim (GPT 全家补测).
      responses: {
        web_search: true,
        models: refuses("temperature", [/^gpt-5\.6-sol$/]),
      },
    },
  },
  // `output_config.format`: GA per Anthropic; held a contradicted enum on five
  // Claude models behind OrcaRouter's verbatim Anthropic route (第十八个样本，补测).
  // `document` block: read end to end on sonnet-5 and opus-5.5 behind that same
  // verbatim route (第十八个样本「再补测」) — the reading is the model's, and the
  // vendor documents the block.
  anthropic: { families: { anthropic: { web_search: true, jsonSchema: true, pdfInput: true } } },
  // `responseJsonSchema`, Gemini 2.5 on (structured-output-plan.md).
  google: { families: { gemini: { jsonSchema: true } } },
  // Chat Completions: none. Its Anthropic-shaped path stays at the protocol's
  // `unknown` — unmeasured, not known absent. A `video_url` part: 422, the
  // error naming it as no accepted variant (第十九个样本).
  deepseek: { families: { all: { models: DEEPSEEK_MODELS }, openai: { web_search: false, videoInput: false } } },
  dashscope: DASHSCOPE,
  "dashscope-intl": DASHSCOPE,
  // json_schema with `strict:true`: 200, output matches (第十一个样本).
  // web_search measured on grok-4.3; web_extractor and the image searches are
  // DashScope's names and are refused (no cell: private, so `no`).
  // A `video_url` part on Chat Completions: 400 `Empty content block` (第十九个样本).
  xai: {
    families: {
      openai: { videoInput: false },
      responses: { web_search: true, jsonSchema: true, responsesInclude: ["reasoning.encrypted_content"] },
    },
  },
  minimax: { families: { anthropic: { web_search: true } } },
  volcengine: {},
  // The first platform whose Anthropic `document` block was seen reaching the
  // model (landscape.md §7 第十二个样本); Anthropic's own and OrcaRouter's
  // verbatim route followed (第十八个样本「再补测」).
  // json_schema: an enum the prompt contradicts held on 2.1-turbo — ① with
  // `strict:true`, ② on this app's `text.format` without it. The wire takes
  // it; 2.0-lite does not (both routes answered past the schema), which is
  // why the model catalog's `strictSchemaModel` rows list 2.1 only (第十二个样本, 2026-09-23).
  "volcengine-plan": {
    families: {
      all: {
        models: DOUBAO.map(([id, maxOutput]) =>
          cal(id, { contextSize: 262_144, maxOutput, thinkingCategory: "doubao" }, MULTIMODAL_PDF)),
      },
      // A `video_url` clip read right on doubao-seed-2.0-mini; `fps` left no
      // mark on a 4-second clip's bill in either spelling, which a clip that
      // short cannot tell from a frame floor — so no `videoFps` cell (第十九个样本).
      openai: { jsonSchema: true, videoInput: true },
      responses: { web_search: true, jsonSchema: true },
      anthropic: {
        web_search: true,
        pdfInput: true,
        models: DOUBAO.map(([id, maxOutput]) => cal(id, { maxOutput, thinkingCategory: "doubao-switch" })),
      },
    },
  },
  // Takes `tool_choice: "auto"` only: forcing is ignored on some models and
  // refused on others with an error that never names the parameter (第十四个样本).
  // json_schema: a 200 that ignores it — prose in a code fence, Chinese keys.
  // A `video_url` clip is read; its `fps` is ignored (same tokens at 0.5 and 2).
  zhipu: {
    families: {
      all: { forcedToolChoice: false, jsonSchema: false, models: ZHIPU_MODELS },
      openai: { videoInput: true },
    },
  },
  // Every cell measured on paid models (landscape.md §7 第十八个样本): a strict
  // schema held against a prompt that contradicted its enum on ①②③④, and the
  // Responses built-in and Anthropic's versioned `web_search` both searched.
  // PDF: a one-page file's passphrase read back on all four; ①② need no cell.
  // Not the official `google` cell: ③ here is Vertex AI, not AI Studio.
  // ③'s three built-in tools, beside function tools, forced calls and a
  // response schema alike (再补测). The GPT ids (GPT 全家补测): gpt-5.6-sol is
  // served by OpenAI's own Chat Completions and refuses tools beside any effort
  // (gpt-5.6-luna is rerouted and was not); gpt-6-astra refuses `none` on both;
  // gpt-5.6-sol's Responses refuses any temperature (its Chat takes one), and
  // its Chat refuses `max` and `minimal` (its Responses takes `max`).
  // gpt-5.6-luna's temperature is rerouted to the translating layer and echoed.
  // A `video_url` part on ① (第十九个样本): Gemini drops it in silence — a 200,
  // a wrong answer, the same input tokens as without it — and GPT is refused
  // upstream. The silent one is why this cell matters: nothing tells the author.
  orcarouter: {
    families: {
      all: { models: ORCAROUTER_MODELS },
      openai: {
        jsonSchema: true,
        videoInput: false,
        models: [
          { match: /^openai\/gpt-5\.6-sol$/, set: { effortWithTools: false, effortMax: false, effortMinimal: false } },
          { match: /^openai\/gpt-6-astra$/, set: { reasoningOff: false } },
        ],
      },
      responses: {
        jsonSchema: true,
        web_search: true,
        models: [
          { match: /^openai\/gpt-6-astra$/, set: { reasoningOff: false } },
          { match: /^openai\/gpt-5\.6-sol$/, set: { temperature: false } },
        ],
      },
      gemini: { jsonSchema: true, pdfInput: true, web_search: true, web_extractor: true, code_interpreter: true },
      anthropic: { web_search: true, jsonSchema: true, pdfInput: true },
    },
  },
  newapi: RELAY,
  ollama: LOCAL,
  comfyui: LOCAL,
  custom: RELAY,
};

/** Each block's rows in `bySpecificity` order, sorted once. */
const sorted = new WeakMap<readonly PlatformModelRow[], readonly PlatformModelRow[]>();
function modelRows(block: FamilyCells | undefined): readonly PlatformModelRow[] | undefined {
  const rows = block?.models;
  if (!rows) return undefined;
  let s = sorted.get(rows);
  if (!s) sorted.set(rows, (s = bySpecificity(rows)));
  return s;
}

/** Whether a block says anything about this capability — as a value, or in any of its rows. */
function owns(block: FamilyCells | undefined, id: CapabilityId): boolean {
  return !!block && (block[id] !== undefined || !!block.models?.some((r) => r.set[id] !== undefined));
}

/**
 * The platform's answer about one capability on one family, for one model id:
 * a row's `true` / `false`, else the owning block's value. Undefined when the
 * platform says nothing and the protocol rule decides.
 *
 * The family's own block owns the capability if it mentions it at all — in a
 * value or in a row — and then the `all` block is not consulted, even for an id
 * no row names (the refuses-only case falls straight to the rule).
 */
export function platformCell(
  platform: PlatformId,
  family: ProtocolFamily,
  id: CapabilityId,
  modelId: string | undefined,
): { cell: boolean | "per-model"; byRow: boolean } | undefined {
  const families = PLATFORM_CELLS[platform]?.families;
  const block = owns(families?.[family], id) ? families?.[family] : owns(families?.all, id) ? families?.all : undefined;
  if (!block) return undefined;
  const row = rowSetting(modelRows(block), rawModelKey(modelId), (r) => r.set[id] !== undefined);
  if (row) return { cell: row.set[id] === true, byRow: true };
  const value = block[id];
  return value === undefined ? undefined : { cell: value, byRow: false };
}

/**
 * What this platform knows about one of its model ids, or undefined — see
 * {@link ModelCalibration}. With a family, only that family's own row: what a
 * route of that family starts with where it differs from the model's (Doubao's
 * `doubao-switch` on the Anthropic route).
 */
export function platformModelCalibration(
  platform: PlatformId,
  modelId: string,
  family?: ProtocolFamily,
): ModelCalibration | undefined {
  const key = rawModelKey(modelId);
  const block = PLATFORM_CELLS[platform]?.families?.[family ?? "all"];
  const row = rowSetting(modelRows(block), key, (r) =>
    r.set.thinkingCategory !== undefined || r.set.contextSize !== undefined || r.set.maxOutput !== undefined || !!r.prefill);
  if (!row) return undefined;
  const { thinkingCategory, contextSize, maxOutput } = row.set;
  return {
    ...(thinkingCategory !== undefined ? { thinkingCategory } : {}),
    ...(contextSize !== undefined ? { contextSize } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...row.prefill,
  };
}

/**
 * The platform's value for one of its model ids on one family: the family's
 * own block's row, else the `all` block's. `accepts` skips a value the family
 * cannot use — the `all` block's `doubao` category is a Chat Completions
 * dialect, and a Responses route on the same platform must not take it.
 */
export function platformValue<F extends ValueFactId>(
  platform: PlatformId,
  family: ProtocolFamily,
  fact: F,
  modelId: string | undefined,
  accepts: (v: ValueFactMap[F]) => boolean = () => true,
): ValueFactMap[F] | undefined {
  const key = rawModelKey(modelId);
  if (!key) return undefined;
  const families = PLATFORM_CELLS[platform]?.families;
  const valueOf = (r: PlatformModelRow) => r.set[fact] as ValueFactMap[F] | undefined;
  for (const block of [families?.[family], families?.all]) {
    const row = rowSetting(modelRows(block), key, (r) => {
      const v = valueOf(r);
      return v !== undefined && accepts(v);
    });
    if (row) return valueOf(row);
  }
  return undefined;
}

/** `include` entries a platform's Responses route must send — see `FamilyCells.responsesInclude`. */
export function platformResponsesInclude(platform: PlatformId): readonly string[] {
  return PLATFORM_CELLS[platform]?.families?.responses?.responsesInclude ?? [];
}
