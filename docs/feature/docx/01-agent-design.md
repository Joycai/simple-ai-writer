# Agent 产出 .docx（Beta）——设计方案

> 状态：`shipped`（一期 + 二期，PR #325）。整条链闭合：作者建/改/读格式 → 模型在
> briefing 里看得见清单 → `export_docx` 出稿 → 审批卡逐项核对 → 回读断言钉住产出。
> **三期仍未做**：页眉页脚与页码、多级自动编号、预设进应用配置备份。可行性与实测在 [00-feasibility.md](00-feasibility.md)，UI 任务书在 [02-ui-brief.md](02-ui-brief.md)。
> 目标已从"导出菜单多一个格式"改为**「agent 能产出 docx，并且按照要求的样式 / 格式 / 版式」**。

## 0. 需求与一处读法

原始需求：

- 作为 Beta 功能，设置里开启。
- 开启后 agent 可以产出 docx。
- 可以设置**默认的 docx 格式化信息**；如果用户不特别指定、也没要求参考模仿，就用默认的输出。

最后一句有两种读法。取的是这一种：**格式来源有三级优先级 —— 本次明确指定 > 参考模仿的文件 > 默认预设**。"不特别指定"意味着模型**什么都不用做**（省略参数即可），而不是模型要去猜一套格式出来。§4 的 `resolveFormat` 就是这条读法的实现，它是纯函数、永远有结果。

## 1. 四条不变量

### I1 模型只写 markdown，格式由确定性代码上

模型产出的是 `.md` —— 这个 app 的原生文档格式，它每天都在写的东西。**转换不经过模型**：`lib/docx` 是一条 markdown-it token → `DocBlock[]` → docx 对象 → 字节的确定性流水线。

同 `pptx-plan.md` D11/D12，但这里更强：pptx 那边模型至少还要写 HTML 来表达版面，docx 这边**模型完全不表达版面** —— 版面全部来自 `DocFormat`。

推论，也是必须守住的：**排版指令永远不许散进正文**。没有"在这里插入分页符"的魔法注释、没有 HTML 内联样式、没有"请把这段设成三号仿宋"的行内标记。要么它是 markdown 的结构（标题就是 `#`），要么它是 `DocFormat` 的字段。中间地带一旦开口，格式就再也不可校对了。

### I2 格式是引用，不是参数

模型手里只有**一个格式 id** 和**一句人类可读的摘要**。完整的 `DocFormat`（三十来个字段）永远不进工具 schema，也永远不由模型逐字段写出来。三条理由，按严重性排：

1. **模型逐字段写格式必然偶尔写错**，而且错得体面 —— "三号"写成 `sizePt: 3`，产出打开来是一片蚂蚁。格式错一个字段整份文件就废了，这是不该交给概率的地方。
2. **工具 schema 的 token 从 ceiling 里扣**（`docs/feature/agent/agent-tool-context.md`，`agentToolBudget.test.ts` 有棘轮）。一个完整排版模型进 schema 是几百 token 的**固定头部**，每一轮都付。
3. **作者校对一个预设，比校对一次性的三十个字段现实得多。** 上一轮定下的"校对规格表而不是校对产出"（00-feasibility §7.3）只有在格式是**具名的、可复用的东西**时才成立。

唯一的松口是 `overrides`，收窄到**五个最常被点名的字段**（§3.2）。

### I3 格式来源三级，纯函数解析

```
本次明确指定（overrides） > 参考模仿的文件（read_doc_format 得到的 id） > 默认预设
```

`resolveFormat()` 是纯函数，可单测，**永远有结果** —— 默认预设兜底，所以"用户不特别指定"这条不需要模型做任何事。

### I4 Beta 关 = 工具缺席，不是拒绝

照 `routing.ts` 对 `export_pptx` 的做法：关掉时把工具**从 toolset 里滤掉**，而不是留一个永远答"作者没开这个功能"的工具。理由 `pptx/flag.ts` 的注释里已经写过 —— 一个能看见但总是失败的工具，读起来是助手坏了，不是功能关着。

同一开关还决定：briefing 里有没有格式清单、设置里有没有「排版格式」那一项。

## 2. 数据流

```
作者：「把这份周报导成 Word，照甲方那份模板的格式」
   │
   ├─（可选，"参考模仿"时才走）
   │   模型 → read_doc_format("模板.docx")
   │        ← 「A4 · 版心 37/35/28/26mm · 正文 仿宋_GB2312 三号 ·
   │           固定值 28 磅 · 首行缩进 2 字符 · 标题1 黑体二号居中」
   │           format_id = "imitated:模板.docx#a1b2"
   │
   └── 模型 → export_docx(source_path="周报.md", format_id="imitated:…")
                │
                ▼  审批卡（DocxProposal）
           ┌──────────────────────────────────────────┐
           │ 周报.md → 周报.docx                      │
           │ 格式来源：照 模板.docx 模仿               │
           │ 仿宋_GB2312 三号(16磅) · 固定值 28 磅     │
           │ 首行缩进 2 字符 · A4 37/35/28/26mm       │
           │                        [拒绝]  [批准]     │
           └──────────────────────────────────────────┘
                │ 批准
                ▼
        applyProposal → lib/docx
        markdown-it tokens → DocBlock[] → docx 对象 → 字节 → 写盘
                │
                ▼
        回报模型：写了 N 段 / 哪些降级了（公式退回原文…）
```

**模型在这条链上只做两件事：选一个源文件，指认一个格式。** 它不碰排版。

### 2.1 为什么是两张卡（先 .md 再 .docx），不是一张

从零写一份 Word 文稿要走两次审批：`create_file` 写 `.md`（现有卡），`export_docx` 转换（新卡）。看起来啰嗦，是故意的：

- 作者审**内容**的时候看的是 markdown —— 可读、可 diff、可继续改。审一份 .docx 的内容等于审一个二进制。
- 作者审**格式**的时候看的是一张规格摘要，和内容分开。两件事混进一张卡，结果是两件都没看。
- `.md` 留在项目里是资产：改完再导一次就是了，不用重新生成全文。

同 `export_pptx` 的形状（先 `create_file` 写 .html，再导出）。

## 3. 工具集

三个工具，两个上来就有，一个二期。

| 工具 | access | 期 |
|---|---|---|
| `export_docx` | `write-approval`（L2） | 一期 |
| `read_doc_format` | `read`（L0） | 二期 |
| ~~`save_doc_format`~~ | — | **不做**，见 §10 |

### 3.1 `export_docx`

```jsonc
{
  "name": "export_docx",
  "description":
    "Turn a project markdown document into a Word file (.docx) beside it. NOTHING is written until the author approves the card. Write the document as markdown first with create_file, then call this — the conversion is deterministic code, not a model: every heading, paragraph, list, table and picture is laid out by Word itself from a named format preset, so the text stays real editable text and the format stays exactly what the preset says. NEVER put formatting instructions in the markdown itself (no inline HTML, no '请设成三号仿宋' notes, no manual page breaks) — structure comes from markdown, appearance comes from the preset. Omit `format_id` to use the author's default preset; that is the right choice unless they named a format or asked you to copy one. What degrades: math falls back to its source text, mermaid to a code block, lore citations to plain words. The result reports what degraded — pass it on to the author.",
  "parameters": {
    "source_path": "string   — Full path of the .md document to convert",
    "out_path":    "string?  — Full path for the .docx. Omit to write it beside the document under the same name.",
    "format_id":   "string?  — A format preset id from the roster in your briefing, or one returned by read_doc_format. Omit for the author's default.",
    "overrides":   "object?  — Only when the author named a specific change this time. See below.",
    "reason":      "string?  — One-line justification shown on the review card"
  },
  "required": ["source_path"]
}
```

实现照 `pptxTools.ts` 抄形状：查路径（`resolveWorkspacePath` 容器约束）、查扩展名、查文件在不在、组一个 proposal、`ctx.requestApproval`、把结果从 `decision.backupPath` 带回。**真正的转换在 `applyProposal` 里做**（同 pptx —— 那边是因为要 DOM，这边是因为要懒加载 1MB 的库并写二进制，都不该在工具循环里）。

### 3.2 `overrides` 只收五个字段

```ts
interface DocFormatOverrides {
  bodyFontEastAsia?: string;   // "仿宋_GB2312"
  bodySize?: string;           // 中文号数或磅："三号" | "12pt"
  lineSpacing?: string;        // "固定值28磅" | "1.5倍" | "最小值20磅"
  firstLineChars?: number;     // 0 | 2
  marginsMm?: [number, number, number, number];  // 上 右 下 左
}
```

为什么收窄：作者在对话里临时点名的，九成是这五个（"用仿宋"、"三号"、"行距 1.5 倍"、"不要首行缩进"、"页边距窄一点"）。再多就该建一个预设 —— 一次性的三十字段格式没有人能校对，也没法复用。**这条收窄要写进 description**，否则模型会试着传别的字段，然后静默丢失。

`bodySize` / `lineSpacing` 收字符串而不是数字，是因为作者说的是"三号"和"固定值28磅"；解析在 `format.ts` 里做（纯函数，可单测），**解析失败就整个调用报错，不静默取默认** —— 静默取默认正是"看起来对、其实不合规"的来源。

### 3.3 `read_doc_format`（二期）

```jsonc
{
  "name": "read_doc_format",
  "parameters": { "target": "string — a .docx/.dotx path in the project, or a preset id from your briefing" },
}
```

返回**人类可读的摘要**（不是 JSON 全量）+ 一个 `format_id`。读文件时在 Rust 侧解 zip、`quick-xml` 读 `pPr`/`rPr`/`sectPr`（`src-tauri/src/docx.rs`，与 `pptx.rs` 同一套依赖，00-feasibility §7.4 有 50 行原型的产出样例）。

读到的格式落成一个**会话内的临时预设**（`imitated:<文件名>#<hash>`），只在本次会话有效。要留下来，作者在卡片上点「存为预设」—— 那是 UI 动作，不是工具（§10）。

## 4. 格式解析

```ts
// lib/docx/resolve.ts —— 纯函数，永远有结果
export function resolveFormat(
  presets: DocFormatPreset[],   // 内置 + 作者建的 + 本会话模仿来的
  defaultId: string,
  args: { formatId?: string; overrides?: DocFormatOverrides },
): { format: DocFormat; origin: FormatOrigin; warnings: string[] }

export type FormatOrigin =
  | { kind: "default"; presetName: string }
  | { kind: "preset"; presetName: string }
  | { kind: "imitated"; sourceFile: string }
  | { kind: "overridden"; base: FormatOrigin; changed: string[] };  // 卡上要能说"在 X 的基础上改了 Y"
```

`formatId` 指了一个不存在的预设 → **报错，不回落默认**。回落是这里最坏的行为：作者说"照甲方模板"，模型拼错了 id，然后静默地用默认格式导出一份合规性为零的文件，没有任何地方会亮红。

## 5. 审批卡（`DocxProposal`）

```ts
export interface DocxProposal extends ProposalBase {
  kind: "docx";
  sourcePath: string;              // 源 .md（path 是目标 .docx）
  formatSummary: string[];         // 人类可读的最终值，一行一条
  origin: FormatOrigin;
}
```

和 pptx 卡的关键差别：**pptx 卡的 `headerMeta` 是空的**（"没什么可预先权衡的，页数要渲染完才知道"）。docx 卡**恰恰相反 —— 可权衡的东西就是格式**，而且它在批准前**完全已知**。所以：

- header 显示 `origin`：「默认格式」/「预设：公文」/「照 模板.docx 模仿」/「预设：公文（改了 2 项）」
- body 是一张**规格表**，写最终值而不是原始值：`仿宋_GB2312 三号（16 磅）`、`行距 固定值 28 磅`、`首行缩进 2 字符`、`A4 · 上37 下35 左28 右26 mm`
- `overridden` 时，被改动的行要标出来 —— 作者要看见"这次和平常不一样的是哪两条"

一条 UI 纪律：**号数和磅一起写**。只写"三号"作者核不了甲方给的"16磅"，只写"16磅"作者核不了甲方给的"三号"。

## 6. Beta 开关与工具预算

`src/lib/docx/flag.ts`，逐字照 `pptx/flag.ts`：

```ts
const KEY = "app:docxExportBeta";
export function isDocxExportEnabled(): boolean;
export function setDocxExportEnabled(enabled: boolean): void;
```

三处消费：

1. `routing.ts` —— 关掉时 `tools = tools.filter(t => t !== "export_docx" && t !== "read_doc_format")`。加进 `routing.test.ts` 现有的"开关关着就整个withhold"那组断言。
2. `briefing` —— 开着且预设不止一个时，往 briefing 挂一段**格式清单**（一行一个：id · 名字 · 一句摘要），照 `lib/workflow/briefing.ts` 的两级渐进披露：清单恒挂，详情靠 `read_doc_format` 取。关掉返回空串，整段省掉。
3. 设置页 —— 「排版格式」这一项在 nav 里**不出现**。

**工具预算**：两个工具进 `AGENT_ASSIST_PRESET` 会撞 `agentToolBudget.test.ts` 的棘轮（`agent-tool-context.md` 明说了"那不是测试坏了"）。棘轮要抬，抬多少要在 PR 里说明；`toolCost.ts` 里那个"Beta 关时扣掉 export_pptx"的计算要同样处理 docx 的两个。

## 7. 预设存哪里

| 东西 | 位置 | 理由 |
|---|---|---|
| 内置预设（手稿 / 素雅 / 公文 / 论文 / 投标…） | `lib/docx/format.ts`，代码里 | 和 markdown 主题同一处理，随版本走 |
| 作者建的预设 | `config.db` 新表 `doc_format` | **装机级不是项目级** —— 一套公文格式要跨所有项目复用；和供应商 / 模型 / Prompt 同级 |
| 默认预设的选择 | `lib/prefs` 的 `app:docxDefaultFormat` | 一个 id，偏好本来就该装机级。**绝不加 localStorage** |
| 本会话模仿来的临时预设 | 内存（store） | 不落盘；作者点「存为预设」才进上面那张表 |

放 `config.db` 的连带好处：**自动落进「应用配置备份」的范围**（`lib/configsync`）—— 排版预设正是典型的"换台机器要带走"的东西。真接进去要给 bundle 加一类，列在三期。

## 8. 文件落点

```
src/lib/docx/
  flag.ts       # Beta 开关（照 pptx/flag.ts）
  format.ts     # DocFormat 模型 + 内置预设 + 号数/单位解析 —— 纯，测试在这里
  resolve.ts    # 三级来源合并 + FormatOrigin —— 纯，测试在这里
  blocks.ts     # markdown-it token 流 → DocBlock[] —— 纯，测试在这里
  write.ts      # DocBlock[] + DocFormat → docx 对象 → 字节。**唯一**知道 `docx` 库存在的文件
  presets.ts    # config.db 的 doc_format 表读写
  index.ts      # exportMarkdownToDocx() 编排 + 降级报告
  __tests__/    # 含「回读断言」：生成 → 解包 → 断言 XML 值 == 声明值（00-feasibility §7.3）

src/lib/agent/docxTools.ts        # export_docx / read_doc_format 的工具处理器（照 pptxTools.ts）
src/components/settings/panes/DocFormatPane.tsx + DocFormatDrawer.tsx
src/components/ai/ApprovalCard.tsx  # 新增 "docx" 分支
src-tauri/src/docx.rs             # 二期：读一份 .docx 的排版参数
```

## 9. 分期

| 期 | 内容 |
|---|---|
| **一期 · 已实施** | `flag.ts` · `format.ts` · `blocks.ts` · `write.ts` · `resolve.ts` · `fontCheck.ts` · `index.ts` · `export_docx`（L2）+ 路由门 + 预算棘轮 · `DocxProposal` 卡 · 设置「排版格式」pane（预设列表 + 纸样示意图 + 选默认）· 通用页的 Beta 开关 |
| **二期 · 已实施** | `briefing.ts` 格式清单 · `presets.ts` 自建预设落 `config.db` · `DocFormatDrawer`（1f/1g）· `src-tauri/src/docx.rs` + `read.ts`（参考模仿）· `read_doc_format` 工具 · `DocxImportModal`（1h/1i） |
| **三期** | 预设进应用配置备份；目录 / 页眉页脚 / 一级标题分页；多级自动编号 |

## 10. 明确不做

- **`save_doc_format` 工具。** 模型不建预设。预设是作者的资产，由作者在 UI 里确认后落盘 —— 让模型写一个会长期生效的格式，是把 I2 那三条理由全部推翻。
- **模型直接产出 OOXML 或 docx 对象树。** 见 I1。
- **正文里的排版魔法注释。** 见 I1 的推论。
- **让模型看完整的 `DocFormat` JSON。** 它看摘要。看得见全量就会想改全量。
- **从 PDF / 截图"模仿格式"。** 二期的模仿只读 .docx/.dotx —— 那里面有确切数值；从一张图里推断磅值是猜。
- **保证 Word 的渲染。** 我们保证文件里写的是什么（00-feasibility §7.5）。


## 11. 实现与设计稿的出入（TURN 1）

设计稿：`11 Word 排版格式 Word Format.dc.html`（1a–1n）。照着做了 1a/1b/1c/1d/1e 的
呈现部分、1j 的四种格式来源、1n 的开关行。三处有意的出入：

1. **内置预设的数值取了设计稿的，不是我自己那版。** 手稿改成思源宋体 1.75 倍、素雅
   改成无缩进小四、投标改成四号固定值 24 磅。设计稿里那几行摘要是作者真正会读到的
   东西，让代码去将就它比反过来省事，也更不容易出「文档写一套、界面显示另一套」。
2. **「+ 新建预设」和「从 Word 文件读取格式」两个按钮没有摆上去。** 它们要的编辑抽屉
   （1f）和读取模态（1h/1i）在二期——一个点了没反应的按钮比没有更糟。自建那一组用一句
   说明占位，讲清楚它们会来。
3. **字体是否安装用量宽度，不用 `document.fonts.check`。** 后者看起来正是干这个的，
   实际上家族缺失时浏览器用后备字体照样能排，于是它对一个根本没装的字体也回答 true。
   改成「候选 + 后备」和「后备」各排一次比宽度，三个后备都判一样宽才认定没装；探测不
   了（node、老 webview）一律回答「装了」——宁可不提示，也不要在一台其实装了字体的机器
   上到处挂警告。

一处设计稿逼出来的模型改动：审批卡④要求把「固定值 28 磅 → 1.5 倍」原样摆出来，所以
`FormatOrigin.overridden.changed` 从 `string[]` 改成了带 `from`/`to` 的结构体
（`FormatChange`）。只说「改了行距」等于什么都没说。

工具预算：`export_docx` 的 schema 是 296 token，常驻（关掉 Beta 时由 `routing.ts` 摘掉，
和 `export_pptx` 同一条路），`agentToolBudget.test.ts` 的棘轮相应从 8,600 抬到 8,950。
省下来的 138 token 来自把 `overrides` 六个属性各自的描述合并成一句——完整的 `DocFormat`
从头到尾没有进过任何 schema（I2）。


## 12. 二期实现记（TURN 1 设计稿 1f–1i）

### 12.1 读格式的分工：Rust 只报，TS 才判

`docx.rs` 报的是「XML 里写着什么」，单位一律原样（twip、半磅、百分之一字符）；
换算和「缺了就继承」的判断全在 `read.ts`。理由和 pptx 那条链同构（`harvester.js`
只量、`deck.ts` 才判断）：单位表只有一份，在 Rust 里再写一份必然漂。

样式继承只解一层——读到的是每个样式**自己**声明的属性，`w:basedOn` 链不追。追下去
要实现 Word 的整套样式解析，而这个功能要回答的问题是「这份文件把什么写死了」，没写死
的本来就该落回默认。

### 12.2 来源那一列才是这张表的重点

`layoutToFormat` 返回的不是一套格式，而是**逐项的 `{ 值, 来源 }`**：`declared`（这份
文件自己写死的）/ `default`（Word 出厂值补的）/ `absent`（文件里根本没出现，比如没用过
的标题级别）。

因为一份 .docx **总能**读出一整套完整规格——问题从来不是「读没读到」，而是「读到的
是不是它的要求」。全是 `default` 的文件读取并没有失败，它只是不能当格式要求用，而这
句话必须在作者点「存为预设」之前说出来（设计稿 1i）。同一个信号也回给模型：
`read_doc_format` 在这种情况下回的是一句 NOTE，而不是一份看起来很像要求的规格。

### 12.3 两个入口读同一份文件，因为授权来源不同

- `docx_read_layout(path)` —— agent 工具走这条，路径过 `FsScope`。
- `docx_layout_from_bytes(data)` —— 作者从系统对话框挑的模板走这条。那个文件**在
  工作区外面**，`FsScope` 不会也不该为它背书：授权来自那个原生对话框本身。

和 `pptx_to_markdown`（字节）/ `pptx_read_slides`（路径）完全同一条分工，不是特例。

### 12.4 生成端和读取端互为逆运算，并且有测试钉住

网格换算在两侧各写了一遍（`gridToDocx` 写出去，`layoutToFormat` 读回来）。
`read.test.ts` 里有一条断言把它们钉成一对：公文预设 → `gridToDocx` → 喂回
`layoutToFormat` → 必须还原成 `22 × 28`。任何一边改了换算，那条就红。

顺带钉住的一件事：公文那套里「每页 22 行」和「行距固定值 28 磅」**本来就不相等**
（28 磅 = 560 twip，而 225mm 版心 ÷ 22 行 = 580）。写出去时网格赢。第一版测试拿
560 当输入，读回来得到 23 行——不是 bug，是夹具自己不自洽，注释里记下了。

### 12.5 工具预算

`read_doc_format` 是 182 token，棘轮 8,950 → 9,150。这是 I2 那笔交易的另一半：
一个 string 参数同时买下「告诉我这套预设的页边距」和「照这份 .docx 来」，两者都以
散文作答——完整的 `DocFormat` 因此从头到尾没有进过任何 schema，模型也就不会被引诱
去写一份回来。
