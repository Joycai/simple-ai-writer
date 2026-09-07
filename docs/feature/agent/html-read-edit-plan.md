# agent 侧 HTML 读写：入口、坐标与超长行

> 状态：`planned`（五片都未实施；片 5 只交测量，不改生产代码）
> 起因：2026-09-07 以「改某一部分时会不会退化成 read-all」为尺子，审阅了 app 对 `.html` 的读写支持。写的一侧是对的，读的一侧在**幻灯片形状**的页面上也已经不 read-all（[`pptx-plan.md`](../pptx-plan.md) 那半 + `read_slides` 吃 `.html`）。断的地方在四处：模型走 `read_file` 进来时**没人把它引到那份目录上**、`inspect_html` 的发现没有坐标、超长单行读不全、非幻灯片页面没有结构坐标。第五处是 IPC 量级，先量后改。
> 相关：[`edit-loop-plan.md`](edit-loop-plan.md)（行号契约与 `inspect_html` 的由来，§5.1 就是本文片 1 补的那句话）、[`large-doc-formatting-plan.md`](large-doc-formatting-plan.md)（段落地图，与本文的地标索引同构）、[`../html-artifact-plan.md`](../html-artifact-plan.md)（HTML 交付物的由来）、[`agent-tool-context-lld.md`](agent-tool-context-lld.md)（schema 成本账）、[`../../reference/tool-presence.md`](../../reference/tool-presence.md)（指路只能指向这次运行真有的工具）

## 1. 量纲：这一轮的余量是 131 / 82 token

工具 schema 每一轮原样重发（[runtime.ts](../../../src/lib/agent/runtime.ts) `getToolDefinitions`，最多 40 轮），`agentToolBudget.test.ts` 的棘轮量的就是它：

| preset | 上限 | 实测 | 余量 |
|---|---|---|---|
| `AGENT_ASSIST_CAP` | 16,800 | 16,669 | **131 token** |
| `WRITE_CAP` | 4,800 | 4,718 | **82 token** |

`read_file`(97 tok) / `read_slides`(211) / `inspect_html`(147) / `read_document`(130) **四个都常驻在这两个 preset 里**，往任何一个的 description 加一句话要在两边各付一次。`contextForecast.test.ts` 另外钉着 32k 模型上 `agent` 档知识库仍分得到 >2000 字符、`write` 档 `free > 0`。

> **所以本文的第一条设计原则：一切「指路」走工具的 RESULT 文本，不走 description。**

结果文本只在它适用的那一轮付一次费，而且到达的时机更好——模型读到 trailer 的时候，写在几千 token 之前的那条规则早就滚出注意力了。这不是新发明：[`edit-loop-plan.md`](edit-loop-plan.md) §D2 论证过「目录搭分页的便车，不做参数」，`lineEcho` 那一套整个是运行时输出而不是 schema。**片 1 / 2 / 4 的 schema 成本因此是 0。**

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
- **I5 一个不从列 1 开始的片段不许挂行号。** 挂了模型会把它当整行抄进 `find`。
- **I6 标错行比不标行糟。** 两份 slide 清单（运行时 `querySelectorAll` 与文本切分）对不上时，整体丢掉行区间，不猜。

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

**`pageLines` 的新形状**

```ts
export function pageLines(raw: string, from: number, fromChar = 1): { … } | { error: string }
```

- `fromChar <= 1` — **整行模式**，与今天逐字节一致（`body` 仍过 `numberLines`）。
- `fromChar > 1` — **行内续读模式**：取 `lines[from-1].slice(fromChar-1, fromChar-1+READ_MAX_CHARS)`，**不加 gutter**（I5），坐标改由 notes 承载。
- 返回对象新增 `nextChar: number | null`。加字段是安全的：四个调用方都不做穷尽解构，也没人读 `from`/`to`/`total`。

**notes 的措辞**（`notes[0]` 的位置不动，I3；`cut mid-line` 保住，I4）

- 整行模式命中 `cutMidLine`：`line 3247 is longer than the 4000-character limit and was cut mid-line — pass start_line=3247 with start_char=4001 to read the rest of it`
- 行内模式 `notes[0]`：`line 3247, characters 4001-8000 of 51203 — this fragment does not start at the beginning of the line, and carries no line-number gutter`
- 后续：还有剩余 → `pass start_line=3247 with start_char=8001 to continue this line`；这一行读完而文件还有下文 → `line 3247 ends here; pass start_line=3248 to continue the file`

单行文件因此有了出路：续读坐标由字符游标给出，不再受 `to < lines.length` 那道门挡着。`whole` 的算法不变，行内模式下恒为 `false`。

**只有 `read_file` 拿这个参数。** `read_document` 走同一个 `pageLines`，但转换出来的 markdown 极少有 4000 字符的行，而它的 schema 也在两个 preset 里——两个都加会把 `write` 档顶到 4,818 > 4,800。`pageLines` 的新形参可选、默认 1，另外三个调用方一字不改。

**schema 账**：`start_char` 的 JSON 按 `estimateToolsTokens` 的口径（`JSON.stringify` 后 4 字符/token）实测 38–69 token → assist 16,707~16,738 / 16,800，write 4,756~4,787 / 4,800。**两个棘轮都不用抬**，但余量只剩几十 token，PR 里要重新量一次并把数字写回 `agentToolBudget.test.ts` 的注释。命名合规：`agentToolConventions.test.ts` 要求分页游标叫 `start_*`。

**写工具不需要改**：模型现在能把超长行读全，`rewrite_lines` 重写它、`propose_edit` 在它内部定位都成立。修复留在读的一侧。

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

**顺带修一个真 bug**：`readHtmlSlideRange` 里超大单页的那句 `read the rest with read_file (start_line=${slide.startLine})` 给的是这张 slide 的**起始**行，模型照做会从头重读。改成截断点之后的坐标，与片 3 的 `start_char` 口径一致——**因此片 4 排在片 3 之后**。

## 8. 片 5：先只做测量

**要量的两件事**：`search_text` 在真实规模项目上的墙钟与过 IPC 的字节数；一份 150–200KB 的 `.html` 用 `read_file` 分页读完的总时间与总字节数。

**怎么量**：fixture 生成脚本不进仓（约 300 份 4KB `.md` + 3 份 60/120/200KB `.html`）。纯 JS 那一半（`scanText` 的扫描成本）用一个 vitest 用例量，可进 CI；IPC 那一半 vitest 量不到（`fs/fileio` 被 mock 掉），用**临时的、不提交的** instrumentation 在 dev app 里跑一次，把数字记进本节。

**判据**：~300 文件上 `search_text` < 1.5s → 不动它（一次运行只调一两次，背后已有节流进度条）；> 3s，或分页读明显占住一次长运行的墙钟 → 进 Stage B。

**Stage B 的形状（量完再决定做不做）**

- Rust 侧 `fs_grep`：字面量、大小写不敏感、过 `State<'_, FsScope>`、沿用今天 JS 侧的四个上限（`SEARCH_MAX_HITS=40` / `SEARCH_MAX_PER_FILE=8` / `LORE_MAX_HITS=12` / `LORE_MAX_PER_FILE=4`）返回带行号的命中。知识库那一半走 `readEntityFile` 而不是裸路径，**留在 JS**。
- 分页读换部分读没那么简单：`pageLines` 要**全文总行数**才能写 "of N lines"，三个索引函数要**全文**才能建地图，所以直接换 `fs_read_head` 会同时打破两处。要么设计一个专门形状的 Rust 命令（行区间 + 总行数 + 地图），要么论证不动它。
- `agentReadTools.test.ts` 用 in-memory Map mock 了 `../fs/fileio`——换 IPC 命令要同步改 mock。
- 这台 Windows 机器上 `cargo test` 跑不起来，Rust 侧只能靠 `fmt` / `clippy` / `build` 加 JS 侧对拍，正确性靠实机验。

## 9. 决策与弃案

### D1 指路走结果文本，不走 description

余量 131 / 82 token，而一句像样的英文指引就是 50 token 起，四个相关工具都常驻在两个 preset 里。结果文本免费，而且到达时机更好。同 [`edit-loop-plan.md`](edit-loop-plan.md) §D2。

### D2 `htmlIndex` 不做参数

理由与标题索引、段落地图、`read_slides` 的整册目录**严格同构**：只在响应装不下整份文件时出现。切分本来就是纯本地计算，一个要先问一次的地图会花掉它省下的那一轮。

### D3 目录/地标不按扩展名分派进 `headingIndex`

`headingIndex` 匹配 ATX 标题，是 markdown 的事；HTML 的结构是标签。两件事共用一个函数只会让两边都长出 `if`。分派放在 `readWritingFile` 里一处，`isHtmlPath` 已经在那儿了。

### D4 `landmarkIndex` 放 `htmlSlides.ts`，不新开模块

扫描器（`scanTags`）、元素闭合（`elementEnd`）、行号映射（`lineMapFor`）、短标签（`slideTitle`）四个都要复用。新开模块就得把它们导出，等于把一个私有扫描器变成公共 API，还多一条 import 边；而 `htmlSlides.ts` 的职责本来就是「按结构读一份 `.html`」，按页只是其中一种结构。

### D5 只有 `read_file` 拿 `start_char`

`read_document` 也走 `pageLines`，但它的输入是转换出来的 markdown——4000 字符的单行不是它的形状。两个都加会把 `write` 档顶破棘轮，而破棘轮换来的是一条几乎走不到的岔路。

### D6 行内片段不挂行号

挂了就是骗人：模型会把一个从第 4001 字符开始的片段当整行抄进 `find`，而那个 `find` 永远匹配不上。宁可让它看起来不一样，并在 notes 里说清楚（I5）。

### D7 片 5 先量后改

`search_text` 背后已经有节流进度条，一次运行也只调一两次；分页读的浪费是真的但可能远小于模型本身的耗时。没有数字就动 Rust 侧，等于用一条最难测的改动去赌一个没量过的瓶颈。

## 10. 分期与顺序

| 片 | 内容 | 依赖 |
|---|---|---|
| A | `read_file` 的 `.html` 目录 + 指路（§4） | — |
| B | `inspect_html` 发现带行区间（§5） | — |
| C | 超长单行可续读（§6） | — |
| D | 地标索引 + 截断坐标修正（§7） | A（分派点）、C（坐标口径） |
| E | 测量（§8） | — |

A 与 B 互不依赖，可并行。每片一个 PR，合完停下来等作者实机验；PR body 写明合并顺序。

## 11. 验证

`pnpm test` + `pnpm tsc --noEmit`。重点文件：`agentReadTools.test.ts`、`htmlSlides.test.ts`、`pptxInspect.test.ts`、`documentTools.test.ts`、`lineEcho.test.ts`、`agentToolBudget.test.ts`、`contextForecast.test.ts`。

端到端（作者侧，真机）：项目里放一份多 `section` 的 `.html`、一份长落地页、一份单行压缩过的 `.html`——

- 「把第三页的标题改成 X」是否**一次**读就定位到；
- 「把「三个季度」那一节重写」是否直接给出行区间；
- 「读完这个单行文件」是否走得到末尾；
- `inspect_html` 的发现行是否带行区间、能否直接 `rewrite_lines` 过去。
