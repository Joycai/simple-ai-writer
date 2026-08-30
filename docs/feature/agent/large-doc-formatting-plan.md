# 大文档格式化：插入清单与段落地图

> 状态：`planned`
> 起因：2026-08-30 用「给一份巨大的、没有标题的 md 加标题、区分段落」这个场景量了一遍现有编辑回路。回路本身没有断——`rewrite_lines` 分块、行号契约、回执位移、standing grant 全都在为它铺路——但成本形状是错的：**轮数 O(文件大小)，正文两次过模型之手**。100k 字符的文件，光 `read_file` 逐页通读就是 25 轮（每轮 ≈15.9k schema + 历史重放），`headingIndex` 在最需要地图的文件上恰好失效（加标题正是任务本身，而索引要求 ≥2 个标题），写回去还得把每一段原文重新打一遍——长跑后半段历史已被压缩折叠，重打就是凭记忆重建，静默改写（paraphrase）风险被放到最大。
> 尺子沿用 [`edit-loop-plan.md`](edit-loop-plan.md) §1：**贵的是轮数，不是正文；省一轮 ≈ 15k+ token**。五期按收益排序，每期独立可交付，单人顺序执行。
> 相关：[`edit-loop-plan.md`](edit-loop-plan.md)（行号契约 / 回执 / `write` 档，本文全部机制的地基）、[`agent-tool-context-lld.md`](agent-tool-context-lld.md) §5（新工具入驻的成本纪律）

## 0. 不变量（在 edit-loop-plan 的 I1–I4 之上）

- **I5 插入的字节由运行时拼装，不由模型重发。** 「加结构」的本质是一份插入清单 `{行号, 插入什么}`；原文一个字节不经过模型，也就没有 paraphrase 可言。先例：词典标准化（AI 只搬运词对、格式由 `formatDictBody` 渲染）、writer 的 `deliverTo`（bytes 不过第二个模型）、`splitTools`（一 facet 一调用）。
- **I6 地图是运行时输出，不是参数。** 段落地图与 §5.1 的标题索引严格同构：只在响应装不下整份文件时出现，零 schema（I2）。
- **I7 卡上呈现的锚点必须是应用时校验的锚点。** `EditProposal` 用 occurrence 计数守「作者批的就是写下去的」；插入提案用**提案时的文件行数**守同一条——卡挂着的时候文件动了，写入拒绝。

## 1. 一期：`insert_lines` —— 插入清单，一轮一卡

### 1.1 形状

新 L2 工具 `insert_lines`：`{path, insertions: [{line, text}], reason}`。`line` 意为**在该行之前插入**（`line = 总行数 + 1` 拒绝并指向 `append_file`；空文件拒绝并指向同一处）。一次调用提交任意多个插入点，运行时**从后往前**应用（前面的插入不会使后面的行号失效——这正是 §4.4 要模型自己遵守的纪律，收进机制里就不用模型记了），一张审批卡呈现全部插入点。

对目标场景这意味着：读地图（二期）→ 一轮 `insert_lines` 提交整份 outline（每处 `## 标题\n\n` 或一个空行）→ 一张卡 → 一份回执。对比现状的 ~25 轮 `rewrite_lines` + K 张卡 + 全文重发。

### 1.2 改动点

| 文件 | 改什么 |
|---|---|
| `src/lib/agent/registry.ts` | 新 `InsertProposal`（`kind: "insert"`）：`insertions[]`、每点提案时抓取的上下各 1 行 `context`（卡不重读文件）、以及 `lineCount`（提案时的文件总行数，I7 的守卫，`EditProposal.occurrences` 的镜像）。进 `Proposal` 联合类型；工具定义描述**压在 ~200 token 内**（见 1.3） |
| `src/lib/agent/editApply.ts` | 纯函数 `applyInsertions(text, insertions)`：排序去重、从后往前拼接、每段插入文本强制以 `\n` 收尾（标题必须独占一行——`rewrite_lines` 的 welding guard 同款，模型不用记） |
| `src/lib/agent/writeTools.ts` | `insertLinesTool`：`manuscriptTarget` 过路径、校验插入点区间与去重、抓 context、建提案、blocks on approval。回执逐点报**新行号**（位移单调累计），末尾用 `countLines(after) − countLines(before) === Σ 插入行数` 自校验，量自文件而非参数（I3） |
| `src/stores/agentStore.ts` | `applyProposal` 新 case：先校验 `countLines(当前) === proposal.lineCount`，不符拒绝（文件在卡挂着时动了）；backup 走既有机制 |
| `src/components/ai/ApprovalCard.tsx` | 新卡样式：逐点一行 `L120 之前插入` + 插入文本 + 上下文各 1 行。作者读到的恰好是那些标题本身，不是一份全文 diff |
| `src/lib/agent/presets.ts` | 进 `AGENT_ASSIST_PRESET` 与 `WRITE_PRESET`（格式化从 chat 和 htmlArtifact 两条路都会走到） |
| i18n（zh-CN / en） | `ai.instructions.agent` 加一句：纯插入（加标题、插空行、补章节分隔）用 `insert_lines` 一次提交清单，不要用 `rewrite_lines` 重发原文 |

### 1.3 schema 账（这期唯一要辩护的地方）

`agentToolBudget.test.ts` 现状：assist 全量 15,937 / cap 16,000（余量 63），resident 10,106；`write` 档 4,065 / cap 4,300。`insert_lines` 没有 lore-plan 那样的门，进不了 deferred 组，**落 resident**，预算 +≈220，两个 cap 都要动（assist → 16,300 量级，write 视实测）。

按那个测试自己的教义：动 resident 的改动才配得上论证，论证是——这一个工具替代的是 O(文件) 的正文重发与 K 轮写入，是 §1 尺子上最大面额的一张；而且它同时**根除**了压缩折叠 → 凭记忆重打 → 静默改写这条正确性风险，这是 `rewrite_lines` 花多少轮都买不到的。落地时照惯例把实测数字写进测试注释。32k 本地模型：`contextForecast.test.ts` 复测，`write` 档必须仍给知识库留出预算。

### 1.4 测试

`editApply.test.ts` 扩：从后往前应用、边界（首行/末行前/越界/重复行号）、`\n` 强制、空文件拒绝。新增提案回路测试：lineCount 漂移拒绝、回执行号与位移自校验、context 抓取。`approvalRouting` / `writePreset` / 棘轮数字更新。

**工作量：2–3 天。**

## 2. 二期：无标题文件的段落地图

`readWritingFile` 分页且 `headingIndex` 产出为空时，前置一份段落地图：一段一行 `L12  段首前 24 字…`（空行分隔的块算一段，跳过 frontmatter 与围栏代码块），行数封顶 60（`INDEX_MAX_ROWS` 同款）加省略计数。尾注一句：这些行号是 `rewrite_lines` / `insert_lines` 的坐标。

- 纯函数 `paragraphIndex(text)` 放 `tools.ts`，与 `headingIndex` 并排；出现条件与它严格同构（I6/D2）：`!page.whole && headingIndex === ""`。零 schema。
- 成本：≤60 行 × ~15 token ≈ 900 token/次分页读——比它省下的「翻完全文才知道该指哪里」小一个数量级；有标题的文件一个字不多付（标题索引优先）。
- 测试进 `lib/__tests__`：有标题→不出段落图；无标题→出；封顶与省略；CRLF；围栏内的空行不当段界。

**工作量：0.5–1 天。**

## 3. 三期：指令层——分页读一轮多发

机制早就支持：`partitionParallelSegments` 把连续读调用并成并行段（`MAX_PARALLEL_TOOLS = 4`），一轮发 4 个不同 `start_line` 的 `read_file` 完全可行。但 §4.4 只教了多处**编辑**，没教多页**读**——这与一期修「一轮一个编辑」的错觉是同一类病。

- `ai.instructions.agent`（zh/en）加一句：顺序翻页可以一轮并发多个 `read_file`。
- `pageLines` 的续读尾注 `pass start_line=N to continue` 补半句「（一轮可发多个）」——运行时输出，规则在生效那一刻到达（D1）；`read_lore_entity` 的分页共用同一实现，顺带受益。

零 schema，零机制改动。25 页 → 7 轮，≈ 27 万 token。**工作量：0.5 天，可随任何一期先行。**

## 4. 四期：确定性段落规范化（作者侧）

「区分段落」的大头是纯文本变换，轮到模型逐段过手本身就是错的层次：

- 纯函数 `normalizeParagraphs(text)`（新 `src/lib/format/paragraphs.ts`）：段落间保证一个空行、3+ 连续空行折为 1、去行尾空白；frontmatter / 围栏代码块 / 表格原样保护。
- 入口做**作者侧**：命令面板 + 编辑器一条命令，走 CodeMirror 事务（undo 完整保留）。零 agent 成本、零 schema。
- **不做** agent 工具（见 D3）：空行插入 `insert_lines` 已能表达，独立工具是每轮白付的 schema；等实际用量说话再议。

**工作量：1 天。**

## 5. 五期：实测复核

一至四期落完后，用目标场景（≥100k 字符、无标题 md）在前沿模型和 32k 本地模型上各跑一遍，轮数 / token / 卡数记进 `measurements/`。预期回到 40 轮预算内（地图 1–2 轮 + 抽读几轮 + `insert_lines` 1 轮 + 规范化 0 轮）；`maxRounds` **不动**——`RoundLimitCard` 仍是兜底，实测仍撞卡才回头议。**工作量：0.5 天。**

## 6. 决策与弃案

### D1 插入不折进 `rewrite_lines` 的语义
曾考虑 `end_line = start_line − 1` 表示纯插入：零新工具，但 schema 描述照样要花 token 讲清这个约定，而一个「区间可以是空的」的区间工具比一个插入工具更难用对。语义各归各。

### D2 段落地图不做参数、不只出现在第一页
与标题索引同构是它唯一需要的规则（I4：契约统一，不做条件化）。「只随第一页出现」省的 token 要模型先记住见没见过它，比重复出现更贵。

### D3 `normalizeParagraphs` 不做 agent 工具
它没有 lore-plan 那样的门，进不了 deferred 组，是每轮常驻的 ~100 token——而它的活要么作者一个命令做掉，要么 `insert_lines` 的空行清单就能表达。棘轮余量该留给一期。

### D4 不做 `rewrite_document` 的分块流式
「整文件重发但流着写」修的是截断，不修 O(文件) 的正文重发，也不修 paraphrase——错的量纲上做优化。

### D5 卡上不呈现整文 diff
曾考虑把插入合成一个 `RewriteProposal` 复用现有卡：apply 路径全现成，但作者要在一张全文卡里找出几十个插入点。作者真正要批的**就是那些标题**，逐点呈现才配得上「批的就是写下去的」。

## 7. token 账（100k 字符、无标题 md，估算）

| | 现状 | 一至四期后 |
|---|---|---|
| 通读定位 | 25 轮 × (15.9k schema + 历史) | 地图 1–2 轮 + 抽读 2–3 轮（三期并发再减半） |
| 写入 | ~25 轮 `rewrite_lines`，全文重发一遍 | 1 轮 `insert_lines`（只发标题与行号）+ 作者侧规范化 0 轮 |
| 审批 | K 张卡（standing grant 可压） | 1 张插入卡 |
| 正文过模型 | 读一遍 + 重打一遍 | 读一遍（且只抽读） |
| paraphrase 风险 | 压缩折叠后凭记忆重打，全文暴露 | 结构由运行时拼装，无 |
