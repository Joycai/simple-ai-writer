/**
 * 查询扩展 —— 把作者的一句话扩成知识库自己的词，再喂回原来的子串匹配器。
 *
 * 起因是取材的一个结构性盲区：子串只能取到**已经写下的字**。「写渚的变身场景」
 * 里没有「星辉之杖」四个字，而那根杖恰恰是这场戏要用的——它还没被写进正文，
 * 因为写它就是这次的活儿。引用图（lib/context/loreSelect 的 L3）接住了作者
 * 已经连起来的那一半；这里接的是另一半：作者没连、也不该连进正文的那种关联
 * （「变身场面通常要召唤法杖」是叙事常识，不是设定）。
 *
 * 三条设计取舍，每条都在承重：
 *
 * **① 输出是词，不是分数。** 扩展词直接并进 matchTarget，走今天这套 substring
 * 匹配，于是注入报告仍然能说「由「星辉之杖」命中」——只是标一下这个词是扩展来的。
 * 换成向量相似度就得在旁边另起一套评分，而「余弦 0.72」是作者无法动手改的东西
 * （方案 §2 不变量 2）。
 *
 * **② 给它名单，不让它自由联想。** 自由联想会产出「咏唱」「魔力回路」这类知识库
 * 里根本不存在的词——命中不了任何东西，纯浪费一次调用。所以请求里带一份候选
 * 词表，任务是「从这份名单里挑」；{@link acceptExpansion} 在**回来的路上**再把
 * 名单外的词滤掉一次，因为「请只从名单里选」是提示，不是保证。
 *
 * **③ 名单必须含特征标题和 keys。** 名单里没有「变身」这个词，它就答不出「变身」，
 * 而特征的激活正是靠 keys 命中的——只给实体名等于让扩展只能唤起条目、永远唤不起
 * 那条战斗服。
 *
 * 设计与取舍：docs/feature/lore/lore-retrieval-plan.md §5
 */

import { runStructuredTask } from "../agent/structured";
import { connOptions, type AiConn, type ConnOptions } from "../ai/conn";
import { inScope, type LoreIndex, type LoreScope } from "../lore";

/**
 * 候选词表的条数上限。
 *
 * 名单是这次调用唯一的成本大头（一个 200 条、每条带 3 个特征的知识库能凑出上千
 * 个词）。截断按 {@link expansionRoster} 的产出顺序发生——实体名在前、特征词在后，
 * 所以砍掉的总是更边缘的那一头。
 */
export const MAX_ROSTER_TERMS = 400;

/** 一次扩展最多接受几个词。防的是模型把整份名单抄回来。 */
export const MAX_EXPANDED_TERMS = 12;

/**
 * 这次运行可以扩展出的全部词：实体名 + 别名 + 特征标题 + 特征 keys。
 *
 * 按取材范围收窄——扩展是**自动发现**，和引用扩展、自动匹配受同一道围栏
 * （见 lib/lore/collections）。顺序是稳定的：分类顺序 → 条目顺序 → 先实体词
 * 后特征词，所以同一个知识库每次给出同一份名单，提示缓存才有意义。
 */
export function expansionRoster(loreIndex: LoreIndex, scope: LoreScope = null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (term: string | undefined) => {
    const t = term?.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  // 两遍，不是一遍：实体词先占满名额。名单被 MAX_ROSTER_TERMS 截断时，丢掉一个
  // 特征关键词只是少激活一层，丢掉一个条目名是整条取不到。
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) {
      if (!inScope(e, scope)) continue;
      push(e.name);
      for (const a of e.aliases ?? []) push(a);
    }
  }
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) {
      if (!inScope(e, scope)) continue;
      for (const f of e.facets ?? []) {
        push(f.title);
        for (const k of f.keys ?? []) push(k);
      }
    }
  }
  return out.slice(0, MAX_ROSTER_TERMS);
}

/**
 * 把模型的回答收敛成「名单里真实存在的词」。
 *
 * 名单外的词一律丢弃，而不是照单全收。理由不是洁癖：一个凭空造出来的词在
 * matchTarget 里命中不了任何条目，却会**混进注入报告的命中来源**里，让作者看到
 * 一个他知识库里根本没有的词被标成「命中」，然后去找一个不存在的条目。
 *
 * 大小写不敏感，且回填的是**名单里的原始拼写**——模型把「Aria」写成「aria」时，
 * 报告里该显示作者自己写的那个形。
 */
export function acceptExpansion(raw: unknown, roster: readonly string[]): string[] {
  const byLower = new Map(roster.map((t) => [t.toLowerCase(), t]));
  const terms = Array.isArray((raw as { terms?: unknown })?.terms)
    ? (raw as { terms: unknown[] }).terms
    : [];
  const out: string[] = [];
  const taken = new Set<string>();
  for (const item of terms) {
    if (typeof item !== "string") continue;
    const hit = byLower.get(item.trim().toLowerCase());
    if (!hit || taken.has(hit)) continue;
    taken.add(hit);
    out.push(hit);
    if (out.length >= MAX_EXPANDED_TERMS) break;
  }
  return out;
}

const OUTPUT_TOOL = {
  type: "function" as const,
  function: {
    name: "pick_terms",
    description: "Report which knowledge-base terms are relevant to the author's request.",
    parameters: {
      type: "object",
      properties: {
        terms: {
          type: "array",
          items: { type: "string" },
          description:
            "Terms copied verbatim from the provided list. Only terms that appear in it. Empty array if none apply.",
        },
      },
      required: ["terms"],
    },
  },
};

const SYSTEM = [
  "You help a writing app decide which knowledge-base entries to load before the author writes a scene.",
  "You are given the author's request and a list of terms that exist in their knowledge base.",
  "Pick the terms whose entries the writer will actually need — including things the request implies but does not name",
  "(a transformation scene needs the weapon that is summoned during it, even if the request never says so).",
  "Copy terms verbatim from the list. Never invent a term that is not in it; a term you make up matches nothing.",
  "Pick nothing rather than padding: an irrelevant entry costs the author context they needed for something else.",
].join(" ");

export interface ExpandQueryArgs extends ConnOptions {
  /** 作者亲手打的字——和进 matchTarget 的是同一份（见 aiTaskStore 的 authorIntent）。 */
  intent: string;
  roster: readonly string[];
  signal?: AbortSignal;
}

/**
 * 跑一次扩展，返回名单内的词；任何失败都返回空数组。
 *
 * **绝不抛。** 它坐在首字延迟的关键路径上，而它做的是一件锦上添花的事：模型不通、
 * 超时、返回一堆废话，正确的表现都是「这一轮和没开这个开关一样」，而不是让作者的
 * 续写整个失败。
 */
export async function expandQuery(args: ExpandQueryArgs): Promise<string[]> {
  const intent = args.intent.trim();
  if (!intent || args.roster.length === 0) return [];
  try {
    const json = await runStructuredTask({
      ...args,
      systemPrompt: SYSTEM,
      toolInstruction: "Call pick_terms exactly once with your selection.",
      jsonInstruction: 'Respond with only JSON: {"terms": ["...", "..."]}',
      outputTool: OUTPUT_TOOL,
      userContent: [
        "AUTHOR REQUEST:",
        intent,
        "",
        "AVAILABLE TERMS (pick only from these):",
        args.roster.join(" | "),
      ].join("\n"),
      signal: args.signal,
    });
    return acceptExpansion(JSON.parse(json), args.roster);
  } catch {
    return [];
  }
}

/**
 * 扩展的**墙上时钟**上限。
 *
 * 它挡在首字之前——一次续写的等待里，这一秒是加上去的。绑一个局域网小模型时
 * 这个数远远够；绑了一个卡住的地址时，作者付出的是三秒而不是一次失败的运行。
 */
export const EXPAND_TIMEOUT_MS = 3000;

/**
 * 一次完整的扩展：建名单 → 跑 → 滤。没配、没意图、超时、出错，一律空数组。
 *
 * 超时用的是**自己的** AbortController，并且 link 到调用方的 signal：作者按下
 * 停止时这一步要立刻断，而这一步超时**绝不能**把整次运行也一起取消。
 */
export async function expandAuthorIntent(opts: {
  intent: string;
  loreIndex: LoreIndex;
  scope?: LoreScope;
  conn: AiConn;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string[]> {
  const intent = opts.intent.trim();
  if (!intent) return [];
  const roster = expansionRoster(opts.loreIndex, opts.scope ?? null);
  if (roster.length === 0) return [];

  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), opts.timeoutMs ?? EXPAND_TIMEOUT_MS);
  const relay = () => own.abort();
  opts.signal?.addEventListener("abort", relay);
  try {
    return await expandQuery({
      ...connOptions(opts.conn),
      intent,
      roster,
      signal: own.signal,
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", relay);
  }
}
