/**
 * Thinking effort: the author's intent, and how each protocol family spells it.
 *
 * The four families all grew an effort dial, and their level names look almost
 * alike — which is the trap. `medium` on one vendor is silently folded into
 * `high` on another; `minimal`/`none` exist on some models and 400 on others;
 * one family wants a *token budget* rather than a level at all. So what is
 * stored on a model is **this app's own six-value vocabulary**, and each adapter
 * translates. Never let a provider's own spelling reach the config layer.
 *
 * See `docs/api/landscape.md` for the protocol facts and `docs/api/reasoning-plan.md`
 * for why the mapping is shaped this way.
 *
 * Only the OpenAI Chat Completions family is wired up so far; the others return
 * undefined, which is exactly the behaviour they had before this file existed.
 */

import { familyOf, type ApiStandard, type ProtocolFamily } from "./types";

/**
 * How hard the author wants this model to think.
 *
 * `default` (and an absent value, which every model configured before this
 * setting existed has) means **send nothing** and let the endpoint apply its own
 * default. That is the only choice that is safe on every relay: any field this
 * app volunteers is a field some gateway can reject outright.
 */
export type ReasoningEffort =
  "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Every legal *stored* value — the set `parseReasoningEffort` admits, not the
 * dial's menu. What a given model actually offers is its category's `menu`
 * (see `THINKING_CATEGORIES`); this superset exists only so a value stored
 * under one category still parses when the model is later read under another.
 *
 * `minimal`/`xhigh` are back (they were dropped when one universal 6-chip dial
 * served every model): now that the menu is per-category, they appear only on
 * the categories that actually accept them — Gemini's `minimal`, Qwen-Max's
 * `xhigh` — instead of on every model or none.
 */
export const REASONING_EFFORTS: ReasoningEffort[] = [
  "default", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/** Narrow a stored string to the union — the DB column is free text. */
export function parseReasoningEffort(v: unknown): ReasoningEffort | undefined {
  return typeof v === "string" && (REASONING_EFFORTS as string[]).includes(v)
    ? (v as ReasoningEffort)
    : undefined;
}

// ─── Which dialect of the thinking parameter a model speaks ───────────────────

/**
 * How this model wants its thinking configured.
 *
 * A protocol family is not enough to answer this: within one family the
 * parameter changed shape between model generations, and **the generation is
 * not recoverable from the model id** on a relay, where that id is free text the
 * author typed (`特价kiro | claude-opus-4-6-thinking`). So the author declares
 * it — they picked the relay and know what they bought; it is the code that
 * can't tell. See `docs/api/anthropic-plan.md` §3.
 *
 *   - `adaptive`  — the model decides when and how deeply to think; depth comes
 *                   from an effort level. Claude 4.6+.
 *   - `extended`  — a fixed thinking token budget per request. Claude 4.5 and
 *                   earlier. Also the shape Gemini 2.5 uses.
 *   - `switch`    — a bare on/off switch, spelled per family: on Anthropic
 *                   bodies `{type:"adaptive"|"disabled"}` and nothing else — no
 *                   `display`, no budget, and **no `output_config`**, which is
 *                   where family ④'s depth dial lives; on OpenAI-compatible
 *                   bodies a top-level `enable_thinking: bool` (Qwen's DashScope
 *                   compatible-mode — what the SDK docs put in `extra_body` is
 *                   just a top-level wire field). Declaring this dialect also
 *                   means "this endpoint has no depth dial at all". The samples
 *                   it was written for: MiniMax-M3's `/anthropic/v1/messages`
 *                   (`docs/api/landscape.md` §7 第四个样本) and Qwen3 on
 *                   DashScope — on both, thinking on the affected models
 *                   defaults to **off**, so sending the switch is the only way
 *                   the model thinks.
 *   - `none`      — this endpoint has no thinking parameter; send nothing.
 *
 * Absent means "assume the family's current generation" — see `defaultDialect`.
 */
export type ThinkingDialect = "adaptive" | "extended" | "switch" | "none";

export const THINKING_DIALECTS: ThinkingDialect[] = ["adaptive", "extended", "switch", "none"];

export function parseThinkingDialect(v: unknown): ThinkingDialect | undefined {
  return typeof v === "string" && (THINKING_DIALECTS as string[]).includes(v)
    ? (v as ThinkingDialect)
    : undefined;
}

// ─── Thinking categories (the author-facing choice) ───────────────────────────

/**
 * How a category's depth is expressed in the UI and on the wire.
 *
 *   - `levels` — an ordered menu of effort chips (its `menu`).
 *   - `onoff`  — a bare on/off toggle (MiniMax): "on" = adaptive, "off" = disabled.
 *   - `budget` — an on/off plus a numeric token budget (Claude 4.5-, Qwen).
 *   - `none`   — no control at all (`off`): send nothing.
 */
export type ThinkingShape = "levels" | "onoff" | "budget" | "none";

/**
 * A named thinking-parameter preset the author picks per model.
 *
 * The dialect axis (`ThinkingDialect`) was too coarse to answer "which levels
 * does *this* model accept": DeepSeek and Qwen-Max are both OpenAI-family yet
 * one tops out at `high`+`max` and the other speaks `xhigh`; GLM cannot turn
 * thinking off at all. A category pins that per vendor/generation — each one
 * carries its own legal `menu`, its wire `dialect`, and (for budget shapes) a
 * token range — so the dial in the model editor and the one in chat render
 * exactly what the endpoint will accept, not a lowest-common-denominator six.
 *
 * `auto` is not a category id — it is the UI sentinel for "unset", which
 * `resolveThinkingCategory` turns into the family's default. `off` is a real
 * category (send nothing) so it can sit in the picker beside the others.
 */
export type ThinkingCategoryId =
  | "off"
  | "openai-generic" | "deepseek" | "qwen-budget" | "qwen-effort" | "glm"
  | "gemini3"
  | "claude-adaptive" | "claude-budget" | "minimax";

export interface ThinkingBudgetSpec {
  min: number;
  max: number;
  default: number;
}

export interface ThinkingCategory {
  id: ThinkingCategoryId;
  /** i18n key for the picker chip label. */
  labelKey: string;
  /** i18n key for the hint under the picker. */
  hintKey: string;
  /**
   * Which protocol family this category is offered under, so the model editor
   * only shows Anthropic categories for an Anthropic provider. `off` is
   * family-agnostic and appended to every family's list regardless of this.
   */
  family: ProtocolFamily;
  /** The underlying wire dialect — drives `thinkingBody` on the Anthropic path. */
  dialect: ThinkingDialect;
  shape: ThinkingShape;
  /** Ordered legal effort levels for a `levels` dial; empty otherwise. */
  menu: ReasoningEffort[];
  /** The level a fresh model of this category should preselect (e.g. GLM → max). */
  defaultEffort?: ReasoningEffort;
  /** The level governs the *whole* response, not just thinking (Anthropic). */
  governsWholeResponse?: boolean;
  /** Token-budget bounds for a `budget`-shape category. */
  budget?: ThinkingBudgetSpec;
  /** Per-category override of the effort→wire string; falls back to the family map. */
  effortWire?: Partial<Record<Exclude<ReasoningEffort, "default">, string>>;
  /** A static fragment always merged into the request while this category is on. */
  extra?: Record<string, unknown>;
}

/**
 * The registry. One entry per vendor/generation the app knows how to spell.
 *
 * Adding support for another endpoint's thinking is one entry here plus its two
 * i18n strings — deliberately, so it never grows back into a per-vendor branch
 * in the adapters (`reasoningBody`/`forcesToolChoiceAuto` read these fields).
 */
export const THINKING_CATEGORIES: Record<ThinkingCategoryId, ThinkingCategory> = {
  // Family-agnostic; `family` is a placeholder (never used to filter — off is
  // appended to every family's list) and never reaches a family branch because
  // its `none` shape short-circuits `reasoningBody`/`thinkingBody`.
  off: {
    id: "off", labelKey: "aiConfig.models.thinkingCatOff", hintKey: "aiConfig.models.thinkingCatOffHint",
    family: "openai", dialect: "none", shape: "none", menu: [],
  },
  "openai-generic": {
    id: "openai-generic",
    labelKey: "aiConfig.models.thinkingCatOpenaiGeneric",
    hintKey: "aiConfig.models.thinkingCatOpenaiGenericHint",
    family: "openai", dialect: "none", shape: "levels",
    menu: ["off", "low", "medium", "high", "max"],
  },
  deepseek: {
    id: "deepseek",
    labelKey: "aiConfig.models.thinkingCatDeepseek",
    hintKey: "aiConfig.models.thinkingCatDeepseekHint",
    family: "openai", dialect: "none", shape: "levels",
    // No `medium`: DeepSeek folds it into `high`, so offering it would be a chip
    // that silently means another. `off` sends the disable switch (not
    // reasoning_effort:"none") — see reasoningBody.
    menu: ["off", "low", "high", "max"],
  },
  "qwen-budget": {
    id: "qwen-budget",
    labelKey: "aiConfig.models.thinkingCatQwenBudget",
    hintKey: "aiConfig.models.thinkingCatQwenBudgetHint",
    family: "openai", dialect: "switch", shape: "budget",
    menu: [],
    budget: { min: 1, max: 32768, default: 4000 },
  },
  "qwen-effort": {
    id: "qwen-effort",
    labelKey: "aiConfig.models.thinkingCatQwenEffort",
    hintKey: "aiConfig.models.thinkingCatQwenEffortHint",
    family: "openai", dialect: "none", shape: "levels",
    // Qwen-Max tops out at `xhigh`, not `max`; `medium` between low and xhigh.
    menu: ["off", "low", "medium", "xhigh"],
  },
  glm: {
    id: "glm",
    labelKey: "aiConfig.models.thinkingCatGlm",
    hintKey: "aiConfig.models.thinkingCatGlmHint",
    family: "openai", dialect: "none", shape: "levels",
    // GLM-5.3 cannot disable thinking, so there is no `off`; it defaults to max.
    menu: ["low", "high", "max"], defaultEffort: "max",
    extra: { thinking: { clear_thinking: false } },
  },
  gemini3: {
    id: "gemini3",
    labelKey: "aiConfig.models.thinkingCatGemini3",
    hintKey: "aiConfig.models.thinkingCatGemini3Hint",
    family: "gemini", dialect: "none", shape: "levels",
    // `off` maps to MINIMAL (this family has no true off) — see GEMINI_LEVEL.
    menu: ["off", "low", "medium", "high"],
  },
  "claude-adaptive": {
    id: "claude-adaptive",
    labelKey: "aiConfig.models.thinkingCatClaudeAdaptive",
    hintKey: "aiConfig.models.thinkingCatClaudeAdaptiveHint",
    family: "anthropic", dialect: "adaptive", shape: "levels",
    menu: ["off", "low", "medium", "high", "max"], governsWholeResponse: true,
  },
  "claude-budget": {
    id: "claude-budget",
    labelKey: "aiConfig.models.thinkingCatClaudeBudget",
    hintKey: "aiConfig.models.thinkingCatClaudeBudgetHint",
    family: "anthropic", dialect: "extended", shape: "budget",
    menu: [],
    budget: { min: 1024, max: 32768, default: 16384 },
  },
  minimax: {
    id: "minimax",
    labelKey: "aiConfig.models.thinkingCatMinimax",
    hintKey: "aiConfig.models.thinkingCatMinimaxHint",
    family: "anthropic", dialect: "switch", shape: "onoff", menu: [],
  },
};

/** Every category id, for narrowing a free-text DB column. */
export const THINKING_CATEGORY_IDS = Object.keys(THINKING_CATEGORIES) as ThinkingCategoryId[];

/** Narrow a stored string to a category id — the DB column is free text. */
export function parseThinkingCategory(v: unknown): ThinkingCategoryId | undefined {
  return typeof v === "string" && (THINKING_CATEGORY_IDS as string[]).includes(v)
    ? (v as ThinkingCategoryId)
    : undefined;
}

/** The category to assume when the author hasn't declared one (the `auto` state). */
export function defaultCategoryId(standard: ApiStandard): ThinkingCategoryId {
  switch (familyOf(standard)) {
    case "anthropic": return "claude-adaptive";
    case "gemini": return "gemini3";
    default: return "openai-generic";
  }
}

/**
 * The category in force for a model: the author's declared one, else a
 * migration of the legacy `thinkingDialect`, else the family default.
 *
 * This is the single seam where an old `thinking_dialect` row becomes a
 * category — the model row carries no family, so the mapping can only happen
 * where the provider's `standard` is known (conn / model editor / chat dial).
 * Old rows are never rewritten until the author next saves the model.
 */
export function resolveThinkingCategory(
  m: { thinkingCategory?: ThinkingCategoryId; thinkingDialect?: ThinkingDialect },
  standard: ApiStandard,
): ThinkingCategory {
  if (m.thinkingCategory && THINKING_CATEGORIES[m.thinkingCategory]) {
    return THINKING_CATEGORIES[m.thinkingCategory];
  }
  // Migrate a legacy dialect, but only to a category of the **same family**.
  // The model row carries no family, and an imported / hand-edited bundle can
  // pair an OpenAI model with an Anthropic-only dialect (`adaptive`/`extended`);
  // without this guard that would resolve to a Claude category and emit
  // Anthropic fields (`output_config`) onto an OpenAI request. A cross-family
  // dialect falls through to the family's own default instead.
  const family = familyOf(standard);
  switch (m.thinkingDialect) {
    case "adaptive":
      if (family === "anthropic") return THINKING_CATEGORIES["claude-adaptive"];
      break;
    case "extended":
      if (family === "anthropic") return THINKING_CATEGORIES["claude-budget"];
      break;
    // switch → the family's on/off category. openai keeps `thinkingBudget`
    // unset so it emits only `enable_thinking`, byte-identical to old `switch`.
    case "switch":
      return family === "anthropic"
        ? THINKING_CATEGORIES["minimax"]
        : THINKING_CATEGORIES["qwen-budget"];
    // `off` is family-agnostic (send nothing), safe on any family.
    case "none":
      return THINKING_CATEGORIES["off"];
  }
  return THINKING_CATEGORIES[defaultCategoryId(standard)];
}

/** Category ids offered in the model editor for a family, plus the always-present `off`. */
export function categoriesForFamily(family: ProtocolFamily): ThinkingCategoryId[] {
  const own = THINKING_CATEGORY_IDS.filter(
    (id) => id !== "off" && THINKING_CATEGORIES[id].family === family,
  );
  return [...own, "off"];
}

/**
 * On/off shapes store their state in `reasoningEffort`. The two helpers below
 * are the one definition of that mapping, shared by the model editor and the
 * chat dial so they can't drift.
 *
 * The asymmetry is real: MiniMax's thinking block is emitted *unconditionally*
 * by `thinkingBody` (undefined effort already yields `adaptive`), so "on" needs
 * no stored marker there. Qwen's switch rides `reasoningBody`, whose guard
 * drops an unset effort to "send nothing", so "on" must be a concrete non-off
 * value — the level itself is immaterial (only on-vs-off is read), so a fixed
 * marker is used.
 */
export function onEffort(category: ThinkingCategory): ReasoningEffort | undefined {
  return category.family === "openai" ? "high" : undefined;
}

/** Whether an on/off toggle should read as "on" for this stored effort. */
export function thinkingIsOn(category: ThinkingCategory, effort: ReasoningEffort | undefined): boolean {
  if (effort === "off") return false;
  // Unset/default: MiniMax defaults on; Qwen's switch defaults to send-nothing.
  if (effort === undefined || effort === "default") return category.family === "anthropic";
  return true;
}

/** Whether this category's dial is an on/off toggle rather than a level menu. */
export function isOnOffCategory(category: ThinkingCategory): boolean {
  // The onoff shape (MiniMax), plus Qwen's budget category — its `enable_thinking`
  // switch needs the same on/off control beside the token field.
  return category.shape === "onoff"
    || (category.shape === "budget" && category.dialect === "switch");
}

/** Whether this category exposes any dial at all (a level menu, on/off, or budget). */
export function categoryHasControl(category: ThinkingCategory): boolean {
  return category.shape !== "none";
}

/**
 * Whether a forced `tool_choice` must be downgraded to `auto` for this category.
 *
 * Two endpoints refuse a forced choice while thinking is on: MiniMax's Messages
 * implementation (always, its enum is `auto|none`) and Qwen on DashScope (only
 * while `enable_thinking` is true). Both callers that force treat a declined
 * call as their JSON-mode / handoff fallback cue, so downgrading only trades a
 * guaranteed 400 for that fallback firing one turn earlier. Learned-from-400
 * endpoints (DeepSeek V4) are handled separately in `lib/ai/toolChoice.ts`.
 */
export function forcesToolChoiceAuto(
  category: ThinkingCategory,
  effort: ReasoningEffort | undefined,
): boolean {
  const thinkingOn = effort !== undefined && effort !== "default" && effort !== "off";
  switch (category.family) {
    case "anthropic":
      return category.dialect === "switch"; // MiniMax: forcing is always illegal
    case "openai":
      return (category.id === "qwen-budget" || category.id === "qwen-effort") && thinkingOn;
    default:
      return false;
  }
}

/**
 * OpenAI Chat Completions spells effort as a top-level `reasoning_effort`
 * string, and turns thinking off with the same field rather than a separate
 * switch. Its full enum is `none|minimal|low|medium|high|xhigh|max`; the two
 * values omitted here (`minimal`, `xhigh`) sit between levels this app already
 * offers, and "not every model supports every value" is a rule that applies to
 * the fringes first.
 *
 * DeepSeek and the other OpenAI-compatible endpoints accept the same field.
 * Vendor switch fields (`thinking: {type}`, `enable_thinking`) are deliberately
 * **not** sent unless the author declared the `switch` dialect on the model:
 * they are single-vendor spellings, and OpenAI's own endpoint rejects unknown
 * top-level arguments outright — so volunteering one would break the official
 * path to spell something `reasoning_effort: "none"` already says. With the
 * dialect declared, the statement inverts: this endpoint's thinking vocabulary
 * *is* the switch, so `enable_thinking` is sent and `reasoning_effort` is not
 * (on Qwen the two are documented as mutually exclusive — effort there
 * only distinguishes "off" from everything else).
 */
const OPENAI_EFFORT: Record<Exclude<ReasoningEffort, "default">, string> = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * The request-body fragment for this model's category + effort, or undefined to
 * send nothing at all.
 *
 * Undefined is returned for the `off`/`none` category and for `default`/absent
 * effort — both mean "leave the endpoint's own default alone". The `budget`
 * argument is read only by budget-shape OpenAI categories (Qwen); the Anthropic
 * budget travels through `thinkingBody` instead.
 */
export function reasoningBody(
  category: ThinkingCategory,
  effort: ReasoningEffort | undefined,
  budget?: number,
): Record<string, unknown> | undefined {
  // `off` and `auto→off` carry no control and send nothing.
  if (category.shape === "none") return undefined;
  // `default`/absent means send nothing, unchanged — the invariant every relay
  // depends on. On budget/onoff categories this means the author must turn
  // thinking on explicitly (pick a level, or flip the toggle to a non-off
  // effort); until then the request is byte-identical to before this existed.
  if (!effort || effort === "default") return undefined;
  const eff = effort as Exclude<ReasoningEffort, "default">;
  const on = eff !== "off";

  switch (category.family) {
    case "openai":
      switch (category.id) {
        case "qwen-budget":
          // A bare `enable_thinking` boolean (DashScope compatible-mode), plus
          // the token budget when the author set one. Budget omitted while off
          // or unset, so a migrated switch model stays byte-identical.
          return {
            enable_thinking: on,
            ...(on && typeof budget === "number" ? { thinking_budget: budget } : {}),
          };
        case "qwen-effort":
          // Qwen-Max: the switch and the level travel together (they are
          // documented as mutually exclusive with the *budget*, not each other).
          return on
            ? { enable_thinking: true, reasoning_effort: effortWire(category, eff, OPENAI_EFFORT) }
            : { enable_thinking: false };
        case "deepseek":
          // DeepSeek turns thinking off with the disable switch, not
          // `reasoning_effort:"none"` — that field only tunes depth while on.
          return on
            ? { reasoning_effort: effortWire(category, eff, OPENAI_EFFORT) }
            : { extra_body: { thinking: { type: "disabled" } } };
        default:
          // openai-generic, glm — the standard top-level field, plus any static
          // fragment the category always carries (GLM's clear_thinking:false).
          return {
            ...(category.extra ?? {}),
            reasoning_effort: effortWire(category, eff, OPENAI_EFFORT),
          };
      }
    case "gemini":
      return {
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: effortWire(category, eff, GEMINI_LEVEL),
            // Paired with the level on purpose. Thinking runs either way and is
            // billed either way; this only decides whether the reasoning comes
            // back with the answer. Setting a depth while leaving it off would
            // pay for thinking nobody can see.
            includeThoughts: true,
          },
        },
      };
    case "anthropic":
      // The `switch` (MiniMax) and `budget` (extended) categories have no
      // `output_config` — depth there is carried by `thinking` alone
      // (`thinkingBody`). Volunteering the field would be an unknown top-level
      // argument on an endpoint whose schema doesn't have one.
      if (category.dialect === "switch" || category.shape === "budget") return undefined;
      return { output_config: { effort: effortWire(category, eff, ANTHROPIC_EFFORT) } };
  }
}

/** The wire string for an effort: the category's own override, else the family map. */
function effortWire(
  category: ThinkingCategory,
  eff: Exclude<ReasoningEffort, "default">,
  base: Record<Exclude<ReasoningEffort, "default">, string>,
): string {
  return category.effortWire?.[eff] ?? base[eff];
}

/**
 * Gemini spells the level as an enum, in **upper case** — the lower-case
 * `thinking_level` seen in the guides belongs to the newer Interactions API, a
 * different surface (see `docs/api/landscape.md` §4.1).
 *
 * Two levels collapse. `off` maps to `MINIMAL` because this family has no way
 * to turn thinking off at all — the docs say plainly that "`minimal` does not
 * guarantee that thinking is off", so the UI's "off" is honestly "as little as
 * this model allows", same as on Anthropic. `max` maps to `HIGH` because the
 * enum stops there.
 *
 * `thinkingBudget` — the older numeric form — is deliberately never sent: it
 * lives in the same object and is distinguished only by which models accept it,
 * and this app's Gemini support starts at 3, where the level enum is the
 * documented input.
 */
const GEMINI_LEVEL: Record<Exclude<ReasoningEffort, "default">, string> = {
  off: "MINIMAL",
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
};

/**
 * Anthropic spells effort in `output_config.effort`, and it governs the **whole
 * response** — prose, tool calls and thinking together — not just thinking
 * depth. That is why it is a second dial here rather than the same one.
 *
 * `off` maps to the lowest level rather than to `thinking: {type:"disabled"}`,
 * which is what "off" means literally. Three reasons, in order of weight:
 * several models reject `disabled` outright; the ones that accept it are
 * documented to occasionally emit tool calls as plain text once thinking is
 * gone; and the vendor's own advice for spending less is to lower effort rather
 * than to disable. So "off" here is honestly "as little as this model allows" —
 * the UI says so rather than promising a switch the protocol won't honour.
 *
 * `xhigh` is deliberately absent from this app's vocabulary (see
 * REASONING_EFFORTS), which sidesteps the one level Claude 4.6 lacks.
 */
const ANTHROPIC_EFFORT: Record<Exclude<ReasoningEffort, "default">, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * The `thinking` field for a request, or undefined to send none.
 *
 * `display` is not negotiable per request here: the current Claude generation
 * defaults it to `"omitted"`, which returns thinking blocks whose text is an
 * empty string — billed in full, and useless to a UI that wants to show the
 * reasoning. Asking for `"summarized"` is what makes the feature visible at all.
 * The `switch` dialect is the one place it is left out, because that endpoint's
 * documented schema has no such field — and a compat layer that ignores unknown
 * keys and one that 400s on them are equally common (see `docs/api/landscape.md`
 * §7), so nothing is volunteered there that the docs don't name.
 *
 * `effort` reaches here only for `switch`, where on/off is the *entire* depth
 * vocabulary: with no `output_config` to carry a level, "as little as possible"
 * can only be said by turning thinking off. Every other dialect keeps the two
 * dials separate and ignores it.
 */
export function thinkingBody(
  dialect: ThinkingDialect,
  budgetTokens: number,
  effort?: ReasoningEffort,
): Record<string, unknown> | undefined {
  switch (dialect) {
    case "adaptive":
      return { thinking: { type: "adaptive", display: "summarized" } };
    case "extended":
      return { thinking: { type: "enabled", budget_tokens: budgetTokens, display: "summarized" } };
    case "switch":
      return { thinking: { type: effort === "off" ? "disabled" : "adaptive" } };
    case "none":
      return undefined;
  }
}

// ─── What a given endpoint can actually be told ───────────────────────────────

/**
 * Whether a thinking level can reach this endpoint at all.
 *
 * Answers "can the adapter *send* it today", not "does the model think" — an
 * endpoint whose family has no mapping yet would swallow the setting silently,
 * and a control that does nothing is worse than no control.
 *
 * Every family this app speaks now has a mapping, so this is true across the
 * board. It stays as a function rather than collapsing into `true` because the
 * fourth family (OpenAI Responses) is not implemented yet, and because
 * `reasoningBody` returning undefined for an unmapped family is exactly the
 * silent-swallow case this guards against.
 */
export function supportsThinkingLevel(standard: ApiStandard): boolean {
  const family = familyOf(standard);
  return family === "openai" || family === "anthropic" || family === "gemini";
}

/**
 * Whether a `temperature` can reach this endpoint at all.
 *
 * Lives here, next to `supportsThinkingLevel` and for the same reason, because
 * the one protocol that refuses it refuses it *because of thinking*: the
 * Messages API accepts `temperature: 1` and nothing else while extended
 * thinking is on, and `defaultDialect` makes Anthropic thinking unless the
 * author declares otherwise — so on an ordinary Claude model the field is
 * unsendable. Clamping the author's 0.2 up to the one legal value would send
 * the opposite of what they asked for under the name of honoring it, so the
 * adapter omits it instead.
 *
 * The adapter and the model editor both read this, rather than each testing
 * the condition their own way: a control the request then drops is exactly
 * what the comment on `supportsThinkingLevel` says not to ship.
 */
export function supportsTemperature(standard: ApiStandard, category?: ThinkingCategoryId): boolean {
  if (familyOf(standard) !== "anthropic") return true;
  // On Anthropic, temperature is unsendable whenever thinking is on. Only the
  // `off` category (and an unset one that resolves to it) leaves it legal;
  // absent resolves to the family default (claude-adaptive), i.e. thinking on.
  return category === "off";
}

// ─── Reasoning content on the OpenAI-compatible wire ──────────────────────────

/**
 * Reasoning the model emitted, kept **verbatim together with the field name it
 * arrived under**, so it can be echoed back exactly as received.
 *
 * The field name travels with the text on purpose. Endpoints speaking the same
 * protocol disagree on what to call this, and an endpoint that sends one name
 * is the endpoint most likely to expect that same name back. Echoing what we
 * were given needs no knowledge of *which* vendor we are talking to — which is
 * the only version of this that survives the next provider.
 */
export interface NativeReasoning {
  /** The wire field it arrived under (`reasoning_content`, `reasoning`, …). */
  field: string;
  text: string;
}

/**
 * Field names carrying reasoning text on an OpenAI-compatible delta, in
 * preference order.
 *
 * OpenAI's own Chat Completions returns **no** reasoning content at all — only
 * a `reasoning_tokens` count — so anything found here comes from an endpoint
 * that extended the protocol. `reasoning_content` is the more widely mirrored
 * spelling; `reasoning` is the other one in circulation. Both are read, neither
 * is assumed: an endpoint that sends neither simply produces no reasoning, and
 * everything downstream behaves exactly as it did before this existed.
 *
 * Adding a name here is the whole cost of supporting another endpoint's
 * spelling — deliberately, so it never becomes a per-vendor branch.
 */
export const REASONING_CONTENT_FIELDS = ["reasoning_content", "reasoning"] as const;

/**
 * Pull a reasoning fragment off one streamed delta, or null if it carries none.
 *
 * Non-string values are ignored rather than coerced: at least one endpoint
 * sends a structured `reasoning_details` array beside the plain field, and
 * `String(...)`-ing an object into the transcript would put "[object Object]"
 * in front of the author.
 */
// ─── Reasoning inlined into the answer text ───────────────────────────────────

const OPEN = "<think>";
const CLOSE = "</think>";

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function danglingPrefix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Pulls an inline `<think>…</think>` block out of streamed answer text.
 *
 * Some endpoints don't separate thinking from the answer at all — they wrap it
 * in tags and send the whole thing as `content`. Left alone, that prose reaches
 * the manuscript: `{text}` chunks are what gets inserted into the document.
 *
 * Two properties make this safe to run on every response:
 *
 *   - **Only at the very start.** A response is treated as tag-wrapped only
 *     when `<think>` is the first non-whitespace thing in it, which is where
 *     the endpoints that do this always put it. A `<think>` appearing later is
 *     the author's own text — this is a writing app, and silently eating a
 *     passage would be far worse than leaving a stray tag visible.
 *   - **Tag-splitting is handled.** `<thi` + `nk>` arriving in two chunks is
 *     normal, so any tail that could still become a tag is held back rather
 *     than emitted as text.
 */
export function createThinkTagSplitter(): {
  push(text: string): StreamPiece[];
  /** Anything still held back when the stream ends. */
  flush(): StreamPiece[];
} {
  type Phase = "start" | "thinking" | "body";
  let phase: Phase = "start";
  let buf = "";

  const step = (out: StreamPiece[]): boolean => {
    if (phase === "start") {
      const lead = buf.length - buf.trimStart().length;
      const rest = buf.slice(lead);
      if (rest.startsWith(OPEN)) {
        buf = rest.slice(OPEN.length);
        phase = "thinking";
        return true;
      }
      // Still possibly the opening tag, split across chunks — wait for more.
      if (rest.length < OPEN.length && OPEN.startsWith(rest)) return false;
      phase = "body";
      return true;
    }
    if (phase === "thinking") {
      const at = buf.indexOf(CLOSE);
      if (at >= 0) {
        if (at > 0) out.push({ reasoning: buf.slice(0, at) });
        buf = buf.slice(at + CLOSE.length);
        phase = "body";
        return true;
      }
      const hold = danglingPrefix(buf, CLOSE);
      const safe = buf.slice(0, buf.length - hold);
      if (safe) out.push({ reasoning: safe });
      buf = buf.slice(buf.length - hold);
      return false;
    }
    if (buf) out.push({ text: buf });
    buf = "";
    return false;
  };

  return {
    push(text: string) {
      buf += text;
      const out: StreamPiece[] = [];
      while (step(out)) { /* phase changed — re-run against the same buffer */ }
      return out;
    },
    flush() {
      if (!buf) return [];
      // An unterminated block: report it as reasoning rather than as answer
      // text. The response was cut off mid-thought, and the tail is not prose
      // the author asked for.
      const out: StreamPiece[] = [{ [phase === "thinking" ? "reasoning" : "text"]: buf } as StreamPiece];
      buf = "";
      return out;
    },
  };
}

/** What the splitter emits — the two `StreamChunk` variants it can produce. */
export type StreamPiece = { text: string } | { reasoning: string };

export function readReasoningDelta(delta: Record<string, unknown>): NativeReasoning | null {
  for (const field of REASONING_CONTENT_FIELDS) {
    const v = delta[field];
    if (typeof v === "string" && v.length > 0) return { field, text: v };
  }
  return null;
}
