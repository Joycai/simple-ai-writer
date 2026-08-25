# 导出 Word（.docx）与排版预设计划

> 状态：`proposal`（未决定，未实施）。
> 背景：作者要的是"导出一份能直接交出去的 Word 文稿，并且能设定样式"。因为"docx 很难处理"的印象，退而问 RTF 是否可行。本文的结论是**退让不成立**：难的是**读** docx，不是**写** docx，而 RTF 在这个 app 里反而是更贵的那条路。

## 1. 现状盘点（规划前逐项核实）

| 环节 | 现状 | 位置 |
|---|---|---|
| 导出出口 | Markdown（剪贴板）/ HTML（自包含单文件）/ PDF（系统打印） | `src/lib/fs/export.ts` + `components/layout/ExportMenu.tsx` |
| 排版来源 | 五套 markdown 主题（手稿/素雅/杂志/公众号/打字机），以 `--md-*` CSS 变量表达 | `src/lib/theme/markdownThemes.ts` |
| 作者能调的格式 | **一个下拉，五个固定值**。页边距、纸张、行距、字号、段间距一律不可调 | 同上 |
| 二进制写盘 | `writeBinaryFile(path, bytes)` 走 base64 over IPC，已在用（配图、图库、pptx） | `src/lib/fs/fileio.ts` → `fs_write_binary_file` |
| 二进制**另存为**对话框 | **没有**。只有 `save_text_file_dialog` / `open_text_file_dialog` / zip 两个 | `src-tauri/src/transfer.rs` |
| OOXML 生成先例 | pptxgenjs（~1 MB，懒加载独立 chunk），HTML → PPTX 已跑通 | `src/lib/pptx/write.ts` |
| docx **读**的先例 | mammoth，且明确**转成 markdown**，因为没有模型 API 收得下 zip | `src/lib/import/docx.ts` |
| 测试环境 | vitest `environment: "node"`，**无 DOM** | `vitest.config.ts` |

## 2. 关键结论：docx 难在读，不难在写

"docx 非常难处理"这个印象是真的——**对读而言**。任意一份 Word 文件里有修订、域、内容控件、六层 rPr 继承、Word 自己都未必往回读的兼容标记，所以这个 app 导入时干脆放弃保真、转成 markdown（`lib/import/docx.ts`）。

**写**是另一个问题：目标结构是我们自己定的，只需要发出 Word 认得的那一小撮 XML。而且——

> 让 .pptx 生成端变难的那件事（PowerPoint 要每个盒子的**绝对坐标**，所以不得不在沙箱 iframe 里把页面渲染出来量一遍，`pptx-plan.md` §4）**在 docx 这边根本不存在**。Word 是流式排版，和 HTML 同构：声明样式，让 Word 自己排。

一份最小 .docx = 一个 zip，里面 `document.xml`（正文）、`styles.xml`（样式表）、`numbering.xml`（列表）、`[Content_Types].xml` + 两个 rels。markdown 的块级结构（标题/段落/列表/引用/代码/表格/图片/分隔线）与 WordprocessingML 几乎一一对应。

### 2.1 实测（2026-08，docx 9.7.1）

不是推断，是跑过的：在 scratchpad 里装 `docx@9.7.1`，用中文正文 + 自定义样式 + A4 页面 + 表格 + 列表 + 图片生成了一份 9.8 KB 的 .docx，解包核对 XML：

```xml
<!-- styles.xml：docDefaults 里落了中文字体和首行缩进 -->
<w:rFonts w:ascii="Georgia" w:eastAsia="宋体" w:hAnsi="Georgia"/><w:sz w:val="24"/>
<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="480"/></w:pPr></w:pPrDefault>

<!-- document.xml：A4 + 页边距，段落按样式名引用 -->
<w:sectPr><w:pgSz w:w="11905" w:h="16837" w:orient="portrait"/>
  <w:pgMar w:top="1417" w:right="1797" w:bottom="1417" w:left="1797" .../>
  <w:docGrid w:linePitch="360"/></w:sectPr>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章　夜行</w:t></w:r></w:p>
```

四条被证实：

1. **中文原样落进 XML**（UTF-8），不需要任何转义——这正是 RTF 做不到的（§4）。
2. **`w:eastAsia` 可设**：`font: { ascii, eastAsia, hAnsi }`，中西文字体可以分开指定，这是中文排版的硬需求。
3. **`firstLineChars` 有**（`w:ind w:firstLineChars="200"` = 首行缩进 2 **字符**）——按字符而不是按磅，改字号时缩进不会错位。这是 Word 中文排版的正确写法。
4. **`Packer.toBase64String()` 存在**——正好落在这个 app 已有的 base64 二进制写盘通道上，一行接上。

顺带踩到一个**必须记下来的坑**：用 `paragraphStyles: [{ id: "Heading1", ... }]` 定义标题样式，产出的 `styles.xml` 里会有**两个** `w:styleId="Heading1"`（库自带的默认标题 + 你的）。要覆盖内置标题，走 `styles.default.heading1`，不要走 `paragraphStyles`。

## 3. 三条路线与弃用理由

### D1 采用 `docx` npm（推荐）

`dolanmiu/docx`，纯 TS，声明式对象模型，浏览器可用（内部是 jszip）。dist 1.1 MB 未压缩——与已在用的 pptxgenjs 同量级，**懒加载进独立 chunk**，和 `pptx/write.ts` 完全一样的处理。

能力核对（均在 9.7.1 的 d.ts 里确认）：样式表 / 页面尺寸页边距 / 段落属性 / 中西文分离字体 / 列表编号 / 表格 / 图片 / 页眉页脚页码 / `TableOfContents`（目录域）/ `FootnoteReferenceRun`（脚注）/ `PageBreak` / `Math*`（OMML 公式）。

新增管道只有一处：`save_binary_file_dialog`，`transfer.rs` 里 `save_text_file_dialog` 的十来行孪生体（base64 进来 → 解码 → 写盘），复用现成的 `pick_save_path`，`base64` crate 已是直接依赖。

### D2 弃用【RTF 顶替 docx】

RTF 有一个真实优点：**纯字符串**，零依赖，走现成的 `saveTextFileDialog` 就能落盘，纯逻辑可单测。但作为 docx 的**替代**它更贵：

- **中文全部要转义。** RTF 正文是 ASCII，每个非 ASCII 字符要写成 `\uNNNN?`，值是**有符号 16 位**（>32767 要转成负数），emoji 还要按代理对拆成两个。一整篇中文小说就是一整篇转义码——写得对不难，但错了很难看出来（错的是某几个字）。
- **表格是 `\trowd\cellx` 的累计宽度舞蹈**，每行都要重发一遍列定义。
- **图片要十六进制展开**（`{\pict\pngblip ...}`），文件体积翻倍，而且要先知道像素尺寸（好在 `lib/image/imageSize.ts` 已经能只读文件头拿到）。
- **产出是二等公民**：Word 打得开，样式面板也能显示，但保存时会提示转换；WPS/Pages 表现不一；主题、目录域、脚注支持参差。

同样的工作量，docx 拿到的是真样式和全部功能，RTF 拿到的是一个"能打开"。**它不是省事的那条路，只是看起来省事。**

### D3 弃用【HTML 塞进 .doc（MHT / altChunk）】

最省事的想象：把现成的 `exportHtml` 输出改个扩展名，或包成 altChunk。否掉：

- 产出**不是 docx**——样式面板是空的，作者拿到手改不动，而"能设定样式"正是需求本身。
- 依赖 Word 自己的 HTML 导入器，版本之间行为不同；WPS/Pages 更不确定。
- 排版规则会退回到 CSS，而 Word 只认得其中一半——`--md-para-indent: 2em` 这类值到了 Word 里是猜。

### D4 弃用【pandoc / LibreOffice sidecar】

保真度最高，代价不可接受：每平台 100 MB+ 的二进制要打包、签名、随版本升级；许可证要处理；`pptx-plan.md` D11 已经因为同一类理由否掉过外部运行时。

### D5 弃用【Rust 侧 `docx-rs`】

技术上可行，且能让 webview bundle 一点不涨。但 markdown 的解析器（markdown-it，含本项目自定义的 `[[lore:…]]` token）在 TS 侧，用 Rust 生成就要**再实现一遍 markdown 方言**——两份方言必然漂移。bundle 体积不是这里的约束（懒加载 chunk，只有点了导出的作者会下载它），所以不值得。

> 决定规则同 `pptx-plan.md` D1 的反面：那次解析放 Rust，是因为 zip 读取器和 quick-xml **已经在 Rust**；这次生成放 TS，是因为 markdown 方言**已经在 TS**。跟着已有的那一份走。

## 4. 另一半需求：排版预设（`DocFormat`）

"调整文章格式"不能靠现有的 markdown 主题。那五套主题是 **CSS**：`--md-para-indent: 2em`、`var(--font-serif)`——em 相对值和 CSS 变量都无法无损翻译成印刷单位，而且它们**根本不表达页面**（纸张、页边距、页眉页脚在 CSS 里不存在）。

所以引入一个独立的模型，单位全是印刷单位：

```ts
export interface DocFormat {
  id: string;
  label: { zh: string; en: string };
  page: { size: "A4" | "Letter" | "B5"; margins: { top; right; bottom; left } /* mm */ };
  body: {
    fontAscii: string; fontEastAsia: string;   // 中西文分开
    sizePt: number;
    lineSpacing: number;                        // 倍数，1.5 / 1.75 …
    firstLineChars: number;                     // 首行缩进「字符数」，中文默认 2
    spaceBeforePt: number; spaceAfterPt: number;
  };
  headings: Record<1 | 2 | 3 | 4, {
    fontEastAsia: string; sizePt: number; bold: boolean;
    align: "left" | "center"; spaceBeforePt: number; spaceAfterPt: number;
    pageBreakBefore?: boolean;                  // 一级标题另起一页——长篇要的
  }>;
  quote / code / list / table: …;
}
```

**内置预设与 markdown 主题同名**（手稿 / 素雅 / 杂志 / 公众号 / 打字机），让"屏幕上看到的"和"导出的"对得上；但**不从 CSS 推导**——一张手写的映射表，写在 `format.ts` 里，因为那本来就是两套单位系统之间的取舍，藏在自动转换里只会得到一个谁也解释不了的行距。

落盘位置分两期（§6）：一期只在代码里内置 + 一个"上次用的"偏好（`lib/prefs` 加 key，**不要碰 localStorage**）；二期做项目级覆盖，并允许能力包给出默认预设（投标文件要仿宋_GB2312 三号，周报要素雅——这正是 `WorkspaceProfile` 该管的事）。

## 5. 分层与文件落点

抄 `lib/pptx/` 的分法：**不碰库就能决定的，都不在碰库的文件里决定。**

```
src/lib/docx/
  format.ts    # DocFormat 模型 + 内置预设 + 单位换算（pt / mm / twip / 字符）——纯，测试在这里
  blocks.ts    # markdown-it token 流 → DocBlock[] 中性 AST——纯，测试在这里
  write.ts     # DocBlock[] + DocFormat → docx 对象 → 字节。**唯一**知道 `docx` 存在的文件
  index.ts     # exportDocx(source, title, baseDir, format) 编排 + 降级汇报
```

两条施工纪律：

1. **从 markdown-it 的 token 流解析，不从渲染后的 HTML 走 DOM。** vitest 跑在 `environment: "node"`，没有 DOM——走 DOM 就等于这层不可测，而这层正是全部逻辑所在。复用 `lib/fs/markdown.ts` 里那**同一个** `md` 实例（导出一个 `parseMarkdown()` 即可），所以方言不会分叉，自定义的 `lore_cite` token 也照样看得见。
2. **`write.ts` 薄到可以整体替换。** 哪天换库或改走 Rust，重写的只有它。

`index.ts` 返回的不是 `void` 而是一份报告（`{ path, blocks, degraded[] }`）——`exportHtmlToPptx` 的先例：只说"完成了"会把降级藏起来。

## 6. 会降级的东西（说清楚，不假装）

| 内容 | 处理 |
|---|---|
| KaTeX 公式 | 一期**降级为原文** `$…$` 并计入报告。docx 有 `Math*`（OMML），但那是把 TeX 编译到 OMML，是独立一件事，不该压在一期里 |
| mermaid 图 | 一期降级为代码块。二期可在 webview 里渲成 PNG 再嵌入（渲染器已在树里） |
| `[[lore:…]]` 引用 | 落成普通文字（显示文字），不带链接。Word 里没有可跳的目标 |
| 图片 | 支持。用 `lib/image/imageSize.ts` 读文件头拿像素尺寸，按正文栏宽等比缩放；读不到的按原图宽插入 |
| 嵌套列表 | 支持，但需要为每层建 numbering level；三层以上不保证与预览一致 |
| 目录 | 二期。`TableOfContents` 插的是**域**，Word 打开后要按 F9 才刷新——这一点必须在 UI 上说，否则作者看到空目录会以为坏了 |

## 7. 分期

| 期 | 内容 | 大小 |
|---|---|---|
| 一期 | `docx` 依赖（懒加载）+ `save_binary_file_dialog` + `format.ts` 内置五套预设 + `blocks.ts` + `write.ts` + 导出菜单加「Word (.docx)…」 | 一个 PR，主要工作量在 `blocks.ts`/`write.ts` 的纯逻辑与测试 |
| 二期 | 导出前的排版对话框（预设下拉 + 页边距/字号/行距/首行缩进可调）+ "上次用的"偏好 | UI 为主，复用 `settingsCommon.module.css` 的表单控件 |
| 三期 | 项目级排版预设（`.ai-writer/`）+ 能力包默认预设 + 目录 / 页眉页脚 / 一级标题分页 | 与 `WorkspaceProfile` 打通 |

RTF 若仍要（个别投稿系统只收 .rtf），作为**独立小模块**追加：`src/lib/rtf/`，纯字符串，复用同一个 `DocBlock[]` 和同一份 `DocFormat`——它的价值在于它不是 docx 的替代品，而是同一条流水线的第二个出口。

## 8. 一句话结论

可行，且应该直接做 docx：**写 docx 比写 RTF 便宜，产出还好得多**；.pptx 那条链路上最贵的"量版面"在这里不存在；已有的 base64 写盘通道、懒加载 chunk 先例、纯逻辑分层先例全部对得上，真正的新代码只有一个 markdown → 段落的映射层和一个排版模型。
