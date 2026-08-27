/**
 * 生成面板「上下文分配」条的预估。
 *
 * 这一层错了**不会报错**。它只会画一条看着很宽裕的条，然后运行时把知识库挤成
 * 零——作者看见注入报告是空的，去改一份本来没问题的设定。所以每一条口径在这里
 * 各占一条用例，包括那几个「条会消失」「条画满了却已经超上限」的角落。
 */

import { describe, expect, it } from "vitest";
import { planForecast, type ForecastInput } from "../context/forecast";
import { DEFAULT_TASKS, type TaskDef } from "../profile/model";
import { BOOK_PREV_TAIL_CHARS } from "../context/bookContext";
import { SUBAGENT_KINDS, type SubAgentConfig, type SubAgentKind } from "../agent/subagent";

const NO_SUBS = Object.fromEntries(
  SUBAGENT_KINDS.map((k) => [k, { enabled: false, modelId: null } as unknown as SubAgentConfig]),
) as Record<SubAgentKind, SubAgentConfig>;

const taskById = (id: string): TaskDef => DEFAULT_TASKS.find((t) => t.id === id)!;

/** 一份中文稿：`measureCharsPerToken` 会量出 ~1 字/token，换算因此是恒等的。 */
const CJK_DOC = "他握着那柄铁鳞甲的残片，站在雪原尽头。".repeat(200);

function input(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    runTask: taskById("custom"),
    contextSize: 32_000,
    maxOutputTokens: undefined,
    utilization: 0.5,
    loreBudgetTokens: 4_000,
    subAgents: NO_SUBS,
    models: [],
    systemPromptChars: 2_000,
    instructionChars: 0,
    selectionChars: 0,
    outlineChars: 0,
    knowledgeChars: 0,
    documentText: CJK_DOC,
    anchorOffset: 50_000,
    contextChars: 1_000,
    continueLength: undefined,
    memoryChars: 0,
    docxRosterChars: 0,
    isZh: true,
    ...over,
  };
}

const seg = (f: NonNullable<ReturnType<typeof planForecast>>, key: string) =>
  f.segments.find((s) => s.key === key)?.chars ?? 0;

describe("预估读的是**会跑的那个任务**", () => {
  /**
   * 这条用例就是这个模块搬出组件的理由。
   *
   * Agent 模式把 `custom`（`tools: "none"`）换成 `agent`（`tools: "full"`），而
   * 原来的实现在组件里取了作者点的那个格子。两份数字差得不是一点：面板承诺
   * 4,000 tk 的条目，运行注入 **零**，参考窗口从五千多字塌到两百出头。
   */
  it("Agent 模式：工具集占了位置，知识库因此拿不到预算", () => {
    const shown = planForecast(input({ runTask: taskById("custom") }))!;
    const real = planForecast(input({ runTask: taskById("agent") }))!;

    expect(seg(shown, "lore")).toBe(4_000);
    expect(seg(shown, "recent")).toBeGreaterThan(4_000);
    // 工具折进「系统+工具」段，所以看差值：真正跑的那个多带了整个助手工具集。
    expect(seg(real, "system") - seg(shown, "system")).toBeGreaterThan(9_000);
    expect(seg(real, "lore")).toBe(0);
    expect(seg(real, "recent")).toBeLessThan(1_000);
    // 上限没变——变的是这条上限里还剩下什么。
    expect(real.ceilingTokens).toBe(shown.ceilingTokens);
  });

  /** 续写与否也只由这一个对象决定：它决定要不要给【全书前情】留位置。 */
  it("续写任务才把上一章结尾算进固定成本", () => {
    const cont = planForecast(input({ runTask: taskById("continue"), anchorOffset: 50_000 }))!;
    const flat = planForecast(input({ runTask: taskById("custom"), anchorOffset: 50_000 }))!;
    expect(cont.usedTokens).toBeGreaterThan(flat.usedTokens - seg(flat, "recent"));
    expect(seg(cont, "memory")).toBeGreaterThan(0); // 全书前情拿到了份额
    expect(seg(flat, "memory")).toBe(0);
  });

  /**
   * 「参考上文」选择器只有声明了 `referenceWindow` 的任务有。没有选择器的任务
   * 传进来的 `contextChars` 必须被忽略，否则参考窗口会被钉死在一个作者根本看不
   * 见的控件的值上。
   */
  it("没有参考窗口选择器的任务忽略 contextChars", () => {
    const withPicker = planForecast(input({ runTask: taskById("polish"), contextChars: 500 }))!;
    const noPicker = planForecast(input({ runTask: taskById("custom"), contextChars: 500 }))!;
    expect(seg(withPicker, "recent")).toBe(500);
    expect(seg(noPicker, "recent")).toBeGreaterThan(500);
  });
});

describe("条的几何", () => {
  /**
   * **段的合计正好是上限，非 free 的那几段正好是「预计输入」。**
   *
   * 以前都不成立：固定成本（系统提示 / 任务指令 / 选区 / 大纲 / 附加知识）没有
   * 自己的段，只让「余量」变小，于是条的总宽是 `上限 − 固定成本`、填充部分比
   * 页脚那句「预计输入」少一个固定成本——同一屏上的两个数对不上。
   */
  it("段的合计 = 上限；非 free 的合计 = 预计输入", () => {
    for (const task of ["custom", "polish", "continue", "agent"]) {
      const f = planForecast(input({ runTask: taskById(task), systemPromptChars: 2_000 }))!;
      const total = f.segments.reduce((n, s) => n + s.chars, 0);
      const filled = total - seg(f, "free");
      expect(Math.round(total / f.charsPerToken)).toBe(f.ceilingTokens);
      expect(Math.round(filled / f.charsPerToken)).toBe(f.usedTokens);
    }
  });

  /**
   * 选区要**看得见**。它是润色/改写/总结里最大的一块，也是作者一个手势就能改小
   * 的那一块——埋进一条灰色的「固定」里算术是对了，可作者仍然不知道是什么占满了
   * 窗口，而那正是这一段被加出来的全部理由。
   */
  it("选区自己一段，随选区一起长", () => {
    const small = planForecast(input({ runTask: taskById("polish"), selectionChars: 200 }))!;
    const big = planForecast(input({ runTask: taskById("polish"), selectionChars: 9_000 }))!;
    expect(seg(small, "input")).toBe(200);
    expect(seg(big, "input")).toBe(9_000);
    // 而且是从「余量」里拿走的，不是凭空多出来的宽度。
    expect(seg(big, "free")).toBeLessThan(seg(small, "free"));
  });

  /** 续写不带选区，带的是大纲 + 附加知识——同一段，由 `runTask` 决定装谁。 */
  it("续写时这一段装大纲和附加知识", () => {
    const f = planForecast(input({
      runTask: taskById("continue"), selectionChars: 9_000,
      outlineChars: 300, knowledgeChars: 120,
    }))!;
    expect(seg(f, "input")).toBe(420);
  });

  /**
   * 上一章结尾是**原文**，所以它归「近期」而不是「选区/附加」：分界是「逐字的
   * vs 概括的」，不是「planContextBudget 把它记在哪个变量上」。
   */
  it("上一章结尾并进「近期」，不是并进固定成本", () => {
    const cont = planForecast(input({ runTask: taskById("continue"), anchorOffset: 400 }))!;
    expect(seg(cont, "recent")).toBe(400 + BOOK_PREV_TAIL_CHARS);
  });

  /** read 层任务的系统提示实际还接着一份工具说明；漏掉它续写每次都少算一点。 */
  it("工具说明算进「系统+工具」", () => {
    const withBriefing = planForecast(input({ runTask: taskById("continue") }))!;
    const without = planForecast(input({ runTask: taskById("polish") }))!;
    // 两者的系统提示、指令长度在这里都一样，差的就是那份说明（read 层才有）。
    expect(seg(withBriefing, "system")).toBeGreaterThan(seg(without, "system"));
  });

  /** 排版格式清单只接在 full 层任务的指令尾部（`aiTaskStore` 就是这么做的）。 */
  it("排版格式清单只算给 full 层任务", () => {
    const full = planForecast(input({ runTask: taskById("htmlArtifact"), docxRosterChars: 900 }))!;
    const fullNone = planForecast(input({ runTask: taskById("htmlArtifact"), docxRosterChars: 0 }))!;
    const none = planForecast(input({ runTask: taskById("polish"), docxRosterChars: 900 }))!;
    const noneNone = planForecast(input({ runTask: taskById("polish"), docxRosterChars: 0 }))!;
    expect(seg(full, "system") - seg(fullNone, "system")).toBe(900);
    expect(seg(none, "system")).toBe(seg(noneNone, "system"));
  });

  /** 工具段走 token→字→token 的往返，必须原样回来（提示词里印的就是回来那个数）。 */
  it("工具段的字数换算回 token 无损", () => {
    const withTools = planForecast(input({ runTask: taskById("agent") }))!;
    const noTools = planForecast(input({ runTask: taskById("custom") }))!;
    const back = Math.round(
      (seg(withTools, "system") - seg(noTools, "system")) / withTools.charsPerToken,
    );
    expect(back).toBeGreaterThan(9_000);
    expect(withTools.usedTokens).toBeGreaterThanOrEqual(back);
  });

  /** 预算装不满的层要按实际裁——不然条会把「装不下的空位」说成「用掉了」。 */
  it("参考窗口与前情裁到真正存在的量", () => {
    const f = planForecast(input({ anchorOffset: 300, memoryChars: 120 }))!;
    expect(seg(f, "recent")).toBe(300);
    expect(seg(f, "memory")).toBe(120);
  });
});

describe("装不下的两个角落", () => {
  /**
   * 固定成本吃光整条窗口。
   *
   * 以前这里每一段都是 0（固定成本没有段位），而组件用 `total > 0` 决定画不画
   * 条——于是**最需要这条条的那一刻它整个消失**，并且退回去打一句「当前模型未
   * 设置上下文大小」，模型明明设了。现在固定成本自己占着段位，条画得出来，并且
   * 画出的正是占满它的那样东西。
   */
  it("固定成本超过上限：条仍然画得出来，而且画的是占满它的那样东西", () => {
    const f = planForecast(input({
      runTask: taskById("polish"), contextSize: 8_000,
      systemPromptChars: 1_500, selectionChars: 3_000,
    }))!;
    expect(f.segments.reduce((n, s) => n + s.chars, 0)).toBeGreaterThan(0);
    expect(seg(f, "input")).toBe(3_000);
    expect(seg(f, "free")).toBe(0);
    expect(f.over).toBe(true);
  });

  /**
   * 工具集 + 固定成本一起超上限：`free` 被 clamp 到 0，条永远是满的，而「预计
   * 输入」已经越过上限了。`over` 就是为了这一刻——助手那条在同样的处境是红框加
   * 红数字，这条以前什么都不说。
   */
  it("条画得满满当当时，over 是唯一说得出「已经超了」的那个字段", () => {
    const f = planForecast(input({
      runTask: taskById("agent"), contextSize: 32_000, systemPromptChars: 6_000,
    }))!;
    expect(seg(f, "free")).toBe(0);
    expect(seg(f, "system")).toBeGreaterThan(9_000);
    expect(f.usedTokens).toBeGreaterThan(f.ceilingTokens);
    expect(f.over).toBe(true);
  });

  /** 装得下的时候不能瞎报——「余量」还在就说明没超。 */
  it("装得下时 over 为假", () => {
    const f = planForecast(input())!;
    expect(seg(f, "free")).toBeGreaterThan(0);
    expect(f.over).toBe(false);
  });

  /** 模型没声明窗口 = 没有计划可画，返回 null（组件退到静态兜底的说明）。 */
  it("没有上下文大小时返回 null", () => {
    expect(planForecast(input({ contextSize: 0 }))).toBeNull();
  });
});

// ── Source guard ─────────────────────────────────────────────────────────────

/**
 * 上面那条 Agent 模式的用例证明**函数**取对了任务，证明不了**调用点**传对了。
 *
 * 而调用点正是原来出错的地方：`AiPanel` 的作用域里同时躺着 `task`（作者点的那
 * 个格子，决定界面画什么）和 `runTaskDef`（真正会跑的那个）。两个都是合法的
 * `TaskDef`，传错不报错、类型也不拦——上一次它就这么活了下来。
 *
 * 所以这里扫源码。用 `import.meta.glob` 而不是 `node:fs`：项目的 tsconfig 没有
 * `@types/node`，走文件系统在 vitest 下跑得动、到 CI 的 `tsc --noEmit` 就炸。
 */
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

describe("调用点传的是会跑的那个任务", () => {
  it("planForecast 的 runTask 只接 runTaskDef", () => {
    const callers = Object.entries(SOURCES)
      .filter(([path]) => !path.includes("/__tests__/"))
      .filter(([path]) => !path.endsWith("/lib/context/forecast.ts"))
      .filter(([, text]) => text.includes("planForecast("))
      .map(([path, text]) => [path.replace(/^\//, ""), text] as const);

    // 先证明这次扫描确实扫到了东西。走空的源码扫描会永远通过——那是这类测试自己
    // 的失败模式。
    expect(callers.map(([p]) => p)).toEqual(["src/components/ai/AiPanel.tsx"]);

    const offenders = callers
      .filter(([, text]) => !/runTask:\s*runTaskDef\b/.test(text))
      .map(([p]) => p);

    expect(
      offenders,
      "这些文件在调 planForecast 时没有传 runTaskDef。传 `task` 会让整条预估描述" +
        "一个没人会发的请求：Agent 模式下工具集是 11k+ tokens，而作者点的那个格子" +
        "报 0——面板承诺的知识库预算在运行时是零。",
    ).toEqual([]);
  });
});
