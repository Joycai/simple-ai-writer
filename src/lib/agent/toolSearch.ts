/**
 * 按需找工具（`search_tools`）：模型自己把一组还没下发的工具要过来。
 *
 * 延迟组有两种装法。`lore_write` / `lore_organize` 由**已批准的方案**装——那一门
 * 本来就在，批准之前它们调不动，所以不发不损失任何能力。这里的两组没有那样的门：
 * 改名、复制、删文件，画图、改图，任何一轮都可能合法地用到，只是**大多数对话用不到**。
 * 于是把「要不要」交给模型：常驻一个很小的 `search_tools`，description 里带一份
 * 分组目录，模型调它，下一轮这组工具就在。
 *
 * 这条路 `agent-tool-context-lld.md` §6 否过一次（当时叫 `load_tools`），理由是
 * 小模型多一层间接就做不成。重开的依据与实测记在同一份文档的 §6——改这里之前先读。
 *
 * 两个不靠模型配合的兜底，都是为了让「先开口要」这一步失败时不至于变成死路：
 *   - 模型不经搜索、直接按名字调了一个未装载的工具（目录里有名字，
 *     别的工具的结果文本也会点名）：当场装上，报文让它下一轮再调一次。
 *   - 同一段对话里前几轮用过的组，新一轮运行开跑时直接装上——每轮对话是一次新运行，
 *     不能让模型每轮都重新要一遍。
 */

import type { StreamMessage } from "../ai/types";
import type { ToolGroup, ToolId } from "./registry";

/** 由模型按需装载的延迟组。其余延迟组由方案装载，见 `runtime.ts`。 */
export type SearchableGroup = Extract<ToolGroup, "file_ops" | "image">;

export const SEARCHABLE_GROUPS: readonly SearchableGroup[] = ["file_ops", "image"];

export function isSearchableGroup(group: ToolGroup): group is SearchableGroup {
  return (SEARCHABLE_GROUPS as readonly ToolGroup[]).includes(group);
}

/** 一次运行里可搜的组及其工具（routing 之后仍在场、且非空的那些）。 */
export type SearchableTools = Partial<Record<SearchableGroup, readonly ToolId[]>>;

/** 运行时注入给工具的句柄：`search_tools` 与未装载工具的兜底都通过它装组。 */
export interface ToolSearchHandle {
  groups: SearchableTools;
  /**
   * Whether this run's knowledge-base writes wait behind `propose_lore_plan`.
   * A model looking for them here is looking in the wrong place, and "no match"
   * alone reads as "they don't exist" — measured: 4/10 runs of the plan-first
   * task searched for update_lore_meta and stopped there (lld §6.1).
   */
  planGated?: boolean;
  /** 排进下一轮开头装载；已装的、本次没有的组忽略。 */
  load(groups: readonly SearchableGroup[]): void;
  isLoaded(group: SearchableGroup): boolean;
}

interface CatalogueEntry {
  /** 目录里的一行，写给模型看：这组能做什么。 */
  summary: string;
  /**
   * 查询里出现任何一个就算命中。中英都收：模型多半用作者的语言描述需求。
   * 宁宽勿窄——多装一组只多花这一次的 schema，漏装则是一轮白跑。
   */
  keywords: readonly string[];
}

const CATALOGUE: Record<SearchableGroup, CatalogueEntry> = {
  file_ops: {
    summary: "rename or move, copy, and delete files or folders; create a new chapter or an empty folder",
    keywords: [
      "file", "folder", "director", "chapter", "move", "rename", "copy", "duplicate", "delete", "remove",
      "文件", "目录", "章", "移动", "改名", "重命名", "复制", "删除", "删掉", "新建", "整理",
    ],
  },
  image: {
    summary: "draw a new picture, or redraw / edit an existing one (costs money; the author approves each)",
    keywords: [
      "image", "picture", "draw", "illustrat", "portrait", "paint", "photo",
      // 不收单个「图」：流程图、架构图按 briefing 该写成 HTML，不该把画图工具招进来。
      "图片", "配图", "插图", "头像", "立绘", "照片", "画",
    ],
  },
};

/**
 * `search_tools` 的 description。只列这次运行**真有**的组——没绑图像模型时
 * image 组被 routing 摘空，目录里就不能再出现它（`tool-presence.md`）。
 *
 * 已装载的组照样列着：description 变了，Anthropic 的缓存前缀就断在这个工具上，
 * 而它排在常驻工具的最后，断了等于常驻半边白缓存。
 */
export function describeSearchTools(groups: SearchableTools): string {
  const lines = SEARCHABLE_GROUPS.flatMap((g) => {
    const tools = groups[g];
    return tools?.length ? [`- ${g}: ${CATALOGUE[g].summary} (${tools.join(", ")})`] : [];
  });
  return [
    "Load a group of tools that is not in your tool list yet. When the task needs one of the groups below, call this FIRST — the group's tools become callable on your next step and stay for the rest of the task. Do not tell the author you cannot do something a group below covers.",
    ...lines,
    "Pass the group name, or a few words describing what you need.",
  ].join("\n");
}

/** 查的是知识库写入——那一组由方案装载，不归这里管。 */
const PLAN_WORDS = ["lore", "knowledge", "entity", "entry", "alias", "facet", "collection", "category",
  "知识库", "条目", "别名", "特征", "集合", "分类"];

/** 查询命中的组：组名、工具名、关键词三选一，按目录顺序。 */
export function matchGroups(query: string, groups: SearchableTools): SearchableGroup[] {
  const q = query.toLowerCase();
  return SEARCHABLE_GROUPS.filter((g) => {
    const tools = groups[g];
    if (!tools?.length) return false;
    if (q.includes(g) || tools.some((t) => q.includes(t))) return true;
    return CATALOGUE[g].keywords.some((k) => q.includes(k));
  });
}

export function runSearchTools(query: string, handle: ToolSearchHandle | undefined): string {
  if (!handle || SEARCHABLE_GROUPS.every((g) => !handle.groups[g]?.length)) {
    return "Error: there are no further tools to load in this run.";
  }
  const hits = matchGroups(query, handle.groups);
  if (hits.length === 0) {
    if (handle.planGated && PLAN_WORDS.some((w) => query.toLowerCase().includes(w))) {
      return (
        "Knowledge-base writes are not loaded through search_tools. They arrive once the author approves a plan: " +
        "call propose_lore_plan with the change you intend, and after approval the write tools are in your list."
      );
    }
    const names = SEARCHABLE_GROUPS.filter((g) => handle.groups[g]?.length);
    return (
      `No tool group matches "${query}". Call search_tools again with one of: ${names.join(", ")}. ` +
      "If none of them fits, the task needs no extra tools — use the ones you already have."
    );
  }
  const lines = hits.map((g) => {
    const tools = (handle.groups[g] ?? []).join(", ");
    return handle.isLoaded(g)
      ? `${g} is already loaded: ${tools}.`
      : `Loaded ${g}: ${tools}.`;
  });
  handle.load(hits);
  return `${lines.join("\n")}\nCall them from your next step; their parameters are in your tool list from then on.`;
}

/** 模型直接调了一个还没装的可搜工具：当场装上，并说清楚为什么这次没执行。 */
export function autoLoadMessage(name: string, group: SearchableGroup): string {
  return (
    `Error: ${name} was not loaded yet, so this call did not run. It is loaded now (group ${group}) — ` +
    `call ${name} again on your next step; its parameters are in your tool list from then on.`
  );
}

/**
 * 这段对话前几轮已经用过的组：历史里调过组内工具，或调过命中该组的 `search_tools`。
 * 与 `matchGroups` 同一个判据，所以「上一轮要到了」和「这一轮开跑就有」对得上。
 */
export function groupsUsedIn(history: readonly StreamMessage[], groups: SearchableTools): SearchableGroup[] {
  const used = new Set<SearchableGroup>();
  for (const message of history) {
    if (message.role !== "assistant" || !("tool_calls" in message)) continue;
    for (const call of message.tool_calls) {
      const name = call.function.name;
      if (name === "search_tools") {
        let query = "";
        try {
          query = String((JSON.parse(call.function.arguments || "{}") as { query?: unknown }).query ?? "");
        } catch {
          continue;
        }
        for (const g of matchGroups(query, groups)) used.add(g);
        continue;
      }
      for (const g of SEARCHABLE_GROUPS) {
        if ((groups[g] as readonly string[] | undefined)?.includes(name)) used.add(g);
      }
    }
  }
  return SEARCHABLE_GROUPS.filter((g) => used.has(g));
}
