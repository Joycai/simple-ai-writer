# agent 编辑回路：行号契约与轮数

> 状态：`partial`（一期「行号契约」已实施；二、三期见 §7）
> 起因：2026-08-30 以 Claude Code / Codex 的工具面为尺子，审阅了 HTML 生成这条链路（`create_file` → 预览 → 改 → `export_pptx`）。断的地方不在生成端，也不在预览端——在**改**这一段：模型手里从来没有一份带行号的原文，于是每一次修改都要多走一到两轮。
> 相关：[`html-artifact-plan.md`](../html-artifact-plan.md)（HTML 交付物的由来）、[`pptx-plan.md`](../pptx-plan.md)（`read_slides` 的另一半）、[`agent-tool-context-lld.md`](agent-tool-context-lld.md)（工具 schema 的成本账）

## 1. 量纲：贵的是轮数，不是正文

工具 schema 每一轮原样重发，AGENT_ASSIST 实测 **≈ 15.1k token**（68 个工具、34,215 字符描述，`agentToolBudget.test.ts` 的棘轮量的就是它），历史也每轮重放。所以：

> **省掉一次往返 ≈ 省 15k+ token，比这条链上任何一份 HTML 正文都大。**

本文所有条目按这把尺子排序：一个把 4000 字符输出撑大 30% 的改动，只要能换掉一轮，就是净赚一个数量级。反过来，一个省下几十个 schema token 却让模型多问一次的设计，是亏的。

## 2. 现状盘点

| 环节 | 现状 | 代价 |
|---|---|---|
| `read_file` | 返回裸文本，只有末尾 trailer 写 `lines 120-232 of 900 shown`（[tools.ts](../../../src/lib/agent/tools.ts) `readWritingFile`） | 模型要在 4000 字符里自己数行；`propose_edit` 的 `find` 只能凭记忆重建缩进 |
| `rewrite_lines` 的说明 | 写着「give start_line and end_line (**the numbers read_file and search_text report**)」 | **read_file 并不报逐行行号**——说明描述的是一个不存在的契约 |
| `rewrite_lines` 成功回执 | 「…**re-read around the region** before naming another range」 | 每改一个区域固定三轮：读 → 写 → 再读 |
| `propose_edit` 成功回执 | 「Edit approved and applied.」 | 模型对改完的样子一无所知 |
| `read_slides`（.html） | 每页逐字源码，无行号（[htmlSlides.ts](../../../src/lib/pptx/htmlSlides.ts)，`lineAt()` 只在「单页超预算」那一支用） | 只能退回 `propose_edit`，把整页源码**再抄一遍**当 `find`：读 1 份 + find 1 份 + replace 1 份 |
| 找第 N 页 | 只能按 4000 字符逐段翻 | 30 页的 deck ≈ 15k token 才能定位 |
| 一轮多处编辑 | `partitionParallelSegments`（[runtime.ts](../../../src/lib/agent/runtime.ts)）**早就支持**：写调用各自成段、依次执行 | 但 `propose_edit` 说「Propose one focused edit per call」、`ai.instructions.agent` 说「写入类工具仍然逐个执行」，模型读到的是「一轮一个」 |
| `ai.instructions.htmlArtifact` | 第 4 步「整页重排用 `rewrite_document`」 | 与 `rewrite_document` 自己的说明、以及「大文件必须分段写」直接冲突——HTML 恰是最长的一类文件，这条把模型推向会被截断的那条路 |

对照 coding agent：Claude Code / Codex 的 read **永远**是 `cat -n`，Edit 成功后把改完那段带新行号回给模型。它们的准确率不是靠模型更聪明，是靠"模型手上永远有一份逐字准确、可寻址的原文"。

## 3. 不变量

- **I1 行号只存在于给模型看的输出里，绝不进文件。** 写工具的 `content` 参数永远是裸文本。这条在 trailer 里对模型说一次（而不是写进四个工具的 description，见 D1）。
- **I2 一期 schema 零增长。** 棘轮 15,200，实测 15,135，余量 65。本期不加参数、不加工具，全部改动落在**运行时输出**和 i18n 上。
- **I3 回执里的位移必须精确。** 它取代的正是那次重读——位移错了，模型据此算出的下一个区间就落在错的地方，而且不报错。
- **I4 契约是统一的，不是条件的。** `read_file` 永远带行号，不做"长文件才带"——"有时带"比"永远带"更难用，模型得先判断这次是哪种。

## 4. 一期：行号契约

### 4.1 `read_file` 永远带行号

每行前缀 `%6d | `，末尾 trailer 说明前缀是行号、不是文件内容（I1），并保留原有的分页信息。整份文件读完时也带 trailer（只是内容不同），因为 I4。

成本：每行 7 个字符（`     1\t`）≈ 2 token。HTML 约 35 字符/行，4000 字符 ≈ 114 行 ≈ **+200 token**（约 +20%）。买到的是：`find` 不再靠记忆重建、`rewrite_lines` 可以直接瞄准、以及那句描述从谎话变成真话（**一个 schema 字都不用加**）。

### 4.2 `read_slides`（.html）：每页行区间 + 分页时的整册目录

- 每页标题从 `## Slide 7` 变成 `## Slide 7 (lines 210-236)`。约 +10 token/页。
- **响应装不下整份 deck 时**，前置一份目录：一页一行 `7. 标题文本 (lines 210-236, 1.4k)`。约 15 token/页。

目录**搭分页的便车**，不是新参数（D2）。`readHtmlSlideRange` 本来就调 `splitHtmlSlides(html)` 切了整份文件，目录是纯本地、纯免费的信息。

### 4.3 写回执带回「现在长什么样」

`rewrite_lines` 与 `propose_edit` 批准后，回执给出：

1. 应用后的行区间；
2. **位移 Δ**——"这一行之后的每个行号都 +5"（I3）；
3. 一段带行号的应用后片段（上下各 2 行上下文）。

区间超过 `ECHO_MAX_LINES`(40) 行时降级为首尾各 3 行 + 位移，正文不回显——回显一份 400 行的片段就是把省下来的那一轮又花出去了。`propose_edit` 命中多处时只给行号清单，不逐处回显。

### 4.4 指令层

- `ai.instructions.agent`：说清**一轮可以发多个互不重叠的编辑调用**（机制早就支持），并给出唯一那条纪律——**同一文件的多处编辑必须按行号从后往前排**，否则前面的改动会让后面的行号失效。
- `ai.instructions.htmlArtifact`：第 4 步不再指向 `rewrite_document`；改为与全局纪律一致的「小改 `propose_edit`／区域重排 `rewrite_lines`／新建长页面骨架 + `append_file`」，并补上这条任务从来没提过的 `read_slides` 和 `export_pptx`。

## 5. 决策与弃案

### D1 行号是运行时契约，不是 schema 契约

加在工具**输出**和 trailer 里，不加进 description。两条理由：棘轮余量只有 65 token（I2）；而 `rewrite_lines` 的描述**已经**声称 read_file 报行号——这次是让那句话变成真的，不是新增一个约定。

- 弃用【给 `read_file` 加 `numbered` 参数】：模型要多学一个开关，而"有时带行号"的契约比"永远带"更难用（I4）；schema 还要多付约 50 token。
- 弃用【在四个写工具的描述里各加一句「行号不要写进 content」】：约 +100 token，直接撞破棘轮。同一句话放在 trailer 里是免费的，而且出现在模型**刚刚读到行号**的那一刻，比出现在几千 token 之前的 schema 里更管用。

### D2 目录搭分页的便车，不做 `outline` 参数

同 D1 的理由，外加一条：模型第一次调 `read_slides` 时**本来就要**知道这册有多少页、第 7 页在哪，目录是它那一刻正需要的东西。做成参数意味着它得先花一轮问、再花一轮读。

### D3 .pptx 这一期不给目录与行区间

`.html` 的切分已经在内存里（`splitHtmlSlides` 切的是整份文件），`.pptx` 要再跑一次整册 IPC 解析才拿得到标题。而且两者的使用形态不同：`.pptx` 通常读一次，`.html` 才是模型反复改的那一个。行号对 `.pptx` 更是没有意义（它不是文本文件）。

### D4 回执回显，而不是让模型重读

「re-read before naming another range」是把一次**确定性的算术**（区间长度差）外包给了模型的第二次阅读。位移是本地算得出来的，算一次写进回执，比让模型再读 4000 字符便宜两个数量级。

### D5 一轮多处编辑是指令问题，不是机制问题

`partitionParallelSegments` 早就把写调用切成"各自成段、依次执行"，一轮里发五个 `propose_edit` 今天就能跑通，每个各自弹卡、按序落盘。所以修在 i18n，不动 runtime。

- 弃用【MultiEdit 式的批量编辑工具】：一张卡片承载 N 处改动，作者审的粒度就变粗了——而这个应用的整个 L2 设计就是"一次改动一张卡"。真正的问题是模型不知道自己可以一轮发五个，那是一句话的事。

### D6 `htmlArtifact` 的指令与全局纪律对齐

一条任务指令不该和它调用的工具的说明互相矛盾。这条是纯 i18n 修正，两个 locale 同步。

## 6. token 账（一期）

| 项 | 每次 | 说明 |
|---|---|---|
| `read_file` 行号 | +≈200 / 次读 | 4000 字符的 HTML 块，约 114 行 |
| `read_slides` 行区间 | +≈10 / 页 | |
| `read_slides` 目录 | +≈15 / 页，仅分页时 | 换掉最多十几次盲翻 |
| 写回执回显 | +≈150–300 / 次写 | 超过 40 行的区域只回显首尾 |
| **省下** | **−15.1k / 轮** | 每消掉一次往返 |

改一张幻灯片：**3 轮 / 3 份源码 → 1 轮 / 1 份源码**。五处独立微调：**5 轮 → 1 轮**。

**schema 增量：0**——`agentToolBudget` 实测前后都是 15,135。这不是巧合而是约束（I2）：余量只有 65 token，所以每一条规则都必须放进模型本来就在读的那份工具输出里。而那本来就是更好的位置——规则在它生效的那一刻到达，而不是在几千 token 之前的 schema 里。

## 7. 一期不做

- **`inspect_html` 只读测量工具**（二期）。`harvestDeck()` 已经能离屏布局并回报每个盒子的 rect，缺的只是一个只读入口：溢出、图片失败、标签栈不平衡。这是 coding agent 准确率的真正来源——一个能自己跑的确定性验证器。要动 `harvester.js` 就要连 `sha256-` 和 `htmlSlides.ts` 的选择器表一起走，值得单独一片。
- **`export_pptx` 审批卡预检**（二期）。`splitHtmlSlides` 是纯函数，页数与命中的选择器层在批准前就知道；[`ApprovalCard.tsx`](../../../src/components/ai/ApprovalCard.tsx) 里"页数要渲染完才知道"的注释今天已经不成立。兜底那一支（整个 `<body>` 成为第 1 页）尤其该在卡上说出来。
- **`HtmlPreview.tsx` 的过期注释**（二期）。模块注释仍写着 "A blob document is its own opaque origin, so its scripts run."——[`html-artifact-plan.md`](../html-artifact-plan.md) D2 已经实测更正过这句话。它正好在"沙箱参数只存在一份"的那个文件里，是下一次改动最可能拿来当依据的地方。连带：三处引导都在教模型内联 JS，而应用内预览从来不执行它。
- **`htmlArtifact` 专用 preset**（三期）。该任务跑的是全量 68 工具集，每轮为用不上的知识库写工具、角色扮演、生图、翻译付 ~10k。一个 HTML 专用工具集约 4–5k。要动 `TaskTools` 三值枚举和 pack schema 的校验，不是一行。
- **`search_text` 正则**（三期，优先级最低）。字面量搜索找 `class="hero"` 够用，找模式不够用。
- **`read_slides` 的常驻成本**（记录备查，不建议动）。约 210 token/轮，一个永远没有 deck 的项目也照付。理论上能按"项目里有没有 .pptx/.html"在 routing 里剥掉，但路由每次运行只算一次——模型在同一次运行里新建了 deck 就读不回来了。省的钱不值这个风险。
