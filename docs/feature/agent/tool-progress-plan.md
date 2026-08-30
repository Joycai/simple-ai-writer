# 长任务的进度：工具卡片能报什么、报不了什么

> Status: `partial` — §2.0（`ToolContext.onProgress` 缝 + translate）、§2.2 A（轮次秒表）、§3.1（子运行卡改成结构判定）在 [#420](https://github.com/Joycai/simple-ai-writer/pull/420)，§2.1（`search_text`）在 [#421](https://github.com/Joycai/simple-ai-writer/pull/421)（基于 #420）；§2.2 B / §2.3 仍是提案。
>
> 起因：作者实机反馈「跑整文件翻译时等的心里没底」，随后要求对**所有长/大文件操作**（html / md / txt）做同一件事的清点。

## 0. 一句话结论

等待分三类，能不能报进度取决于**这次等待发生在谁手里**：

1. **工具自己在循环** —— 缝已经有了（`ToolContext.onProgress`）。translate 和 `search_text` 都走它，都已做。
2. **工具卡在别人手里** —— 批准之后的导出与生图，真正的活在 `agentStore.applyProposal` 里跑（生图轮询上限 **600 秒**），而那时工具正阻塞在 `requestApproval` 里，手上那个 `onProgress` 够不着。缝要另开。
3. **根本还没有工具** —— 模型正在把一份长正文**流式吐进工具参数**。这是「长文件操作」里最长的一段等待，而现在它一个字都没有：日志上只有「思考中…」。

查这三类时顺手翻出一条与 translate **同源**的真 bug（§3.1，已修）和一条查下来不是 bug 的（§3.2）：带 `parentStep` 的事件曾经只有 `delegate` 一条路能重新露面。

---

## 1. 清点

一次运行里真正花时间的地方，按「现在显示什么」排。时间量级是量级，不是实测。

| 路径 | 量级 | 现在显示 | 能报吗 | 单位 |
|---|---|---|---|---|
| `translate`（整文件） | 分钟 | ✅ 块/行/字 + ETA | 已做 | 块 · 行 · 字 |
| **模型把长正文流进工具参数**（`rewrite_document` / `rewrite_lines` / `create_file` / `append_file` / `propose_edit` / 写 .html） | 30 秒 – 3 分钟 | ⏱ 轮次秒表（§2.2 A 已做）；**字数仍然没有** | 能（三家协议里两家） | 已生成字数 |
| `generate_image` / `edit_image` / `redraw_lore_image` | 30 秒 – **10 分钟** | 批准后一直 running，无数字 | 能，但缝在 store 侧 | 轮询次数 / 已用时 / 上限 |
| `search_text` | 大项目上秒级 | ✅ 已扫 N/M 个文件 · 命中数（§2.1 已做） | 已做 | 文件 |
| `export_pptx` / `export_docx` / `export_xlsx` | 秒级（harvest 上限 20s） | 无 | 能，同生图那条缝 | 幻灯片 / 工作表 |
| `inspect_html` | 秒级 | 无 | 同上 | 幻灯片 |
| `run_pack` 子运行 | 分钟 | ✅ 执行代理卡（§3.1 已修） | 已有 | — |
| `delegate` 子运行 | 分钟 | ✅ 子代理卡（带嵌套日志） | 已有 | — |
| L2 写工具等作者批准 | 作者自己的时间 | running + 审批卡 + 系统通知 | **不做**（§4） | — |
| `read_file` / `read_slides` / `list_files` / 知识库读 | 毫秒 | — | **不做**（§4） | — |

证据：

- 适配器**只在流结束时**交出工具调用：`ai/openai.ts:245,264`（两处 `emitToolCalls()`，都在读流之后）、`ai/anthropic.ts:611` 同形。增量本来就在 `toolCallMap` / `toolBlocks` 里逐片累加，缺的只是往外发一次。
- **Gemini 拿不到增量**：`ai/gemini.ts:288` 的注释写着 "Gemini sends complete functionCall objects (not streamed fragments)"。这条对 Gemini 家族只能退化成「已用时」。
- `search_text` 是**逐文件串行读**：`agent/tools.ts:917` 对每份文档 `await readFile`，`:934` 起再对知识库每个条目的每份 md 读一遍。300 章 + 50 条目 ≈ 350+ 次 IPC。
- 生图轮询上限：`ai/image.ts:1013` `DASHSCOPE_TASK_TIMEOUT_MS = 600_000`、`:1109` ComfyUI 同值，轮询间隔 1–5 秒。
- 导出与生图**在批准之后**才干活：`stores/agentStore.ts:551` `applyProposal` 的 `illustrate` / `pptx` / `docx` / `xlsx` 分支，由 `settleApproval` 调用，**之后**才 `item.resolve()` 放行那次工具调用。所以工具步一直是 running，而工具本身早已阻塞在 `requestApproval` 里。
- harvest 上限：`pptx/harvest.ts:68` `TIMEOUT_MS = 20_000`。

---

## 2. 可做项

### 2.0 已做 · `ToolContext.onProgress`（PR #420）

运行时把自己那一步 running step 提成常量，工具通过 `ctx.onProgress({label, ratio})` 让它**就地前进**；`ToolStep.progress` 只在 `running` 时有意义。工具因此不用重建 step 的身份 —— 重建错任何一个都会在第一行下面**再印一行**，而不是把第一行推着走（translate 原来那份代码踩的正是这个坑，见 §3 同源）。

界面：运行中的行右侧显示进度而不是它还没有的结果，行底压一根 1px 进度线；折叠着的标题行也带同一串数字，并**顶掉参数** —— 那行从右边裁，参数是静态的、下一行就有。

**这条缝对 §2.1 直接可用，对 §2.2 / §2.3 都不够。**

### 2.1 已做 · `search_text`（PR #421）

单位是「已扫 N/M 个文件 · 命中 X 处」，走 §2.0 那条缝。三件事值得记：

- **分母先于第一个 await 存在。** 知识库那一侧原来是三层嵌套循环边走边读，现在先由
  `scopedLoreFiles` 把「这次要读哪些文件」列平（走索引不碰盘，免费），然后两侧各一个平铺
  循环。一个不知道自己在往哪儿去的进度条回答的是问题的另一半。
- **节流按时间，而且时钟从构造那一刻起走。** 300 章的项目是 350 次串行读，逐个报就是 350 次
  store 写、去画一行只能显示最后一次的东西。而按时间的副作用正是想要的：**一次在一个周期内
  跑完的搜索一个字都不报**（绝大多数搜索如此），于是不必去猜「多大算大项目」这个阈值。
- **读不出来的文件照样计入已扫。** 权限错误跳过的是扫描不是计数 —— 那份文件的等待确实结束
  了，而一个分子永远够不到的分母比没有进度更糟。

标签走 i18n（`ai.agent.progress.search*`）：`search_text` 不像 translate 那样只在中文场景下
出现，硬写中文会让英文界面的作者看到一行中文。translate 那条标签仍是硬写的中文 —— 它是
日中翻译，暂时随它去。

### 2.2 模型流式写长文件 —— 最值钱的一个（A 已做，B 待定）

**这是作者说的「长/大文件操作」的正主。** 让助手重写一章 3,000 字的正文，模型要吐 ~4,000 token 的 `content` 参数；40 tok/s 就是 100 秒的**完全静默**（非思考模型连那一行 reasoning 都没有）。而这恰恰是这个应用最主要的一件事。

分两层，建议**分两片 PR**：

**A. 只加「已用时」（零协议改动）—— 已做**

秒表挂在**轮次筹码**上而不是标题行上（`3/12 轮 · 1:22`）：标题行已经是这个组件里最挤的一行（工具自己的进度就落在那儿），而「第几轮、多久了」本来就是一个念头。计时从**本轮**开始算，不是整个运行 —— 一次运行长有正当理由（十二轮真活），一个**轮次**跑了两分钟才是该注意的事。

**满 5 秒才出现**（`ROUND_TIMER_FLOOR_S`）。多数轮次两三秒就结束，一个 0:01 冒出来、0:04 消失的钟，是拿每一轮的抖动换零收益；它该在这一轮**安静下来**的时候才出现，而那正是它存在的理由。

把「冻住」变成「活着，而且我知道等了多久」—— 这是本次全部问题里性价比最高的一改，也是唯一对**四个协议家族一视同仁**的一改。

**B. 流式参数字数（要动协议层）**

- `StreamOptions.onChunk` 加一种：`{ toolCallProgress: { name, chars } }`。
- `openai.ts` 累加 `entry.args` 的地方（`:220`）与 `anthropic.ts` 的 `input_json_delta` 处各发一次，**在适配器里节流**（每 ~200ms 一次，否则一秒几十个事件）。
- 运行时把它变成一行日志：`正在写入 rewrite_lines · 3,240 字`。这一行**不是 tool-step**（那一步还不存在），要么新开一种事件，要么复用 reasoning 那种「同轮就地替换」的行。
- Gemini 家族没有增量，退化成 A。

代价：中（3 个文件 + 一种新 chunk + 一行 UI）。收益：高。风险：适配器是全应用最不该出错的一层，这条改动**只加分支不改既有路径**，且没有它 tool call 照常工作 —— 可测（给适配器喂一段带 `tool_calls` 增量的 SSE 固件，断言 progress 事件的条数与最终 arguments 不变）。

### 2.3 生图 / 导出 —— 缝不在工具这边

要报进度，得让审批通道把工具步的身份带过去：`PendingApproval`（`agentStore.ts:156`）今天有 `runId` / `turnId` / `signal`，没有 `toolCallId`。加上它之后，`settleApproval` 就能往**同一行**发 progress：

- 生图：`轮询中 · 已等 48 秒 / 上限 10 分`（ComfyUI 还能读到队列位置，DashScope 只有 task 状态）。
- pptx：`第 7/24 页已量`（harvest 的 `harvester.js` 本来就是逐节点走的，但它一次 postMessage 回全部 —— 要报页级进度得让它中途也发消息，那是改 `harvester.js`，**要同步更新 `tauri.conf.json` 的 sha256 和 `htmlSlides.ts` 的选择器清单**，代价一下就上去了）。

建议只做**生图的「已等 / 上限」**（不需要碰 harvester，纯计时），导出秒级先不做。

### 2.4 明确排在后面

`file_lore_entries` / `move_lore_entity` 等归集类工具会写 N 个条目，但 N 通常是个位数、每次写是毫秒级。等哪天有人报了再说。

---

## 3. 顺手捡到的两条（一条是 bug，一条不是）

根因一句话：**带 `parentStep` 的事件曾经只有 `delegate` 一条路能重新露面。** `buildLogModel` 第一行 `log.filter(e => !e.parentStep)` 把它们全滤掉，而建子代理卡的那一步只认 `step.name === "delegate"` 这个字面量。

### 3.1 `run_pack` 的整段子运行在日志里不存在

`packs.ts:351` 用和 `subagent.ts:472` **一模一样**的方式转发（`{...e, parentStep: call.id}`），但 `run_pack` 不叫 `delegate`，所以那些轮次、工具步、`run-done` 一条都不显示。开着「助手工具包模式」Beta 时，**每一次写入都发生在一个看不见的子运行里**。

token 账没丢：`sumTokens`（`logModel.ts:320`）读的是**原始 log**，带 `parentStep` 的 `run-done` 照样计入 subInput/subOutput。丢的只有卡片。

这三条**跑过**（临时 vitest，未入库）：同一段事件流只把工具名从 `delegate` 换成 `run_pack`，`subagents` 从 1 张卡变成 0 张，且整个 model 里再也找不到任何带 `parentStep` 的事件；`sumTokens` 仍然算出 700/300。

**已修（本 PR）。** 两条修法里选了本分的那条：**凡是有嵌套事件指着它的工具步，就给它一张卡** —— 名字不再参与判定。`DISPATCHERS` 表只剩**取名**一件事（`delegate` 读 `kind`、`run_pack` 读 `pack`），认不出的第三个分发器照样有卡，只是标签就是它的工具名。下一个转发嵌套事件的工具不用再改这个文件一次；这已经是第三次了。

顺带两处：`buildLogModel` 先一遍把嵌套事件按 `parentStep` 分好桶（原来是每个 delegate 步各扫一遍全表，O(n²)）；**没起来的分发器不再拿到一张空卡** —— 一次在启动前就失败的派单现在留在行上，错误就写在那一行，而不是藏在一张要先点开的空卡里。

### 3.2 写手（handoff）—— 查下来**不是** bug，故意不修

`handoff.ts:408` 确实同样转发，但它的 `parentStep` 是 `handoff-<round>`，一个**合成 id**：那次工具调用在 `runtime.ts:857` 就被截走了，从来没有 tool-step 事件。所以结构规则天然够不着它 —— 而这正合设计：设计稿 12 · 屏 3a 写的是「执行日志里不再有工单卡」，交接渲染在**回合本身**上（`WriterTurn`），`handoff-done` 带着字数、耗时、token 和费用。

改前的判断（「按 §3.1 会顺带修好」）是错的，在此更正：写手少的是内部轮次那一层细节，而它的状态和账都在作者看得见的地方。

---

## 4. 明确不做

- **毫秒级工具的进度条。** 给一个三毫秒的调用画进度条只是噪音，而噪音会让真正在动的那根线变得不值得看。
- **「等待作者批准」的进度。** 那是作者自己的时间，卡片就在眼前，还有系统通知（`lib/notify`）。把它画成进度，等于把一个决定伪装成一段处理。
- **导入（docx / pdf / pptx）。** 它确实是长文件操作，也确实逐页跑（`import/pdf.ts:274` 的 `for i <= numPages`，一页一次文本 + 图片抽取），但它**根本不在工具卡片上** —— 那是文件树的一次对话框操作。要做是另一条线，不该混进这份清单。

---

## 5. 建议的落地顺序

| 片 | 内容 | 代价 | 收益 | 状态 |
|---|---|---|---|---|
| PR 1 | §3.1 子运行卡改成结构判定 | 小 | 中 —— 这是「日志在骗人」类的问题 | ✅ 已做 |
| PR 2 | §2.2 A：轮次秒表 | 小 | **高** —— 唯一对四个协议家族一视同仁的一改 | ✅ 已做 |
| PR 3 | §2.1 `search_text` 的 N/M | 小 | 中 | ✅ 已做（#421） |
| PR 4 | §2.2 B：流式参数字数（含适配器固件测试） | 中 | 高 | |
| PR 5 | §2.3 生图的「已等 / 上限」 | 中 | 中 | |

每片之间停下来，等作者在真机上看过再往下走。
