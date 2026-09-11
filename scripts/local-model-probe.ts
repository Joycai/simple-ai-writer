/**
 * Live probe: what a small local model does on this app's real agent wire.
 *
 * Not a test — it talks to a live model and nothing about the answer is
 * deterministic. It exists because the failures authors report on local models
 * (a run that sits silent, re-reads the same file until the round cap, or stops
 * mid-sentence) are invisible to every mocked-stream test: the loop still runs,
 * the schemas still validate, and the only symptom is a transcript nobody reads.
 *
 * Drives the real runtime, the real tool schemas and the real tool handlers.
 * Two things are stand-ins: the Tauri file system underneath is an in-memory
 * project, and every approval card is granted (and applied) at once.
 *
 *   LOCAL_LLM_URL=http://192.168.2.206:11234/v1
 *   LOCAL_LLM_MODEL=qwen3.8-27b-uncensored
 *   LOCAL_LLM_CTX=32000          the window the server actually loaded
 *   LOCAL_LLM_UTIL=0.5           Settings → 上下文与记忆 → 窗口占用 (app default 0.5)
 *   LIVE_SCENARIO=chat-edit      one id from SCENARIOS, or omit for all
 *   LIVE_LOG_DIR=<dir>           transcript JSON + a live progress log per run
 *   pnpm exec vitest run --config scripts/local-model.vitest.config.ts
 *
 * vitest swallows console output, so everything worth reading is a file:
 * `<id>-<ts>.progress.log` grows while the run is live (tail it to tell a slow
 * run from a hung one) and `<id>-<ts>.json` is written at the end.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mem = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const parent = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  const addDirs = (p: string) => {
    for (let d = parent(p); d && !dirs.has(d); d = parent(d)) dirs.add(d);
  };
  const children = (dir: string) => {
    const pre = dir.endsWith("/") ? dir : `${dir}/`;
    const names = new Map<string, boolean>();
    const visit = (p: string, isDir: boolean) => {
      if (!p.startsWith(pre)) return;
      const rest = p.slice(pre.length);
      const i = rest.indexOf("/");
      if (i < 0) names.set(rest, isDir || names.get(rest) === true);
      else names.set(rest.slice(0, i), true);
    };
    for (const f of files.keys()) visit(f, false);
    for (const d of dirs) visit(d, true);
    return [...names]
      .filter(([name]) => name)
      .map(([name, is_dir]) => ({ name, path: pre + name, is_dir }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  type Node = { name: string; path: string; is_dir: boolean; children?: Node[] };
  const tree = (dir: string): Node[] =>
    children(dir).map((c) => (c.is_dir ? { ...c, children: tree(c.path) } : c));
  const enc = new TextEncoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = async (cmd: string, a: Record<string, any> = {}): Promise<unknown> => {
    const p = a.path as string;
    switch (cmd) {
      case "fs_read_text_file":
        if (!files.has(p)) throw new Error(`No such file or directory: ${p}`);
        return files.get(p);
      case "fs_write_text_file":
        addDirs(p);
        files.set(p, a.content);
        return undefined;
      case "fs_append_text_file":
        addDirs(p);
        files.set(p, (files.get(p) ?? "") + a.content);
        return undefined;
      case "fs_exists":
        return files.has(p) || dirs.has(p);
      case "fs_stat":
        if (files.has(p)) return { isDir: false, size: enc.encode(files.get(p)!).length, modifiedMs: Date.now() };
        return dirs.has(p) ? { isDir: true, size: 0, modifiedMs: null } : null;
      case "fs_create_dir":
        dirs.add(p);
        addDirs(p);
        return undefined;
      case "fs_read_dir":
        return children(p);
      case "read_dir_recursive":
        return tree(a.dirPath);
      case "fs_read_head": {
        const bytes = enc.encode(files.get(p) ?? "");
        let bin = "";
        for (const b of bytes.subarray(0, a.maxBytes)) bin += String.fromCharCode(b);
        return { size: bytes.length, head: btoa(bin) };
      }
      case "fs_remove_file":
        files.delete(p);
        return undefined;
      default:
        throw new Error(`local-model probe: invoke("${cmd}") is not mocked`);
    }
  };
  return { files, dirs, invoke, addDirs };
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => mem.invoke(cmd, args),
}));

import i18n from "../src/i18n";
import { parseReasoningEffort } from "../src/lib/ai/reasoning";
import type { StreamMessage } from "../src/lib/ai/types";
import { profileSystemPrompt } from "../src/lib/context/rag";
import { applyFindReplace, applyInsertions } from "../src/lib/agent/editApply";
import type { AgentEvent } from "../src/lib/agent/events";
import {
  AGENT_ASSIST_PRESET, CONTINUE_PRESET, toolBriefingFor, type TaskPreset,
} from "../src/lib/agent/presets";
import type { ApprovalDecision, Proposal } from "../src/lib/agent/registry";
import { runAgent, type AgentRunResult } from "../src/lib/agent/runtime";
import { createTaskWorkspace } from "../src/lib/agent/taskWorkspace";
import { compactTriggerFor, createSessionMeta, noteTurnStart } from "../src/lib/agent/compact";
import { compactChatHistory, summarizeForCompaction } from "../src/lib/agent/compactRun";
import { estimateMessagesTokens } from "../src/lib/ai/tokenEstimate";
import { COMPACT_TRIGGER_RATIO_DEFAULT, COMPACT_TRIGGER_TOKENS_DEFAULT } from "../src/lib/context/budget";
import { messageCeilingForTools } from "../src/lib/agent/toolCost";
import { promptParams } from "../src/lib/profile/active";

const BASE = process.env.LOCAL_LLM_URL ?? "";
/**
 * Empty for a keyless local server. Set it to point the same scenarios at a
 * hosted model with LOCAL_LLM_CTX forced small — the control that separates
 * "this model is weak" from "this window is nearly full".
 */
const KEY = process.env.LOCAL_LLM_KEY ?? "";
const MODEL = process.env.LOCAL_LLM_MODEL ?? "qwen3.8-27b-uncensored";
const CTX = Number(process.env.LOCAL_LLM_CTX ?? 32_000);
const UTIL = Number(process.env.LOCAL_LLM_UTIL ?? 0.5);
/**
 * The model editor's thinking level, sent through the app's own reasoningBody
 * under the generic category — `off` is what turns qwen's thinking off on LM
 * Studio (only `reasoning_effort: "none"` is honoured there). Empty = unset.
 */
const EFFORT = parseReasoningEffort(process.env.LOCAL_LLM_EFFORT);
const ONLY = process.env.LIVE_SCENARIO ?? "";
const LOG_DIR = process.env.LIVE_LOG_DIR ?? "";
/** A run that has not ended by now is reported as hung and aborted. */
const WALL_MS = Number(process.env.LIVE_WALL_MS ?? 20 * 60_000);

const ROOT = "/proj";

const CHAPTERS: Record<string, string> = {
  "第一章 雨夜.md": `# 第一章 雨夜

雨是从傍晚开始下的，一直没有停的意思。林默把风衣的领子竖起来，沿着旧港区的石板路往下走。路灯隔很远才有一盏，光被雨切成一段一段的。

他在第三个路口停下，回头看了一眼。没有人跟着。只有一只瘦猫缩在屋檐下，眼睛亮得像两粒玻璃珠。

码头到了。几艘渔船挤在一起，随着浪轻轻地撞，发出沉闷的声响。空气里是鱼腥、柴油和铁锈混在一起的味道。一个穿雨衣的人站在最里面那个仓库门口，手里的烟一明一灭。

"你迟到了。"那人说。

"雨太大。"林默把手插进口袋，指尖碰到了那枚铜钥匙。钥匙是父亲留下的，背面刻着一个他至今看不懂的符号：一个圆，被一条斜线从中间劈开。

穿雨衣的人没再说话，转身推开仓库的铁门。门轴发出一声长长的尖叫，像是很多年没人开过。

仓库里堆满了木箱，每只箱子上都用红漆写着编号。林默数到第十七只的时候，看见了那个符号——和钥匙背面一模一样。
`,
  "第二章 旧账.md": `# 第二章 旧账

第二天早上，雨停了，天却没有晴。林默坐在报社对面的茶馆里，面前的茶已经凉了。

苏晚进门的时候，把一份泛黄的档案拍在桌上。"你要的东西。二十年前的码头失火案，卷宗只剩这一份。"

林默翻开第一页。失火的仓库编号是十七。死者名单里有三个名字，第二个是他父亲，林远山。

"官方结论是电线老化。"苏晚压低声音，"可当年负责这案子的警探，结案第二个月就辞职了，全家搬去了南方。"

"他叫什么？"

"周启明。"苏晚顿了一下，"我查过，他三年前回来了，就住在旧港区。"

林默合上卷宗，手又一次摸到了口袋里的钥匙。他没有告诉苏晚昨晚在仓库看到的东西。有些事，他想先自己弄明白。

茶馆的老板娘过来添水，瞥了一眼桌上的卷宗，手微微抖了一下，水洒出来一点。她什么也没说，转身走了。
`,
  "第三章 周启明.md": `# 第三章 周启明

旧港区的巷子窄得只能过一个人。周启明的家在巷子尽头，门口种着一棵半死不活的无花果树。

开门的是个头发全白的老人，背有点驼，眼神却很锐利。他打量了林默很久，才说："你长得像你父亲。"

屋里很暗，窗帘拉得严严实实。墙上挂着一张旧照片：几个年轻人站在码头上，笑得很灿烂。林默认出了其中一个是父亲，另一个，是年轻时的周启明。

"那场火不是意外。"周启明给他倒了一杯酒，自己却没喝，"你父亲那天晚上本来不该在仓库里。他是去拿一样东西的。"

"什么东西？"

老人没有回答，只是盯着林默的口袋。过了很久，他才开口："钥匙还在你身上，对吧？"

窗外传来一声很轻的响动，像是有人踩断了一根树枝。周启明的脸色一下子变了。
`,
};

/** All three chapters as one document — longer than the budget a default 32k run leaves for messages. */
const OMNIBUS = Object.values(CHAPTERS).join("\n\n");

function seedProject(extra: Record<string, string>): Map<string, string> {
  mem.files.clear();
  mem.dirs.clear();
  for (const d of [ROOT, `${ROOT}/.ai-writer`, `${ROOT}/.ai-writer/lore`]) mem.dirs.add(d);
  const seeded = new Map<string, string>();
  for (const [name, body] of Object.entries({ ...CHAPTERS, ...extra })) {
    mem.files.set(`${ROOT}/${name}`, body);
    seeded.set(`${ROOT}/${name}`, body);
  }
  return seeded;
}

interface Scenario {
  id: string;
  preset: TaskPreset;
  system: () => string;
  user: () => string;
  /** Files beyond the three chapters, by project-relative name. */
  extraFiles?: Record<string, string>;
}

const zh = () => promptParams(true);
const agentSystem = () => `${profileSystemPrompt()}\n\n${i18n.t("ai.instructions.agent", zh())}`;

const SCENARIOS: Scenario[] = [
  {
    id: "chat-edit",
    preset: AGENT_ASSIST_PRESET,
    system: agentSystem,
    user: () => "请读一下「第一章 雨夜.md」，把其中描写码头的那一段改得更有画面感，直接修改文件。",
  },
  {
    id: "chat-longdoc",
    preset: AGENT_ASSIST_PRESET,
    system: agentSystem,
    user: () => "请读一下「全本.md」，把第三章开头描写巷子和无花果树的那一段改得更有悬疑感，直接修改文件。",
    extraFiles: { "全本.md": OMNIBUS },
  },
  {
    // Twice the omnibus, the second copy renumbered: a document that on its own
    // outweighs what a default 32k run leaves for messages, so reading it is
    // exactly the call whose result trimHistory has to drop.
    id: "chat-bigdoc",
    preset: AGENT_ASSIST_PRESET,
    system: agentSystem,
    user: () => "请读一下「长篇.md」，把第四章里描写码头的那一段改得更有画面感，直接修改文件。",
    extraFiles: {
      "长篇.md": `${OMNIBUS}\n\n${OMNIBUS
        .replace("第一章 雨夜", "第四章 再临")
        .replace("第二章 旧账", "第五章 夜航")
        .replace("第三章 周启明", "第六章 故人")}`,
    },
  },
  {
    id: "chat-survey",
    preset: AGENT_ASSIST_PRESET,
    system: agentSystem,
    user: () => "通读项目里所有章节，然后告诉我：主线目前推进到哪里了？埋了哪些还没回收的伏笔？",
  },
  {
    id: "continue",
    preset: CONTINUE_PRESET,
    system: () => `${profileSystemPrompt()}\n\n${toolBriefingFor("read", zh())}`,
    user: () =>
      `【当前文档】第三章 周启明.md\n\n${CHAPTERS["第三章 周启明.md"]}\n\n`
      + "【任务】接着上文续写下一段，约 800 字，保持原有文风，不要重复已有内容。",
  },
  {
    id: "longform",
    preset: { id: "longform", tools: [], maxRounds: 1, finishPolicy: "force-text" },
    system: () => profileSystemPrompt(),
    user: () => "写一篇 3000 字左右的短篇小说，题材：雨夜码头的一次秘密交易。要有完整的起承转合。",
  },
];

interface RequestTiming {
  bodyChars: number;
  /** ms until response headers. */
  headersMs: number;
  /** ms until the first body byte — prefill, on a local server. */
  firstByteMs: number;
  /** ms until the last body byte the client read. */
  lastByteMs: number;
  /** Longest silence between two body chunks after the first. */
  maxGapMs: number;
  status: number;
}

/** Wrap global fetch so every request's prefill and stall pattern is measured. */
function tapFetch(sink: RequestTiming[]): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const t0 = Date.now();
    const res = await real(input, init);
    const rec: RequestTiming = {
      bodyChars: typeof init?.body === "string" ? init.body.length : 0,
      headersMs: Date.now() - t0,
      firstByteMs: -1,
      lastByteMs: -1,
      maxGapMs: 0,
      status: res.status,
    };
    sink.push(rec);
    if (!res.body) return res;
    let last = Date.now();
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        const now = Date.now();
        if (rec.firstByteMs < 0) rec.firstByteMs = now - t0;
        else rec.maxGapMs = Math.max(rec.maxGapMs, now - last);
        last = now;
        rec.lastByteMs = now - t0;
        ctl.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(tap), { status: res.status, headers: res.headers });
  };
  return () => {
    globalThis.fetch = real;
  };
}

/** Auto-approve an L2 proposal and apply it to the in-memory project. */
async function approve(p: Proposal, log: string[]): Promise<ApprovalDecision> {
  const read = () => mem.files.get(p.path) ?? "";
  log.push(`${p.kind} ${p.path}`);
  switch (p.kind) {
    case "edit":
      mem.files.set(p.path, applyFindReplace(read(), p.find, p.replace, p.occurrences, p.target));
      break;
    case "rewrite":
    case "create":
      mem.addDirs(p.path);
      mem.files.set(p.path, p.content);
      break;
    case "append":
      mem.files.set(p.path, read() + p.content);
      break;
    case "insert":
      mem.files.set(p.path, applyInsertions(read(), p.insertions, p.lineCount));
      break;
    default:
      return { approved: false, reason: `local-model probe does not apply "${p.kind}"` };
  }
  return { approved: true, auto: true };
}

/** The most-repeated 24-character window in a text, and how often it occurs. */
function worstRepeat(text: string): { snippet: string; count: number } {
  const counts = new Map<string, number>();
  let best = { snippet: "", count: 0 };
  for (let i = 0; i + 24 <= text.length; i += 4) {
    const w = text.slice(i, i + 24);
    if (!w.trim()) continue;
    const n = (counts.get(w) ?? 0) + 1;
    counts.set(w, n);
    if (n > best.count) best = { snippet: w, count: n };
  }
  return best;
}

async function runScenario(s: Scenario) {
  const seeded = seedProject(s.extraFiles ?? {});
  const stamp = Date.now();
  const progress = (line: string) => {
    if (!LOG_DIR) return;
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(`${LOG_DIR}/${s.id}-${stamp}.progress.log`, `+${Math.round((Date.now() - stamp) / 1000)}s ${line}\n`);
  };
  const requests: RequestTiming[] = [];
  const untap = tapFetch(requests);
  const events: AgentEvent[] = [];
  const approvals: string[] = [];
  const messages: StreamMessage[] = [
    { role: "system", content: s.system() },
    { role: "user", content: s.user() },
  ];
  const ceiling = s.preset.tools.length ? messageCeilingForTools(CTX, UTIL, s.preset.tools) : undefined;
  progress(`start ctx=${CTX} util=${UTIL} messageCeiling=${ceiling}`);
  const ctrl = new AbortController();
  let hung = false;
  const wall = setTimeout(() => {
    hung = true;
    ctrl.abort();
  }, WALL_MS);
  let output = "";
  let error: string | null = null;
  let result: AgentRunResult | null = null;
  try {
    result = await runAgent({
      baseUrl: BASE,
      apiKey: KEY,
      standard: "openai_compat",
      modelId: MODEL,
      contextSize: CTX,
      ...(EFFORT ? { thinkingCategory: "openai-generic" as const, reasoningEffort: EFFORT } : {}),
      inputCeilingTokens: ceiling,
      preset: s.preset,
      messages,
      toolContext: {
        projectPath: ROOT,
        loreIndex: {},
        multimodal: false,
        requestApproval: (p) => approve(p, approvals),
        ...(s.preset.scratchpad ? { taskWorkspace: createTaskWorkspace(ROOT, MODEL) } : {}),
      },
      signal: ctrl.signal,
      onEvent: (e) => {
        // Reasoning is re-emitted per fragment with the whole text; keep the last.
        if (e.kind === "reasoning" && !e.done) return;
        events.push(e);
        if (e.kind === "round-start") {
          progress(`round ${e.round} est=${e.estInputTokens} tools=${e.toolTokens}`);
        } else if (e.kind === "round-done") {
          progress(`  round ${e.round} done, actual input ${e.actualInputTokens}`);
        } else if (e.kind === "reasoning") {
          progress(`  reasoning ${e.text.length} chars in ${e.elapsedMs}ms`);
        } else if (e.kind === "tool-step" && e.step.status !== "running") {
          progress(`  ${e.step.status} ${e.step.name} ${e.step.argumentSummary.slice(0, 120)}`);
        } else if (e.kind === "context-trimmed") {
          progress(`  context-trimmed ${e.count}`);
        } else if (e.kind === "output-truncated") {
          progress(`  output-truncated cause=${e.cause ?? "-"}${e.thinkingOnly ? " thinkingOnly" : ""}${e.recovery ? ` recovery=${e.recovery.kind}#${e.recovery.attempt}` : ""}`);
        }
      },
      onOutputText: (t) => {
        output = t;
      },
    });
  } catch (e) {
    error = String(e);
  } finally {
    clearTimeout(wall);
    untap();
  }
  progress(`end outcome=${result?.outcome ?? "-"} error=${error ?? "-"} hung=${hung}`);

  const toolCalls = events.flatMap((e) =>
    e.kind === "tool-step" && e.step.status !== "running"
      ? [{
          round: e.step.round,
          name: e.step.name,
          args: e.step.argumentSummary,
          status: e.step.status,
          result: (e.step.resultSummary ?? "").slice(0, 300),
        }]
      : [],
  );
  const callKeys = toolCalls.map((c) => `${c.name} ${c.args}`);
  const summary = {
    scenario: s.id,
    model: MODEL,
    ctx: CTX,
    util: UTIL,
    messageCeiling: ceiling,
    wallSeconds: Math.round((Date.now() - stamp) / 1000),
    hung,
    error,
    rounds: result?.rounds ?? null,
    outcome: result?.outcome ?? null,
    inputTokens: result?.inputTokens ?? null,
    outputTokens: result?.outputTokens ?? null,
    trimmedEvents: events.filter((e) => e.kind === "context-trimmed").length,
    duplicateCalls: callKeys.length - new Set(callKeys).size,
    toolCalls,
    approvals,
    reasoning: events.flatMap((e) =>
      e.kind === "reasoning" ? [{ round: e.round, chars: e.text.length, ms: e.elapsedMs, tail: e.text.slice(-200) }] : [],
    ),
    requests,
    roundsDone: events.flatMap((e) => (e.kind === "round-done" ? [{ round: e.round, actualInput: e.actualInputTokens }] : [])),
    truncations: events.filter((e) => e.kind === "output-truncated").length,
    outputChars: output.length,
    outputRepeat: worstRepeat(output),
    output,
    changedFiles: [...mem.files.entries()]
      .filter(([p, body]) => seeded.get(p) !== body)
      .map(([p, body]) => ({ path: p, chars: body.length })),
  };
  if (LOG_DIR) {
    writeFileSync(`${LOG_DIR}/${s.id}-${stamp}.json`, JSON.stringify({ ...summary, messages }, null, 2));
  }
  return summary;
}

/**
 * A conversation of several turns, compacted between turns the way the chat
 * store does it (stores/agentStore.sendChat): fold if due, then the question,
 * then the run. What it measures is how often a small window folds — each fold
 * is one summarize request to the same model, paid before the turn starts
 * (docs/feature/agent/window-edge-plan.md M5). Differences from the real store,
 * kept on purpose so the numbers stay attributable: no seed block and no
 * per-turn lore injection (this project has no knowledge base).
 */
interface ChatSession {
  id: string;
  turns: string[];
}

const CHAT_SESSIONS: ChatSession[] = [
  {
    id: "chat-session",
    turns: [
      "请读一下「第一章 雨夜.md」，告诉我码头那一段写了什么。",
      "把码头那一段改得更有画面感，直接修改文件。",
      "再读一下「第二章 旧账.md」，概括苏晚这个人物。",
      "「第三章 周启明.md」里提到的钥匙，前面哪里出现过？",
      "给「第三章 周启明.md」的结尾加一句制造悬念的话，直接修改文件。",
      "总结一下这几轮我们一起改了哪些地方。",
    ],
  },
];

async function runChatSession(s: ChatSession) {
  seedProject({});
  const stamp = Date.now();
  const progress = (line: string) => {
    if (!LOG_DIR) return;
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(`${LOG_DIR}/${s.id}-${stamp}.progress.log`, `+${Math.round((Date.now() - stamp) / 1000)}s ${line}\n`);
  };
  const conn = {
    baseUrl: BASE,
    apiKey: KEY,
    standard: "openai_compat" as const,
    modelId: MODEL,
    contextSize: CTX,
    ...(EFFORT ? { thinkingCategory: "openai-generic" as const, reasoningEffort: EFFORT } : {}),
  };
  const preset = AGENT_ASSIST_PRESET;
  const messageCeiling = messageCeilingForTools(CTX, UTIL, preset.tools);
  const trigger = compactTriggerFor({
    contextSize: CTX,
    messageCeiling,
    // LIVE_TRIGGER_TOKENS forces folds for measuring what one costs. The app's
    // own slider stops at 8,192, above a 32k assistant's ceiling line, so this
    // is a probe-only lever — never a setting an author can reach.
    triggerTokens: Number(process.env.LIVE_TRIGGER_TOKENS ?? COMPACT_TRIGGER_TOKENS_DEFAULT),
    triggerRatio: COMPACT_TRIGGER_RATIO_DEFAULT,
  });
  progress(`start ctx=${CTX} util=${UTIL} messageCeiling=${messageCeiling} trigger=${trigger.tokens} (${trigger.boundBy})`);

  let history: StreamMessage[] = [{ role: "system", content: agentSystem() }];
  const meta = createSessionMeta();
  const workspace = createTaskWorkspace(ROOT, MODEL);
  const approvals: string[] = [];
  const turns: Array<{
    turn: number;
    beforeTokens: number;
    folded: boolean;
    foldedTurns?: number;
    toTokens?: number;
    foldMs: number;
    runMs: number;
    afterTokens: number;
    rounds: number | null;
    error: string | null;
  }> = [];
  const ctrl = new AbortController();
  let hung = false;
  const wall = setTimeout(() => {
    hung = true;
    ctrl.abort();
  }, WALL_MS);

  try {
    for (const [i, question] of s.turns.entries()) {
      const n = i + 1;
      const beforeTokens = estimateMessagesTokens(history);
      const foldStart = Date.now();
      const compacted = await compactChatHistory({
        history,
        meta,
        ceilingTokens: messageCeiling,
        triggerTokens: trigger.tokens,
        // LIVE_FOLD_FORCE=1 folds every turn it can, the way 立即归纳 does —
        // for timing one summarize request when the hysteresis would otherwise
        // (correctly) decline to fold at all.
        force: process.env.LIVE_FOLD_FORCE === "1",
        summarize: (input) => summarizeForCompaction(conn, input, ctrl.signal),
      });
      const foldMs = Date.now() - foldStart;
      const folded = compacted?.event.kind === "context-compacted" ? compacted.event : null;
      if (compacted) {
        history = compacted.history;
        progress(`turn ${n}: FOLDED ${folded?.foldedTurns} turns ${folded?.fromTokens} -> ${folded?.toTokens} in ${foldMs}ms`);
      } else {
        progress(`turn ${n}: no fold (history ${beforeTokens}, trigger ${trigger.tokens})`);
      }

      const q: StreamMessage = { role: "user", content: question };
      noteTurnStart(meta, q);
      history.push(q);
      const runStart = Date.now();
      let rounds: number | null = null;
      let error: string | null = null;
      try {
        const r = await runAgent({
          ...conn,
          inputCeilingTokens: messageCeiling,
          preset,
          messages: history,
          toolContext: {
            projectPath: ROOT,
            loreIndex: {},
            multimodal: false,
            requestApproval: (p) => approve(p, approvals),
            taskWorkspace: workspace,
          },
          signal: ctrl.signal,
          onEvent: (e) => {
            if (e.kind === "context-trimmed") progress(`  turn ${n} context-trimmed ${e.count}`);
            else if (e.kind === "tool-step" && e.step.status !== "running") progress(`  turn ${n} ${e.step.status} ${e.step.name}`);
          },
          onOutputText: () => {},
        });
        rounds = r.rounds;
      } catch (e) {
        error = String(e);
      }
      const afterTokens = estimateMessagesTokens(history);
      progress(`  turn ${n} done in ${Math.round((Date.now() - runStart) / 1000)}s, rounds ${rounds}, history ${afterTokens}${error ? ` error=${error}` : ""}`);
      turns.push({
        turn: n,
        beforeTokens,
        folded: !!compacted,
        ...(folded ? { foldedTurns: folded.foldedTurns, toTokens: folded.toTokens } : {}),
        foldMs,
        runMs: Date.now() - runStart,
        afterTokens,
        rounds,
        error,
      });
      if (error) break;
    }
  } finally {
    clearTimeout(wall);
  }

  const summary = {
    scenario: s.id,
    model: MODEL,
    ctx: CTX,
    util: UTIL,
    messageCeiling,
    trigger,
    hung,
    folds: turns.filter((t) => t.folded).length,
    turns,
    approvals,
    wallSeconds: Math.round((Date.now() - stamp) / 1000),
  };
  progress(`end folds=${summary.folds}/${turns.length} hung=${hung}`);
  if (LOG_DIR) {
    writeFileSync(`${LOG_DIR}/${s.id}-${stamp}.json`, JSON.stringify({ ...summary, messages: history }, null, 2));
  }
  return summary;
}

describe.skipIf(!BASE)("LIVE local model", () => {
  for (const s of SCENARIOS.filter((x) => !ONLY || x.id === ONLY)) {
    it(s.id, async () => {
      const summary = await runScenario(s);
      expect(summary.hung).toBe(false);
    }, WALL_MS + 60_000);
  }
  for (const s of CHAT_SESSIONS.filter((x) => !ONLY || x.id === ONLY)) {
    it(s.id, async () => {
      const summary = await runChatSession(s);
      expect(summary.hung).toBe(false);
    }, WALL_MS + 60_000);
  }
});
