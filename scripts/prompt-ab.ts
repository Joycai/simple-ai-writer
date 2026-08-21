/**
 * A/B harness for prompt changes that could move tool choice.
 *
 * Not a test — it talks to a live model and there is nothing deterministic
 * about the answer. It exists because the one change in this area that can
 * actually break things (trimming the agent briefing, docs/agent-tool-context-
 * lld.md §4) is invisible to every unit test we have: the schemas still
 * validate, the loop still runs, and the only symptom is a smaller model
 * picking the wrong tool a bit more often than it used to.
 *
 * Small local models are the point. Frontier models infer the discipline from
 * the schemas alone and would report no difference at all — the same finding
 * `presets.ts` → `toolBriefingFor` already records for the read tier.
 *
 *   ollama serve
 *   AB_MODEL=gemma4:12b-mlx pnpm exec vitest run --config scripts/ab.vitest.config.ts
 *
 * Run through vitest only because the repo has no standalone TS runner — the
 * project's vitest `include` is `src/**` so this never joins the CI suite, and
 * adding a runner to devDependencies for one manual script is not worth it.
 * Knobs are environment variables for the same reason (vitest owns argv):
 * `AB_MODEL`, `AB_RUNS`, `AB_VARIANT`, `AB_TASKS`, `OLLAMA_URL`, `AB_OUT`.
 *
 * Prints one row per (task × variant) with the tool the model reached for
 * first, plus a verdict per acceptance criterion.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { AGENT_ASSIST_PRESET } from "../src/lib/agent/presets";
import { getToolDefinitions, partitionByGroup } from "../src/lib/agent/registry";
import { promptParams } from "../src/lib/profile/active";
import type { ToolDefinition } from "../src/lib/ai/types";

const BASE = process.env.OLLAMA_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.AB_MODEL ?? "gemma4:12b-mlx";
const RUNS = Number(process.env.AB_RUNS ?? "3");
/** Path to an alternative briefing to test; empty = the shipped locale string. */
const VARIANT = process.env.AB_VARIANT ?? "";
/** vitest swallows console output, so the report is a file. */
const OUT = process.env.AB_OUT ?? "prompt-ab-report.txt";
const say = (line: string) => appendFileSync(OUT, line + "\n");

const locale = JSON.parse(
  readFileSync(new URL("../src/i18n/locales/zh-CN.json", import.meta.url), "utf-8"),
) as { ai: { instructions: Record<string, string> } };

/** i18n's `{{x}}` interpolation, which is all these strings use. */
function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? `{{${k}}}`);
}

function briefing(): string {
  const params = promptParams(true);
  const raw = VARIANT
    ? readFileSync(VARIANT, "utf-8")
    : locale.ai.instructions.agent;
  return interpolate(raw, params);
}

const SYSTEM = () =>
  `${interpolate(locale.ai.instructions.system, promptParams(true))}\n\n${briefing()}`;

/**
 * The toolset the chat actually sends after PR5a: resident only. The lore
 * write tools are deliberately absent — reaching for one of them is not a
 * possible answer here, and "did it propose a plan first" is the question.
 */
const TOOLS: ToolDefinition[] = getToolDefinitions(
  partitionByGroup(AGENT_ASSIST_PRESET.tools).resident,
);

interface Task {
  id: string;
  prompt: string;
  /**
   * The discipline being checked, as a predicate over the whole tool-call
   * sequence — not over the first call.
   *
   * The first call is the wrong thing to look at, and finding that out cost a
   * baseline run: asked to add an alias, the model opened with
   * `list_lore_entities` every time, which is step 1 of the briefing's own
   * mandatory procedure ("先用只读工具查清楚现状"). Grading that as a failure
   * would have condemned the model for following the instructions.
   */
  expect: (calls: string[]) => boolean;
  why: string;
}

/**
 * Canned tool results, so a run can go several turns without a project.
 *
 * Deliberately terse and unsurprising: the question is which tool the model
 * reaches for next, and a result rich enough to send it somewhere interesting
 * would be measuring the fixture rather than the prompt.
 */
const RESULTS: Record<string, string> = {
  list_lore_entities: "characters:\n  - 阿瓦 — 主角，星舰驾驶员\n  - 凯尔 — 阿瓦的搭档\nworld:\n  - 环带城 — 故事主要发生地",
  read_lore_entity: "# 阿瓦\n\n别名：小阿\n\n星舰驾驶员。沉默寡言。\n\n（此条目有 1 个特征文件：outfit.md）",
  search_text: "/p/第三章.md:42: 星舰坠落在环带城外的荒原上",
  list_files: "/p\n  第一章.md\n  第二章.md\n  第三章.md",
  read_file: "第三章\n\n星舰坠落在环带城外的荒原上，阿瓦从舱门爬出来。\n\n（文件到此结束）",
  read_slides: "（不是演示稿）",
  read_memory: "（暂无记忆）",
  propose_lore_plan: "方案已获作者批准。可以按步骤执行了。",
  create_file: "已创建 /p/intro.html。",
  append_file: "已追加到 /p/intro.html。",
  propose_edit: "作者已批准，改动已写入。",
  rewrite_lines: "作者已批准，区段已替换。",
  rewrite_document: "作者已批准，整篇已替换。",
  task_plan: "清单已记录。",
  task_progress: "进度已更新。",
  write_note: "笔记已写入。",
};

const TASKS: Task[] = [
  {
    id: "plan-first",
    prompt: "给知识库里的人物「阿瓦」加一个别名「小瓦」。",
    // The plan gate is the discipline the briefing exists to carry: no lore
    // change without a card the author approved first.
    expect: (calls) => calls.includes("propose_lore_plan"),
    why: "动知识库之前必须提 propose_lore_plan",
  },
  {
    id: "search-before-read",
    prompt: "我在某一章里写过「星舰坠落」那一段，帮我找出来看看写在哪。",
    expect: (calls) => {
      const s = calls.indexOf("search_text");
      const r = calls.indexOf("read_file");
      return s >= 0 && (r < 0 || s < r);
    },
    why: "用 search_text 定位，而不是逐个 read_file 翻",
  },
  {
    id: "segmented-write",
    prompt: "帮我写一个项目介绍页 intro.html，要有封面、三个特性区块和一个联系方式区块，内容尽量充实。",
    // 「大文件必须分段写」: skeleton with create_file, then append_file per
    // section. The failure mode this guards is one giant create_file that runs
    // into the output cap and writes nothing at all.
    expect: (calls) => {
      const c = calls.indexOf("create_file");
      return c >= 0 && calls.indexOf("append_file") > c;
    },
    why: "create_file 写骨架 + append_file 分段补，而不是一次性灌完",
  },
];

/**
 * How many model turns one run is allowed before it is called unfinished.
 *
 * Sized against measured cost, not taste: one turn on gemma4:12b-mlx with this
 * toolset is ~65s, almost all of it prefill on the ~6.6k-token prompt. Four
 * turns × 3 runs × 3 tasks is already ~40 minutes per variant, and a run that
 * has not shown its hand by turn four is not going to.
 */
const MAX_TURNS = 4;

/**
 * Per-reply output cap, mirroring the app's own (`lib/ai/modelLimits` →
 * `effectiveMaxOutput`). A model that tries to write a whole page in one call
 * gets truncated here the way it would in the app — which is exactly the
 * failure the 分段写 rule exists to prevent, so leaving it uncapped would be
 * testing a setup the author never runs.
 */
const MAX_OUTPUT_TOKENS = 2048;

interface Reply {
  content: string;
  tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
}

/**
 * One completion, streamed, over **node:http rather than fetch**.
 *
 * Both of those are deliberate, and both were learned the expensive way.
 *
 * `stream: true`, because with `stream: false` the response headers do not
 * arrive until generation ends: asked for "内容尽量充实" this model spent 357s
 * on a single `create_file` argument, and the run came back as an opaque
 * `TypeError: fetch failed` that says nothing about tool choice. `max_tokens`
 * does not save it either — ollama's /v1 does not appear to charge gemma4's
 * `reasoning` output against the cap.
 *
 * `node:http`, because streaming alone still was not enough. Ollama does not
 * emit its first SSE byte until it has prefilled the whole prompt, and this
 * toolset is a 28KB payload: measured **84 seconds to first byte** on an idle
 * machine, and past 300s on a busy one — which is undici's default
 * `headersTimeout`, the very ceiling the switch to streaming was meant to
 * escape. Node's fetch offers no way to raise it without the `undici` package,
 * which this project does not depend on. `http.request` has no such default.
 *
 * There is an irony worth keeping: what makes this harness slow is the size of
 * the tool payload, which is the thing the whole change set is about.
 */
async function complete(messages: Record<string, unknown>[]): Promise<Reply> {
  const url = new URL(`${BASE}/chat/completions`);
  const payload = JSON.stringify({
    model: MODEL,
    messages,
    tools: TOOLS,
    stream: true,
    temperature: 0.7,
    max_tokens: MAX_OUTPUT_TOKENS,
  });

  let content = "";
  /** Accumulated by `index`, the way every OpenAI-shaped stream reports them. */
  const calls: { id?: string; function: { name: string; arguments: string } }[] = [];
  let buffer = "";

  const consume = (text: string) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!payload || payload === "[DONE]") continue;
      let chunk: {
        choices?: {
          delta?: {
            content?: string;
            tool_calls?: {
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // keep-alive, or a partial line the next read completes
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: tc.id, function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        res.setEncoding("utf-8");
        res.on("data", consume);
        res.on("end", resolve);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    // Inactivity, not total duration: a prefill that takes minutes is normal
    // here, a socket that has gone quiet for five is not.
    req.setTimeout(300_000, () => req.destroy(new Error("socket idle 300s")));
    req.end(payload);
  });

  const tool_calls = calls.filter((c) => c && c.function.name);
  return { content, ...(tool_calls.length ? { tool_calls } : {}) };
}

async function run(task: Task): Promise<string[]> {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: SYSTEM() },
    { role: "user", content: task.prompt },
  ];
  const calls: string[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await complete(messages);
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) return calls;

    messages.push({ role: "assistant", content: msg.content, tool_calls: toolCalls });
    for (const [i, c] of toolCalls.entries()) {
      calls.push(c.function.name);
      messages.push({
        role: "tool",
        tool_call_id: c.id ?? `call_${turn}_${i}`,
        content: RESULTS[c.function.name] ?? "（已完成）",
      });
    }
    // Stop the moment the question is answered. At ~65s a turn, letting a run
    // that already did the right thing keep going is a minute of nothing —
    // and a run that has NOT done it still spends its full budget, which is
    // where the information is anyway.
    if (task.expect(calls)) return calls;
  }
  return calls;
}

async function main() {
  writeFileSync(OUT, "");
  const promptChars = SYSTEM().length;
  const toolTokens = Math.ceil(JSON.stringify(TOOLS).length / 4);
  say(`model=${MODEL} runs=${RUNS} variant=${VARIANT || "(locale ai.instructions.agent)"}`);
  say(`system prompt: ${promptChars} chars · tools: ${TOOLS.length} defs ≈ ${toolTokens} tok\n`);

  let pass = 0;
  let total = 0;
  const only = (process.env.AB_TASKS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  for (const task of TASKS.filter((t) => only.length === 0 || only.includes(t.id))) {
    let ok = 0;
    // Written as they land, not batched at the end: the first attempt at this
    // ran past its timeout mid-task and left nothing behind at all.
    say(`\n[${task.id}] ${task.why}`);
    for (let i = 0; i < RUNS; i++) {
      const t0 = Date.now();
      try {
        const calls = await run(task);
        const hit = task.expect(calls);
        if (hit) ok++;
        say(`  ${hit ? "✓" : "✗"} ${((Date.now() - t0) / 1000).toFixed(0)}s  ${calls.length ? calls.join(" → ") : "(无工具调用)"}`);
      } catch (e) {
        say(`  ! ${((Date.now() - t0) / 1000).toFixed(0)}s  ERROR ${String(e).slice(0, 80)}`);
      }
    }
    total += RUNS;
    pass += ok;
    say(`  = ${ok}/${RUNS}`);
  }
  say(`\n总计 ${pass}/${total}`);
}

import { describe, it } from "vitest";

describe("prompt A/B", () => {
  // Never asserts: the output is the deliverable, and a live model has no
  // deterministic answer to assert on. Generous timeout — a dozen cold-start
  // completions on a local 12B model is minutes, not seconds.
  it("reports first-tool choice per task", async () => {
    await main();
  }, 3 * 60 * 60 * 1000);
});
