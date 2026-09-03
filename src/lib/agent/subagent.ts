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
import type { ContentPart, MessageContent, StreamMessage } from "../ai/types";
import { costFor, isTranslateOnly, type Model, type Provider } from "../ai/configDb";
import { connOptions, type AiConn } from "../ai/conn";
import { persistUsage } from "../ai/usage";
import { bytesToBase64 } from "../fs/images";
import { fileExists, readBinaryFile } from "../fs/fileio";
import { isWorkspacePath, resolveRelativePath } from "../paths";
import type { TaskPreset } from "./presets";
import { runAgent, type AgentRunResult } from "./runtime";
import type { ToolContext } from "./registry";
import type { ToolCall, ToolResult } from "./tools";
import { writeTaskNote } from "./taskWorkspace";
import { baseName } from "../paths";

export type SubAgentKind =
  | "search" | "vision" | "longread" | "pdf" | "imagegen" | "translate" | "writer"
  | "retrieval";

export const SUBAGENT_KINDS: readonly SubAgentKind[] =
  ["search", "vision", "longread", "pdf", "imagegen", "translate", "writer", "retrieval"];

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
 */
export type DelegateKind =
  Exclude<SubAgentKind, "imagegen" | "translate" | "writer" | "retrieval">;

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

const DELEGATE_SUMMARY_CHARS = 800;

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
 * Read one project PDF for a delegation, or say exactly why not.
 *
 * Containment mirrors `read_file`, not `read_image`: `.ai-writer/` is refused.
 * A PDF is a document the model reads as text, so the exfiltration argument
 * that keeps `read_file` out of the app's own data applies unchanged — and
 * unlike lore gallery images, nothing this tool serves legitimately lives
 * there.
 */
async function loadProjectPdf(
  projectPath: string,
  rawPath: string,
): Promise<{ dataUrl: string; name: string } | { error: string }> {
  // Empty prefix would contain every absolute path — same guard as the read tools.
  if (!projectPath) return { error: "no project is open — the pdf subagent cannot run here." };
  const wanted = rawPath.trim();
  if (!wanted.toLowerCase().endsWith(".pdf")) {
    return { error: `"${rawPath}" is not a .pdf file. The pdf subagent reads PDFs only; for text documents use the longread subagent or read_file.` };
  }
  const path = resolveRelativePath(projectPath, wanted);
  // `isWorkspacePath` is the tools' whole answer — inside the project AND not
  // in `.ai-writer/` — so the guard is its single negation, not a re-derivation.
  if (!isWorkspacePath(projectPath, path)) {
    return { error: `"${rawPath}" is outside the project's documents.` };
  }
  if (!(await fileExists(path))) {
    return { error: `no file at "${path}". Paths come from list_files (folder line + "/" + filename).` };
  }
  const bytes = await readBinaryFile(path);
  if (bytes.length > MAX_PDF_BYTES) {
    return { error: `"${rawPath}" is ${(bytes.length / 1024 / 1024).toFixed(0)}MB — over the 150MB per-file limit.` };
  }
  return {
    dataUrl: `data:application/pdf;base64,${bytesToBase64(bytes)}`,
    name: baseName(path) || "document.pdf",
  };
}

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
  if (kind === "pdf" && !model.pdfInput) return null;
  if (kind === "imagegen" && model.type !== "image") return null;
  // The mirror of the image check: that one refuses a model that cannot draw,
  // this one refuses a model that has not been *declared* a translation model —
  // and here the failure is silent rather than loud, which is why it is checked
  // at all. A general model handed Sakura's fixed template answers something
  // plausible; nothing errors, and the author reads a worse translation as the
  // feature working.
  if (kind === "translate" && !isTranslateOnly(model)) return null;
  // The writer is the one kind with no capability to test for — any text model
  // can write — so the check runs the other way, excluding what cannot: an
  // image/video model has no prose to give, and a translation-only model is the
  // silent failure of the set. Sakura bound here reports no error at all; it
  // just returns the work order back, translated. That is a worse outcome than
  // an unset switch, so it is refused rather than warned about.
  if (kind === "writer" && (model.type === "image" || model.type === "video")) return null;
  if (kind === "writer" && isTranslateOnly(model)) return null;
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
 * docs/feature/agent/subagent-lld.md §6.1).
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

  // `refs` is the parameter's pre-1.28 spelling, still accepted.
  const args = parseArgs<{ kind?: string; task?: string; references?: string[]; refs?: string[] }>(
    call.arguments,
  );
  const kind = args.kind as DelegateKind;
  if (!DELEGATE_KINDS.includes(kind)) {
    if ((args.kind as SubAgentKind) === "imagegen") {
      return fail("images are not delegated — call generate_image, edit_image or redraw_lore_image directly.");
    }
    return fail(`unknown subagent kind "${args.kind}". Must be one of: search, vision, longread, pdf.`);
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
  if (kind === "pdf" && !conn.model.pdfInput) {
    return fail(
      `the pdf subagent's model "${conn.model.name}" is not declared to accept PDF files. ` +
        `Tell the author to enable PDF input on it in Settings → Models, or read the document another way.`,
    );
  }

  const refs = ((args.references ?? args.refs) ?? []).filter((r) => typeof r === "string" && r.trim());
  const preset = SUB_PRESETS[kind];

  // Two templates, not one with an interpolated blank: the refs-bearing key
  // carries its own 「参考资源」 heading, so reusing it with nothing to list
  // handed the subagent an empty section — an instruction to consult sources
  // that aren't there.
  let userContent: MessageContent = refs.length
    ? i18n.t("ai.instructions.subagentTaskWithRefs", {
        task,
        refs: refs.map((r) => `- ${r}`).join("\n"),
      })
    : i18n.t("ai.instructions.subagentTask", { task });

  // The pdf kind is the one whose refs are *payload*, not reading list: each
  // is loaded here and attached as a file part, because the sub-run has no
  // tool that could fetch a document later — the request is the whole job.
  // Files precede the instruction, matching the vendor's documented order.
  if (kind === "pdf") {
    const pdfRefs = refs.filter((r) => r.toLowerCase().endsWith(".pdf"));
    if (!pdfRefs.length) {
      return fail("the pdf subagent needs at least one .pdf path in 'refs' — pass the document's full path from list_files.");
    }
    if (pdfRefs.length > MAX_PDF_FILES) {
      return fail(`too many PDFs (${pdfRefs.length}) — delegate at most ${MAX_PDF_FILES} per call, splitting the job if needed.`);
    }
    const parts: ContentPart[] = [];
    for (const ref of pdfRefs) {
      const loaded = await loadProjectPdf(ctx.projectPath, ref);
      if ("error" in loaded) return fail(loaded.error);
      parts.push({ type: "file", file: { file_data: loaded.dataUrl, filename: loaded.name } });
    }
    parts.push({ type: "text", text: i18n.t("ai.instructions.subagentTask", { task }) });
    userContent = parts;
  }

  const messages: StreamMessage[] = [
    { role: "system", content: i18n.t(`ai.instructions.subagent.${kind}`) },
    { role: "user", content: userContent },
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
        // 围栏跟着子对话走。不继承的话，把活派给子代理就成了绕过取材范围的方法
        // ——而那正是「委派」最不该有的副作用。
        loreScope: ctx.loreScope,
        multimodal: conn.model.type === "multimodal",
        // Threaded through so this stays correct if a delegate preset ever
        // gains a lore write tool (none has one today). runAgent clones the
        // index per run, so a child's writes reach disk and the app but not the
        // parent's snapshot — self-healing, since the parent's next syncLore
        // re-reads disk.
        onLoreChanged: ctx.onLoreChanged,
        onMemoryChanged: ctx.onMemoryChanged,
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
