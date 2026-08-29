# 导入文档的图片抽取（PDF · docx）

> **Status: `planned`** — 方案已定，未实现。切两片 PR：PR-1 开接缝 + PDF 侧全链路，PR-2 让 docx 复用同一条接缝。实现落地后此行改 `shipped` 并补记出入。

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
- **pptx 不在本轮。** 它的转换在 Rust（`src-tauri/src/pptx.rs`），接缝一样能用，但抽图得在 Rust 侧解 zip media 目录，另开一片再做。
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
