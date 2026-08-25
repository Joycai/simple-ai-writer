# Agent 产出 .docx（Beta）——设计方案

> 状态：`proposal`（未决定，未实施）。可行性与实测在 [00-feasibility.md](00-feasibility.md)，UI 任务书在 [02-ui-brief.md](02-ui-brief.md)。
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
| **一期** | `flag.ts` + `format.ts`/`blocks.ts`/`write.ts`/`resolve.ts` + `export_docx`（L2）+ `DocxProposal` 卡 + briefing 清单 + 设置「排版格式」pane（内置预设 + 选默认，只读不可编辑）+ 回读断言测试 |
| **二期** | `read_doc_format` + `src-tauri/src/docx.rs`（参考模仿）+ 预设编辑器（完整表单 + 纸样预览）+ 「存为预设」+ `overrides` |
| **三期** | 预设进应用配置备份；目录 / 页眉页脚 / 一级标题分页；多级自动编号 |

## 10. 明确不做

- **`save_doc_format` 工具。** 模型不建预设。预设是作者的资产，由作者在 UI 里确认后落盘 —— 让模型写一个会长期生效的格式，是把 I2 那三条理由全部推翻。
- **模型直接产出 OOXML 或 docx 对象树。** 见 I1。
- **正文里的排版魔法注释。** 见 I1 的推论。
- **让模型看完整的 `DocFormat` JSON。** 它看摘要。看得见全量就会想改全量。
- **从 PDF / 截图"模仿格式"。** 二期的模仿只读 .docx/.dotx —— 那里面有确切数值；从一张图里推断磅值是猜。
- **保证 Word 的渲染。** 我们保证文件里写的是什么（00-feasibility §7.5）。
