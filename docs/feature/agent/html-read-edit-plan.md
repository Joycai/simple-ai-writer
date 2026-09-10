# agent 侧 HTML 读写：入口、坐标与超长行

> 状态：`shipped`（五片全部走完。片 A–D 已实施；片 E 量完，结论是两件都不改——数字见 [`measurements/read-cost-2026-09.md`](measurements/read-cost-2026-09.md)）
> 起因：2026-09-07 以「改某一部分时会不会退化成 read-all」为尺子，审阅了 app 对 `.html` 的读写支持。写的一侧是对的，读的一侧在**幻灯片形状**的页面上也已经不 read-all（[`pptx-plan.md`](../pptx-plan.md) 那半 + `read_slides` 吃 `.html`）。断的地方在四处：模型走 `read_file` 进来时**没人把它引到那份目录上**、`inspect_html` 的发现没有坐标、超长单行读不全、非幻灯片页面没有结构坐标。第五处是 IPC 量级，先量后改。
> 相关：[`edit-loop-plan.md`](edit-loop-plan.md)（行号契约与 `inspect_html` 的由来，§5.1 就是本文片 1 补的那句话）、[`large-doc-formatting-plan.md`](large-doc-formatting-plan.md)（段落地图，与本文的地标索引同构）、[`../html-artifact-plan.md`](../html-artifact-plan.md)（HTML 交付物的由来）、[`agent-tool-context-lld.md`](agent-tool-context-lld.md)（schema 成本账）、[`../../reference/tool-presence.md`](../../reference/tool-presence.md)（指路只能指向这次运行真有的工具）

## 1. 量纲：这一轮的余量是 135 / 28 / 86 token

工具 schema 每一轮原样重发（[runtime.ts](../../../src/lib/agent/runtime.ts) `getToolDefinitions`，最多 40 轮），`agentToolBudget.test.ts` 的棘轮量的就是它：

| preset | 上限 | 实测（2026-09-07） | 余量 |
|---|---|---|---|
| `AGENT_ASSIST_CAP` | 16,800 | 16,665 | 135 token |
| `CONTINUE_CAP` | 2,000 | 1,972 | **28 token** |
| `WRITE_CAP` | 4,800 | 4,714 | 86 token |

`read_file`(97 tok) / `read_slides`(211) / `inspect_html`(147) / `read_document`(130) 常驻在这几个 preset 里，往任何一个的 description 加一句话要在每一档各付一次。**最紧的是 `CONTINUE_CAP` 的 28 token**——它比另外两个小一个数量级，而且最容易被漏掉：HTML 这条线上的讨论从来不提续写档，可 `CONTINUE_PRESET` 带着 `read_file` / `read_slides` / `read_document` 三个都在。本文第一版就漏了它，第一次实测才发现（§9 D5）。`contextForecast.test.ts` 另外钉着 32k 模型上 `agent` 档知识库仍分得到 >2000 字符、`write` 档 `free > 0`。

> **所以本文的第一条设计原则：一切「指路」走工具的 RESULT 文本，不走 description。**

结果文本只在它适用的那一轮付一次费，而且到达的时机更好——模型读到 trailer 的时候，写在几千 token 之前的那条规则早就滚出注意力了。这不是新发明：[`edit-loop-plan.md`](edit-loop-plan.md) §D2 论证过「目录搭分页的便车，不做参数」，`lineEcho` 那一套整个是运行时输出而不是 schema。**四片的 schema 成本因此全是 0**——包括片 3，它的续读坐标塞进已有的 `start_line` 里（§6）。

## 2. 现状盘点

| 环节 | 现状 | 代价 |
|---|---|---|
| `read_file` 打开 `.html` | `headingIndex` 匹配 markdown ATX 标题 → HTML 上恒为 0；`paragraphIndex` 在紧凑 HTML 上凑不满两段 → **index 是空串**（[tools.ts](../../../src/lib/agent/tools.ts) `readWritingFile`） | 「改第三页的标题」从一页 4000 字符往下翻开始 |
| 指路 | `ai.instructions.agent` 只提了 `inspect_html`，**一个字没提 `.html` 可以按页读**；只有 `ai.instructions.htmlArtifact` 第 6 步提了 | 对话助手（最常用的那个面）上模型不知道 `read_slides` 吃 `.html` |
| `inspect_html` 的发现 | `label()` 是截到 24 字符、空白归一化的引文（[inspect.ts](../../../src/lib/pptx/inspect.ts)），报告只有 slide 序号 | 引文不能直接当 `find`；定位要多走一轮 `read_slides`。而 `inspectHtmlTool` **已经调过** `splitHtmlDeck`，行区间就在手上被丢掉了 |
| 超长单行 | `pageLines` 的 `cutMidLine` 只说「被截断」，不给续读坐标；续读提示又被 `to < lines.length` 挡住 | 整文件一行时**读不到第 4000 字符之后**；多行文件里的超长行尾巴永远读不到，而模型接着 `rewrite_lines` 覆盖它 |
| 非幻灯片 `.html` | 落到 `WHOLE_PAGE_TIER`，整个 body 当一张幻灯片截 4000 字符 | 没有任何结构坐标；末尾那句 `read the rest with read_file (start_line=…)` 给的还是这张 slide 的**起始**行，照做会从头重读 |
| 分页读的 IPC | 每一页都 `readFile` 整文件过 IPC（`fs_read_text_file` 返回整串） | 200KB 的页面分 50 页 = 50 × 200KB |
| `search_text` | JS 侧**串行**整读每个文件再扫描，无 Rust grep、无索引 | 量级未测 |

对照：`read_slides` 那一半是对的——按 slide 返回 verbatim 源码 + 行区间，装不下时自带目录（标题/行区间/字符数），切分与 `harvester.js` 共用选择器且由测试钉住。**本文不动它，本文是把进得来的路补上。**

## 3. 不变量

- **I1 指路只能指向这次运行真有的工具。** 判据是 `ToolContext.allowedTools`，不是注册表（[`tool-presence.md`](../../reference/tool-presence.md)）。`WRITER_PRESET` 与 `NARRATOR_PRESET` **有 `read_file` 没有 `read_slides`**——旁白那条的行内注释正好在讨论这个坑。
- **I2 `numberLines` 的 gutter 一个字符都不改。** 6 位右对齐 + TAB，由 `lineEcho.test.ts` 逐字符钉死，另有三个测试文件在断言里抄了它。
- **I3 `pageLines` 的 `notes[0]` 位置是载荷。** `readWritingFile` 和 `readDocumentFile` 都在 `notes.splice(1, 0, …)`。
- **I4 已钉的 trailer 串继续成立**：`whole file, N lines`、`lines A-B of N shown`、`pass start_line=N to continue`（`agentReadTools.test.ts` 用正则把数字抠出来再喂回去）、`cut mid-line`。
- **I5 行内片段的「我是第几个字符」由 notes 承载，不由 gutter 承载。** gutter 保持统一（长行的尾片没有换行符，正好占一行、编号就是它自己的行号）——今天长行的**第一页**本来就是这样一个片段，续读页跟它一致比跟它不一致好。真正要说清「这不是整行」的地方是 notes，因为那正是模型准备把它抄进 `find` 之前读到的最后一句话。
- **I6 标错行比不标行糟，所以每一个坐标来源都要说清它算错时会怎样。** 模型拿到行区间就会照着写——`rewrite_lines` 不会问第二遍。凡是产出行号或行区间的地方，都要能回答「它可能错吗？错了会怎样？」，并把答案写在代码旁边。今天的四个来源各有各的答案：

  | 来源 | 可能错吗 | 答案 |
  |---|---|---|
  | `inspect_html` 的发现 | **会**。两份 slide 清单（运行时 `querySelectorAll` 与文本切分）按构造一致，但脚本生成的幻灯片只存在于渲染后的 DOM 里 | 数目对不上就**整体丢掉**行区间，退回不带坐标的措辞，不按下标硬对 |
  | `landmarkIndex` 的地标 | **会**。区间来自 `elementEnd`，而它对找不到闭合标签的元素一路算到文件末尾 | 空元素表（`VOID_TAGS`）让它们止于自己的 `>`；容器忘了闭合仍跑到末尾，那与浏览器一致 |
  | `lint` 的发现 | 不会。行号由同一份源码的偏移直接算出（`lineAt`），不跨清单对齐 | 无须守卫，但这句话本身就是答案 |
  | `pageLines` / `slideIndex` / `readHtmlSlideRange` | 不会。同上，各自从自己的偏移算 | 同上 |

  **加一个新来源时，往这张表里加一行。** I6 最初只写了第一行，于是 §7 引入第二个来源时没人问这个问题：`<img id="logo">` 报出「第 5 行到文件末尾」，标签文字还被同一条兜底带歪成看起来正常的样子，两天后自审才发现（修复见 PR #538）。不变量要跟着**坐标的每一个新来源**走，不是只钉在写它的那一片里。

## 4. 片 1：`read_file` 打开 `.html` 时给目录并指向 `read_slides`

[`edit-loop-plan.md`](edit-loop-plan.md) §5.1 当初写的就是「没有标题的 `.txt` 和 `.html` 页面自然什么都不产出——而 `.html` 有 `read_slides` 的目录」。但没有任何代码把 `read_file` 引到那份目录上。这一片是把那句话补成真的。

**改动点**

| 文件 | 改动 |
|---|---|
| [tools.ts](../../../src/lib/agent/tools.ts) `readWritingFile` | 新增本地 `htmlIndex(raw, canReadSlides)`；index 那一行改成 `isHtmlPath(path) ? htmlIndex(...) : "" \|\| headingIndex(raw) \|\| paragraphIndex(raw)` |
| [htmlSlides.ts](../../../src/lib/pptx/htmlSlides.ts) `slideIndex` | 加行数上限（沿用 `INDEX_MAX_ROWS = 60`）——目前无上限，200 个 `<section>` 的页面会在**每一页**结果里铺 200 行 |

`htmlIndex`：`splitHtmlDeck(raw)` → 若 `tier !== WHOLE_PAGE_TIER && slides.length > 1` 返回 `slideIndex(slides)`，否则返回 `""`（另一半是片 4）。切分是纯文本函数、文件已经在手里，**零额外 IO**。

**新增的结果文本**（英文；有 `read_slides` 时才出现，I1）

> `Read one slide with read_slides (start_slide=N) — its source comes back verbatim, which is what propose_edit's 'find' needs.`

没有 `read_slides` 时**目录照给**——行区间本身对 `rewrite_lines` 就有用——只是不提那个工具名。先例：同文件的 `loreGutterNote(canRewrite)` 与音频重定向。

**测试**：`agentReadTools.test.ts` 加三例（有/无 `read_slides`、无 section 的 `.html`）；`htmlSlides.test.ts` 加 `slideIndex` 的截断行。

## 5. 片 2：`inspect_html` 的发现带上行区间

`formatDeckReport` 全仓只有一个生产调用方（[htmlTools.ts](../../../src/lib/agent/htmlTools.ts)），而那个调用方**已经**解构了 `splitHtmlDeck` 的 `tier`，`slides` 就在旁边。

**新签名**

```ts
export function formatDeckReport(
  report: DeckReport,
  path: string,
  tier: string,
  lines?: readonly { startLine: number; endLine: number }[],
): string
```

传结构极简的数组而不是 `HtmlSlide[]`：`inspect.ts` 因此不用 import `htmlSlides.ts` 的类型，两个模块的方向不变（`inspect` 只吃量出来的东西）。

**渲染**：`Slide 3 (lines 88-142, 12 boxes): "长标题…" is 34px past the right edge.`；空白页那行同样带上。长度对不上时整体丢掉行区间（I6）。

**测试**：`pptxInspect.test.ts` 三例（带 `lines` / 不带 / 长度对不上）。

## 6. 片 3：超长单行可续读

这一片修的是正确性，不只是效率。触发场景不假设：内联 `<style>` 压成一行、SVG 的 `d="M…"` 长路径、作者拖进来的保存网页或导出报告（常是单行）。

**续读坐标塞进已有的 `start_line`，不加参数**

`start_line` 在四个读工具的 schema 里本来就是 `"type": "number"`，而四个调用方都把模型给的值原样传进 `pageLines`（`registry.ts` 三处 + `tools.ts` 的 lore 读），`pageLines` 自己才 `Math.floor` 掉小数。所以一个 `57.0001` 形状的游标今天就能原封不动地到达 `pageLines`——**一处改动同时修好四个读工具，且 schema 一个 token 都不动**。

```
游标 = 行号 + 页序 / 10000        页序 ∈ [0, 9999]，固定四位小数
页序 k 表示：从这一行的第 k * READ_MAX_CHARS 个字符（0 基）开始
```

`57` = 第 57 行从头；`57.0001` = 第 57 行从第 4001 字符起；`57.0002` = 从第 8001 字符起。四位小数够 40 MB 的单行，双精度也稳（`Math.round((57.0002 - 57) * 10000) === 2`）。**这个字面量永远由工具产出、模型抄回，从不由模型自己拼**——和今天的 `start_line=21` 是同一份契约。

**`pageLines` 的新形状**（签名不变，返回对象加两个字段）

```ts
/** 精确给出下一次该传什么，或文件到底了。新字段。 */
next: string | null;
/** 这一页从行内某处开始、或在行内被截断。新字段。 */
partial: boolean;
```

- 拆出 `line = Math.floor(from)` 与 `part = Math.round((from - line) * 10000)`，`skip = part * READ_MAX_CHARS`。
- 起始那一行剩余 > `READ_MAX_CHARS` → 只回这一片，`next = pageCursor(line, part + 1)`；否则补完这一行后按今天的逻辑继续装整行，`next = String(to + 1)`。
- `body` **照旧过 `numberLines`**（I2）：长行的尾片里没有换行符，所以它正好占一行 gutter、编号就是 `line`，后面接上的整行自然是 `line+1, line+2…`。**gutter 格式一个字符都不用改**，`whole` 的算法也只多一个 `part === 0` 的合取项。
- 第一页的行为与今天**逐字节相同**（9000 字符的单行仍然回前 4000 且带 `     1\t`），所以现有的 `cut mid-line` 断言原样通过。

**notes**（`notes[0]` 的位置不动，I3）

- `notes[0]`：`lines 57-57 of 900 shown` 后按需追加 `(line 57, characters 4001-8000 of 51203)`——`whole file, N lines` 与 `lines A-B of N shown` 两个已钉子串都保住（I4）。
- 截断时：`cut mid-line — pass start_line=57.0001 to continue inside line 57: the digits after the dot are a position INSIDE that line, not a line number.` 再带上「这一行还剩几页、首尾游标各是什么、几页可以同一轮一起要」——40 轮的上限下，一份 500 片的压缩页面就是靠这句话读得完的。
- 不截断而文件还有下文时，那句 `pass start_line=${to + 1} to continue — several pages can be requested in the same round, they do not wait on each other` **逐字节不变**，所以 `agentReadTools.test.ts` 里把数字抠出来再喂回去的那一例照旧。
- 模型自己编出来的游标要报错并**给出正确的字面量**：`Error: start_line 57.0009 is past the end of line 57 (12000 characters, 3 pages). Its last page is start_line=57.0002.`

单行文件因此有了出路：续读坐标由游标给出，不再受 `to < lines.length` 那道门挡着。

**`search_text` 顺手接上**（同一片，仍是零 schema）：命中行长于 `READ_MAX_CHARS` 时，把坐标渲染成 `> L1 (character 124501 — read it with start_line=1.0031)`。「在压缩页面里找到那一段」于是从无界翻页变成一次搜 + 一次读。

**写工具不需要改**：`rewrite_lines` 与 `rewrite_lore_lines` 都做 `Math.floor(Number(...))`，游标漏进写工具只会退化成整行，不会写坏东西。修复留在读的一侧。

**唯一的不确定**是小模型会不会把 `57.0001` 抄成 `57`——代价是白费一轮（拿到同一页和同一条纠正提示），不是数据损坏。**已实测，结论是站得住**（2026-09-07，LM Studio 本地端点，真的 `read_file` schema + 真的首页结果，各 6 次）：

| 模型 | `start_line=1.0001` | 没调工具 | 抄错的游标 |
|---|---|---|---|
| `gemma4-26b-a4b` | **6 / 6** | 0 | 0 |
| `qwen3.8-27b` | **5 / 6**（其中 4 次同一轮并发发了 1.0001 / 1.0002 / 1.0003） | 1 | 0 |

12 次里 11 次拿到正确游标，**一次抄错的都没有**。qwen 的思考过程原文：「The file has only 1 line, and that line is long (13815 characters). … I need to continue reading within the same line: pass start_line=1.0001 to continue inside line 1.」——它连「几页可以同一轮一起要」那半句也照做了，这正是那句话加进 trailer 的理由。唯一那次「没调工具」是探针自己 `max_tokens` 太小把思考截断了，不是模型的问题。

（这里没用 `scripts/prompt-ab.ts`：那个台架量的是**选哪个工具**，这里要量的是**参数抄得对不对**，两件事。探针是一次性的，没进仓。）

顺手在 registry 里把 `args.start_line` 过一道 `Number(...)`，模型把它字符串化也还能用（`cursorArg`，零 schema 成本）。

**同片顺带的两个防护**（都在读/回执一侧，不动协议）

- `echoRegion` 只按 40 **行**封顶，没有字符上限。真让模型重写了一行 132 KB，批准回执会把它整行回显。给单行加一个约 500 字符的截断标记即可，`numberLines` 的格式不受影响。
- `read_file` 在截断时追加一句（仅当本次运行有 `propose_edit`，I1）：改这么长的一行请把有辨识度的片段抄进 `find`，`rewrite_lines` 会替换掉整整 13 万字符。

## 7. 片 4：非幻灯片 HTML 的结构地标索引

**先纠正一个容易得出的错判**：`inspect_html` 对长滚动页面并非空转。`harvest.ts` 的框是 1280×720，whole-page 时 `canvas` 取 body 的 rect（宽 1280、高为整页），所以**横向溢出、图片加载失败、整页空白照报**，只有纵向溢出不报——而那正是对的，一个长落地页不该因为自己长就被报成溢出。所以这一片只做**读**的一半。

**改动点**

- [htmlSlides.ts](../../../src/lib/pptx/htmlSlides.ts) 新增 `landmarkIndex(html)`，复用同文件的 `scanTags` / `elementEnd` / `hasClass` / `lineMapFor` / `slideTitle`。**放同一个文件而不是新开模块的理由就是这个：标签扫描器和行号映射只应该有一份。** 模块头注释与 codemap 的 `src/lib/pptx/` 段同步改成「按结构读一份 `.html`：是幻灯片就按页，不是就按地标」。
- `htmlIndex`（片 1 建的）补上 else 分支。

**索引长什么样**（与 `slideIndex` 同构）

```
This page has no slide sections. Its landmarks and the lines they occupy — rewrite_lines takes these numbers, so a section can be named without paging to it:
1. <h1> 产品发布计划 (lines 42-44)
2. <section id="hero"> 让每一次发布 (lines 46-88)
3. <h2> 三个季度 (lines 90-92)
```

选行：全部 `<h1>`–`<h6>`（文本用 `slideTitle` 取），带 `id` 的块级元素，以及 `header / nav / main / footer / aside / figure / table`。超过 60 行时**先保住全部标题**，剩余额度给 id 地标——不能像 `paragraphIndex` 那样等距抽样，标题的价值不均匀。标题和 id 都没有 → 返回 `""`，落回 `paragraphIndex`。

**顺带修一个真 bug**：`readHtmlSlideRange` 里超大单页的那句 `read the rest with read_file (start_line=${slide.startLine})` 给的是这张 slide 的**起始**行，模型照做会从头重读。改成截断点之后的坐标，与片 3 的小数游标同一套口径（`1.0031` 而不是另造一种说法）——**因此片 4 排在片 3 之后**。

## 8. 片 5：只做测量（已完成，结论是不改）

量完了，数字与完整论证在 [`measurements/read-cost-2026-09.md`](measurements/read-cost-2026-09.md)；harness 是 `scripts/read-cost.ts`（配 `scripts/cost.vitest.config.ts`，照 `prompt-ab.ts` 的先例，**永不进 CI**）：

```
pnpm exec vitest run --config scripts/cost.vitest.config.ts
```

**结论：两件都不改，`fs_grep` 不写。**

- `search_text`：304 个文件、2.32MB，最慢一次查询 **16.8ms**，单次同步块最长 0.3ms，传输下界再加 6.8ms。判据是「> 1.5s 或同步块 > 100ms 或过 IPC > 5MB」，三条全不沾边。一份第二套搜索实现（大小写折叠 / 四个上限 / 排序 / 编码探测都要永远对齐）换不到这 17ms。
- 分页读：今天也不改，但它**是二次的**——每页重读整个文件，页数又正比于文件大小，所以搬运量正比于大小的平方。实测 200KB → 10.35MB / 85ms，500KB → 64.5MB / 586ms，1MB → 256MB / 2313ms。这个 app 产出的 `.html` 在 60–200KB，85ms 摊在 53 个模型轮里看不见。

**因此拐点不是「今天多快」，而是文件大小**：工作区里出现 **≥ 500KB 的单个文本文件**时回来看这一页。真到那天，修法也**不是 Rust**——`fs_read_head` 那条路走不通（`pageLines` 要全文总行数，三个索引函数要全文），而 `lib/fs/fileio.ts` 里一个 TTL 约 2 秒、在同模块写操作上失效的**读合并器**就够：实测「同一轮 40 页」那行的 7.81MB 会塌成一次 200KB 的读，零 Rust、零 schema、不动协议。

**押错的那一条记在这里**：本文原写「我的先验是搜索**会**撑得起这次改动，而读的那一半不会」。两半都反了——搜索是完全不用管的那一半，读的那一半虽然今天同样不用管，却是唯一会撞墙的那一个。

## 9. 决策与弃案

### D1 指路走结果文本，不走 description

余量 135 / 28 / 86 token，而一句像样的英文指引就是 50 token 起，四个相关工具在三档里都常驻。结果文本免费，而且到达时机更好。同 [`edit-loop-plan.md`](edit-loop-plan.md) §D2。

### D2 `htmlIndex` 不做参数

理由与标题索引、段落地图、`read_slides` 的整册目录**严格同构**：只在响应装不下整份文件时出现。切分本来就是纯本地计算，一个要先问一次的地图会花掉它省下的那一轮。

### D3 目录/地标不按扩展名分派进 `headingIndex`

`headingIndex` 匹配 ATX 标题，是 markdown 的事；HTML 的结构是标签。两件事共用一个函数只会让两边都长出 `if`。分派放在 `readWritingFile` 里一处，`isHtmlPath` 已经在那儿了。

### D4 `landmarkIndex` 放 `htmlSlides.ts`，不新开模块

扫描器（`scanTags`）、元素闭合（`elementEnd`）、行号映射（`lineMapFor`）、短标签（`slideTitle`）四个都要复用。新开模块就得把它们导出，等于把一个私有扫描器变成公共 API，还多一条 import 边；而 `htmlSlides.ts` 的职责本来就是「按结构读一份 `.html`」，按页只是其中一种结构。

### D5 续读坐标塞进 `start_line`，不加 `start_char` 参数（弃案有账）

本文第一版写的是「加 `start_char`，实测 38–69 token，两个棘轮都装得下」。**那个账漏了一档**：`CONTINUE_PRESET`（续写）也带 `read_file`/`read_slides`/`read_document`，而它的余量实测只有 **28 token**——最便宜的可用参数 JSON 是 +29，一句像样的说明就 +47。抬 `CONTINUE_CAP` 是可以的，但换来的是**续写每一轮都在为一个它永远用不到的参数付费**：4000 字符的单行不是小说正文的形状。

小数游标零成本，而且还多两个好处：一处改动同时修好四个读工具，不拆 `pageLines` 自己注释里那条「这是**唯一**一份分页实现，预算、首行溢出规则、trailer 措辞都不许在工具之间分叉」；协议本身也不需要模型理解，它只需要抄回工具给它的字面量。

代价是坐标看起来怪，且模型可能把 `57.0001` 抄成 `57`——那是白费一轮，不是数据损坏，而且纠正提示当场就在。落地前用 `scripts/prompt-ab.ts` 在本地 12B 上验一遍；真验不过就退回加参数 + 抬棘轮。

### D6 弃案：负数或纯字符偏移的游标

`start_line=-124501` 当全文字符偏移也能编码，还是整数、没有浮点问题。弃掉是因为**行号从坐标里消失了**——那是 `search_text` 的 `L34`、`rewrite_lines` 的 `start_line` 和这一侧唯一共用的语汇；而且掉一个负号静默地就是「第 1 行」，和掉一个小数点一样错，但数字本身连个提示都不剩。

### D7 片 5 先量后改

`search_text` 背后已经有节流进度条，一次运行也只调一两次；分页读的浪费是真的但可能远小于模型本身的耗时。没有数字就动 Rust 侧，等于用一条最难测的改动去赌一个没量过的瓶颈。

## 10. 分期与顺序

| 片 | 内容 | 依赖 |
|---|---|---|
| A | `read_file` 的 `.html` 目录 + 指路（§4） | — |
| B | `inspect_html` 发现带行区间（§5） | — |
| C | 超长单行可续读 + `search_text` 的行内坐标（§6） | — |
| D | 地标索引 + 截断坐标修正（§7） | A（分派点）、C（坐标口径） |
| E | 测量（§8） | — |

A 与 B 互不依赖，可并行。每片一个 PR，合完停下来等作者实机验；PR body 写明合并顺序。**四片都不动 schema**，所以 `agentToolBudget.test.ts` 与 `contextForecast.test.ts` 全程应当纹丝不动——它们红了就说明有东西漏进 description 了。

## 11. 验证

`pnpm test` + `pnpm tsc --noEmit`。重点文件：`agentReadTools.test.ts`、`htmlSlides.test.ts`、`pptxInspect.test.ts`、`documentTools.test.ts`、`lineEcho.test.ts`、`agentToolBudget.test.ts`、`contextForecast.test.ts`。

端到端（作者侧，真机）：项目里放一份多 `section` 的 `.html`、一份长落地页、一份单行压缩过的 `.html`——

- 「把第三页的标题改成 X」是否**一次**读就定位到；
- 「把「三个季度」那一节重写」是否直接给出行区间；
- 「读完这个单行文件」是否走得到末尾；
- `inspect_html` 的发现行是否带行区间、能否直接 `rewrite_lines` 过去。
