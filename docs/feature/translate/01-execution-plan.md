# Sakura 日中翻译 · 执行方案

> 状态：`shipped`（Beta 开关后）· 四个开放问题已由作者拍板 · **四片全部完成**
> 前置阅读：[`00-sakura-feasibility.html`](00-sakura-feasibility.html)（可行性分析 + 实机实测记录，浏览器打开）

分析文档回答"能不能做、落在哪"，这一份回答"按什么顺序做、每片交付什么、怎么算做完"。

---

## 0. 已定的四件事

| # | 问题 | 作者的决定 | 落地形态 |
|---|---|---|---|
| 1 | `frequency_penalty` 放哪 | 按建议：引擎逐次传入，模型行上不给旋钮 | **`StreamOptions` 的请求字段**，不是 `ConnOptions`（见 §1 修正） |
| 2 | 上下文回带原文还是译文 | **both** | 上一块尾部 N 行的「原文 → 译文」作为一对合成消息前置 |
| 3 | 要不要 Beta 开关 | **要** | `lib/translate/flag.ts`，照 `pptx/flag.ts` 抄 |
| 4 | 术语表接不接知识库 | **接，但可开关** | 子代理卡片上一个复选框，pref `ai:translate:useLore` |

### §1 修正：这两个字段属于 `StreamOptions`，不是 `ConnOptions`

分析文档 §04 的接缝表把 `topP` / `frequencyPenalty` 写在了 `lib/ai/conn.ts` 上。**这一条是错的，按 `conn.ts` 自己的注释就该改**：

> `ConnOptions` 是"exactly the `StreamOptions` fields that come **from configuration** rather than from the task"；"Task inputs (messages, tools, callbacks) are deliberately *not* here"。

`frequency_penalty` 在这里是**重试阶梯的一环**（0.1 → 0.2 → 切块），每次请求都可能不同，是彻头彻尾的任务输入。`top_p` 同理：0.3 是 Sakura 这个**格式**的常量，不是作者对某个模型的配置。两者都由翻译引擎在调用点给出，覆盖 `connOptions(conn)` 展开后的值。

于是 `conn.ts` **一个字都不用改**，"十八处调用点各改一遍"的论证在这里不适用——这两个字段只有一个调用点。

---

## 1. 不变量

动这块代码时，下面六条任何一条被破坏都算 bug，不算权衡：

1. **Sakura 永不进入 agent 工具循环。** 翻译路径直接调 `streamCompletion`，绕开 `runAgent`。它没有 tool calling，也不读指令（实测 E1/E3）。
2. **带 `translateFormat` 的模型永不出现在任何非翻译候选列表里。** 主模型选择器、其它子代理绑定、记忆模型——全部排除。绑错的后果不是报错，是"把你的中文提示词改写一遍还回来"。
3. **坏译文永不落盘。** 重试阶梯走完仍不合格的块，写回**原文**并加一行失败标记，绝不写入模型那次的输出。
4. **退化判定只信三个信号**：被输出上限截断（`StreamChunk.done.truncated`，不是某一家的 `finish_reason` 拼法）、行数不符、tok/行 > 35。**不信"重复整行"**——实测退化两次的重复行计数都是 0。
5. **术语表只注入本块命中的条目**，且译名一致性由**后处理强制替换**保证，不依赖模型（实测：术语表是软提示，15 行里漏替了一半）。
6. **回带的上下文对是合成的**：只带上一块尾部 N 行，不参与本块的退化计量（tok/行 只算本块），也不写进产物。

---

## 2. 分片总览

| PR | 目标 | 结束时能做什么 | 能否独立合并 |
|---|---|---|---|
| 1 | 采样参数打通 + 模型标记 | 在应用里手动对 Sakura 发一次请求，拿到和实测一样的译文 | 是（无行为变化） |
| 2 | `lib/translate/` 纯逻辑层 | 全部切块/判定/术语表逻辑有测试，但没有 UI 也不联网 | 是（死代码，但有测试） |
| 3 | 子代理绑定 + 短文本工具 | 助手能翻译对话里的一段文本 | 是 |
| 4 | 整文件路径 | 助手能把一个 `.txt`/`.md` 翻成 `<原名>.zh.md` | 是（需求完整） |

每片合并前跑：`pnpm tsc --noEmit` + `pnpm test` + `pnpm build`。Rust 侧无改动。

---

## 3. PR 1 — 采样参数打通 + 模型标记

**目标**：底座。结束时应用还没有"翻译功能"，但能手动验证模型接得通。

### 改动

| 文件 | 改动 |
|---|---|
| `src/lib/ai/types.ts` | `StreamOptions` 加 `topP?: number` / `frequencyPenalty?: number`，注释写明：**OpenAI 家族独有**，Gemini / Anthropic 适配器忽略它们（Sakura 只走 openai 这一条，不为它污染另两个协议族） |
| `src/lib/ai/openai.ts` | 有值时写进请求体 `top_p` / `frequency_penalty`；`undefined` 时**不发**（沿用 `temperature` 的既有写法，不要发 0） |
| `src/lib/ai/apiLog.ts` | 两个字段进日志快照，否则调翻译参数时看不见发了什么 |
| `src/lib/ai/configDb.ts` | `Model.translateFormat?: "sakura"`；`addColumn(db, modelCols, "models", "translate_format", "TEXT")`；`insertModel` / `rowToModel` 各加一处 |
| `src/lib/ai/configTransfer.ts` | 配置导入导出带上这一列（检查是否逐字段列举） |
| `src/components/settings/panes/ModelDrawer.tsx` | 一个下拉：`（无）` / `Sakura（日→中）`。旁边一行说明：选中后此模型只能用于翻译，不会出现在其它模型选择器里 |
| `src/i18n/locales/{en,zh-CN}.json` | 上述文案 |

### 测试

- `src/lib/__tests__/aiClient.test.ts` 补两条：给 `topP` / `frequencyPenalty` 时请求体带上；不给时字段不存在。
- `localeParity.test.ts` 会自动守 i18n 两语齐全。

### 验收

1. 设置里加一个 provider（base URL 指向 LM Studio，key 留空），加模型 `sakura-14b-qwen2.5-v1.0`，翻译格式选 Sakura，`temperature` 0.1、`contextSize` 填实际值。
2. 用 API 日志确认一次请求里 `top_p: 0.3` / `frequency_penalty` 按传入值出现。

### 明确不做

- 不碰 `ConnOptions`（见 §1）。
- 不加 `top_k` / `repetition_penalty`：官方推荐里没有可调项，加了只是多两个没人会动的旋钮。

---

## 4. PR 2 — `lib/translate/` 纯逻辑层

**目标**：全部判断逻辑，纯函数，可单测。不碰 UI、不碰网络、不碰 store。**这一片是质量的分水岭**——实测数字直接当测试基线。

### 新增文件

```
src/lib/translate/
├── sakura.ts      提示词模板 · 参数常量 · 退化判定
├── chunk.ts       切块 · 穿透 · 重组
├── glossary.ts    术语表拼装 · 强制替换
├── context.ts     上一块的合成回带对
└── __tests__/     一模块一测试文件
```

#### `sakura.ts`

```ts
export const SAKURA_SYSTEM = "你是一个轻小说翻译模型，…";  // 逐字，训练时固定
export const SAKURA_SAMPLING = { temperature: 0.1, topP: 0.3 } as const;
export const FREQ_LADDER = [0.1, 0.2] as const;   // 首发 0.1，重试 0.2
export const TOK_PER_LINE_LIMIT = 35;             // 正常 19–22，退化 65–120
export const MAX_TOKENS_PER_LINE = 32;            // max_tokens = 行数 × 这个数

export function buildUserMessage(src: string, glossary: string): string;
export function judgeChunk(r: {
  srcLineCount: number; outText: string;
  finishReason?: string; completionTokens: number;
}): { ok: true } | { ok: false; reason: "truncated" | "line-mismatch" | "degenerate" };
```

`FREQ_LADDER` 首项是 **0.1 而不是 0**：实测 100 行在 0 上退化，0.2 上不但完整还快一倍；官方也把 0.1~0.2 列为退化时的处方。首发就给 0.1 是拿一点点保守换掉大部分重试。

#### `chunk.ts`

- `splitDocument(text, { linesPerChunk = 50 })` → `Chunk[]`。默认 50 行落在实测的安全区（30/60 稳、100 需靠 freq 救）。
- **空行、markdown 标题、引用、列表、图片链接照常送进模型**——实测它们原样穿透且不破坏行数对齐（测试 F）。
- **只有"零日文字符"的行被摘出不送**（纯 URL、纯 ASCII、纯数字符号），保留原索引，重组时按索引插回。摘出的行不计入本块的行数校验。
- 已知损失：行内 `**强调**` 标记会被模型吃掉（实测 F）。本片**不做保护**，在 §7 记为已知问题。

#### `glossary.ts`

- `collectGlossary(loreIndex, chunkText)` → 只含本块命中的条目，格式 `src->dst #备注`。命中判定按实体名 + 别名。
- `enforceGlossary(outText, entries)` → **最长词优先**的强制替换，兜住模型的漏替。不替换 URL / 路径 / 代码片段内的文本。
- 空表时返回空串，调用方走无术语表模板。

#### `context.ts`

- `buildCarry(prev: TranslatedChunk | null, lines = 4)` → `[] | [userMsg, assistantMsg]`：上一块尾部 `lines` 行原文包进同一个 user 模板，对应译文作为 assistant 回复。
- 「both」就落在这里：一次带上原文和译文两侧。
- 上限硬编码在 4 行左右，**不随块大小放大**——官方建议是"前 3–5 句"，不是"上一整块"。

### 测试

`src/lib/translate/__tests__/` 下一模块一个文件，用实测数字当基线：

- `judgeChunk`：20 tok/行 判 ok；65 tok/行 判 degenerate；`finish_reason: "length"` 判 truncated；行数不符判 line-mismatch。**并且**：一段"整行完全重复但 tok/行 正常"的输出必须判 **ok**——这条是不变量 4 的守卫，防止有人回头加"重复行检测"。
- `splitDocument`：一份含空行/标题/URL 的样本，切块后逐块行数 ≤ 上限，重组后与原文行结构逐行等长。
- `enforceGlossary`：`文香→芙美香` 与 `文香さん→芙美香小姐` 同时存在时走最长优先。
- `buildCarry`：`null` 返回空数组；有前块时返回恰好两条消息，且只含尾部 N 行。

### 明确不做

- 不写 `run.ts`（PR 4）。
- 不做 `**强调**` 保护。

### 实现记录（PR 2 已完成）

与上面的计划有四处出入，都是实现时的判断，不是计划写错了：

| 出入 | 结果 |
|---|---|
| 判定的截断信号 | 用 `StreamChunk.done.truncated` 而不是 `finish_reason === "length"`。后者是 OpenAI 一家的拼法，前者是三个协议族都归一过的同一件事 |
| 空行怎么处理 | 计划说"照常送进模型"，实现改成**和 URL 一样摘出不送**。空行本来就没有日文字符，`isTranslatable` 一条规则就覆盖了两种情况；少送几十行还省 token。实测穿透效果与计划一致 |
| tok/行 判定加了下限 | 行数 < 3 时跳过。一行长句子六十个 token 完全正常，而阈值会把它报成退化；行数校验和截断校验对短块照常生效，所以放过它不会漏掉真正的失败 |
| 多了两个函数 | `halveChunk`（重试阶梯最后一级，单行块切不动时返回自身，让 run 层据此停止）和 `pairTranslation`（行数不等时返回空数组而不是错位配对） |

**实机验证**：用你给的《魔法愛姫フミカ》第一话跑完整条管线（155 行 → 3 块 50/50/45），三块全部通过判定，19.3 / 23.4 / 17.4 tok/行，共 47 秒；空行、URL 原样穿透，成品行数与原文一致。这组数字也确认了 `TOK_PER_LINE_LIMIT = 35` 的裕度：真实值最高 23.4，离阈值还有很远。

---

## 5. PR 3 — 子代理绑定 + 短文本工具

**目标**：`translate` 成为一个真正的子代理绑定，助手能翻译对话里的一段文本。

### 改动

| 文件 | 改动 |
|---|---|
| `src/lib/translate/flag.ts` **新** | 照抄 `lib/pptx/flag.ts`，pref key `app:translateBeta`，默认关 |
| `src/components/settings/panes/GeneralPane.tsx` | 实验功能里加一个开关（`pptxOn` 旁边） |
| `src/lib/agent/subagent.ts` | `SUBAGENT_KINDS` 加 `"translate"`；`DelegateKind` 保持 `Exclude<SubAgentKind, "imagegen" \| "translate">`；`subAgentModel` 加 `if (kind === "translate" && !model.translateFormat) return null` |
| `src/lib/agent/routing.ts` | Beta 开 **且** 绑定可用时**追加** `translate`（照 `delegate` 的追加写法，不进 preset —— 见下方「关于 tool budget」） |
| `src/lib/agent/registry.ts` | `ToolId` 加 `"translate"`；注册项 `access: "read"`（本片只有 `text` 形态，什么都不写） |
| `src/lib/translate/tool.ts` **新** | 工具处理器：解析 `text` → 拿绑定的 conn（照 `imageTools.activeImageModel` 那样动态 import `aiStore`）→ 走一次 `runChunks`（本片只允许单块，超长直接拒绝并让模型改用文件形态，PR 4 再放开） |
| `src/components/settings/panes/SubAgentsPane.tsx` | translate 卡片；**`textCandidates` / `imageCandidates` 排除 `translateFormat` 模型**；卡片上加「从知识库提取术语表」复选框（pref `ai:translate:useLore`） |
| `src/components/ai/SubAgentChips.tsx` | 会话级 chip 自动跟随 `SUBAGENT_KINDS`，确认无需硬编码 |
| `src/stores/aiStore.ts` | 无需改：`readAllSubAgents` / persist 订阅都遍历 `SUBAGENT_KINDS` |
| i18n | `systemSettings.subagents.translate` / `translateSub` / `translateReq` / `warnNotTranslate` / `useLore`；`groupTool` 的标签与说明从"绘图工具"泛化成"直接工具"（现在它有两个成员） |

### 不变量 2 的落实清单

必须逐一确认下列列表已排除 `translateFormat` 模型：

- `SubAgentsPane.textCandidates`（`type !== "image"` → 再加 `&& !m.translateFormat`）
- `LibraryView.tsx:370` 的 `enabledModels`
- 主模型选择器 / 记忆模型 / 图像模型的候选来源（PR 期间 `grep -rn "\.enabled" src/components --include=*.tsx` 复核一遍）

建议把这个过滤收成 `lib/ai/configDb.ts` 里一个导出函数 `conversationalModels(models)`，让"哪些模型能当对话模型用"只有一个答案——否则下一个能力字段进来时同样的清单要再走一遍。

### 关于 tool budget

`src/lib/__tests__/agentToolBudget.test.ts` 的棘轮测的是**整个 preset**（`AGENT_ASSIST_PRESET.tools`），当前 9,609 / 上限 10,000，只剩 391 token 余量。

按 `delegate` 的既有做法，`translate` **在 `routeTools` 里条件追加**，不进 preset —— 所以棘轮看不见它。这不是绕过：`delegate` 就是这么处理的，因为它的存在取决于作者的开关。但为了不把成本藏起来，**本片要新增一条断言**：把 Beta 开 + 绑定可用时的 routed 集合算一次 token，钉一个自己的小上限（预期 ≈ 200 token）。

工具描述必须写清三件事，否则模型会拿它翻中文：**只做日→中**、**不接受指令**、**长文档改用 `path` 形态**（PR 4 之前是"拒绝并说明"）。

### 测试

- `src/lib/__tests__/routing.test.ts` 扩展：Beta 关 → 无 `translate`；Beta 开但无绑定 → 无；两者齐备 → 有。
- `src/lib/__tests__/subagent.test.ts` 扩展：`subAgentModel("translate", …)` 对无 `translateFormat` 的模型返回 null；`DELEGATE_KINDS` 不含 `translate`（这条是不变量 1 的守卫）。
- 新增 routed-toolset token 断言。

### 验收

对话里让助手翻一段日文，拿到译文；关掉 Beta 后助手看不到这个工具。

### 实现记录（PR 3 已完成）

**不变量 2 的落点比计划里干净**：过滤没有散在八个调用点，而是收在 `ModelSelector`
里 —— 那个组件**就是**"挑一个模型来对话"这件事，而一个专用翻译模型不能对话。
它对 `modelsOverride` 也过滤，所以六个 lore 模态、文库、助手头部一次全覆盖。
`lib/ai/configDb` 里新增 `isTranslateOnly` / `conversationalModels` 作为这条不变量
可被引用的名字，`SubAgentsPane` 和 `LibraryView` 各调一次。

其余出入：

| 出入 | 结果 |
|---|---|
| 多了 `lib/translate/run.ts` | 计划把 run 层整个放在 PR 4，但短文本工具也要走"请求 → 判定 → 重试阶梯"这条路。所以 PR 3 就落了单块的 `runChunk`（含对半切的递归），PR 4 只加**整文件的编排**（逐块推进、进度事件、审批卡片、记账） |
| 对半切时不往下传 carry | 后半段的上文是前半段，而不是原来那一块。传下去会让它带上一段与它不相邻的文本 |
| 一半失败即整块失败 | 半份译文配半份原文，读起来比整块原文更难收拾 |
| 术语表在判定**之后**落实 | 判定算的是模型交回来的东西；强制替换只改字面不改行数，放在后面才不会让判定看到一份被我们动过的输出 |
| 空 API key 是合法的 | 别的子代理把"没有 key"当配置错误报出来，这里不能 —— LM Studio / Ollama 这条主线本来就没有 key |
| `translateMeta` / `translateUseLore` 等文案 | 术语表开关直接长在 translate 卡片里，没有抽象成"每个 kind 可以有额外控件"的通用槽位 —— 只有一个 kind 需要它 |

**tool budget**：`translate` 实测 **217 token**，`delegate` 287，合计 504。两者都由
`routeTools` 追加、不进 preset，所以 `agentToolBudget.test.ts` 的 preset 上限看不见
它们 —— 该文件因此多了一条**针对追加集合**的断言（上限 600），不让"在 routing 里
追加"成为一条绕开棘轮的路。

**实机验证**：mock 掉 aiStore 的绑定后端到端跑了一次 `translateTool`，五行输入
（含一个空行和一条 URL）→ 五行输出，空行与 URL 原位不动，1.1 秒。设置两页在
dev server 里渲染正常、无 console 错误。

---

## 6. PR 4 — 整文件路径

**目标**：需求完整。

### 改动

| 文件 | 改动 |
|---|---|
| `src/lib/translate/run.ts` **新** | 分块循环：切块 → 逐块请求（回带上一块）→ `judgeChunk` → 重试阶梯 `0.1 → 0.2 → 对半切` → 三次仍失败则写回原文 + 失败标记 → 重组 |
| 同上 | 每块发一个 `AgentEvent`（进度）；`signal` 中断时保留已完成的块；全程结束后 **一次** `persistUsage(projectPath, model.id, in, out, cost, "subagent:translate")` |
| `src/lib/translate/tool.ts` | 工具加 `path` 参数；`access` 升为 `"write-approval"`；产出 `CreateProposal`（`<原名>.zh.md`）走 `ctx.requestApproval` |
| `src/lib/agent/registry.ts` | 工具定义补 `path` 参数与说明 |

### 失败块的形态

```markdown
<!-- 翻译失败（第 7 块，退化，已重试 3 次）：以下为原文 -->
原文行……
```

注释形态而不是纯文本，是为了在 markdown 预览里不显示、在编辑器里能搜到，也让作者一眼看出哪几段要手工处理。

### 测试

- `run.ts` 用假的 `streamCompletion` 驱动：首轮退化 → 二轮 freq 0.2 成功，断言两次请求的 `frequencyPenalty` 分别是 0.1 / 0.2。
- 三次全败 → 产物里出现原文 + 失败标记，且**不含**模型那次的输出（不变量 3 的守卫）。
- 中断：`signal` abort 后已完成的块在结果里。

### 验收

用你给的《魔法愛姫フミカ》第一话（148 行）跑一遍：3 块、约 60–70 秒、产出 `.zh.md`、审批卡片可见、执行日志有逐块进度、用量页有一行记录。

### 实现记录（PR 4 已完成）

| 出入 | 结果 |
|---|---|
| 失败块的粒度 | 计划说「三次仍失败则写回原文」，实现里失败的单位是**块**：一半失败即整块判死。半份译文配半份原文比整块原文更难收拾 |
| 翻不动的块只花 4 次请求 | 阶梯 2 次 → 对半切 → 前半 2 次失败即整块返回，**后半根本不发**。不是 6 次 |
| 失败标记的插入时机 | 先收进一张 `行号 → 标记` 的表，最后**从后往前**插。直接往结果数组里插会让后面每一块的行号全部失效 |
| 中断是产物的一个字段 | `aborted` 一路传到工具的返回文本里。没轮到的块保持原文，已完成的留下——花掉的时间不该跟着丢，但助手必须知道这不是一份译完的稿子 |
| 一块都没成时不出卡片 | 那会是一份加了三十行标记的原文。直接报错并说清端点或绑定可能不对 |
| `translate` 升为 `write-approval` | `path` 那条路写文件。`text` 那条路什么都不写，但**工具的 tier 是它的上限**——把一个能力拆成两个 tier 去省掉一半的审批，正是写工具变得不需要审批的方式 |
| 目标文件已存在就拒绝 | 这个工具永不覆盖一份译稿 |
| tool budget 上限从 600 提到 720 | `translate` 因为多了 `path` / `reason` 和那几句"别选错形态"的说明，从 217 涨到 **347**；`delegate` 仍是 287，合计 634。按 `agentToolBudget.test.ts` 自己的规矩：涨了就在同一个 commit 里抬上限并说明为什么 |

**实机验证**：整文件路径端到端跑了你给的第一话——155 行 → 155 行，3/3 块全部译出，47.5 秒，逐块进度事件（`1/3 块 → 2/3 块 → 3/3 块`）就地更新同一行日志，审批卡片带着正确的目标路径和 `3/3 块译出` 的说明。空行、作者署名行、pixiv 链接全部原位不动。

---

## 7. 已知问题（不在本次范围）

| 问题 | 说明 |
|---|---|
| 行内 `**强调**` 丢失 | 实测确认。要修得在切块层做行内标记保护与还原，代价不小，先记着 |
| 术语表的"备注"字段没验证过 | `src->dst #备注` 的备注部分是否真被利用，本次没测 |
| 回带 4 行是猜的 | 官方说"前 3–5 句"，落成 4 行是取中。用一章真实文本 A/B 一次可以定死 |
| 只测过 14B/v1.0 | 7B / 1.5B 的退化阈值可能不同，`TOK_PER_LINE_LIMIT` 也许要随体积调 |

---

## 8. 回滚

四片都可以单独 revert。最脏的一处是 PR 1 的 DB 列——`addColumn` 是加列，revert 代码后列还在但没人读，无害（和 `pdf_input` 上线前后的情形一样）。若要彻底回退，按作者一贯偏好：**不写迁移，直接说清哪些配置会丢**（这里只有"翻译格式"这一个字段，重设一次即可）。

---

## 附录 A · 实测基线（2026-08-22，供测试取值）

端点 LM Studio @ `192.168.2.206:11234`，`sakura-14b-qwen2.5-v1.0`，ctx 33536，素材《魔法愛姫フミカ》01（148 非空行）。

| 块大小 | max_tokens | freq | 耗时 | tok/行 | 结果 |
|---|---|---|---|---|---|
| 30 行 | 1024 | 0 | 19.0s | 18.9 | 30→30 ✅ |
| 60 行 | 2048 | 0 | 21.0s | 21.6 | 60→60 ✅ |
| 60 行 | 512 | 0 | 9.0s | — | 27→60 ❌ `finish=length` |
| 100 行 | 4096 | 0 | 69.9s | 65.0 | 63→100 ❌ 退化 |
| 100 行 | 4096 | 0.2 | 34.2s | 20.6 | 100→100 ✅ |
| 138 行 | 8192 | 0 | 144.0s | 120.5 | 68→138 ❌ 严重退化 |

行为验证：中文提问 → 把问题改写还回；中译日 → 输出仍是中文；注入指令 → 当文本翻掉；markdown 块级结构与空行完整穿透，行内 `**` 丢失；术语表 15 行里漏替一处。

完整记录见 [`00-sakura-feasibility.html`](00-sakura-feasibility.html) §01。
