# 用 LaTeX 排版导出 PDF

> 状态：`proposal`（未决定，未实施）。
> 背景：作者的想法是「md 作源 → 复制一份 → 让处理 LaTeX 的 subagent 改标记 → 本机编译器出 PDF」，目标有两条：**排版和插图不走形**，以及**正文不重新过模型**（token 太贵）。
> 本文接受这两个目标，但对中间那一步给出不同的实现，理由见 §2。

---

## 1. 现状：为什么现有的 PDF 出口不够

| 环节 | 现状 | 位置 |
|---|---|---|
| PDF 出口 | 系统打印。macOS 走 `NSPrintOperation`，其余平台走隐藏 iframe 的 `window.print()` | `lib/fs/export.ts` → `exportPdf`、`src-tauri/src/print.rs` |
| 排版来源 | 五套 markdown 主题的 `--md-*` CSS，和预览窗看到的同一份 | `lib/theme/markdownThemes.ts` |
| 插图 | 导出前内联成 data URL（打印的 iframe 没有 base URL，相对路径解析不到） | `export.ts` → `inlineImages` |
| markdown 方言 | **全树只有一份**：`lib/fs/markdown` 的 `md` 实例，已挂 KaTeX 与 `[[lore:…]]` 自定义 token | `lib/fs/markdown.ts` |
| 中性块流 | `markdownToBlocks()` → `DocBlock[]`，docx 和 xlsx 都从这里取 | `lib/docx/blocks.ts` |
| 二进制写盘 | `writeBinaryFile` 走 base64 over IPC，已在用 | `lib/fs/fileio.ts` |
| 起外部进程的先例 | `std::process::Command` 起兄弟实例；**没有** `tauri-plugin-shell` | `src-tauri/src/instance.rs` |

webview 打印这条路能出 PDF，但它**做不到的事是固定的**，不是调 CSS 能补的：

- 没有目录、没有交叉引用、没有页码引用（「见第 12 页」）；
- 浮动体不存在——图只能待在它在正文里的那一行，长图把整页顶掉也没办法；
- 断行与孤行寡行控制交给 webview，中文两端对齐的字距是浏览器算的，不是排版引擎算的；
- 页眉页脚、章首页、双面书眉、页边注一律没有；
- 数学公式是 KaTeX 画的 HTML，打印出来是 HTML 的样子。

LaTeX 这条线不是替代那条，是**另一档**：交出去要印的东西走这条，快速看一眼走那条。两条并存，`ExportMenu` 里各占一项。

---

## 2. 关键改动：中间产物是「转录」，不是「复制」

作者的原方案是**逐字复制 md，再让模型把 md 标记改成 LaTeX 标记**。省 token 的动机完全成立，但这个做法本身达不到目的，而且会静默丢内容：

**（a）它比重吐全文更贵，不是更便宜。** 一份三万字的稿子里，`##` 标题几十处、`**粗体**` 上百处、列表项几百处、图片几十处。每一处都是一次 `propose_edit` 的定点编辑：一次工具调用、一轮请求、一次审批。模型省下的是「吐正文」的 output token，付出的是几百轮 round-trip 的 input token（每轮重发全部工具 schema——`agent-tool-context.md` 记着这笔账）。

**（b）真正致命的是转义，而且它是静默的。** LaTeX 有十个字符不能原样出现：`\ { } $ & # ^ _ ~ %`。其中 `%` 是注释符——中文稿里一句「同比增长 50%，全年……」，`%` 之后**这一行剩下的字全部消失**，编译不报错，PDF 少一行字。`_` 和 `^` 在数学模式外报错（响亮），但 `&` 在表格里改变列、`#` 在宏定义里改变参数、`~` 变成不断行空格——全是不响的。模型漏一个不会有人知道，直到印出来。

这条正好踩在这个仓库反复出现的那条判断上：*静默的数据损坏比响亮的失败坏得多*（`lib/xlsx/cells.ts` 判不出类型就留成文本、`lineEcho.ts` 位移从落盘后的文件量出来而不是推算）。

**所以：md → tex 是确定性转录，零模型。** 和 pptx（「转换本身不经过任何模型」）、docx（同一句话）、xlsx 走的是同一条规则。作者的成本目标不是部分达成而是**完全**达成——正文 0 token，一个字都不过模型。

那模型还干什么？见 §4：它只碰**版式**，而版式是一屏纸。

---

## 3. 四条不变量

> 这四条是这个特性的正确性边界。改动这条线之前先读它们。

**I1 · 正文不过模型。** md → tex 的转录是纯函数，零模型。模型不生成正文的任何一个字符，也不需要读它。

**I2 · 正文与版式是两个文件。** `body.tex` 是转录产物，作者每次改 md 都整份重生成；`main.tex` 是前导区（preamble）加一行 `\input{body}`，是模型和作者调版式的地方。因此**重新转录不会丢掉调好的版式**——这是分家的全部理由。

**I3 · 文字流不变式。** 任何落在 `body.tex` 上的编辑，应用前后的「可见文字流」必须逐字节相同（§4.2）。这条把「不走形」从一句期望变成一个纯函数判定：模型可以加环境、改参数、插浮动体，**不能动字**。

**I4 · 编译不经 shell，不允许写外部。** 固定 argv 直传，`-no-shell-escape` + `openin_any=p` / `openout_any=p`。一份 .tex 是图灵完备的程序，而这份 .tex 有一半是模型写的。

---

## 4. 数据流

```
 周报.md
   │
   │  ① 转录（纯函数，0 token）
   │     parseMarkdown → DocBlock[] → 转义 → body.tex
   │     插图复制进 build/ 并改 ASCII 名
   ▼
 .ai-writer/latex/<hash>/
   ├── main.tex     preamble（模板） + \input{body}      ← 模型/作者可写
   ├── body.tex     转录产物，每次导出重生成             ← 只读（I3 之外）
   ├── img-01.png   拷进来的插图，ASCII 名
   └── build/       .aux .log .toc .out  →  main.pdf
   │
   │  ② 调整（可选，模型，只读 preamble + 定点编辑）
   │     read_file(main.tex) → propose_edit → compile_latex → 看诊断 → 再改
   │
   │  ③ 编译（Rust，0 token）
   │     xelatex ×N（或 latexmk）→ 解析 .log → 结构化诊断
   ▼
 周报.pdf   （落在文档旁边，同 docxPathFor 的规矩）
```

**②是可以整段跳过的。** 默认路径是 ①→③ 一键出 PDF，一个 token 都不花。模型那段是给「这份投标书要按甲方模板排」这类活准备的增强，不是必经之路。

### 4.1 为什么工作目录在 `.ai-writer/` 且用哈希名

- `.ai-writer/` 是 app 数据区，模型的 `resolveWorkspacePath` 明确挡在门外——中间产物天然不会被模型乱翻，也不会混进作者的文件树。
- 目录名取 `sha1(文档相对路径)` 前 12 位：**TeX 对非 ASCII 路径的支持历来脆弱**（Windows + MiKTeX 尤其），而作者的文档大概率叫《第三章 夜行.md》。把路径问题从「大概能行」变成「不可能出现」，代价是一个哈希。
- 插图同理：复制进 build 目录、重命名 `img-01.png`。顺带好处是格式判定和降级检查在这一步一次做完（§4.3）。

### 4.2 文字流不变式（I3）怎么算

纯函数 `visibleText(tex: string): string`：剥掉 `%` 注释、`\command` 与其可选/必选参数中的**非印刷**部分、环境定界符、连续空白归一，剩下会印到纸上的字符序列。编辑前后严格相等才允许应用。

- 落点在 `editApply.ts` 旁边——它已经在做「提案记录 find 出现次数、落盘前核对文件没动过」这类前置校验，这是同一类检查的第二条。
- **先严格相等，不做白名单。** 模型想加 `\caption{图 1：夜行}` 这种「新增印刷文字」的需求，由转录层解决：图片的 caption 从 md 的 alt 文本生成，模型不需要自己加字。放宽比收紧容易，反过来不行。
- `main.tex` 不受这条约束——那里本来就没有正文。

### 4.3 转录层要做的判断

`src/lib/latex/`，全部纯逻辑，可单测（vitest 跑在 node，没有 DOM——和 `lib/pptx/deck.ts`、`lib/xlsx/cells.ts` 同样的分工）：

| 模块 | 职责 |
|---|---|
| `escape.ts` | 十个特殊字符 + 中文引号 + URL 里的 `%`。**唯一**做转义的地方 |
| `blocks.ts` | `DocBlock[]` → tex。复用 `lib/docx/blocks` 的 token 流，方言树仍然只有一份 |
| `preamble/builtins.ts` | 内置模板（书籍 / 报告 / 公文 / 小说 / 论文） |
| `textFlow.ts` | I3 的判定 |
| `log.ts` | .log → 结构化诊断（纯函数，和 `probeAnalysis.ts` 同构：Rust 只负责跑和给字节） |
| `index.ts` | 编排：读盘、取图、转录、写盘、汇报降级 |

块映射与已知的坑：

| markdown | LaTeX | 注意 |
|---|---|---|
| 标题 | `\chapter` / `\section` / … | 深度按模板的 `documentclass` 决定：`ctexart` 没有 `\chapter` |
| 段落 | 空行分段 | 中文首行缩进由 `ctex` 的 `\parindent` 管，不在正文里写 |
| 粗体/斜体 | `\textbf{}` / `\emph{}` | 中文没有真斜体，`ctex` 会伪斜——模板里可换成着重号 `\CJKunderdot` |
| 行内代码 | `\texttt{}` | 需 `\setCJKmonofont`，否则中文等宽字缺字 |
| 代码块 | `verbatim` + `fvextra` | **不要用 `listings`**：它逐字符处理，UTF-8 中文会碎 |
| 引用 | `quote` | |
| 列表 | `itemize` / `enumerate` + `enumitem` | 中文列表间距默认过松 |
| 表格 | `longtable` + `X` 列宽 | `tabular` 不换行、不跨页，中文长表必溢出。列宽均分，宽度 `\linewidth` |
| 图片 | `figure[htbp]` + `\includegraphics[width=\linewidth,keepaspectratio]` | 按 `readImageHeader` 的真实像素判断要不要缩；alt 文本 → `\caption` |
| 分隔线 | `\par\noindent\rule{\linewidth}{0.4pt}` | |
| **数学** | **原样透传** | 见下 |
| `[[lore:…]]` | 显示文字 | 同 docx，报一条降级 |

**数学是这条线相对 docx 的净胜。** 这个 app 的 markdown 已经挂了 KaTeX（`lib/fs/markdown.ts`），`$…$` / `$$…$$` 解析成 `math_inline` / `math_block` token，而 `lib/docx/blocks.ts` 只能记一句「数学公式退回成了原始文本」。到了 LaTeX 这边它**本来就是 LaTeX**——原样搬过去，不转义，编译出来是排版级的公式。这一条单独就值一条导出线。

图片的降级（同 docx 的 `loadImages` 措辞，逐条给作者看）：

- 远程图不下载——导出是本地的确定性操作，不该因为一个 404 沉掉整份稿子；
- `.svg` / `.webp` xelatex 收不了（它经 `xdvipdfmx`，认 PNG/JPEG/PDF/EPS），落成替代文字；
- 文件读不到 / 读不出尺寸，落成替代文字。

---

## 5. 模型那一段：不是新 subagent，是主 agent 的一组工具

作者的说法是「latex subagent」。目标（隔离、别把 LaTeX 的杂事塞进主对话）是对的，但按这个仓库现有的分类，它不该是一个 `SubAgentKind`：

`SUBAGENT_KINDS` 里的东西是**绑一个自己模型的专家**——`vision` 要个看得见图的模型，`translate` 要个 Sakura，`imagegen` 要个画图的。LaTeX 调版不需要另一个模型：它需要**工具循环**（读 → 改 → 编译 → 看诊断 → 再改）和**审批通道**（改文件要过卡），而这两样正是主 agent 已经有的，另一个模型反而要把审批卡透传过去。

要隔离的话现成的路是**能力包子运行**（`ORCHESTRATOR_PRESET` + `run_pack`，`lib/agent/packs.ts`）：在父 agent 自己的模型上开一个薄工具集的子运行，审批通道和方案闸门原样透传，卡片仍然在它们一贯出现的地方渲染。想要的隔离拿到了，不用新增一个 kind，也不用作者再去设置里绑一个模型。

具体给这段的工具：

| 工具 | 层级 | 说明 |
|---|---|---|
| `read_file(main.tex)` | 读 | 一屏 preamble，不是三万字 |
| `propose_edit` / `rewrite_lines` | L2 | 已有的定点编辑机器，`main.tex` 上不受 I3 约束，`body.tex` 上受 |
| `compile_latex` | **验** | 这条链上唯一一个验而不是写的工具——和 `inspect_html` 同位（`edit-loop-plan.md` §6） |
| `export_pdf` | L2 | 提案卡 → 批准后转录 + 编译 + 落盘 |

`compile_latex` 的存在理由和 `inspect_html` 一模一样：**模型看不见自己排出来的页面**。它写了 `\begin{longtable}` 却不知道这张表有没有溢出到页边之外，也不知道那个生僻字在选定的字体里根本没有字形。

### 5.1 编译诊断回报什么（不回报什么）

.log 动辄几千行，绝大部分是宏包版本声明。整份塞进上下文是纯浪费，所以 `log.ts` 只回报四类：

1. **错误**，`-file-line-error` 格式（`./body.tex:42: Undefined control sequence.`）加它后面那两行上下文，最多 N 条；
2. **`Missing character: There is no 燚 in font …`** —— 这条**必须报**，是这条线独有的静默走形：XeTeX 只警告，PDF 里那个字**就是空的**，作者要翻到那一页才发现；
3. **`File … not found`** —— 图没进去；
4. **Overfull \hbox 的计数**，不是每一条。一份中文长稿有几百条，那是排版噪音不是错误；数量突然从 3 变成 300 才是信号。

再加两个页面级的数字：**页数**、**空白页数**。和 `lib/pptx/inspect.ts` 报「盒子有没有掉出幻灯片、有没有一页什么都没画」是同一种验收。

---

## 6. 编译层（Rust）

新模块 `src-tauri/src/latex.rs`，两个命令：

```rust
latex_probe() -> LatexToolchain     // 有哪些引擎、版本、有没有 latexmk
latex_compile(job) -> LatexRun      // 跑，返回 exit code + log 字节 + pdf 路径
```

**不引入 `tauri-plugin-shell`。** 那等于给前端一把通用 shell；这里只需要跑一个固定二进制、一张固定参数表。先例是 `instance.rs` 的 `std::process::Command`，同样是自己起进程而不装插件。

### 6.1 引擎

| 引擎 | 取舍 |
|---|---|
| **xelatex**（首选） | CJK 最稳，`ctex` 宏包成熟，`\setCJKmainfont` 直接按名字取系统字体 |
| lualatex | 备选，`luatexja` 路线；慢一截 |
| **pdflatex** | **不列**。它不支持中文，列出来只会让作者选中然后失败 |
| latexmk | 有就用（它自己决定跑几遍），没有就手动跑 |
| tectonic | 单文件、按需下宏包、不用装 TeX Live——对「作者装不起 5GB」是最好的答案，但**首次编译要联网下几十 MB**。列为可选，**不做默认**：这个 app 里联网下载是需要作者知情的行为 |

**绝不打包 TeX 发行版**（TeX Live full ~7GB；basic 装了也缺 ctex 这一套）。探测不到就给一句人话加三个官网链接（MiKTeX / TeX Live / MacTeX），而不是静默失败或者报一句 `ENOENT`。

### 6.2 参数与环境

```
xelatex -interaction=nonstopmode -halt-on-error -file-line-error
        -no-shell-escape -output-directory=<build> main.tex
```

环境变量：

- `openin_any=p` / `openout_any=p` —— paranoid：禁止绝对路径、禁止 `..`、禁止写点开头的文件。**I4 的另一半**；
- `TEXINPUTS` 指向工作目录 + build 目录；
- `max_print_line=1000` —— 默认 79 会把长文件名在日志里折断，`log.ts` 的路径解析就此失配。这是个必踩的坑，不是优化。

跑几遍：`latexmk -xelatex` 在就交给它；否则跑两遍，日志里出现 `Rerun to get cross-references right` 就再跑一遍，上限 3。

**超时 + 可取消。** nonstopmode 下一个死循环宏会一直转下去，硬上限 120 秒，进度和取消走和其他长任务一样的通道。

### 6.3 字体

模板里的 CJK 字体本机没装 → **一枚中性提示，不是错误**：导出的 PDF 仍然是对的（字体已嵌入，或者拿到装了它的机器上重编一样合规），只是作者本机排出来是替换字。措辞和 `lib/docx/fontCheck.ts` 那份完全一致（那里连「不用红色」都写在注释里了），探测手段也复用它——量宽度，不用 `document.fonts.check`（后者对没装的字体照样答 true）。

---

## 7. 模板（preamble）

两级，和工作流卡完全同构（`lib/workflow/cards.ts`：同 id **整张**覆盖内置）：

- **内置**在代码里：书籍（`ctexbook`，章首页、目录、书眉）/ 报告（`ctexart`，A4）/ 公文（仿宋_GB2312、3 号字、固定行距）/ 小说（正文纸开本、无目录）/ 论文；
- **项目级** `.ai-writer/latex/templates/*.tex` 覆盖同 id。

为什么是文件而不是像 docx 的 `DocFormat` 那样存成结构化 JSON：LaTeX 模板**就是一段文本**，作者从期刊或甲方那里拿到的模板也是一段文本。把它拆成三十个字段再拼回去，只会让「把甲方给的 .tex 贴进来」这件最常见的事变得做不到。

代价是它不像 `doc_format` 那张表那样自然进「应用配置备份」（那是装机级的 `config.db`）。项目级模板跟着知识库同步走；要不要再加一层装机级模板见 §10。

---

## 8. 入口

**① 零 token（默认）** —— `ExportMenu` 里加一项「导出 PDF（LaTeX 排版）」，和现有的「导出 PDF（打印）」并列，措辞要让作者一眼看出差别。选模板 → 转录 → 编译 → 保存到文档旁边。没装引擎时这一项**仍然在**，点了给引导，不是灰掉——灰掉的菜单项没人知道为什么。

**② Agent** —— `export_pdf` 与 `compile_latex` 进工具表，门槛两道（同 pptx 的 routing 规则）：Beta 开关（`lib/latex/flag.ts`，`app:latexExportBeta`，设置 → 通用 → 实验功能，默认关）**且**探测到引擎。关着的时候工具不是「被拒绝」而是**不存在**，模型不会提议一个作者没打开的功能。

进工具表要撞 `agentToolBudget.test.ts` 的棘轮——那不是测试坏了，是这两个工具的 schema 要从 ceiling 里扣掉（`agent-tool-context.md`）。所以按 `tools: "write"` 档考虑，不要顺手塞进 `full`。

---

## 9. 弃案

**pandoc.** 最显然的备选，不选有两个理由，第二个是硬的：① 要作者再装一个二进制；② 它是**第二份 markdown 方言**。这个仓库明写着方言树只有一份（`lib/docx/blocks` 的 token 流，xlsx 也从那儿取），而 pandoc 不认识 `[[lore:…]]`，对 KaTeX 那套 `$…$` 的语义也未必和 `@vscode/markdown-it-katex` 一致。而且 pandoc 自己也只是生成 .tex 再调 latex——我们省掉的正好是它带来的那个依赖。

**让模型直接写整份 .tex.** 正是作者要避开的（全文过模型），而且转义错了是静默的。

**逐字复制 md 再让模型改标记.** §2。

**浏览器里的 LaTeX（texlive.js / SwiftLaTeX WASM）.** 首次要往 IndexedDB 里下 100–300MB 的 texlive 包，中文字体还得另外塞；且这个 app 的 CSP 严到 `harvester.js` 都要在 `tauri.conf.json` 里写 `sha256-`。不做。

**Typst.** 诚实地说，这是最强的备选：单二进制、不用装 TeX Live、中文排版好、编译快到可以做实时预览。不选是因为作者要的是 LaTeX，而且「交出去的模板」——期刊的、学校的、甲方的——生态在 .tex 那边。但**架构上把引擎做成可换的**（`engine: "xelatex" | "lualatex" | "tectonic"`），以后加 Typst 就是加一个转录后端加一个引擎，不用动前面三段。

**用现有的 HTML → 打印顶上.** 保留，不替换。它是「快速看一眼」，这条是「印出来交出去」，§1 列的那五件事不是调 CSS 能补的。

---

## 10. 分片计划

每片一个 PR，落一片停一次，作者真机测过再下一片。

| 片 | 内容 | 能验什么 |
|---|---|---|
| **A** | `lib/latex/`：`escape` / `blocks` / `preamble/builtins` / `textFlow` / `log`。纯逻辑 + 单测，零 UI 零 Rust | 转义表、块映射、文字流不变式、日志解析全部可测 |
| **B** | `src-tauri/src/latex.rs`：探测 + 编译 + 超时/取消。`flag.ts` + 设置开关 | 本机能不能编出一份 PDF |
| **C** | 零 token 入口：`ExportMenu` 一项 + 模板选择 + 失败面板 + 缺引擎引导 | **到这里功能就完整可用了** |
| **D** | Agent：`export_pdf` 提案卡 + `compile_latex` + routing/beta 门 + toolCost 棘轮 | 模型能不能按甲方模板调出来 |
| **E** | 项目级模板 `.ai-writer/latex/templates/` + 管理 UI | |

顺序本身是个判断：**模型那一段最后加**。前三片已经把两个目标都做完了——不走形（LaTeX 排版 + 图片按真实像素处理 + Missing character 会报出来）、不花 token（正文一个字都不过模型）。D 是增强，不是地基。

---

## 11. 待定（需要作者拍板）

1. **本机装的是哪个发行版？** MiKTeX / TeX Live / MacTeX / 没装。决定 B 片先按谁调通，以及首版默认引擎。
2. **Tectonic 要不要作为「没装 TeX 时的一键方案」？** 好处是作者的读者不用装 5GB；代价是首次编译联网下宏包。
3. **模板两级（内置 + 项目）够不够？** 还是要像 docx 的排版预设那样再来一层装机级（进配置备份）。
4. **文字流不变式先做严格相等，接受吗？** 严格意味着模型想给图加一句 caption 也会被拒（caption 改由转录层从 alt 文本生成）。放宽容易，收紧难。
5. **除了 PDF 还要什么？** 同一条链换 `-output-format` 能出 DVI/PS，但真正有价值的可能是 **.tex 本身**（交给出版社/期刊）。要的话 C 片顺手加一个「导出 .tex 工程」。
