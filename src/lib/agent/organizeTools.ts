/**
 * 重整知识库**组织结构**的工具：集合的建/改名/删、把条目归入或移出、新建分类。
 *
 * ## 为什么这些工具存在（而分类的改名/删除仍然不存在）
 *
 * `writeTools` 顶上写着一条老规矩：没有任何工具能建/改名/删分类，因为分类是作者
 * 在 app 里管的组织方案。这条规矩在「作者委派一次批量整理」面前不成立——
 * 「帮我把资料按各自的作品归类」是个完全正当的请求，而让 agent 先在聊天里报一串
 * 集合名、作者手动去建、再回来叫它归档，是把活推回给作者。
 *
 * 让它成立的不是放松，而是**审批机制本来就在**：这些工具全部挂在已批准的方案上
 * （`plan.ts`），作者在方案卡上逐行看见「新建集合《雪原书》」「归入 12 条：…」再
 * 决定。所以 agent 不能发明集合——它只能**提议**发明，批准的是人。
 *
 * 唯一保留的不对称是**分类只给 create**：分类是磁盘上的文件夹，新建只是建目录，
 * 而改名/删除会让每个成员条目的文件夹搬家，并让 `[[lore:分类/id]]` 路径引用和特征
 * 置顶失效。集合三个都给，因为它只是 frontmatter 上的一个字段，可逆且便宜。
 *
 * ## 这一组是 deferred 的
 *
 * 全部挂 `group: "lore_organize"`，方案批准之前根本不下发（`runtime.ts`）。而且是
 * **按方案形状**装载：批准一个「整理」方案才装载它们，批准一个「改写条目正文」的
 * 方案不装。这是 `agent-tool-context-lld.md` §6 认可的那条路——由运行状态自动装载，
 * 不需要模型自己开口要工具（`load_tools` 那条路被实测否掉了）。
 */

import { sameCollection, type LoreEntity } from "../lore";
import { checkPlan, type LorePlanAction } from "./plan";
import type { LoreOrganizer, ToolContext } from "./registry";
import type { ToolResult } from "./tools";
import { findEntityByName } from "./tools";

/** 缺能力时的统一说明——工具直接说清楚，而不是静默无操作。 */
const NO_ORGANIZER =
  "Error: this surface cannot reorganise the knowledge base. Report what you would change instead of calling this tool.";

function organizerOf(toolCallId: string, ctx: ToolContext): LoreOrganizer | ToolResult {
  if (!ctx.organize) return { toolCallId, content: NO_ORGANIZER };
  return ctx.organize;
}

/** 方案门，集合/分类那一侧。`member` 是正在归档的条目名（只有归集调用会传）。 */
function gate(
  toolCallId: string,
  ctx: ToolContext,
  action: LorePlanAction,
  name: string,
  target: "collection" | "category",
  member?: string,
): { refusal: ToolResult } | { ok: true } {
  const check = checkPlan(ctx.lorePlan, ctx.loreIndex, action, name, undefined, { target, member });
  return check.ok ? { ok: true } : { refusal: { toolCallId, content: check.message } };
}

// ─── manage_collection ───────────────────────────────────────────────────────

export async function manageCollectionTool(
  toolCallId: string,
  args: { op?: string; collection?: string; new_name?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const org = organizerOf(toolCallId, ctx);
  if ("content" in org) return org;

  const op = String(args.op ?? "").trim();
  const name = String(args.collection ?? "").trim();
  if (!name) return { toolCallId, content: "Error: 'collection' is required — the collection to act on." };

  const exists = org.collections.some((c: string) => sameCollection(c, name));

  if (op === "create") {
    // 已存在不算错：批量整理里模型常常给同一个集合发两次 create，报错只会让它
    // 换个名字重试，而换名字恰恰是最坏的结果（作者会得到《雪原书》和《雪原书2》）。
    if (exists) {
      return { toolCallId, content: `Collection "${name}" already exists — nothing to do. File entries into it with file_lore_entries.` };
    }
    const g = gate(toolCallId, ctx, "create", name, "collection");
    if ("refusal" in g) return g.refusal;
    await org.createCollection(name);
    return { toolCallId, content: `Created collection "${name}". It is empty until you file entries into it.` };
  }

  if (op === "rename") {
    const to = String(args.new_name ?? "").trim();
    if (!to) return { toolCallId, content: "Error: 'new_name' is required for a rename." };
    if (!exists) return { toolCallId, content: unknownCollection(name, org) };
    const g = gate(toolCallId, ctx, "move", name, "collection");
    if ("refusal" in g) return g.refusal;
    await org.renameCollection(name, to);
    return {
      toolCallId,
      content: `Renamed collection "${name}" to "${to}". Every member entry's frontmatter was rewritten, so the name in the files matches what the author sees.`,
    };
  }

  if (op === "delete") {
    if (!exists) return { toolCallId, content: unknownCollection(name, org) };
    const g = gate(toolCallId, ctx, "delete", name, "collection");
    if ("refusal" in g) return g.refusal;
    await org.deleteCollection(name);
    return {
      toolCallId,
      content: `Deleted collection "${name}". No entry was deleted — they only lost that membership; any entry that had no other collection is now unfiled.`,
    };
  }

  return { toolCallId, content: `Error: 'op' must be one of: create, rename, delete.` };
}

function unknownCollection(name: string, org: LoreOrganizer): string {
  return (
    `Error: there is no collection named "${name}". Existing collections: ${org.collections.join(", ") || "(none)"}. ` +
    "Collections are the author's own filing scheme — propose creating one in a plan step rather than assuming it exists."
  );
}

// ─── file_lore_entries ───────────────────────────────────────────────────────

export async function fileLoreEntriesTool(
  toolCallId: string,
  args: { entities?: string[]; add?: string[]; remove?: string[] },
  ctx: ToolContext,
): Promise<ToolResult> {
  const org = organizerOf(toolCallId, ctx);
  if ("content" in org) return org;

  const names = (args.entities ?? []).map((n) => String(n).trim()).filter(Boolean);
  const add = (args.add ?? []).map((n) => String(n).trim()).filter(Boolean);
  const remove = (args.remove ?? []).map((n) => String(n).trim()).filter(Boolean);
  if (names.length === 0) return { toolCallId, content: "Error: 'entities' must name at least one entry." };
  if (add.length === 0 && remove.length === 0) {
    return { toolCallId, content: "Error: pass 'add' and/or 'remove' — at least one collection to file into or out of." };
  }

  // 归入一个不存在的集合会静静造出一个只存在于 frontmatter 里的集合。拒绝，并让
  // 模型走 manage_collection —— 那条路上有方案门，作者会看见。
  for (const c of add) {
    if (!org.collections.some((x: string) => sameCollection(x, c))) {
      return { toolCallId, content: unknownCollection(c, org) };
    }
  }

  const resolved: LoreEntity[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const found = findEntityByName(ctx.loreIndex, n);
    if (found) resolved.push(found);
    else missing.push(n);
  }
  if (missing.length > 0) {
    return {
      toolCallId,
      content: `Error: no entity named ${missing.map((m) => `"${m}"`).join(", ")}. Call list_lore_entities for the exact names.`,
    };
  }

  // 逐条过门：方案里那一行列了谁，就只能动谁。这是这个工具的授权边界——批准
  // 「归入 12 条」不等于批准归入第 13 条。
  for (const entity of resolved) {
    for (const collection of [...add, ...remove]) {
      const g = gate(toolCallId, ctx, "update", collection, "collection", entity.name);
      if ("refusal" in g) return g.refusal;
    }
  }

  await org.file(resolved.map((e) => e.dirPath), add, remove);

  const parts: string[] = [];
  if (add.length) parts.push(`into ${add.map((c) => `"${c}"`).join(", ")}`);
  if (remove.length) parts.push(`out of ${remove.map((c) => `"${c}"`).join(", ")}`);
  return {
    toolCallId,
    content:
      `Filed ${resolved.length} ${resolved.length === 1 ? "entry" : "entries"} ${parts.join(" and ")}: ` +
      `${resolved.map((e) => e.name).join(", ")}. Memberships are additive — an entry keeps every other collection it was in.`,
  };
}

// ─── create_lore_category ────────────────────────────────────────────────────

export async function createLoreCategoryTool(
  toolCallId: string,
  args: { label?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const org = organizerOf(toolCallId, ctx);
  if ("content" in org) return org;

  const label = String(args.label ?? "").trim();
  if (!label) return { toolCallId, content: "Error: 'label' is required — what the author will see this category called." };

  const g = gate(toolCallId, ctx, "create", label, "category");
  if ("refusal" in g) return g.refusal;

  const id = await org.createCategory(label);
  return {
    toolCallId,
    content:
      `Created category "${label}" (id: ${id}). New entries can go in it via create_lore_entity, and existing ones via move_lore_entity. ` +
      "There is no tool to rename or delete a category: a category is a folder on disk, so either would relocate every member entry and stale its `[[lore:…]]` path citations. Ask the author to do that in the app.",
  };
}
