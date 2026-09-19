/**
 * Subagent kinds, bindings and connection resolution — the *query* half of the
 * subagent system: which kinds exist, which model a kind is bound to and
 * whether it can do the job, and the connection a direct call would use.
 *
 * Split from `subagent.ts` (docs/feature/code-structure-plan.md P1) because
 * almost every caller wants only this half — the image, translate and ASR
 * tools, `routeTools`, settings panes, the composer — while `subagent.ts`
 * holds `executeDelegate`, which runs a nested agent and so imports the
 * runtime. Keeping them in one file pulled `runtime` into every one of those
 * callers' import graphs and closed the agent subsystem's import cycles.
 * Nothing in this file may import `./runtime`.
 */

import i18n from "../../i18n";
import { serverToolsSent } from "../ai/serverTools";
import { canSeeImages, isAsrOnly, isTranslateOnly, readsPdf, type Model, type Provider } from "../ai/configDb";
import type { AiConn } from "../ai/conn";
import { providerFor } from "../ai/routes";
import type { TaskPreset } from "./presets";

export type SubAgentKind =
  | "search" | "vision" | "longread" | "pdf" | "imagegen" | "translate" | "writer"
  | "retrieval" | "asr";

export const SUBAGENT_KINDS: readonly SubAgentKind[] =
  ["search", "vision", "longread", "pdf", "imagegen", "translate", "writer", "retrieval", "asr"];

/**
 * The kinds `delegate` can dispatch to — a *conversational* sub-run on the
 * bound model. `imagegen` is deliberately not one of them: an image model
 * cannot hold a conversation, so the assistant's interface to that specialist
 * is the `generate_image` / `edit_image` / `redraw_lore_image` tools (proposal → approval card →
 * generation, see lib/agent/imageTools.ts), and `routeTools` is what makes the
 * binding matter — those tools exist only while this subagent is usable, and
 * they draw with its model.
 *
 * `writer` is excluded for a third reason, and it is the sharpest of the three:
 * it is not called at all. The whole point of the writer switch is that no model
 * decides whether to use it — a tool would put that decision back in the
 * model's hands. It runs as the run's **finish stage** instead
 * (`finishPolicy: "handoff"`, lib/agent/handoff.ts), which is also why its
 * output is not summarised into a note the way a delegate's is: it *is* the
 * turn's answer, and a delegate's contract is the opposite of that.
 *
 * `translate` is excluded for exactly the same reason as imagegen, and the evidence is
 * blunter than for images: asked "你是什么模型", Sakura paraphrases the question
 * back instead of answering; handed a task description it translates it. A
 * `subagentTask` prompt would come back as its own Chinese translation. So the
 * assistant's interface to it is the `translate` tool, and `lib/translate/`
 * calls the endpoint directly rather than through `runAgent` — it has no tool
 * calling to loop over. See docs/feature/translate/01-execution-plan.md §1.
 *
 * `retrieval` is excluded on the writer's grounds rather than the other two's:
 * it is not called, and by the time any model is looking at the conversation it
 * has already run. It expands the author's own words into knowledge-base terms
 * *before* the request is assembled, so that retrieval can match on 「星辉之杖」
 * on a turn where the author only wrote 「变身场景」. Its output is a word list
 * fed back through the ordinary substring matcher — deliberately, because that
 * keeps the injection report saying 「由「星辉之杖」命中」 instead of a score the
 * author cannot act on. See docs/feature/lore/lore-retrieval-plan.md §5.
 *
 * `asr` is excluded on imagegen's grounds: a transcription model's endpoint
 * takes an audio URL, not messages — there is no conversation to delegate.
 * The assistant's interface to it is the `transcribe_audio` tool (a proposal
 * card *before* the paid call, docs/feature/asr/01-execution-plan.md §5), and
 * the file tree's 右键 reaches the same `lib/asr/run` directly.
 */
export type DelegateKind =
  Exclude<SubAgentKind, "imagegen" | "translate" | "writer" | "retrieval" | "asr">;

export const DELEGATE_KINDS: readonly DelegateKind[] = ["search", "vision", "longread", "pdf"];

export interface SubAgentConfig {
  kind: SubAgentKind;
  /** Model.id, or null if unconfigured. */
  modelId: string | null;
  enabled: boolean;
}

export const SUB_PRESETS: Record<DelegateKind, TaskPreset> = {
  search: {
    id: "subagent-search",
    tools: [],
    maxRounds: 2,
    finishPolicy: "force-text",
    serverTools: "always",
  },
  vision: {
    id: "subagent-vision",
    tools: ["read_image", "read_lore_image"],
    maxRounds: 3,
    finishPolicy: "force-text",
    serverTools: "off",
  },
  longread: {
    id: "subagent-longread",
    tools: ["read_file", "read_slides", "read_document", "search_text", "list_files"],
    maxRounds: 4,
    finishPolicy: "force-text",
    serverTools: "off",
  },
  // Single-shot on purpose: the PDF rides in the first user message as file
  // parts (there is no tool that could fetch one later), so the whole job is
  // one request — the endpoint extracts the document server-side and answers.
  pdf: {
    id: "subagent-pdf",
    tools: [],
    maxRounds: 1,
    finishPolicy: "force-text",
    serverTools: "off",
  },
};

/**
 * Per-file ceiling for a delegated PDF — DashScope's own documented cap. The
 * base64 form is a third larger again and the whole request body is built in
 * webview memory, so a file near this limit is slow but loud about any
 * failure; nothing here truncates silently.
 */
export const MAX_PDF_BYTES = 150 * 1024 * 1024;

/**
 * How many PDFs one delegation may carry. The vendor's examples show one file
 * per request and document no multi-file contract, so this stays small enough
 * that a refusal reads as "split the job", not as an arbitrary wall.
 */
export const MAX_PDF_FILES = 3;

/**
 * The model behind one subagent, but only when it can actually do that job.
 *
 * **"Enabled and bound" is not "usable."** The settings pane warns about a
 * mismatched binding and still allows it — the author may be part-way through
 * configuring — so anything that acts on the flag alone ends up offering a
 * capability that will refuse the moment it is used: an image control that
 * posts to a text model, or a search subagent on a model with no web_search
 * (which is worse than useless, since `routeTools` takes the main model's own
 * browsing away in its favour).
 *
 * These are the same preconditions `executeDelegate` enforces. They live here
 * so every surface asks the same question instead of each re-deriving it.
 */
export function subAgentModel(
  kind: SubAgentKind,
  models: Model[],
  subs: Record<SubAgentKind, SubAgentConfig>,
  /**
   * With the provider list, "can search" means the platform actually sends
   * web_search for this model (`serverToolsSent`); without it, the row's
   * declaration alone answers — the surfaces that have no providers in hand
   * (a chip, a strip) accept that, `routeTools` and the delegate do not.
   */
  providers?: readonly Provider[],
): Model | null {
  const cfg = subs[kind];
  if (!cfg?.enabled || !cfg.modelId) return null;
  const model = models.find((m) => m.id === cfg.modelId);
  if (!model) return null;
  if (kind === "vision" && !canSeeImages(model)) return null;
  if (kind === "search" && !serverToolsSent(model, providers)?.includes("web_search")) return null;
  if (kind === "pdf" && !readsPdf(model, providers ? providerFor(model, providers) : undefined)) return null;
  if (kind === "imagegen" && model.type !== "image") return null;
  // The mirror of the image check: that one refuses a model that cannot draw,
  // this one refuses a model that has not been *declared* a translation model —
  // and here the failure is silent rather than loud, which is why it is checked
  // at all. A general model handed Sakura's fixed template answers something
  // plausible; nothing errors, and the author reads a worse translation as the
  // feature working.
  if (kind === "translate" && !isTranslateOnly(model)) return null;
  // Same shape as translate: only a model *declared* a transcription model
  // may be bound here. The failure is loud rather than silent this time (the
  // ASR endpoint 400s on a chat model's id), but the declaration is still the
  // one place the author says "this row is the transcriber".
  if (kind === "asr" && !isAsrOnly(model)) return null;
  // The writer is the one kind with no capability to test for — any text model
  // can write — so the check runs the other way, excluding what cannot: an
  // image/video model has no prose to give, and a translation-only model is the
  // silent failure of the set. Sakura bound here reports no error at all; it
  // just returns the work order back, translated. That is a worse outcome than
  // an unset switch, so it is refused rather than warned about. A
  // transcription-only model has no prose to give either.
  if (kind === "writer" && (model.type === "image" || model.type === "video" || model.type === "vision")) return null;
  if (kind === "writer" && (isTranslateOnly(model) || isAsrOnly(model))) return null;
  return model;
}

/**
 * Whether a search subagent on this model can open a web page itself: the
 * row declares 网页抓取 (`web_extractor`) **and** its provider's platform
 * spells it — see `serverToolsSent` (lib/ai/serverTools). Promising page reading where it
 * isn't sent makes the subagent report search snippets, or worse, as the page.
 *
 * Asked in three places that must agree: the `delegate` description (via
 * `routeTools`), the search subagent's own system prompt, and the settings
 * pane's note under the binding.
 */
export function searchReadsPages(model: Model, provider: Provider | undefined): boolean {
  return provider !== undefined
    && (serverToolsSent(model, [provider])?.includes("web_extractor") ?? false);
}

/** {@link subAgentModel} for the vision kind — the one with callers outside the agent. */
export function visionSubAgentModel(
  models: Model[],
  subs: Record<SubAgentKind, SubAgentConfig>,
): Model | null {
  return subAgentModel("vision", models, subs);
}

/**
 * The author's settings with this conversation's chip toggles applied.
 *
 * Subtractive only: a chip can switch off something Settings enabled, never the
 * reverse — "use it just this once" would need a model binding the author never
 * made. One implementation because the composer, the router and the delegate
 * resolver must agree on what is live; two copies of this drift.
 */
export function withSessionOverrides(
  subs: Record<SubAgentKind, SubAgentConfig>,
  disabled: readonly SubAgentKind[],
): Record<SubAgentKind, SubAgentConfig> {
  if (disabled.length === 0) return subs;
  const next = { ...subs };
  for (const kind of disabled) {
    if (next[kind]) next[kind] = { ...next[kind], enabled: false };
  }
  return next;
}

/**
 * Whether anything on this chain can understand an image — the active model
 * itself, or a usable vision subagent behind it.
 *
 * For enabling UI that depends on images being *understood* somewhere. It is
 * NOT the answer to "may I put base64 in this request": that stays
 * `ToolContext.multimodal`, a property of the one model being called (see
 * docs/feature/agent/subagent-lld.md §6.1).
 */
export function chainCanSeeImages(
  mainModel: Model | undefined,
  subs: Record<SubAgentKind, SubAgentConfig>,
  models: Model[],
): boolean {
  return (!!mainModel && canSeeImages(mainModel)) || visionSubAgentModel(models, subs) !== null;
}

/**
 * Resolve an AiConn for a given subagent kind from active aiStore state.
 */
export async function resolveSubAgentConn(
  kind: SubAgentKind,
  models: Model[],
  providers: Provider[],
  subs: Record<SubAgentKind, SubAgentConfig>,
  loadKey: (providerId: string) => Promise<string | null>,
): Promise<AiConn | { error: string }> {
  const cfg = subs[kind];
  if (!cfg?.enabled || !cfg.modelId) {
    return { error: `The ${kind} subagent is not enabled or not configured with a model.` };
  }
  const model = models.find((m) => m.id === cfg.modelId);
  if (!model) {
    return { error: `Model for ${kind} subagent not found.` };
  }
  const provider = providerFor(model, providers);
  if (!provider) {
    return { error: `Provider for ${kind} subagent not found.` };
  }
  const apiKey = await loadKey(provider.id);
  // Not defaulted to "": an empty key produces a 401 the parent model reads as
  // "the subagent is broken", when the actual fix is to paste a key. Say which.
  if (!apiKey) {
    return {
      error: `No API key stored for the provider serving the ${kind} subagent ("${provider.name}"). Tell the author to add it in Settings → Providers.`,
    };
  }
  return { provider, model, apiKey };
}

/**
 * Who describes a picture for a direct UI action (the lore gallery's AI 描述).
 *
 * **The vision subagent wins whenever it is usable, even if the active model
 * could do it too.** That is the whole meaning of the switch: an author running
 * a multimodal main model would otherwise flip it on and see no effect, and the
 * same rule governs the agent's tool routing (`routeTools` strips the image
 * tools from the main model), so the two would disagree about what "enabled"
 * means. The cost is one extra hop; the benefit is one answer to "who reads
 * images here".
 *
 * Returns the reason on failure rather than null: both call sites sit behind a
 * control the author just clicked, and "nothing happened" is the least useful
 * thing to show them.
 */
export async function resolveVisionConn(
  models: Model[],
  providers: Provider[],
  activeModelId: string | null,
  subs: Record<SubAgentKind, SubAgentConfig>,
  loadKey: (providerId: string) => Promise<string | null>,
): Promise<AiConn | { error: string }> {
  if (visionSubAgentModel(models, subs)) {
    return resolveSubAgentConn("vision", models, providers, subs, loadKey);
  }

  const activeModel = models.find((m) => m.id === activeModelId);
  if (!activeModel || !canSeeImages(activeModel)) {
    return { error: i18n.t("ai.errors.noVisionModel") };
  }
  const provider = providerFor(activeModel, providers);
  if (!provider) return { error: i18n.t("ai.errors.providerNotFound") };
  const apiKey = await loadKey(provider.id);
  // Never "": a keyless request comes back 401 and reads as a broken feature
  // rather than as an unset credential. Same rule as resolveSubAgentConn.
  if (!apiKey) return { error: i18n.t("ai.errors.noApiKey", { provider: provider.name }) };
  return { provider, model: activeModel, apiKey };
}
