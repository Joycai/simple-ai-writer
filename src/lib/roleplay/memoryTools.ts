/**
 * 角色记忆的三个工具：`remember` / `revise_memory` / `recall`。
 *
 * 刻意避开既有的 `read_memory` / `update_memory` —— 那两个是**文档**的故事记忆
 * （滚动摘要，按源文本字符区间分段），语义完全不同，同名只会让模型混淆。
 *
 * `AgentMemoryStore` **每次调用都读盘，不缓存**：ToolContext 是一次运行的快照，
 * 而同一次运行里 `remember` 之后紧接着的 `recall` 必须看得见刚记下的东西。
 */

import i18n from "../../i18n";
import type { ToolResult } from "../agent/tools";
import { MEMORY_KINDS, hasDoneState, kindLabel } from "./memory";
import type { MemoryKind, MemoryRecord, MemoryStatus } from "./model";

export interface AgentMemoryStore {
  list(): Promise<MemoryRecord[]>;
  add(rec: {
    kind: MemoryKind; title: string; body: string; subject: string | null; keys: string[];
  }): Promise<MemoryRecord>;
  revise(
    id: string, patch: { body?: string; status?: MemoryStatus },
  ): Promise<MemoryRecord | null>;
}

const NO_STORE =
  "Memory tools are only available to an agent in the roleplay panel.";

function isKind(v: unknown): v is MemoryKind {
  return typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);
}

function describe(r: MemoryRecord): string {
  const subject = r.subject ? ` (${r.subject})` : "";
  const body = r.body ? ` — ${r.body.replace(/\s*\n\s*/g, " ")}` : "";
  // 场号让一条记忆变成一个**可以回去读的坐标**：轮号在每一场里各数各的，单给
  // 「turn 14」指不到任何东西。0 = 不详（这个字段出现之前记的），那就不写——
  // 写一个 `scene 0` 只会让模型拿着它去 read_conversation 然后扑空。
  const where = r.scene > 0 ? `scene ${r.scene} · turn ${r.turn}` : `turn ${r.turn}`;
  return `[${r.id}] ${kindLabel(r.kind)}${subject} · ${r.status} · ${where}: ${r.title}${body}`;
}

interface RememberArgs {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  subject?: unknown;
  keys?: unknown;
}

export async function rememberTool(
  id: string, args: RememberArgs, ctx: { agentMemory?: AgentMemoryStore },
): Promise<ToolResult> {
  if (!ctx.agentMemory) return { toolCallId: id, content: NO_STORE };
  if (!isKind(args.kind)) {
    return {
      toolCallId: id,
      content: `"kind" must be one of: ${MEMORY_KINDS.join(", ")}.`,
    };
  }
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { toolCallId: id, content: `"title" is required — one line, what you will see when you look back.` };

  const record = await ctx.agentMemory.add({
    kind: args.kind,
    title,
    body: typeof args.body === "string" ? args.body.trim() : "",
    subject: typeof args.subject === "string" && args.subject.trim() ? args.subject.trim() : null,
    // 关键字现在是常驻层里的一个附带字段，**转场那一刻**才真正派上用场：这条
    // 记录沉进记忆区之后，靠它被想起来（见 lib/roleplay/area）。所以要在记的
    // 当下就收——那时模型正看着上下文，事后补要重读整场戏。
    keys: Array.isArray(args.keys)
      ? args.keys.filter((k): k is string => typeof k === "string" && k.trim() !== "")
        .map((k) => k.trim()).slice(0, 8)
      : [],
  });
  return {
    toolCallId: id,
    content: `Recorded ${describe(record)}\nThis survives context compaction. Use revise_memory with "${record.id}" when it is kept, called off, or changes.`,
  };
}

interface ReviseArgs {
  id?: unknown;
  body?: unknown;
  status?: unknown;
}

export async function reviseMemoryTool(
  callId: string, args: ReviseArgs, ctx: { agentMemory?: AgentMemoryStore },
): Promise<ToolResult> {
  if (!ctx.agentMemory) return { toolCallId: callId, content: NO_STORE };
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { toolCallId: callId, content: `"id" is required. Call recall to see the ids.` };

  const status = args.status;
  if (status !== undefined && status !== "open" && status !== "done" && status !== "void") {
    return { toolCallId: callId, content: `"status" must be one of: open, done, void.` };
  }
  const body = typeof args.body === "string" ? args.body : undefined;
  if (status === undefined && body === undefined) {
    return { toolCallId: callId, content: "Nothing to change — pass body, status, or both." };
  }

  const record = await ctx.agentMemory.revise(id, { body, status });
  if (!record) {
    // 不静默新建：那会让你以为改成功了，而作者会看到两条互相矛盾的记录。
    const existing = (await ctx.agentMemory.list()).map((r) => r.id).join(", ");
    return {
      toolCallId: callId,
      content: `No memory record with id "${id}". Existing ids: ${existing || "none"}. Nothing was created — call recall and try again with a real id.`,
    };
  }
  if (record.status !== "open" && !hasDoneState(record.kind)) {
    return {
      toolCallId: callId,
      content: `Updated ${describe(record)}\n(Note: a ${kindLabel(record.kind)} record is not a thing to complete — it just stops being true. "void" is the right status for that.)`,
    };
  }
  return { toolCallId: callId, content: `Updated ${describe(record)}` };
}

interface RecallArgs {
  kind?: unknown;
  include_closed?: unknown;
  /** 点名展开某一条（注入块里只有标题）。给了它，其余筛选参数一概不看。 */
  id?: unknown;
}

export async function recallTool(
  id: string, args: RecallArgs, ctx: { agentMemory?: AgentMemoryStore },
): Promise<ToolResult> {
  if (!ctx.agentMemory) return { toolCallId: id, content: NO_STORE };
  const all = await ctx.agentMemory.list();

  // 按 id 取一条：注入块里只有标题，展开某一条的细节是最常见的一次调用，而它
  // 不该顺带把整本记事本再拉进上下文一遍。**不受 include_closed 约束**——点名
  // 要某一条的模型已经知道自己在找什么，一条已兑现的约定的细节照给。
  const wanted = typeof args.id === "string" ? args.id.trim() : "";
  if (wanted) {
    const one = all.find((r) => r.id === wanted);
    if (!one) {
      const ids = all.map((r) => r.id).join(", ");
      return {
        toolCallId: id,
        content: `No memory record with id "${wanted}". Existing ids: ${ids || "none"}.`,
      };
    }
    return { toolCallId: id, content: describe(one) };
  }

  const includeClosed = args.include_closed === true;
  const kind = isKind(args.kind) ? args.kind : null;

  const rows = all
    .filter((r) => (includeClosed || r.status === "open"))
    .filter((r) => (kind ? r.kind === kind : true));

  if (!rows.length) {
    return {
      toolCallId: id,
      content: includeClosed
        ? "You have not recorded anything yet."
        : "Nothing active. Pass include_closed to see kept and called-off records.",
    };
  }
  return {
    toolCallId: id,
    content: rows.map(describe).join("\n"),
  };
}

/** 旁白读某个角色的记忆——它已经能读那个角色的全部对话，这只是更便宜的入口。 */
export function formatSceneMemory(records: readonly MemoryRecord[], name: string): string {
  if (!records.length) {
    return i18n.t("roleplay.memory.sceneEmpty", {
      name,
      defaultValue: `${name} 还没有记下任何东西。`,
    });
  }
  return `${name}:\n${records.map(describe).join("\n")}`;
}
