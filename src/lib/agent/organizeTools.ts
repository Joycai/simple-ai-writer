/**
 * 重整知识库**组织结构**的工具：集合的建/改名/删、把条目归入或移出、分类的建/改名/删。
 *
 * ## 为什么这些工具存在
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
 * 分类曾经只给 create，理由写的是「改名/删除会让每个成员条目的文件夹搬家」。那条理由
 * 是错的，而且错得很具体：分类的 **id 就是文件夹名**，而改名改的是 `labelZh`/`labelEn`
 * ——`WorkspacePane.handleRename` 从来只换标签，id 原样留着。所以改名不搬任何东西，
 * `[[lore:分类/id]]` 和按 dirPath 存的置顶一个都不受影响。删除同理：摘掉的是
 * profile.json 里的一行声明，文件夹留在原地。真正会让文件夹搬家的是**把条目换个分类**
 * （`move_lore_entity`），那是另一件事，它一直有自己的工具。
 *
 * 于是两根轴的管理面终于对齐了。分类只保留一条集合没有的纪律：**删除拒绝还有成员的
 * 分类**。摘掉声明不删任何东西，但会让整个分类退化成孤儿（标签退回文件夹 id、条目照常
 * 注入），而那不是「删掉」这个词让作者预期的结果——所以搬家必须单独占一个方案步骤，
 * 作者在卡上分别读到「12 条搬去势力」和「删掉空分类」。改名和删除还都只对**作者自建**
 * 的分类生效：能力包带来的分类属于那个包（去掉它得整包关掉），孤儿文件夹压根没有声明
 * 可改。这两条和作者在 app 里能做的事完全一致，不多一分也不少一分。
 *
 * 分类**作为搬入目的地**同样是一个 target 为 `category` 的 move 步骤，`members` 列出
 * 这一批条目，`move_lore_entity` 逐条过这一个步骤的门（见 `writeTools.ts` 的 `moveGate`）。
 * 所以「把 12 条归到势力」在卡上是一行，不是十二行。分类改名共用同一个 move 动作、同一
 * 个 target，只是不带 `members`。
 *
 * ## 这一组是 deferred 的
 *
 * ## 每一处写入都要回灌运行快照
 *
 * 这三个工具改的是**条目 frontmatter 上的字段**（集合归属），而 `ctx.loreIndex` 是
 * 运行开始时克隆的一份快照。不回灌的话，同一次运行里紧接着的 `update_lore_meta`
 * 会拿快照上那份**旧的** `collections` 覆写回磁盘（`saveEntityMetaAndBody` 缺席即
 * 沿用手上这份 entity），把刚归好的集合静静撤销——作者收不到任何提示。所以每条
 * 成功路径都以 `syncLore(ctx, touched)` 收尾，`touched` 是 store 交回来的真改动
 * 名单，于是刷新范围也正好是这几条而不是全库。
 *
 * ## 这一组是 deferred 的
 *
 * 全部挂 `group: "lore_organize"`，方案批准之前根本不下发（`runtime.ts`）。而且是
 * **按方案形状**装载：批准一个「整理」方案才装载它们，批准一个「改写条目正文」的
 * 方案不装。这是 `agent-tool-context-lld.md` §6 认可的那条路——由运行状态自动装载，
 * 不需要模型自己开口要工具（`load_tools` 那条路被实测否掉了）。
 */

import i18n from "../../i18n";
import { sameCollection, type LoreEntity } from "../lore";
import { loreCategories } from "../profile/active";
import { categoryRef } from "../profile/model";
import { checkPlan, recordMatch, recordRefusal, type LorePlanAction } from "./plan";
import type { LoreOrganizer, ToolContext } from "./registry";
import type { ToolResult } from "./tools";
import { findEntityByName } from "./tools";
import { syncLore } from "./writeTools";

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
  if (!check.ok) {
    recordRefusal(ctx.lorePlan, toolCallId);
    return { refusal: { toolCallId, content: check.message } };
  }
  recordMatch(ctx.lorePlan, toolCallId, check.step);
  return { ok: true };
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
    await syncLore(ctx, await org.renameCollection(name, to));
    return {
      toolCallId,
      content: `Renamed collection "${name}" to "${to}". Every member entry's frontmatter was rewritten, so the name in the files matches what the author sees.`,
    };
  }

  if (op === "delete") {
    if (!exists) return { toolCallId, content: unknownCollection(name, org) };
    const g = gate(toolCallId, ctx, "delete", name, "collection");
    if ("refusal" in g) return g.refusal;
    await syncLore(ctx, await org.deleteCollection(name));
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

  // 名字在快照回灌之前先取下来：回灌会把 `resolved` 里的 entity 对象换掉。
  const filed = resolved.map((e) => e.name);
  await syncLore(ctx, await org.file(resolved.map((e) => e.dirPath), add, remove));

  const parts: string[] = [];
  if (add.length) parts.push(`into ${add.map((c) => `"${c}"`).join(", ")}`);
  if (remove.length) parts.push(`out of ${remove.map((c) => `"${c}"`).join(", ")}`);
  return {
    toolCallId,
    content:
      `Filed ${filed.length} ${filed.length === 1 ? "entry" : "entries"} ${parts.join(" and ")}: ` +
      `${filed.join(", ")}. Memberships are additive — an entry keeps every other collection it was in.`,
  };
}

// ─── manage_category ─────────────────────────────────────────────────────────

/**
 * 按 id 或作者所见的标签找一个**已声明**的分类。三路比对（id / labelZh / labelEn，
 * 忽略大小写），因为模型手上的名字一半来自作者的说法，而那正是某个 id 的标签。
 */
function findCategory(name: string) {
  const key = name.trim().toLowerCase();
  return loreCategories().find(
    (c) =>
      c.id.toLowerCase() === key ||
      c.labelZh.trim().toLowerCase() === key ||
      c.labelEn.trim().toLowerCase() === key,
  );
}

/** 已声明分类的清单，给「没有这个分类」的错误信息用。 */
function categoryList(isZh: boolean): string {
  return loreCategories().map((c) => categoryRef(c, isZh)).join(", ") || "(none)";
}

export async function manageCategoryTool(
  toolCallId: string,
  args: { op?: string; category?: string; new_label?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const org = organizerOf(toolCallId, ctx);
  if ("content" in org) return org;

  const op = String(args.op ?? "").trim();
  const name = String(args.category ?? "").trim();
  const isZh = i18n.language === "zh-CN";
  if (!name) {
    return { toolCallId, content: "Error: 'category' is required — the category to act on (for 'create', the label you are giving it)." };
  }

  if (op === "create") {
    // 查重先于方案门，且幂等成功而不是报错——同 manage_collection 的 create：报错只会
    // 让模型换个名字重试，而《人物2》恰恰是最坏的结果。只查已声明分类：label 撞上孤儿
    // 文件夹的场景不拦——同名自定义分类会「收养」那个文件夹，正是停用包降级设计期望
    // 的迁出路径。
    const existing = findCategory(name);
    if (existing) {
      return {
        toolCallId,
        content:
          `Category "${name}" already exists as ${categoryRef(existing, isZh)} — nothing to create. ` +
          `File entries into it with create_lore_entity / move_lore_entity, passing the id "${existing.id}".`,
      };
    }
    const g = gate(toolCallId, ctx, "create", name, "category");
    if ("refusal" in g) return g.refusal;
    // 这一条不回灌快照：新分类是空的，`ctx.loreIndex` 至多少一个空键，而
    // `setCustomCategories` 那一侧已经全量重扫过 store 了——再 `syncLore(ctx)` 只会
    // 紧接着再扫一遍全库。真往里放条目的 `create_lore_entity` 本来就走全量刷新。
    // rename / delete 同理，而且它们连条目内容都没碰。
    const id = await org.createCategory(name);
    return {
      toolCallId,
      content:
        `Created category "${name}" (id: ${id}). New entries can go in it via create_lore_entity, and existing ones via move_lore_entity.`,
    };
  }

  if (op !== "rename" && op !== "delete") {
    return { toolCallId, content: "Error: 'op' must be one of: create, rename, delete." };
  }

  const target = findCategory(name);
  if (!target) {
    // 孤儿文件夹（有条目、没有任何包声明它）值得单独说一句：它不是「不存在」，
    // 而是没有可改的声明——把这两种说成同一句，模型会去建一个同名分类，而那会
    // 「收养」这个文件夹，是完全不同的一次改动。
    const orphan = Object.keys(ctx.loreIndex).some((id) => id.toLowerCase() === name.toLowerCase());
    return {
      toolCallId,
      content: orphan
        ? `Error: "${name}" is a folder in the knowledge base that no enabled pack declares, so there is no category declaration to ${op}. Its entries are listed and injected as usual; move them into a declared category with move_lore_entity if they should leave.`
        : `Error: there is no category "${name}". Existing categories: ${categoryList(isZh)}.`,
    };
  }
  if (!org.userCategories.includes(target.id)) {
    return {
      toolCallId,
      content:
        `Error: ${categoryRef(target, isZh)} comes from a capability pack, not from the author, so it cannot be ${op === "rename" ? "renamed" : "deleted"} here — a pack's categories go away by turning the pack off, which is the author's switch in Settings. Only categories the author created themselves can be.`,
    };
  }

  if (op === "rename") {
    const label = String(args.new_label ?? "").trim();
    if (!label) return { toolCallId, content: "Error: 'new_label' is required for a rename — the new author-facing label." };
    const clash = findCategory(label);
    if (clash && clash.id !== target.id) {
      return {
        toolCallId,
        content: `Error: "${label}" is already ${categoryRef(clash, isZh)} — two categories answering to one name would make every "which category" answer ambiguous. Pick a different label, or move the entries into that category instead with move_lore_entity.`,
      };
    }
    const g = gate(toolCallId, ctx, "move", target.id, "category");
    if ("refusal" in g) return g.refusal;
    await org.renameCategory(target.id, label);
    return {
      toolCallId,
      content:
        `Renamed the category to "${label}". Its folder id stays \`${target.id}\`, so nothing moved on disk — every entry, every \`[[lore:…]]\` citation and every pinned entry still resolves. Keep passing the id "${target.id}" to create_lore_entity / move_lore_entity.`,
    };
  }

  // delete —— 有成员就拒绝。摘掉声明不删任何东西，但会让整个分类退化成孤儿（标签
  // 变回文件夹 id、条目照常注入），而那不是「删掉」这个词让作者预期的结果。让搬家
  // 单独占一个方案步骤，作者就能在卡上分别读到「12 条搬去势力」和「删掉空分类」。
  const members = ctx.loreIndex[target.id] ?? [];
  if (members.length > 0) {
    return {
      toolCallId,
      content:
        `Error: ${categoryRef(target, isZh)} still holds ${members.length} ${members.length === 1 ? "entry" : "entries"} (${members.map((e) => e.name).join(", ")}). Deleting the category would not delete them — it would leave their folder undeclared, so they would keep showing up under the raw folder name. Move them somewhere first with move_lore_entity, as its own plan step, then delete the empty category.`,
    };
  }
  const g = gate(toolCallId, ctx, "delete", target.id, "category");
  if ("refusal" in g) return g.refusal;
  await org.deleteCategory(target.id);
  return {
    toolCallId,
    content:
      `Deleted the category ${categoryRef(target, isZh)}. It was empty, so no entry was affected; its (empty) folder stays on disk and is simply no longer offered as a destination.`,
  };
}
