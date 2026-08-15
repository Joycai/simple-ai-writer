/**
 * Subagents execution engine and delegate tool.
 *
 * Specialist agents (search, vision, longread) run on their own configured
 * model with a fresh, isolated 2-message context. Intermediate findings
 * and raw materials (search results, full documents, base64 images) are
 * written into notes in the task workspace, returning only a concise summary
 * and note path to the parent model.
 */

import i18n from "../../i18n";
import type { StreamMessage } from "../ai/types";
import { costFor, type Model, type Provider } from "../ai/configDb";
import { connOptions, type AiConn } from "../ai/conn";
import { persistUsage } from "../ai/usage";
import type { TaskPreset } from "./presets";
import { runAgent, type AgentRunResult } from "./runtime";
import type { ToolContext } from "./registry";
import type { ToolCall, ToolResult } from "./tools";
import { writeTaskNote } from "./taskWorkspace";

export type SubAgentKind = "search" | "vision" | "longread";

export const SUBAGENT_KINDS: readonly SubAgentKind[] = ["search", "vision", "longread"];

export interface SubAgentConfig {
  kind: SubAgentKind;
  /** Model.id, or null if unconfigured. */
  modelId: string | null;
  enabled: boolean;
}

export const SUB_PRESETS: Record<SubAgentKind, TaskPreset> = {
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
    tools: ["read_file", "search_text", "list_files"],
    maxRounds: 4,
    finishPolicy: "force-text",
    serverTools: "off",
  },
};

const DELEGATE_SUMMARY_CHARS = 800;

/** How much of the instruction survives into the note's filename. */
const SLUG_HINT_CHARS = 20;

function parseArgs<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

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
): Model | null {
  const cfg = subs[kind];
  if (!cfg?.enabled || !cfg.modelId) return null;
  const model = models.find((m) => m.id === cfg.modelId);
  if (!model) return null;
  if (kind === "vision" && model.type !== "multimodal") return null;
  if (kind === "search" && !model.serverTools?.includes("web_search")) return null;
  return model;
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
 * docs/subagent-lld.md §6.1).
 */
export function chainCanSeeImages(
  mainModel: Model | undefined,
  subs: Record<SubAgentKind, SubAgentConfig>,
  models: Model[],
): boolean {
  return mainModel?.type === "multimodal" || visionSubAgentModel(models, subs) !== null;
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
  const provider = providers.find((p) => p.id === model.providerId);
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
  if (!activeModel || activeModel.type !== "multimodal") {
    return { error: i18n.t("ai.errors.noVisionModel") };
  }
  const provider = providers.find((p) => p.id === activeModel.providerId);
  if (!provider) return { error: i18n.t("ai.errors.providerNotFound") };
  const apiKey = await loadKey(provider.id);
  // Never "": a keyless request comes back 401 and reads as a broken feature
  // rather than as an unset credential. Same rule as resolveSubAgentConn.
  if (!apiKey) return { error: i18n.t("ai.errors.noApiKey", { provider: provider.name }) };
  return { provider, model: activeModel, apiKey };
}

/**
 * Execute a delegate tool call: dispatch to a subagent on its own model.
 */
export async function executeDelegate(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({
    toolCallId: call.id,
    content: `Error: ${msg}`,
  });

  if (!ctx.taskWorkspace || !ctx.signal || !ctx.onNestedEvent || !ctx.resolveSubAgent) {
    return fail("this surface cannot run subagents — do not call this tool here.");
  }

  const args = parseArgs<{ kind?: string; task?: string; refs?: string[] }>(call.arguments);
  const kind = args.kind as SubAgentKind;
  if (!SUBAGENT_KINDS.includes(kind)) {
    return fail(`unknown subagent kind "${args.kind}". Must be one of: search, vision, longread.`);
  }

  const task = args.task?.trim();
  if (!task) {
    return fail("'task' is required — state the whole job, the subagent cannot see this conversation.");
  }

  const conn = await ctx.resolveSubAgent(kind);
  if ("error" in conn) return fail(conn.error);

  // Capability preconditions, checked here rather than inside the sub-run: a
  // subagent bound to a model that cannot do its one job would otherwise burn a
  // whole round trip before reporting it, and report it as a failure rather
  // than as a configuration problem the author can fix.
  if (kind === "search" && !conn.model.serverTools?.includes("web_search")) {
    return fail(
      `the search subagent's model "${conn.model.name}" has no server-side web_search enabled. ` +
        `Tell the author to turn it on in Settings → Models, or answer without searching.`,
    );
  }
  if (kind === "vision" && conn.model.type !== "multimodal") {
    return fail(
      `the vision subagent's model "${conn.model.name}" is text-only and cannot read images. ` +
        `Tell the author to bind a multimodal model to it in Settings → Subagents.`,
    );
  }

  const refs = (args.refs ?? []).filter((r) => typeof r === "string" && r.trim());
  const preset = SUB_PRESETS[kind];

  // Two templates, not one with an interpolated blank: the refs-bearing key
  // carries its own 「参考资源」 heading, so reusing it with nothing to list
  // handed the subagent an empty section — an instruction to consult sources
  // that aren't there.
  const messages: StreamMessage[] = [
    { role: "system", content: i18n.t(`ai.instructions.subagent.${kind}`) },
    {
      role: "user",
      content: refs.length
        ? i18n.t("ai.instructions.subagentTaskWithRefs", {
            task,
            refs: refs.map((r) => `- ${r}`).join("\n"),
          })
        : i18n.t("ai.instructions.subagentTask", { task }),
    },
  ];

  let output = "";
  let result: AgentRunResult;

  try {
    result = await runAgent({
      ...connOptions(conn),
      preset,
      messages,
      toolContext: {
        projectPath: ctx.projectPath,
        loreIndex: ctx.loreIndex,
        multimodal: conn.model.type === "multimodal",
        taskWorkspace: undefined,
        signal: ctx.signal,
      },
      signal: ctx.signal,
      onEvent: (e) => ctx.onNestedEvent!({ ...e, parentStep: call.id }),
      onOutputText: (text) => {
        output = text;
      },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return fail(`the ${kind} subagent failed: ${(e as Error).message}`);
  }

  // What this specialist spent, on the record where the author can see it.
  // The DB row below is the permanent ledger, but it is invisible until someone
  // opens Settings → 用量 — and a delegation is exactly the step whose cost the
  // author is deciding about *now*. `parentStep` keeps it out of the parent
  // run's own totals, which count the parent's model only.
  ctx.onNestedEvent({
    kind: "run-done",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    at: Date.now(),
    parentStep: call.id,
  });

  const cost = costFor(conn.model, result.inputTokens, result.outputTokens, result.cachedTokens);
  await persistUsage(
    ctx.projectPath,
    conn.model.id,
    result.inputTokens,
    result.outputTokens,
    cost,
    `subagent:${kind}`,
    result.cachedTokens,
  );

  if (!output.trim()) {
    return fail(`the ${kind} subagent returned nothing. Try a narrower task, or do it yourself.`);
  }

  // Generic title, never the delegated instruction. Naming the workspace after
  // whichever artefact happened to land first is the defect PR-A fixed for
  // write_note, and it reads worse here: a delegate task is a whole paragraph
  // by design, so it became the document's H1. The task's name belongs to
  // task_plan.
  const { taskId } = await ctx.taskWorkspace.ensure(i18n.t("ai.taskDoc.untitled"));
  const note = await writeTaskNote(ctx.projectPath, taskId, {
    // A filename, not a sentence — the full instruction is the note's title on
    // the first line, and `writeTaskNote` suffixes rather than overwrites when
    // two delegations share an opening.
    slug: `${kind}-${[...task].slice(0, SLUG_HINT_CHARS).join("")}`,
    title: task.slice(0, 80),
    content: output,
    sources: refs,
    origin: kind,
  });

  return {
    toolCallId: call.id,
    content: [
      `The ${kind} subagent finished. Full findings saved to: ${note.path}`,
      `Call read_note with that path when you need the detail.`,
      ``,
      `Summary:`,
      clip(output, DELEGATE_SUMMARY_CHARS),
    ].join("\n"),
  };
}
