/**
 * Tool registry for the agent runtime.
 *
 * Every tool the model can call is registered here once: its wire definition
 * (OpenAI function schema), its access level, and its executor. Task presets
 * (presets.ts) pick tools by id; the runtime resolves definitions and dispatches
 * calls through this registry instead of a hardcoded switch.
 *
 * Access levels gate what a tool may do to the project:
 *   - "read"           — no writes anywhere (current four tools)
 *   - "write-auto"     — may write lore/.ai-writer state; applied automatically
 *                        with a backup (PR2)
 *   - "write-approval" — produces a proposal the user must approve before it
 *                        lands (manuscript edits, PR4)
 * The runtime itself only executes; enforcement of the write policies lives
 * with the write tools' executors + the approval queue (see
 * docs/feature/agent/unified-agent-plan.md §3.2).
 */


import type { ToolDefinition } from "../ai/types";
import i18n from "../../i18n";
import { loreCategories, loreCategoryIds } from "../profile/active";
import { categoryRef } from "../profile/model";
import { type ToolCall, type ToolResult } from "./tools";
import { autoLoadMessage, isSearchableGroup, SEARCHABLE_GROUPS, type SearchableTools } from "./toolSearch";

import { CATEGORY_PLACEHOLDER } from "./toolTable/shared";
import { READ_TOOLS } from "./toolTable/read";
import { LORE_TOOLS } from "./toolTable/lore";
import { COLLECTOR_TOOLS } from "./toolTable/collectors";
import { MANUSCRIPT_TOOLS } from "./toolTable/manuscript";
import { EXPORT_TOOLS } from "./toolTable/exports";
import { IMAGE_TOOLS } from "./toolTable/image";
import { MANUSCRIPT_DELETE_TOOLS } from "./toolTable/manuscriptDelete";
import { SCRATCHPAD_TOOLS } from "./toolTable/scratchpad";
import { ROLEPLAY_TOOLS } from "./toolTable/roleplay";
import { SUB_RUN_TOOLS } from "./toolTable/subRuns";

export type * from "./toolTypes";
import type { ToolContext, ToolGroup, DescribeContext, RegisteredTool, ToolId } from "./toolTypes";

/**
 * Every tool, in declaration order — the fragments' order below *is* the wire
 * order (`toolDefinitionsSnapshot.test.ts` pins it). A new tool goes into the
 * fragment of its domain; a new fragment goes where its tools should appear.
 */
const REGISTRY: Record<ToolId, RegisteredTool> = {
  ...READ_TOOLS,
  ...LORE_TOOLS,
  ...COLLECTOR_TOOLS,
  ...MANUSCRIPT_TOOLS,
  ...EXPORT_TOOLS,
  ...IMAGE_TOOLS,
  ...MANUSCRIPT_DELETE_TOOLS,
  ...SCRATCHPAD_TOOLS,
  ...ROLEPLAY_TOOLS,
  ...SUB_RUN_TOOLS,
};

/**
 * Copy a tool definition with everything category-dependent resolved from the
 * active profile: the `enum` of each parameter named in `profileCategoryParams`,
 * and any `{{categories}}` placeholder in the description.
 *
 * Copies rather than mutates: REGISTRY is shared across every run, and writing
 * into it would leave one project's categories in place after the author
 * switched profiles. Only the objects on the path being changed are cloned —
 * the untouched parameter schemas are shared, which is safe because nothing
 * else writes to them.
 */
function withProfileCategories(
  definition: ToolDefinition,
  params: readonly string[] | undefined,
): ToolDefinition {
  const describesCategories = definition.function.description.includes(CATEGORY_PLACEHOLDER);
  if (!describesCategories && !params?.length) return definition;

  const ids = loreCategoryIds();
  const fn = { ...definition.function };

  // A tool that names the categories in prose is as misleading as a wrong enum:
  // told "characters, world, …", a model asks for lore that doesn't exist here.
  // Rendered through `categoryRef` — `id(label)` — because the id alone is the
  // other half of that bug: a model that has never seen 「characters ＝ 人物」
  // answers a Chinese author by creating a duplicate category. This rides the
  // resident schema (~40 tokens for the default workspace), priced in
  // agentToolBudget.test.ts when the resident cap moved to 12,000.
  if (describesCategories) {
    const refs = loreCategories().map((c) => categoryRef(c, i18n.language === "zh-CN"));
    // split/join rather than replaceAll — the project's TS target predates it.
    fn.description = fn.description.split(CATEGORY_PLACEHOLDER).join(refs.join(", "));
  }

  const properties = definition.function.parameters.properties;
  if (params?.length && properties && typeof properties === "object") {
    const nextProperties: Record<string, unknown> = { ...(properties as Record<string, unknown>) };
    for (const name of params) {
      const schema = nextProperties[name];
      if (!schema || typeof schema !== "object") continue;
      nextProperties[name] = { ...(schema as Record<string, unknown>), enum: ids };
    }
    fn.parameters = { ...definition.function.parameters, properties: nextProperties };
  }

  return { ...definition, function: fn };
}

/**
 * Split a toolset into what the request carries from the start and what waits
 * for the run to earn it, preserving order within each part.
 *
 * Order matters twice over. It is what the model reads, and — on the Anthropic
 * family — it is the cached prefix (`lib/ai/anthropic.ts`): keeping the
 * resident tools in their original positions means a group loading mid-run
 * appends to the array rather than reshuffling it, so the cached prefix
 * covering the resident half survives the load.
 */
export function partitionByGroup(
  ids: readonly ToolId[],
  /** Searchable groups the preset keeps resident (`TaskPreset.residentGroups`). */
  residentGroups: readonly ToolGroup[] = [],
): {
  resident: ToolId[];
  deferred: Record<ToolGroup, ToolId[]>;
  /** The deferred groups the model loads itself, non-empty ones only. */
  searchable: SearchableTools;
} {
  const resident: ToolId[] = [];
  const deferred: Record<ToolGroup, ToolId[]> = {
    lore_write: [],
    lore_organize: [],
    file_ops: [],
    image: [],
  };
  for (const id of ids) {
    const group = REGISTRY[id].group;
    if (group && !residentGroups.includes(group)) deferred[group].push(id);
    else if (id !== "search_tools") resident.push(id);
  }
  const searchable: SearchableTools = {};
  for (const g of SEARCHABLE_GROUPS) if (deferred[g].length) searchable[g] = deferred[g];
  // Last, so the resident order before it is the preset's own and the only
  // thing a toolset without searchable groups sees is exactly what it had.
  if (Object.keys(searchable).length) resident.push("search_tools");
  return { resident, deferred, searchable };
}

/** Every searchable group at its widest — the fallback when no run shape is given. */
function allSearchable(): SearchableTools {
  const groups: SearchableTools = {};
  for (const g of SEARCHABLE_GROUPS) {
    groups[g] = (Object.keys(REGISTRY) as ToolId[]).filter((id) => REGISTRY[id].group === g);
  }
  return groups;
}

/**
 * May one round's call to this tool run concurrently with its neighbours?
 *
 * The read tier — `delegate` included — is pure IO against its own inputs:
 * nothing it touches is mutated by another read, so a round of several may
 * overlap. Every write tool says no, and for two different reasons that both
 * matter: the L2 tools block on an approval card (two in flight is two stacked
 * cards, and editApply's occurrence count assumes the document does not move
 * between proposal and apply), and the L1 auto tools mutate the run's lore
 * snapshot and the disk under it. `access` is already the exact boundary, so
 * the answer is derived from it rather than kept as a second list to drift.
 *
 * Unknown names are safe by construction: `executeRegisteredTool` answers them
 * with error text without executing anything.
 */
export function isParallelSafeTool(name: string): boolean {
  const tool = (REGISTRY as Record<string, RegisteredTool | undefined>)[name];
  return !tool || tool.access === "read";
}

/**
 * Every tool id in the registry, in declaration order.
 *
 * Derived from `REGISTRY` rather than written out, so a sweep over "all tools"
 * cannot silently miss a new one — which is the whole value of the convention
 * checks in `agentToolConventions.test.ts`: a hand-copied list would be a list
 * that stops covering the tool added the day after it was written.
 */
export const ALL_TOOL_IDS = Object.keys(REGISTRY) as ToolId[];

/**
 * Whether `id` is fenced behind an open folder — see
 * {@link RegisteredTool.projectFree}. Exposed so the convention test can pin
 * the exemption list, which is the half of this rule a reviewer can't check.
 */
export function toolNeedsProject(id: ToolId): boolean {
  return !REGISTRY[id].projectFree;
}

/** Resolve wire definitions for a preset's toolset, preserving order. */
export function getToolDefinitions(
  ids: readonly ToolId[],
  /**
   * The run's searchable groups, for `search_tools`' catalogue. Omitted by
   * callers that only price a toolset, which then get the widest catalogue — an
   * upper bound, the safe side for a budget.
   */
  searchable?: SearchableTools,
  /** `ToolContext.searchReadsPages` — see `describeDelegate`. */
  searchReadsPages = false,
): ToolDefinition[] {
  let describeCtx: DescribeContext | undefined;
  return ids.map((id) => {
    const tool = REGISTRY[id];
    if (tool.describe) describeCtx ??= { searchable: searchable ?? allSearchable(), searchReadsPages };
    const definition = tool.describe && describeCtx
      ? { ...tool.definition, function: { ...tool.definition.function, description: tool.describe(describeCtx) } }
      : tool.definition;
    return withProfileCategories(definition, tool.profileCategoryParams);
  });
}

/**
 * Execute one model-requested tool call. Unknown tools and executor throws both
 * come back as error-text results — the model gets to read the error and retry,
 * and a single bad call never kills the run.
 */
/**
 * 一个**这次运行有、但还没装载**的延迟工具被调用时说什么。
 *
 * 存在的理由是一次真实的死路：派单去建一条条目、方案里只有 entity 步骤，于是
 * `lore_organize` 整组没装；模型想把新条目归进集合，改 frontmatter 被
 * `update_lore_file` 拒绝（那条守卫是对的），转头调 `file_lore_entries` 得到
 * 「Unknown tool」——它只能读成「这个工具不存在」，于是放弃并回头问作者。而正确的
 * 下一步一直在那儿：重新 `propose_lore_plan` 带一条 collection 步骤，工具下一轮就装上。
 * 没有任何一处说出这句话，所以这里说。
 *
 * 只对**这次运行的预设里真有**的工具这么说（`pending`），否则就是在承诺一个这个
 * surface 根本给不了的能力——`tool-presence.md` 的契约。
 */
function unloadedToolMessage(name: string, group: ToolGroup): string {
  if (isSearchableGroup(group)) {
    return `Error: ${name} is not loaded yet. Call search_tools with "${group}" first, then use ${name} on the next round.`;
  }
  const organize = group === "lore_organize";
  const how = organize
    ? "a plan step whose `target` is 'collection' (or 'category' for a new one)"
    : "a plan step naming the entity you mean to change";
  return (
    `Error: ${name} is not loaded yet — it is withheld until the plan covers it, not missing. ` +
    `It becomes callable as soon as the author approves ${how}: call propose_lore_plan again with that step included, ` +
    `then use ${name} on the next round.` +
    // 绕过去的那条路只有归集那一支有（改 index.md 的 frontmatter），而它已经被
    // update_lore_file 挡住了。对 create/update 那一支说这句话是无的放矢。
    (organize ? " Do not work around it by rewriting an entry's frontmatter." : "")
  );
}

export async function executeRegisteredTool(
  call: ToolCall,
  allowed: readonly ToolId[],
  ctx: ToolContext,
  /**
   * 这次运行的预设里有、但所属延迟组还没装载的工具。由 `runtime` 传入——只有它
   * 知道预设的全貌和已装载的组。缺席即「没有这类工具」，报文退回原来那句。
   */
  pending: readonly ToolId[] = [],
): Promise<ToolResult> {
  // Narrowed rather than asserted: `call.name` is whatever the model emitted,
  // so a double cast here would hand a `RegisteredTool` shape to something
  // that may be undefined.
  const isAllowed = (name: string): name is ToolId =>
    (allowed as readonly string[]).includes(name);
  const tool = isAllowed(call.name) ? REGISTRY[call.name] : undefined;
  if (!tool) {
    const waiting = (pending as readonly string[]).includes(call.name)
      ? REGISTRY[call.name as ToolId]?.group
      : undefined;
    // A searchable group has no gate to wait for: the model asking for one of
    // its tools by name IS the request, so load the group and say so.
    if (waiting && isSearchableGroup(waiting) && ctx.toolSearch) {
      ctx.toolSearch.load([waiting]);
      return { toolCallId: call.id, content: autoLoadMessage(call.name, waiting) };
    }
    return {
      toolCallId: call.id,
      content: waiting
        ? unloadedToolMessage(call.name, waiting)
        : `Unknown tool: ${call.name}`,
    };
  }
  // The fence (see RegisteredTool.projectFree). Here rather than in each
  // handler because it has to hold for the forty-odd that never thought about
  // it, and for the next one: this is the single door every model-requested
  // call comes through, on every surface, including a subagent's and a pack's.
  if (!tool.projectFree && !ctx.projectPath) {
    return {
      toolCallId: call.id,
      content: `Error: no folder is open, so ${call.name} has nothing to read or write. Do not call any other tool either — tell the author to open a folder first.`,
    };
  }
  try {
    // A copy, not a mutation: ctx is shared across a round's calls. Handlers
    // that patch run state do it through the objects ctx points at (the lore
    // snapshot, the plan gate), which the spread preserves by reference.
    return await tool.execute(call, { ...ctx, allowedTools: allowed });
  } catch (e) {
    return { toolCallId: call.id, content: `Error: ${String(e)}` };
  }
}
