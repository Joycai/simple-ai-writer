# 入模图片规范化方案：HEIC 转码 + 超阈值降采样

> **状态：`partial`。** §2（出口降采样）与 §1.3 的选择器收敛已实现；§3
> （HEIC 入口转码）**明确不做** —— 见 §3.0。
>
> 本来是两件独立的事，落在两层：
>
> 1. iPhone 默认出 `.HEIC`，绝大多数模型不收 —— **入口转码**，落盘一次。
>    **已放弃**，理由是许可证而非技术（§3.0 / §3.1）。
> 2. 手机照片和生图模型的输出动辄 4000px 以上、十几 MB —— **出口降采样**，
>    不落盘，每次请求按需。**已实现。**
>
> 两层没有合成一个改动，这一点在只做第二件事时也仍然成立：一张图会不会被缩，
> 取决于这次要发给谁，而不取决于它在盘上长什么样。§3 整节保留，因为那笔账
> （为什么是入口而不是发送前、为什么不需要 worker）在有人再提 HEIC 时就是答案。

---

## 1. 现状盘点

### 1.1 `.HEIC` 现在不是「发不出去」，是「不存在」

[`lib/fs/images.ts`](../../src/lib/fs/images.ts) 的 `IMAGE_EXTS` 是
`png / jpg / jpeg / webp / gif`。这一个集合同时决定了五件事：

| 谁读它 | `.heic` 现在的结果 |
| --- | --- |
| `isImagePath` → `read_image` / `read_lore_image` | 工具直接报错「不是图片文件」 |
| `projectFilesFromTree` → 聊天 `@` 候选 | 选不到 |
| `FileTree` / `EditorArea` 的文件类型分派 | 当成文本文件打开 |
| `IMAGE_EXTENSIONS` → `COPY_BINARY_EXTENSIONS` | 导入对话框的过滤器里没有，拷不进来 |
| 四个图片选择器各自硬编码的 `extensions` 数组 | 选不到（见 §1.3） |

所以这不是「发送前加一步转换」，而是「让 HEIC 进入这个应用」。

### 1.2 像素进模型只有一个出口，但入口分成两类

一张图到模型永远是 `role: "user"` 消息上的 `image_url` part
（[`架构文档` → Images in context](../reference/architecture.md)）。所有构造它的地方
都调 `imageToDataUrl`。但**调 `imageToDataUrl` 的地方不都是给模型看的**——
这是整个方案里最要紧的一条分界：

| 给模型（应改走 `imageForModel`） | 给人看 / 写盘（**必须原样**） |
| --- | --- |
| `agent/tools.ts:187` `read_lore_image` | `editor/Preview.tsx:124` 正文图内联 |
| `agent/tools.ts:272` `read_image` | `editor/ImagePreview.tsx:26` 图片文件预览 |
| `ai/AgentChat.tsx:235` 聊天 `@` 附件 | `lore/useImageDataUrl.ts` 图集/头像 |
| `roleplay/RoleplayChat.tsx:568` 扮演附件 | `common/MarkdownPreview.tsx:44` |
| `lore/ai/AttachmentTextarea.tsx:89` | `fs/export.ts:53` 导出内嵌 |
| `lore/LoreDetail.tsx:501` 图集描述（vision） | `fs/htmlDoc.ts:26` HTML 内嵌 |
| `lore/LoreMetaImproveModal.tsx:121` | `library/LibraryView.tsx` 书脊缩略图 |
| `ai/ImageGenModal.tsx:372` 校准复审（vision） | **`ai/ImageGenModal.tsx:421`**（读回字节**写盘**，不是发送） |
| `image/illustrate.ts:97` 插图参考图 | **`lore/LoreGenerator.tsx:198`**（把附件写成条目头像） |
| `stores/imageStore.ts:184` 改图源图 | |

右列最后两行值得单独标出来。`ImageGenModal.tsx:421` 长得和同文件的 `:372`
一模一样，做的却是把候选图落盘；`LoreGenerator.tsx:198` 更隐蔽 —— 它取
`{ bytes, ext }` 去写 `avatar.<ext>`，一个数据 URL 建出来只是被丢掉。降采样接到
这两处，等于**永久损坏作者存下来的图**。

> 这张表第一版把 `LoreGenerator:198` 放在了左列，因为它在一个满是模型调用的
> 文件里、调的又是同一个函数。**按调用点分类是不够的，得看返回值去了哪里** ——
> 这条教训直接决定了 §2.7 的做法：不是加注释提醒，而是让这两处根本调不到那个
> 函数。

### 1.3 四个选择器各写各的扩展名

`LoreDetail:347`（头像）、`LoreDetail:433`（图集）、`LoreWall:125`（头像）、
`CodeEditor:112`（正文插图）四处各自硬编码 `["png","jpg","jpeg","webp"]` 或
带 `gif` 的版本，没有一个读 `IMAGE_EXTENSIONS`。加一个扩展名要改五个地方，
而漏掉的那个不会报错，只是那条路选不到新格式 —— **已把这四处收回
`IMAGE_EXTENSIONS`**。附带效果：两个头像选择器以前少一个 `gif`，现在也能选了，
应用本来就渲染得了动图头像。

### 1.4 已经现成的地基

- [`imageToThumbnailDataUrl`](../../src/lib/fs/images.ts) 是一套完整的 canvas
  降采样（`<img>` → `drawImage` → `toDataURL`），连 WebKit 对超大 `data:` URI
  的解码上限都踩过了。降采样这半基本是把它参数化。
- `MAX_IMAGE_BYTES = 12MB` 已经是**一个**数字、住在**一个**地方，它的注释已经
  论证过「两个入口用不同上限」是错的。本方案继续遵守。
- 懒加载重依赖切独立 chunk 是既有模式（pdfjs、mammoth、pptxgenjs、mermaid）。

---

## 2. 出口降采样（PR-A）

### 2.1 语义变化：`MAX_IMAGE_BYTES` 从「拒绝」变成「目标」

今天 [`AgentChat.tsx:239`](../../src/components/ai/AgentChat.tsx) 和
[`RoleplayChat.tsx:571`](../../src/components/roleplay/RoleplayChat.tsx) 撞到 12MB
是弹一句「太大，换一张」。这是这个方案真正的收益点：作者手上那张就是要发的
那张，「换一张」不是一个可执行的建议。

改成：先缩，缩到达标就正常发；**只有阶梯走完仍不达标才保留今天的报错**——
错误路径不删，它是兜底。

### 2.2 两个阈值

| 阈值 | 默认 | 可调 | 理由 |
| --- | --- | --- | --- |
| 长边 `app:imageMaxLongEdge` | **4096 px** | 设置 → 通用 → 图片 | 保原分辨率是默认行为，4096 之上才动手。iPhone 主摄 4032×3024 恰好在线下，正常照片一像素不动 |
| 字节 `MAX_IMAGE_BYTES` | 12 MB | 否 | 已有常量，语义见 §2.1 |

`0` = 不限长边（只在超字节时才缩）。上界钳在 16384，照
[`DEFAULT_MAX_OUTPUT_MAX`](../../src/lib/ai/modelLimits.ts) 的做法：自由数字
输入框，但不接受胡来的数字。

**为什么不是 2048。** 各家 vision 端点内部大多会把长边压到 1500 左右
（Anthropic 文档给的建议值是 1568），照这个逻辑 2048 更省。但省的是**服务端
本来就会替我们做的事**，而代价落在作者身上：截图认字、扫描件读表格、看清人物
配饰这类需求，正是降采样第一个毁掉的东西。[`LoreDetail.tsx:501`](../../src/components/lore/LoreDetail.tsx)
的注释已经就同一件事表过态 ——「vision 模型描述一张降采样过的副本，会漏掉的
恰好是这段描述存在的理由」。4096 的位置是：**只挡住真正异常的东西**（生图模型
的 4096² 输出、长截图、扫描 TIFF 转来的巨图），正常照片一律放行。想更省的作者
自己调低，这就是它可配的理由。

**为什么不做 per-provider 上限表。** 这个应用支持任意 OpenAI 兼容中转，
`model.type === "multimodal"` 是**模型行上的一个声明**而不是从名字猜的，
中转背后到底是谁根本探测不出来。一张按 provider 分档的表会在第一次中转换后端
时开始撒谎，而且是静默的。一个保守默认 + 可调，是这里唯一诚实的形状。

### 2.3 分层：纯决策 + 薄 DOM

vitest 跑在 node 环境，没有 canvas。所以照
[`pptx/deck.ts` 与 `harvest.ts`](./pptx-plan.md) 的分法：

```
src/lib/image/imageSize.ts       纯 —— 从文件头读尺寸，避开绝大多数解码
src/lib/image/downscalePlan.ts   纯 —— 阶梯本身，测试都在这
src/lib/image/normalize.ts       DOM —— decode / drawImage / toBlob，尽量薄
```

`imageSize.ts` 不在原计划里，是实现时补的：绝大多数图**本来就达标**，而为了
知道这件事去解码一张 12MP 照片要 ~100ms 和 ~48MB 位图 —— 代价落在每条聊天附件
和 agent 循环里的每次 `read_image` 上。PNG / JPEG / GIF / WebP 四种都是定长
文件头，白读。三条约束写进了模块注释：认不出的格式返回 `null` 让调用方去解码
（它是快路径，不是权威）；`alpha` 是「**可能**有透明」而不是测量结果，宁可多留
一次 PNG 也不要把透明区域编成黑块；读出来的是**存储尺寸**，一张竖拍照片的
文件头写着 4032×3024 加一个旋转标记 —— 长边一样，所以判断不受影响，但别的
地方不能拿这个数当显示尺寸用。

决策层是一个**步进函数**，不是一次算完：JPEG 编码后的字节数事先算不出来，
只能编一次量一次。

```ts
export type Step =
  | { kind: "as-is" }                                             // 不用动
  | { kind: "encode"; w: number; h: number; mime: string; quality?: number }
  | { kind: "reject" };                                           // 阶梯走完仍超

export function planImageStep(state: {
  width: number; height: number;
  bytes: number;          // 上一轮编码后的实际字节；首轮 = 原文件字节
  attempt: number;        // 0 = 还没编码过
  hasAlpha: boolean;
  animated: boolean;      // GIF / HEIC sequence
  limits: { longEdge: number; maxBytes: number };
}): Step;
```

阶梯（`attempt` 递增）：

1. `attempt 0`：长边和字节都达标 → `as-is`。动图 → 永远 `as-is`（§2.5）。
2. 长边超 → 等比缩到 `longEdge`，质量 0.9。
3. 仍超字节 → 同尺寸，质量 0.8 → 0.7。
4. 仍超 → 长边 ×0.75，回到质量 0.85，再走一轮。
5. 四轮之后仍超 → `reject`，走 §2.1 保留的错误路径。

驱动这个循环的是 `normalize.ts`，它每轮拿到新字节数再问一次。纯层拿得到的
全是数字，测得了全部分支。

### 2.4 编码与方向

- **有 alpha → PNG，否则 JPEG**。`hasAlpha` 从原扩展名 + 解码结果推断，
  不是猜的：PNG/WebP/HEIC 都可能带 alpha，JPEG 不会。把一张带透明的立绘编成
  JPEG 会得到一块黑底。
- **EXIF 方向必须显式处理**。这是 iPhone 照片的重灾区：竖着拍的照片字节里是
  横的，靠 EXIF `Orientation` 转正。**实现用 `<img>` + `decode()`，不是计划里
  写的 `createImageBitmap`** —— 改主意的理由是失败模式不对称：`<img>` 默认就
  应用方向（`image-orientation: from-image` 是初始值，`naturalWidth/Height` 报
  的是转正后的尺寸），而 `createImageBitmap` 的 `imageOrientation` 是**字典
  成员**，不实现它的引擎会**忽略**而不是报错。选错了没有任何信号，只有一张躺倒
  的照片和一段模型对它的认真描述。`imageToThumbnailDataUrl` 走的也是这条路，
  它那段注释还替 classic canvas 挡过 WebView2 的怪癖。

### 2.5 动图直接放行

GIF 在 `IMAGE_EXTS` 里，canvas 重编码会把它压成第一帧。HEIC 也有 sequence
形态（Live Photo）。两者一律 `as-is` —— 宁可让一张超大 GIF 走 §2.1 的错误
路径，也不要静默地把动图变成静图。

### 2.6 作者要看得见

缩过之后在附件 chip 的 tooltip 和工具结果上写一行：
`4032×3024 → 2048×1536, 8.2MB → 1.1MB`（`downscaleNote()` 只吐数字，措辞留在
两个调用方各自的语言里）。静默降质的代价是作者不理解模型为什么认不出截图里的
小字，而这个原因在界面上无迹可寻。

工具结果那一份是**说给模型听的**：一张缩过的图，小字可能已经不可读，而一个
认真读出模糊标签的模型比一个说「看不清」的模型更糟。

### 2.7 三个读图函数，按去向分

§1.2 那张表证明了「哪个调用点该改」不能靠注释维持。所以最后落成三个名字：

| 函数 | 去向 | 会不会改动像素 |
| --- | --- | --- |
| `imageForModel`（`lib/image/normalize`） | 发给模型 | 会，超阈值时 |
| `imageToDataUrl`（`lib/fs/images`） | 渲染给人看 | 不会 |
| `readImageBytes`（`lib/fs/images`） | 写盘 | 不会，而且根本不建 data URL |

`readImageBytes` 是这次新加的，专门给 `LoreGenerator:198` 那种「取字节去写文件」
的调用点 —— 它以前建一个数据 URL 再丢掉，而那正是它看起来像模型调用点的原因。
现在写盘路径**调不到**任何会改动像素的函数，这比在旁边写一行注释可靠。

---

## 3. 入口转码（**没做**）

### 3.0 为什么没做

不是技术问题 —— §3.1 的选型成立，§3.2 的落点也成立。是许可证：`libheif` 与
它的 HEVC 解码器 `libde265` 都是 **LGPL-3.0**，这会是本仓库第一个非宽松许可的
依赖，还要在分发物里带上声明和替换该库的途径，外加 HEVC 专利那片灰色地带。
作者看过这笔账后决定不接。

于是 `.heic` 保持 §1.1 的现状：这个应用里不存在这种文件。这是一个**明确的取舍
而不是遗漏** —— 再有人提，看 §3.1 那张表和这一段，别重新调研一遍。§2 的降采样
与它完全独立，已经单独发了。

### 3.1 选型：`libheif` 的 WASM 构建

| 方案 | 判断 |
| --- | --- |
| 靠 webview 原生解码 | **否决。** Windows 的 WebView2（Chromium）不解 HEIC，Linux 的 WebKitGTK 也不解；只有 macOS 的 WKWebView 可能行。做成 fast path 意味着维护两条解码路径来省一个懒加载 chunk |
| **WASM（`libheif-js` 系）** | **采用。** 三平台行为一致，无 Rust 构建风险，和 pdfjs / mammoth / pptxgenjs 同一个懒加载模式 |
| Rust `libheif-rs` | **否决。** 要系统 libheif（brew / apt / vcpkg），三平台 CI 都得装，交叉编译与签名分发全部变复杂 |

具体包（2026-08 查 npm registry）：

| 包 | 版本 | 许可 | 解包体积 | note |
| --- | --- | --- | --- | --- |
| `libheif-js` | 1.19.8 | LGPL-3.0 | 6.4 MB（含 asm.js / wasm 多套构建） | 底座，无依赖 |
| `heic-decode` | 2.1.0 | ISC | 6.6 KB + 上面 | 只做「HEIC → RGBA + 宽高」，接口面最小 |
| `heic-to` | 1.5.2 | LGPL-3.0 | 24 MB | 自带 PNG/JPEG 编码，重复了我们已有的 canvas 那一层 |
| `heic2any` | 0.0.4 | 名义 MIT | 2.7 MB | 2023 年后无更新，内嵌旧版 libheif |

**取 `heic-decode` + 我们自己的 canvas 编码**：它只吐 RGBA，正好接进 §2 已经
存在的 `ImageData → canvas → toDataURL` 那一段，两条路共用一个编码器。实际
进 bundle 的 wasm 体积（`libheif-js/wasm-bundle` 一套，约 2 MB 量级）**要在
PR 里实测确认**，上表的 6.4 MB 是整包解包大小，不是打包结果。

> **许可证是这条路的终点（已拍板：不接）。** libheif 与其 HEVC 解码器
> libde265 都是 **LGPL-3.0**，
> 这是本仓库第一个非宽松许可的依赖。LGPL 对分发的二进制要求声明使用、提供该库
> 的源码获取途径、并允许使用者替换该库 —— Vite 把它切成独立 chunk 在事实上满足
> 最后一条，但前两条需要在「关于」页或 README 里显式写出来。另有 HEVC 专利这条
> 众所周知的灰色地带。选择的是最后一条退路：不做 HEIC，只做 §2。

### 3.2 落点：`ImportMode` 的第四种处置

[`lib/import/index.ts`](../../src/lib/import/index.ts) 已经有一个说清楚了的
处置枚举：`convert`（docx/xlsx/pdf/pptx → markdown）、`copy-text`、
`copy-binary`。加第四种：

```ts
export type ImportMode = "convert" | "copy-text" | "copy-binary" | "transcode";
export const TRANSCODE_EXTENSIONS = ["heic", "heif"] as const;
```

`transcode` 与 `convert` 同源：**没有任何模型 API 收这个二进制**，转换不是
捷径而是唯一选项 —— 这正是 `CONVERT_EXTENSIONS` 注释里已经论证过的那条。
落盘名 `photo.heic` → `photo.jpg`（带 alpha 则 `.png`），走已有的
`uniqueImportPath` 编号。

四个外部图片入口都要过这一步，而它们今天各写各的（§1.3）。所以先抽一个：

```ts
// src/lib/image/ingest.ts
/** 一张来自项目外的图片，转成这个应用能渲染、模型能收的形态。 */
export async function ingestImageFile(src: string): Promise<{ bytes: Uint8Array; ext: string }>;
```

`lib/import`、`LoreDetail`（头像 / 图集）、`LoreWall`（头像）、
`assets.importDocumentAsset`（正文插图）全部改调它。

### 3.3 为什么是入口而不是「发送前」

你最初的描述是发送前转换。入口转码多三个好处，且都不是风格问题：

1. **渲染路径不用碰 HEIC。** 如果 `heic` 进了 `IMAGE_EXTS` 而只在发送前转，
   那么文件树缩略图、`ImagePreview`、正文预览的 `<img>`、导出内嵌的 HTML/PDF
   全都会拿到一个 webview 解不了的文件，**静默渲染成空白**（§1.2 右列七处，
   全走 `imageToDataUrl`）。要么让 WASM 也进渲染路径 —— 那它就从「发送时懒加载」
   变成「打开文件夹就加载」，白省。
2. **不需要 worker。** 一张 12 MP HEIC 在主线程解码是几百 ms 到 1s+ 的卡顿。
   放在导入时，作者本来就在等一个「导入中」；放在发送前，那是每次对话都要
   付一次的、看不出原因的卡。
3. **转一次而不是每次转。** 同一张参考图在一场对话里可能被读五次。

代价是作者盘上多一份 JPEG。可以接受：这个应用的导入本来就是「把东西搬进
工作区」，`docx → md` 也从不保留原件。

### 3.4 `.heic` 不进 `IMAGE_EXTS`

推论：既然入口转过了，项目里就不该存在 `.heic`，`isImagePath` 也就不必认它。
`TRANSCODE_EXTENSIONS` 只出现在**选择器过滤器**和 `importMode` 里。
这条让 §1.1 那张表上的五行全部不用改。

（万一作者在 Finder 里直接把 `.heic` 拷进项目文件夹 —— 那它在文件树里是个
未知类型文件，和今天一样。不为这条边界做补偿：补偿它就等于把 WASM 拉回渲染
路径，回到 §3.3 第 1 条。）

---

## 4. 设置项

`Settings → 通用`，在「实验功能」之上加一节「图片」（`GeneralPane.tsx`，
用 `bits.tsx` 已有的 `Section` / `Row`）：

- **发送给模型的最大长边** — 数字输入，默认 4096，空/0 = 原样发送。
  hint：「超过这个尺寸的图片会在发送前等比缩小，原文件不受影响。」
- pref key `app:imageMaxLongEdge` 加进 `PREF_KEYS`；读取用**调用时读**的
  `imageMaxLongEdge()`，照 [`defaultMaxOutput()`](../../src/lib/ai/modelLimits.ts)
  的先例 —— 每条请求路径都要它，靠参数往下穿的那条迟早会忘。`appStore` 里那份
  同名字段只给输入框绑定，权威在前者，理由与 `defaultMaxOutput` 同。
- **`0` 是一个值，不是空。** 作者清空这个框是在要回改动之前的行为，所以
  「没读到这个 pref」（→ 4096）和「读到 0」（→ 不缩）必须分开处理，两处 clamp
  都写了这条。
- 提交在 **blur** 而不是每次按键：下界是 256，边打边 clamp 的话「4096」的第一个
  字符就变成 256，后面没地方去了。

不加 Beta 开关：这不是一条新能力，是一条已有路径的行为修正，off 的那一半
（12MB 直接拒绝）没有人想要。

---

## 5. 明确不做

1. **HEIC** —— §3.0。是取舍，不是待办。
2. **per-provider 上限表** —— §2.2。
3. **渲染 / 落盘路径降采样** —— §1.2 右列 + §2.7。
4. **动图逐帧处理** —— §2.5。
5. **worker** —— 解码只在「这张图确实超标」时发生，而超标的图本来就少
   （§2.3 的文件头快路径就是为此存在的）。真要卡，卡的是那一张图的发送，
   不是每一次发送。
6. **AVIF** —— 两个 webview 引擎都能原生渲染 AVIF，不需要 WASM；但模型端
   收不收是另一回事，且没人在问。要做的话是往 `IMAGE_EXTS` 加一行 + §2 的
   编码目标 + `imageSize.ts` 一个分支，与本方案正交。
7. **「这次发原图」的单次开关** —— 想清楚它该长在哪（附件 chip 上？工具参数
   上？）之前不做。4096 的默认值已经让它在正常照片上不触发。

---

## 6. PR 切片

| PR | 内容 | 状态 |
| --- | --- | --- |
| **A** | `imageSize.ts` + `downscalePlan.ts` + `normalize.ts` + `imageForModel`，改 §1.2 左列 10 处；`readImageBytes` 收走两个写盘点（§2.7）；四个选择器收回 `IMAGE_EXTENSIONS`（§1.3）；pref + 设置 → 通用 → 图片 + i18n；§2.6 的提示 | **已发** |
| **B** | `ingestImageFile` + `transcode` 处置 + `heic-decode` 懒加载 + 许可证声明 | **不做**（§3.0） |

§1.3 原本排在 B，实现时提到了 A：它与 HEIC 无关，是一条独立成立的收敛。

测试全在两个纯层上 —— `imageSize.test.ts`（四种文件头的偏移量，手搓头部当
fixture）和 `imageDownscale.test.ts`（阶梯、质量先于像素、PNG 无质量档、动图
放行、`longEdge = 0`、give-up 边界、不把边长舍成 0）。canvas 那层照
[`imageToDataUrl.test.ts`](../../src/lib/__tests__/imageToDataUrl.test.ts) 的做法
在调用方 mock 掉：`agentReadTools.test.ts` 和 `imageSession.test.ts` 现在打桩的
是 `imageForModel` 而不是 `imageToDataUrl`。

---

## 7. 验证

单元测试（`imageSize.test.ts` / `imageDownscale.test.ts`）覆盖的是两个纯层。
canvas 那层在 Vite dev server 的真实 webview 里跑过一轮，用 canvas 现编的图当
输入、真的 `planImageStep` 驱动真的编码循环：

| 场景 | 输入 | 阶梯 | 结果 |
| --- | --- | --- | --- |
| 出厂默认（4096 / 12MB） | 6000×4000 JPEG 23.7MB | `4096×2731@0.9` → `as-is` | 4096×2731 7.6MB，达标，1.4s |
| 只压字节（长边关掉，1MB 上限） | 同上 | `@0.9` → `@0.8` → `@0.7` → `×0.75@0.85` | give-up 后交出历史最佳，5.2s |
| PNG（无质量档，1MB 上限） | 3000×2000 PNG 20MB | 2250 → 1688 → 1266 → 950，每轮都缩 | give-up 后交出历史最佳 |

三条都与设计一致。后两条的输入是**随机噪声**（JPEG/PNG 都压不动），是特意构造
的最坏情况 —— 它们证明的是「阶梯走完会体面地放弃」，不是真实照片的表现。

一条值得记下来的观测：**不收敛的那条路是贵的** —— 四次全尺寸编码 5.2 秒。但它
只出现在「作者把长边关掉了、文件又远超字节上限」这个组合里；出厂默认下长边那
一步先把像素砍掉一半，后面几轮都在小图上跑。没有为此加「超太多就直接跳到缩放」
的分支：那要引入一个魔数，而换来的只是一个作者已经显式关掉过一次的路径。

还没验，**只有真机能答**：

- [ ] 一张竖拍的 iPhone 照片（EXIF `Orientation = 6`）缩完是不是正的 ——
      §2.4 是这个方案里唯一没有退路的假设，而它错了不会报错。canvas 现编的图
      没有 EXIF，上面那轮验不到这条。
- [ ] 带透明的 PNG 立绘缩完仍然透明（走 PNG 分支，没有被编成 JPEG 的黑底）。
- [ ] 超大 GIF 原样送出、没有被压成第一帧。

许可证一条已经有答案了 —— §3.0，不接。
