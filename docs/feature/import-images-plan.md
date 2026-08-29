# 导入文档的图片抽取（PDF · docx · pptx）

> **Status: `shipped`** — PR-1（#389：`ConvertResult` 接缝 + PDF 全链路）、PR-2（#390：docx 复用）均已合并，真机验证 2026-08-29 通过。实现出入记在 §8。§2 里推迟的 pptx 抽图随后补上（#392，设计在 §9，Rust 侧解 media），同日真机验证通过——三种带图格式至此全部落地。

## 1. 背景与现状

导入器（`src/lib/import/`）目前对图片的处理是「两种丢法」：

- **PDF**（`pdf.ts`）只走 pdfjs 的文本流（`streamTextContent`），图片根本不读。但行/段重建（`itemsToLines` / `linesToMarkdown`）已经在用每个文本项的 y 坐标——这正是决定一张图「该插在哪两段之间」所需要的全部信息，只是现在没有图可插。
- **docx**（`docx.ts` → `markdown.ts`）是**故意丢图**：mammoth 把图片内联成 base64 data URL，turndown 里挂了 `dropImages` 规则整个删掉。当时的理由（data URL 塞进正文是编辑器、RAG、diff 的死重）在「图片只能活在正文里」的前提下成立——但应用后来长出了完整的文档插图约定（`lib/image/assets.ts`：`assets/<文档名>/` + 相对链接 + 文档移动/复制/删除时的资产跟随），前提已经不在了。图片可以落盘成文件、正文里只留一行相对链接，data URL 的三条罪状一条都不沾。

所以这不是「加一个功能」，而是把两个转换器接到一个已经存在的落盘约定上。

## 2. 目标与非目标

**目标**

- 导入 PDF / docx 时，把内嵌的**光栅图**抽出来，按阅读顺序落到 `assets/<文档名>/` 下，正文对应位置插 `![](assets/…)` 相对链接。
- 抽取与定位是纯函数层，和现有 `itemsToLines` 一样可以不碰 pdfjs 直接单测。

**非目标**

- **矢量图不做。** PDF 里用路径画的图表/示意图不是光栅 XObject，这条路拿不到；要拿只能整页渲染再裁剪，那是另一个方案（§7 否掉了）。和表格降级成文本一样，这是格式限制，文档一下即可。
- **pptx 不在本轮。** 它的转换在 Rust（`src-tauri/src/pptx.rs`），接缝一样能用，但抽图得在 Rust 侧解 zip media 目录，另开一片再做。（后来补上了——见 §9。）
- **OCR 不做。** 扫描件抽出来的是整页图，不是文字。

## 3. 设计

### 3.1 接缝：`convertToMarkdown` 返回值扩容

现在 `convertToMarkdown(ext, data): Promise<string>`。改为：

```ts
interface ConvertedAsset {
  /** 文件名（"p3-1.jpg"），目录由调用方决定。 */
  name: string;
  bytes: Uint8Array;
}
interface ConvertResult {
  markdown: string;
  assets: ConvertedAsset[];
}
convertToMarkdown(ext, data, opts: { assetRelDir: string }): Promise<ConvertResult>
```

`assetRelDir` 是正文里链接要用的相对目录（`assets/<group>`）。它能在转换**前**算出来，因为 `index.ts` 的导入循环本来就先跑 `uniqueImportPath` 定下目标 md 路径——`group = safeAssetName(stemOf(target))`，和 `assets.ts` 的 `writeDocumentAsset` 同一条推导。转换器把链接直接写进 markdown（经 `imageMarkdown` 同款的 encodeURIComponent 处理），返回的 `assets` 由 `index.ts` 在 md 写盘成功后逐个 `writeBinaryFile` 到 `dirOf(target)/<assetRelDir>/<name>`。

为什么是「converter 返回字节、index 写盘」而不是 converter 自己写：转换器至今是「bytes 进、字符串出」的纯层（docx/pdf 的测试全靠这一点），碰盘的只有 `index.ts` 一处——保持这个分工，抽图逻辑照样可测。

转换失败则什么都没写；md 写成功、某张资产写失败，归入现有的 per-file `failures` 通道（正文已在，链接悬空一张，比整个文档导入失败好）。目标 md 经 `uniqueImportPath` 拿的是全新名字，所以 `assets/<group>/` 一般不存在；万一残留同名旧目录（md 删了资产没删），直接往里写、同名文件让 `uniqueImportPath` 同款的编号规则避让。

### 3.2 PDF 抽取层

对每页在文本流之外再跑 `page.getOperatorList()`，扫操作数组：

- 维护 CTM 栈：`OPS.save` / `OPS.restore` / `OPS.transform`。
- `OPS.paintImageXObject` / `OPS.paintImageXObjectRepeat`：args 里是对象 id，像素从 `page.objs.get(id)`（个别落在 `page.commonObjs`）取。`OPS.paintInlineImageXObject` 的 args 直接带图像对象。`paintImageMaskXObject`（纯蒙版，通常是艺术字/印章的镂空）跳过。
- pdfjs 给回来的两种形态都要接：新版在 OffscreenCanvas 可用时给 `ImageBitmap`（drawImage 即可），否则给 `{ data, width, height, kind }`（按 `ImageKind` 铺成 ImageData）。CMYK、JPEG2000、SMask 透明这些 pdfjs 内部都已解码，我们只面对 RGB(A)。
- 位置：paint 操作把单位正方形映射过 CTM，图片顶边 y ≈ `f + d`（PDF 用户空间 y-up），和文本项的 baseline y 同一坐标系——这就是排序键。渲染宽高 ≈ `|a|`、`|d|`，用于小图过滤（§4）。

编码走 canvas `toBlob`：**含 alpha → PNG，不含 → JPEG 0.9**。这条规则的靶子是标书/扫描件：它们的图源头几乎都是 DCT（照片、扫描页），重编码成 PNG 会膨胀 5–10 倍；而带透明的图（logo 抠图）本来就小，PNG 无损不吃亏。判断 alpha 就扫一遍像素的 A 通道，纯函数。

### 3.3 定位层：行列表 → 块列表

`itemsToLines` 的输出从 `Line[]` 扩成 `Block[]`：

```ts
type Block =
  | { kind: "line"; y: number; text: string }
  | { kind: "image"; y: number; relPath: string };
```

文本行照旧折叠，图片块带着自己的顶边 y 混入，按 y 降序（y-up，页面从上往下）归位。`linesToMarkdown` 的段落间距逻辑只看相邻**文本**行的 y 差（图片的 y 是顶边不是基线，掺进中位数会把段落阈值搅坏）；图片块独立成段输出，前后空行，同 `imageMarkdown` 的理由——插图链接粘在句子中间渲染成行内小图，从来不是想要的。

命名 `p<页码>-<序号>.<ext>`（`p3-1.jpg`）：页码在名字里，作者在 `assets/` 文件夹里就能对上号，和现有 `<!-- page N -->` 注释同一套坐标。

### 3.4 docx 复用

mammoth 换用自定义 `convertImage`：回调里拿到 contentType + 字节，登记进 `assets`（名字 `img-1.png` 起，扩展名从 contentType 推），`src` 直接写成最终相对链接，alt 沿用 mammoth 读到的 altText。turndown 的 `dropImages` 规则收窄为**只丢 `data:` URL**——它从「策略」降级为「防御」：万一哪条路径漏了 convertImage，data URL 也进不了正文。

docx 不需要定位层——图片本来就在 HTML 流里的正确位置。

## 4. 三个决策

**重复图去重 + 装饰过滤。** 标书 PDF 每页页眉都有 logo/水印，不处理就是两百份同一张图。规则：对编码后的字节算哈希（`crypto.subtle` SHA-256），同哈希只落盘一次、链接复用；一张图出现在 **≥3 页且 ≥30% 的页面**上，判为页面装饰，正文里一处都不留（落盘也不落）。两个阈值都在纯层，可测可调。误伤面小：正文里合法复现的插图很少铺满三成页面。

**小图丢弃。** 渲染尺寸不足 24pt 或原生不足 32px 的图（列表符号、边框贴片、扫描噪点）直接丢。同样是纯层常量。

**扫描件保留，不设资产总量上限。** 整页即一张图的 PDF，抽取后 md 是一本「图册」——但另一个选项是维持现状：正文空空如也（扫描件没有文本层），那更糟。不另设上限的理由：导入输入已有 64MB 硬顶（`MAX_IMPORT_BYTES`），JPEG 重编码后资产量级与输入同阶，不会出现输入 64MB、落盘 600MB 的放大。

## 5. 测试

- 定位层（块排序、段落阈值不被图片 y 污染、命名、独立成段）：纯函数直测，样式同 `pdf.ts` 现有测试。
- CTM 跟踪 + 操作扫描：把 opList 抽象成 `{fn, args}[]` 输入的纯函数，喂手造序列测 save/restore 嵌套、repeat 操作。
- 去重/装饰/小图三条规则：纯层直测。
- canvas 编码和 `page.objs` 的两种形态：vitest 环境没有 canvas，这一薄层不测，靠真机验证（导入一份真实标书 PDF + 一份扫描件）。
- docx：mammoth 在 Node 可跑，构造带图 docx 固定样本直测 convertImage → 链接 → assets 的全链路。

## 6. PR 切片

1. **PR-1**：`ConvertResult` 接缝 + PDF 抽取/定位/去重/落盘 + 测试。docx/xlsx/pptx 转换器同步改返回形状（assets 恒空数组），行为不变。
2. **PR-2**：docx 侧换 convertImage、收窄 `dropImages` + 测试。

各片合入后停下等真机验证（标书 PDF、扫描件、带图 Word 各一份），再动下一片。

## 7. 被否掉的方案

- **整页渲染再按区域裁剪。** 能捎带上矢量图，且蒙版/色彩空间由渲染管线兜底。否掉：分辨率受渲染倍率钳制（原生 300dpi 的扫描图按 2× 渲染就是有损）、裁剪框要自己从 opList 算（工作量没省）、整页渲染比只解图像对象慢一个量级。矢量图的价值不抵这三条。
- **图片内联 base64 进正文。** `markdown.ts` 里 `dropImages` 的注释已经把它埋了：编辑器、RAG、diff 三处死重。落盘约定就是为此存在的。
- **资产进统一平铺目录（如 `.ai-writer/media/`）。** 违背 `assets.ts` 的既有理由——按文档分组才能手工整理、删章节时知道哪些图随之作废，且移动/复制/删除的跟随机制（`moveDocumentAssets` 等）只认这套布局。
- **抽图作为导入后的独立动作（先纯文本导入，再让 agent 补图）。** 定位信息（y 坐标）只在转换现场有，事后补插只能靠猜。

## 8. 实现出入（PR #389 / #390）

按方案落地，出入四条：

- **mammoth 的输入要两个 key 都给。** 它有两副面孔：browser 构建（应用里）只认 `{arrayBuffer}`，Node 构建（vitest 里）只认 `{buffer}`/`{path}`，各自忽略对方的 key。`docxToMarkdown` 因此同时传 `arrayBuffer` 和 `buffer`（声明的 `Input` 类型一次只许一个，带一个 cast）——否则真 mammoth 进不了单测。
- **不支持的图片格式走「空 src」信道。** 方案 §3.4 没写不支持的 content-type 怎么办；实现里 `imageCollector` 的白名单是应用自己打得开的图（png/jpg/gif/webp，对齐 `lib/fs/images`），白名单外（Office 爱嵌的 EMF/WMF 矢量图）返回空 `src`，由 `markdown.ts` 收窄后的 `dropDataUrlImages` 规则（空 src 或 `data:` 皆删）丢掉。命名计数器只为留下的图前进，文件名不留空洞。
- **docx 全链路测试靠手写 zip 打包器，不靠检入二进制样本。** §5 说「构造带图 docx 固定样本」；实现是测试文件里 ~50 行的存储式（不压缩）zip 写入器 + 最小 DrawingML 文档，穿过真 mammoth 断言资产字节、相对链接和 alt（取自 `wp:docPr@descr`）。
- **PDF 胶水层对 `page.objs` 的两种对象形态都接**（新版 pdfjs 的 `{bitmap: ImageBitmap}` 与旧形态 `{data, width, height, kind}`），方案只提了要接、没定形状；全局资源（`g_` 前缀 id）落在 `commonObjs`，也在实现里补上了。

其余与方案一致：三条取舍规则的阈值原样（24pt / 32px / ≥3 页且 ≥30%）、含 alpha → PNG 否则 JPEG 0.9、`p<页>-<序>` 命名、抽取整体 try/catch 丢图不丢文。

## 9. pptx 抽图（§2 推迟的那片）

pptx 的转换器在 Rust（`src-tauri/src/pptx.rs`），图早就被**看见**了——`parse_slide` 解析 `<a:blip r:embed>`、渲染成 `_[image: image7.png]_` 占位——缺的只是把 `ppt/media/` 的字节带回来。所以这一片没有定位层、没有编码层，只有「读出来、名字起好、跨 IPC 送回接缝」：

- **`pptx_to_markdown` 返回 `{markdown, assets}`**（`PptxImport`，每张资产 `{name, data: base64}`），正文里被留下的图从占位变成真链接 `![alt](assets/…/s3-1.png)`。alt 取自 `p:cNvPr@descr`（PowerPoint 的替换文字），同 docx 取 `wp:docPr@descr` 一条来源。TS 侧（`lib/fs/pptx.ts`）解 base64 后原样交给 `index.ts` 的既有落盘循环——转换器仍然一个字节都不写盘。
- **`read_slides`（agent 翻页）一点不动。** 收集器是 `Option`，翻页路径传 `None`：agent 读的是文字，每翻一页拖着整页图片过 IPC 会把分页做的事（pptx-plan D3）全赔回去。占位符 `_[image: …]_` 在那条路上原样保留。
- **白名单同 docx**：png/jpg（jpeg 归一成 jpg）/gif/webp，对齐 `lib/fs/images` 的可打开种类；media 里的 EMF/WMF/SVG/音视频不抽，占位符原样留下（PDF/docx 的「只取光栅」同一条线）。
- **去重按 media part，不按哈希。** pptx 的包格式已经替我们去过重：跨页复用的图指向同一个 `ppt/media/` 条目，按 zip 路径 memoize 即可——首见的页命名（`s<页>-<序>.<ext>`，对齐 PDF 的 `p<页>-<序>`），之后每处都链接同一个文件。PDF 那套 SHA-256 + 装饰过滤在这里没有对象：版式母版上的 logo 根本不出现在 slide XML 里，天然不进结果。
- **链接目录由 TS 编码后传入**（`asset_dir` 参数，percent-encode 每段）。编码规则住在 `lib/image/assets.ts` 一侧，Rust 不再实现一份——两份实现只会漂移；Rust 生成的文件名是纯 ASCII（`s3-1.png`），无需编码。
- **预算截断时回滚资产。** `convert_range` 是先渲染整页再判预算的（页边界纪律），被丢弃的那页已经收了图——`assets.truncate` 回滚，不然 md 里没链接的孤儿文件会落进 `assets/`。
- rels 指向不存在的 media、或 media 为空字节：占位符兜底，不出资产（丢图不丢文，同 PDF 的 per-page try/catch 精神）。

测试在 `pptx.rs` 内联（真 zip fixture）：抽取 + 链接位置、EMF 不抽占位保留、跨页复用一份资产多处链接、缺失 media 兜底、翻页路径不带字节。这台开发机 `cargo test` 起不来（见 CLAUDE 备忘），由 CI 跑。
