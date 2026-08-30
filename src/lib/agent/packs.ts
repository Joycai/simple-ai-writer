/**
 * Tool packs — focused write toolsets a run *dispatches to* instead of carrying.
 *
 * The problem this solves is the resident tool bill: schemas resend every
 * round, and chat is the one surface that cannot know in advance which class
 * of work the author will ask for, so it carries everything (~10k resident).
 * A pack is one class of work (write documents / edit the knowledge base /
 * export) bundled as a preset; `run_pack` hands a self-contained brief to a
 * sub-run that carries only that pack. Design, bench evidence and the
 * decisions (D1–D4): docs/feature/agent/tool-pack-plan.md.
 *
 * What a pack sub-run is — and is not:
 *
 *   - It runs on the **parent's own model** (D1). Unlike delegate subagents,
 *     whose reason to exist is a *different* model (vision/search/Sakura), a
 *     pack's reason is a narrower toolset; the model doesn't change, so the
 *     conn is the parent run's own, injected as `ToolContext.selfConn`.
 *   - It is **not** `delegate` (D2): delegate's contract is read-only work
 *     summarised into a note; a pack writes, and blocks on the author's cards.
 *   - Approvals and the plan gate stay on the main surface (D3): the child
 *     context receives the parent's `requestApproval` / `requestPlanApproval` /
 *     `lorePlan` **objects themselves**, so a card renders exactly where it
 *     always does and a plan the author approved this turn keeps covering the
 *     pack's writes — the runtime reloads deferred groups from the shared
 *     gate's steps on the child's first round.
 *   - The task workspace passes through unchanged: notes the parent collected
 *     are the material bus (`read_note`), and the pack's closing report lands
 *     as a note beside them.
 */

import i18n from "../../i18n";
import type { StreamMessage } from "../ai/types";
import { costFor, type Model } from "../ai/configDb";
import { connOptions, type AiConn } from "../ai/conn";
import { persistUsage } from "../ai/usage";
import { CONTEXT_UTILIZATION_DEFAULT, inputCeilingFor } from "../context/budget";
import { isDocxExportEnabled } from "../docx/flag";
import { isPptxExportEnabled } from "../pptx/flag";
import { isXlsxExportEnabled } from "../xlsx/flag";
import { AGENT_ASSIST_PRESET, type TaskPreset } from "./presets";
import { isOrchestratorEnabled } from "./packFlag";
import { partitionByGroup } from "./registry";
import type { ToolContext, ToolId } from "./registry";
import { runAgent, type AgentRunResult } from "./runtime";
import { toolTokensOf } from "./toolCost";
import type { ToolCall, ToolResult } from "./tools";
import { writeTaskNote } from "./taskWorkspace";
import { syncLore } from "./writeTools";

export type PackId = "file_write" | "lore_edit" | "export";

export const PACK_IDS: readonly PackId[] = ["file_write", "lore_edit", "export"];

/**
 * The read set every pack carries: a specialist still has to look at what it
 * is changing, and the parent's materials arrive as note paths (`read_note`).
 * Deliberately *small* — no images, no memory, no workflow cards: a pack is
 * dispatched with its research already done, and every schema here rides on
 * each of the sub-run's rounds.
 */
const PACK_READS: readonly ToolId[] = [
  "list_files",
  "read_file",
  "read_slides",
  "search_text",
  "list_lore_entities",
  "read_lore_entity",
  "read_note",
  "list_notes",
];

/**
 * The three packs (tool-pack-plan §3.1). maxRounds are the plan's §8 initial
 * numbers — sized to each job's shape, and to be revisited with slice-3 data:
 * a document job is read→write→verify per file (16); a knowledge-base pass is
 * one read per entity plus a plan round before any write (24); an export is
 * read→convert (8).
 *
 * `lore_edit` lists the two deferred groups the way AGENT_ASSIST does: listing
 * is what lets `partitionByGroup` defer them, so the sub-run's resident half
 * stays plan-gate cheap and the groups load when the (shared) gate's steps
 * demand them.
 */
export const PACK_PRESETS: Record<PackId, TaskPreset> = {
  file_write: {
    id: "pack-file-write",
    tools: [
      ...PACK_READS,
      "inspect_html",
      "propose_edit",
      "rewrite_lines",
      "rewrite_document",
      "append_file",
      "create_chapter",
      "create_file",
      "create_directory",
      "move_chapter",
      "copy_file",
      "delete_chapter",
      "delete_directory",
    ],
    maxRounds: 16,
    finishPolicy: "force-text",
    serverTools: "off",
  },
  lore_edit: {
    id: "pack-lore-edit",
    tools: [
      ...PACK_READS,
      "read_lore_image",
      "propose_lore_plan",
      "create_lore_entity",
      "create_lore_facet",
      "update_lore_file",
      "update_lore_meta",
      "append_lore_file",
      "edit_lore_file",
      "rewrite_lore_lines",
      "update_facet_meta",
      "delete_lore_file",
      "set_lore_avatar",
      "copy_lore_file",
      "move_lore_entity",
      "delete_lore_entity",
      "manage_collection",
      "file_lore_entries",
      "create_lore_category",
    ],
    maxRounds: 24,
    finishPolicy: "force-text",
    serverTools: "off",
  },
  export: {
    id: "pack-export",
    tools: [...PACK_READS, "export_pptx", "export_docx", "export_xlsx", "read_doc_format"],
    maxRounds: 8,
    finishPolicy: "force-text",
    serverTools: "off",
  },
};

/**
 * The orchestrator tier — chat's thin resident half when the tool-pack Beta is
 * on (tool-pack-plan §3.1, slice 3).
 *
 * What it keeps is what the plan's §1 table says should be resident: the whole
 * read/search set, story memory (both halves — memory upkeep is tiny and
 * frequent, exactly the wrong shape to pay a dispatch for), the task
 * workspace (its notes are the material bus every brief points into), and the
 * image-generation trio — 生图不进 pack: those tools already have their own
 * shape (imagegen subagent + routing strips them when no binding is live), so
 * listing them here costs nothing for an author without the binding.
 *
 * What it deliberately does NOT hold: any document, knowledge-base or export
 * write tool — that is D4's clean boundary ("主控不持有任何写工具"), the thing
 * that makes the answer to "who writes?" one word. `run_pack` / `delegate` /
 * `ask_author` are appended by routing, same as on the assist preset.
 *
 * maxRounds matches AGENT_ASSIST: it is also what one 继续 press grants, and
 * an orchestrator round is cheap by construction — the cap is about runaway
 * loops, not about budget.
 */
export const ORCHESTRATOR_PRESET: TaskPreset = {
  id: "agent-orchestrator",
  tools: [
    "list_lore_entities",
    "read_lore_entity",
    "read_lore_image",
    "read_image",
    "list_files",
    "read_file",
    "read_slides",
    "search_text",
    "read_memory",
    "read_workflow",
    "update_memory",
    "generate_image",
    "edit_image",
    "redraw_lore_image",
    "task_plan",
    "task_progress",
    "write_note",
    "read_note",
    "list_notes",
  ],
  maxRounds: 40,
  finishPolicy: "force-text",
  scratchpad: "required",
};

/**
 * The preset chat runs on, resolved from the Beta switch — the ONE seam every
 * chat-side reader goes through (ceiling, routing, round cap, briefing choice,
 * the context meter). Two of these disagreeing is exactly the drift the
 * messageCeilingFor comment warns about, so nothing reads the flag directly.
 *
 * Read at call time, never cached: the author can flip the switch in Settings
 * between turns. (The system-layer *briefing* is still seeded once per
 * session — a mid-session flip changes the toolset on the next turn but keeps
 * the old briefing until a new session, same read-once contract as the
 * workflow roster.)
 */
export function chatAgentPreset(): TaskPreset {
  return isOrchestratorEnabled() ? ORCHESTRATOR_PRESET : AGENT_ASSIST_PRESET;
}

/** Same clip as a delegate's summary — the artefacts are on disk, not in here. */
const PACK_SUMMARY_CHARS = 800;

/** How much of the brief survives into the report note's filename. */
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
 * The export pack's toolset with the Beta switches applied — the same rule
 * `routeTools` applies to the main preset: an export the author hasn't turned
 * on is *absent*, not refused. Returns the tools, or null when every export
 * line is off, in which case the pack itself must be refused (a specialist
 * with nothing but read tools would "finish" without exporting anything).
 */
function exportPackTools(): ToolId[] | null {
  const tools = PACK_PRESETS.export.tools.filter((t) => {
    if (t === "export_pptx") return isPptxExportEnabled();
    if (t === "export_docx" || t === "read_doc_format") return isDocxExportEnabled();
    if (t === "export_xlsx") return isXlsxExportEnabled();
    return true;
  });
  return tools.some((t) => t.startsWith("export_")) ? [...tools] : null;
}

/**
 * Execute a run_pack tool call: a nested run of the pack's preset on the
 * parent's own model, with the parent's approval channels passed through.
 */
export async function executeRunPack(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({
    toolCallId: call.id,
    content: `Error: ${msg}`,
  });

  if (!ctx.taskWorkspace || !ctx.signal || !ctx.onNestedEvent || !ctx.selfConn) {
    return fail("this surface cannot run tool packs — do not call this tool here.");
  }

  const args = parseArgs<{ pack?: string; task?: string; references?: string[]; refs?: string[] }>(
    call.arguments,
  );
  const pack = args.pack as PackId;
  if (!PACK_IDS.includes(pack)) {
    return fail(`unknown pack "${args.pack}". Must be one of: file_write, lore_edit, export.`);
  }
  const task = args.task?.trim();
  if (!task) {
    return fail("'task' is required — state the whole job, the pack agent cannot see this conversation.");
  }

  // Fail fast on a missing channel instead of letting the sub-run burn rounds
  // discovering it one refused write at a time. Which channel is "the" channel
  // differs by pack: manuscript/export writes block on the approval card,
  // knowledge-base writes on the plan gate.
  if ((pack === "file_write" || pack === "export") && !ctx.requestApproval) {
    return fail(`the ${pack} pack needs the approval card, which this surface cannot render.`);
  }
  if (pack === "lore_edit" && (!ctx.requestPlanApproval || !ctx.lorePlan)) {
    return fail("the lore_edit pack needs the plan-approval card, which this surface cannot render.");
  }

  let tools: ToolId[] = [...PACK_PRESETS[pack].tools];
  if (pack === "export") {
    const filtered = exportPackTools();
    if (!filtered) {
      return fail(
        "every export format is switched off (Settings → 通用 → 实验功能) — tell the author which Beta to enable instead of dispatching.",
      );
    }
    tools = filtered;
  }
  const preset: TaskPreset = { ...PACK_PRESETS[pack], tools };

  const refs = ((args.references ?? args.refs) ?? []).filter(
    (r) => typeof r === "string" && r.trim(),
  );
  const userContent = refs.length
    ? i18n.t("ai.instructions.subagentTaskWithRefs", {
        task,
        refs: refs.map((r) => `- ${r}`).join("\n"),
      })
    : i18n.t("ai.instructions.subagentTask", { task });

  const messages: StreamMessage[] = [
    { role: "system", content: i18n.t(`ai.instructions.pack.${pack}`) },
    { role: "user", content: userContent },
  ];

  const conn: AiConn = ctx.selfConn;
  // The sub-run sizes its own message ceiling the way every surface does
  // (toolCost.messageCeilingFor's subtraction, inlined here because the pack's
  // toolset is already resolved): the window is the model's, the schema share
  // is the pack's resident half — the runtime shrinks it further if the shared
  // plan gate loads a deferred group mid-run.
  const { resident } = partitionByGroup(preset.tools);
  const inputCeilingTokens = Math.max(
    0,
    inputCeilingFor(conn.model.contextSize, ctx.contextUtilization ?? CONTEXT_UTILIZATION_DEFAULT) -
      toolTokensOf(resident),
  );

  let output = "";
  let result: AgentRunResult;
  try {
    result = await runAgent({
      ...connOptions(conn),
      inputCeilingTokens,
      preset,
      messages,
      toolContext: {
        projectPath: ctx.projectPath,
        loreIndex: ctx.loreIndex,
        // 围栏跟着子运行走——把活派给 pack 不能成为绕过取材范围的方法（同 delegate）。
        loreScope: ctx.loreScope,
        organize: ctx.organize,
        multimodal: conn.model.type === "multimodal",
        onLoreChanged: ctx.onLoreChanged,
        onMemoryChanged: ctx.onMemoryChanged,
        // D3: the parent's channels, not copies. The cards render on the main
        // surface exactly as if the parent had proposed; auto-approve grants
        // ride inside the closures the caller bound.
        requestApproval: ctx.requestApproval,
        requestPlanApproval: ctx.requestPlanApproval,
        lorePlan: ctx.lorePlan,
        // The material bus: notes the parent wrote are readable by path, and
        // the pack's report note (below) lands in the same workspace.
        taskWorkspace: ctx.taskWorkspace,
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
    return fail(`the ${pack} pack failed: ${(e as Error).message}`);
  }

  // A lore_edit pack has (very likely) changed entities the parent's own run
  // snapshot still shows the old way — resync it now, exactly as the parent's
  // own write tools would have, so the turn's remaining rounds resolve what the
  // pack just created. Other packs don't touch lore; skipping the disk rescan
  // for them is the point of the condition.
  if (pack === "lore_edit") {
    await syncLore(ctx);
  }

  // The pack ran on the parent's model, but its rounds are not the parent's:
  // the nested run-done event keeps its spend visible in the log without
  // double-counting it into the parent run's own totals (same as delegate).
  ctx.onNestedEvent({
    kind: "run-done",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    at: Date.now(),
    parentStep: call.id,
  });
  const model: Model = conn.model;
  const cost = costFor(model, result.inputTokens, result.outputTokens, result.cachedTokens);
  await persistUsage(
    ctx.projectPath,
    model.id,
    result.inputTokens,
    result.outputTokens,
    cost,
    `pack:${pack}`,
    result.cachedTokens,
  );

  if (!output.trim()) {
    return fail(`the ${pack} pack returned no report. Check the execution log for what it did, or retry with a clearer brief.`);
  }

  const { taskId } = await ctx.taskWorkspace.ensure(i18n.t("ai.taskDoc.untitled"));
  const note = await writeTaskNote(ctx.projectPath, taskId, {
    slug: `pack-${pack}-${[...task].slice(0, SLUG_HINT_CHARS).join("")}`,
    title: task.slice(0, 80),
    content: output,
    sources: refs,
    origin: "pack",
  });

  return {
    toolCallId: call.id,
    content: [
      `The ${pack} pack finished. Its full report is saved to: ${note.path}`,
      `File and knowledge-base changes were made through the author's approval cards — the report says what actually landed.`,
      ``,
      `Report:`,
      clip(output, PACK_SUMMARY_CHARS),
    ].join("\n"),
  };
}
