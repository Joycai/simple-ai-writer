# AI 生图 / 改图接入方案（草案 · 基线 v1.3.0）

> **状态：五期全部实施完毕（PR1~PR5，见 §8）**，之后仍有零散修订（如 DashScope
> 原生异步路由）。生图现以 `imagegen` 子代理形态存在——见
> [`subagent-lld.md`](./agent/subagent-lld.md)。
>
> 目标：让写作过程中「需要一张图」这件事留在应用内 —— 由模型读人设/场景/正文
> 自动写出图像提示词，调用生图模型出图，不满意就继续对话改，满意的图落进
> 设定库图集或正文插图。
>
> 适用域不限于小说：`novel` 用它出角色立绘与场景图，`wechat`/`copy` 出配图与
> 封面，`bid`/`weekly` 出示意图 —— 与工作台 profile 一致，靠数据而非分支扩展。

---

## 1. 现状盘点

### 1.1 已经存在的地基

| 已有能力 | 位置 | 对本方案的意义 |
| --- | --- | --- |
| `ModelType` 含 `"image" \| "video"` | `lib/ai/configDb.ts:11` | 模型表与设置 UI 已能登记生图模型 —— **目前无任何代码消费，是死配置** |
| 「图 → 文」描述器 | `lib/lore/vision.ts` | 反向链路已通；生成的新图可复用它自动写描述 |
| 多模态消息协议 `ContentPart.image_url` | `lib/ai/types.ts:14` | 图片进 prompt 的表示法已定，改图请求可直接复用 |
| 图集存储 `images.md` + `addLoreImage` / `setEntityAvatar` | `lib/lore/gallery.ts` | 落盘与索引现成，PR1 不需要新存储格式 |
| 请求走 Rust reqwest | `lib/http.ts` | 无 webview CORS 限制，可直连各家图像端点 |
| 预览自动把相对路径 `<img>` 内联成 data URL | `components/editor/Preview.tsx:27` | 正文里的 `![](assets/x.png)` 无需额外工作即可渲染 |
| 结构化输出（强制 tool_choice + JSON 兜底） | `lib/agent/structured.ts` | 提示词生成直接复用，无需新引擎 |
| 角色化模型选择先例 `memoryModelId` | `stores/aiStore.ts` | `imageModelId` 照抄这一模式即可 |

### 1.2 缺的部件

1. **图像客户端** —— `streamCompletion` 是纯文本 SSE 链路，生图是一次性
   JSON + base64（甚至 multipart），塞不进去，需要平级的兄弟入口。
2. **Gemini 侧的 contents 装配**要与流式适配器共用（`convertToGeminiContents`
   已经会把 `image_url` 转成 `inline_data`），避免两份实现各自漂移。
3. **提示词生成** —— 从设定/正文到图像提示词的那一步任务。
4. **会话式改图** —— 「当前图」的会话状态，以及生成/编辑的分派。
5. **按张计价** —— `costFor()` 与 `token_usage` 全是 token 口径。
6. **正文插图落盘** —— 图集之外的第二个落点（`writing/assets/`）。

---

## 2. 协议层设计

### 2.1 统一接口

新增 `src/lib/ai/image.ts`，与 `streamCompletion` 平级：

```ts
export interface ImageRequest {
  prompt: string;
  /** 参考图 / 待编辑图（data URL）。非空即「编辑」语义。 */
  images?: string[];
  /** 编辑遮罩，仅 OpenAI 支持；其余 provider 忽略。 */
  mask?: string;
  n?: number;              // 出图张数，默认 1
  size?: string;           // "1024x1024" | "1536x1024" | …，provider 能力不同
  /** provider 专有参数的逃生口（对齐 StreamOptions.extraBody 的既有约定）。 */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ImageResult {
  images: { dataUrl: string; mime: string }[];
  /** 模型附带的文字说明（Gemini 会同时返回文本 part）。 */
  text?: string;
  /** 部分 provider 会报 token 用量（OpenAI 图像模型按 token 计费）。 */
  usage?: { inputTokens: number; outputTokens: number };
}

export async function generateImage(
  conn: ProviderConn, req: ImageRequest,
): Promise<ImageResult>;
```

`ProviderConn` 即现有各处重复解构的 `{ baseUrl, apiKey, standard, modelId,
safetySettings }`，顺手提成具名类型（`aiTaskStore`/`LoreDetail`/`vision.ts`
现在都在手抄这五个字段）。

**不拆 `generateImage` / `editImage` 两个函数**：三家的编辑都是「同一端点 +
带图输入」，拆开会让调用方去分派 provider 差异。`images` 是否为空即语义。

### 2.2 三个 adapter

| 协议 | 端点与形状 | 编辑支持 |
| --- | --- | --- |
| `openai` / `openai_compat` | 生成 `POST /v1/images/generations`（JSON）；编辑 `POST /v1/images/edits`（**multipart**，字段 `image[]`/`mask`/`prompt`）。响应 `data[].b64_json`，部分实现返回 `data[].url` | 有（官方端点）；中转与 xAI 常缺 |
| `gemini` | 生成与编辑同为 `POST /v1beta/models/{id}:generateContent`，`generationConfig.responseModalities: ["TEXT","IMAGE"]`；输入图走 `contents[].parts[].inline_data`。响应在 `candidates[0].content.parts[].inlineData` | 有，且**天然多轮**——把历史整段回灌 `contents` 即可 |
| xAI（走 `openai_compat`） | `POST /v1/images/generations`，OpenAI 形状；无 size/quality 参数，`response_format` 支持 `url`/`b64_json` | 目前**无编辑端点** → 降级 |

三点实现注意：

- **`url` 响应要落地成字节**。`response_format` 能指定就指定 `b64_json`；不能
  的（xAI 默认 url、多数中转）就用 `lib/http.ts` 的 fetch 取回 `arrayBuffer()`
  ——这些链接普遍是短时效签名 URL，不能写进 `images.md` 当引用。
- **multipart 已验证可发**（见 §2.3）。仓库里目前零处 `FormData`，但
  `@tauri-apps/plugin-http` 的传输链路能原样承载它。唯一约束：**发 multipart
  时不得手动设置 `Content-Type`**。
- **Gemini adapter 改动最小但必须做**：`gemini.ts` 的 part 循环补一条
  `inlineData` 分支。生图走非流式 `generateContent`，不复用 `streamGemini`，
  但两者共享 `convertToGeminiContents`（它已经会把 `image_url` 转成
  `inline_data`），把该函数导出即可。

### 2.3 multipart 可行性验证（已完成 · plugin-http 2.5.9）

结论：**可以发**，无需手工拼 boundary。

链路上三层各自的行为：

1. **JS 侧** `plugin-http/dist-js/index.js:66-75` 自己不序列化 body —— 它
   `new Request(input, init)` 交给 webview 序列化，`arrayBuffer()` 取字节，
   再把浏览器生成的 header 复制进去（**仅当调用方没声明同名 header**）。
2. **WebView2（Chromium）实测**：FormData 正确序列化为 multipart，
   `Content-Type` 自动带 boundary，`filename` 保留，中文字段 UTF-8 未损，
   二进制部分逐字节比对完整。
3. **Rust 侧** `tauri-plugin-http/src/commands.rs`：`data: Option<Vec<u8>>` →
   `request.body(data)` 原样透传；header 除 `is_unsafe_header` 那张 forbidden
   列表外照发，而 **`content-type` 不在列表里**，boundary 能活到 reqwest。

> **实现约束**：发 multipart 时 adapter **绝不能手动设 `Content-Type`**。
> 一旦调用方声明了，上面第 1 步的复制循环会跳过浏览器生成的那个，boundary
> 丢失，服务端必然解析失败。`lib/http.ts` 包装层本身是安全的（只改 Origin）。

**顺带测得的 IPC 开销**：plugin-http 把 body 转成 JSON 数字数组过桥
（`Array.from(new Uint8Array(buffer))`），1 MB 图片 → 3.57 MB 载荷、约 50 ms
JS 耗时。这反而支持选 multipart：同一张图走 base64-in-JSON 先膨胀到
1.37 MB，再按同样规则过桥约 4.9 MB —— **multipart 是更省的那条路**。
§4.2「结果即时落盘、store 只存路径」的约束也由此而来。

### 2.4 能力声明与降级

不做在线探测（图像请求太贵，探一次就是一次出图费用）。改为：

- `models` 表加 `caps` 列（JSON），生图模型登记 `{ edit: boolean, sizes?: string[], maxRefs?: number }`；
- 默认值按 `apiStandard` 猜（gemini → 支持编辑；openai → 支持；openai_compat → 否），设置里给作者一个复选框覆盖；
- 运行期兜底：编辑请求失败且错误可归类为「端点不存在/不支持」时，自动降级为
  **带累积指令的重新生成**（原提示词 + 历次修改指令合并），并在执行日志里明说
  「该模型不支持编辑，已改为重新生成」。降级要可见，否则作者会以为模型没听懂。

---

## 3. 提示词生成

新增 `src/lib/image/promptGen.ts`，基于 `runStructuredTask`（强制 tool_choice
+ JSON 兜底，已在 lore 侧验证过）：

```ts
// 输出 schema（即伪工具的 parameters）
{
  prompt: string;        // 主提示词
  negative?: string;     // 负面提示词（支持的模型才用）
  style?: string;        // 画风描述，独立字段便于作者单独换风格
  aspect?: "1:1" | "3:4" | "4:3" | "16:9" | "9:16";
  note: string;          // 给作者看的中文说明：这张图打算画什么
}
```

上下文来源分两类，都复用现有装配：

- **设定类**（角色立绘/场景图）：实体 `index.md` + 勾选的特征文件；已有图集
  图片的描述作为「保持一致」的参考（这正是 `vision.ts` 写的描述的用武之地）。
- **正文类**（配图/封面）：编辑器选区 + `assembleContext()` 出的 RAG bundle。

两条 profile 约定：

- 提示词指令走 `ai.instructions.imagePrompt*`，措辞域中立，`novel` 用
  `imagePromptNovel` 覆盖（与现有 continue/rewrite 的处理完全一致）；
- 文案里的「立绘/配图/示意图」由 `useTerms()` 供词，**不要在组件里硬编码**。

**提示词语言**：默认跟随 UI 语言，设置里给「提示词语言：跟随 / 中文 /
English」三档。多数模型现在吃中文没问题，但画风类 token（cinematic lighting、
watercolor…）英文更稳；`note` 字段始终用 UI 语言，保证作者看得懂自己在发什么。

---

## 4. 会话式改图

### 4.1 分派：交给模型，不写分类器

不新增「判断这句话是生成还是编辑」的分类逻辑。会话式改图接进已有的 agent
runtime，注册两个工具：

| 工具 | access | 行为 |
| --- | --- | --- |
| `generate_image` | `write-approval` | 新出一张图 |
| `edit_image` | `write-approval` | 基于会话中的当前图修改 |

模型自己按上下文选 —— 这正是 `registry.ts` 既有的模式，也天然解决了「上一张
图是哪张」（工具参数里带 `sourceImage` 引用）。

选 `write-approval` 而非 `write-auto`：生图既花钱又写盘，`ApprovalCard` 已经
是现成的阻塞式审批通道。卡片上摆最终提示词 + 张数 + 预估费用，批准才发请求。
作者若嫌烦，设置里可给「信任生图工具」开关跳过审批（不做在 PR1）。

### 4.2 会话状态

新增 `stores/imageStore.ts`（或并入 `agentStore` 的会话，见 §7 取舍）持有：

```
session: { id, target: LoreTarget | DocTarget, turns: ImageTurn[] }
ImageTurn = { prompt, instruction?, parentId?, results: dataUrl[], chosen?: number }
```

改图链是一棵树而不是一条线（作者常从第 2 轮的图分叉再改），`parentId` 保留
这一点。Provider 差异在这里抹平：

- Gemini：把 `turns` 整链回灌 `contents`，模型看得见完整修改历史；
- OpenAI：无状态，取 `chosen` 那张作为 `images[0]` + 本轮 `instruction`；
- 不支持编辑的：合并历次 `instruction` 重新生成（§2.4 的降级）。

**内存**：base64 大图不进持久 store。每轮结果先写临时文件，store 只留路径，
渲染复用 `useImageDataUrl`。否则十几轮下来 Zustand 里躺着几十 MB base64。

---

## 5. 落盘与引用

| 场景 | 落点 | 引用方式 |
| --- | --- | --- |
| 设定实体图 | 实体目录，走 `addLoreImage()` | `images.md` 条目（已有格式，不改） |
| 实体头像 | `avatar.<ext>`，走 `setEntityAvatar()` | 扫描器自动识别（已有） |
| 正文插图 | `writing/assets/<文档名>/<slug>.png` | 相对路径 `![note](assets/…/x.png)`，预览已能内联 |

**入库即描述**：图落进图集后自动调 `describeLoreImage()` 写描述。生成提示词
不能替代描述 —— 提示词是「我要什么」，描述是「实际画出了什么」，且纯文本模型
后续读实体时只看得见后者。这一步让生成的图立刻对写作链路可见。

**生成记录** `.ai-writer/imagegen.json`：每张生成图记 `{ path, prompt, style,
model, params, parentPath, createdAt, costUsd }`。理由有三：改图链在重开应用后
还能续；作者能回看「这张当初怎么出来的」；费用有据可查。它是旁路日志，
`images.md` 格式一个字不动。

---

## 6. 计费与用量

- `models` 表加 `price_per_image REAL`（沿用 `configDb.ts` 既有的
  `PRAGMA table_info` + `ALTER TABLE` 迁移写法）。
- `token_usage` **不改表结构**：一次生图写一行，`task = "image-gen"` /
  `"image-edit"`，`cost_usd = pricePerImage × n`；provider 若报了 token 用量
  （OpenAI 图像模型是 token 计费）就照实填 `prompt_tokens`/`completion_tokens`，
  否则填 0。
- `costFor()` 保持 token 语义不变，另开 `imageCostFor(model, n, usage?)`：
  两种计费口径混进一个函数只会让两边都不对。

---

## 7. 一个需要先定的取舍

**改图会话放哪儿。** 两个选项：

- **(A) 独立 `imageStore` + 独立模态框** —— 图像会话与文字会话互不干扰，
  PR1 能独立交付，但作者在对话助手里说「给这个角色画张图」不会有反应。
- **(B) 直接并进 `agentStore` 的对话会话** —— 一个助手什么都能干，符合
  `unified-agent-plan.md` 第二阶段的方向，但要先解决对话消息里渲染图片、
  以及图像轮次不进文字上下文预算这两件事。

**建议 A 起步、B 收口**：PR1–PR3 走 A（图集/正文两个入口各自的模态框，共享
`imageStore`），PR4 把 `generate_image` / `edit_image` 注册进
`AGENT_ASSIST_PRESET`，会话状态仍由 `imageStore` 持有，`agentStore` 只在消息
流里插一个「图片卡片」引用它。这样 B 不需要重写 A。

---

## 8. 分阶段实施

### PR1 · 打通一条最短链路（设定立绘）— ✅ 已实现

- ~~验证 multipart 传输可行性~~ —— 结论见 §2.3：可发，约束是不得手动设
  `Content-Type`
- `lib/ai/image.ts`：`generateImage()` + OpenAI/兼容、Gemini 两条 adapter
  （xAI 走 OpenAI 形状）。**仅生成**，传 `images` 会显式报错而不是静默忽略
- `gemini.ts` 导出 `convertToGeminiContents` / `DEFAULT_GEMINI_BASE` 供其复用。
  流式适配器的 `inlineData` 分支**未做也不需要**：生图走非流式
  `generateContent`，不经过 `streamGemini`，加一个 `StreamChunk` 图片变体会
  波及每一个文本消费方却没有消费者
- `models` 表加 `price_per_image` / `caps`（+ `defaultImageCaps()` 按协议猜
  默认值）；`imageCostFor()` 与 token 计费的 `costFor()` 并列
- 设置 → 模型：type=image 时显示每张价格 / 支持尺寸 / 支持编辑，并**隐藏**
  上下文窗口、最大输出、端点探测、前置提示词这些 token 形状的字段
- `aiStore.imageModelId`（照 `memoryModelId`，含删除模型/供应商时的清理）
- `lib/image/`：`promptGen.ts`（结构化输出）、`sizeForAspect()`、
  `recordImageUsage()`；i18n `ai.instructions.imagePrompt`（中英）
- `fs/images.ts` 加 `dataUrlToBytes()`（`imageToDataUrl` 的逆运算）
- `components/lore/ai/LoreImageGenModal.tsx` + 图集头部的「AI 生成」入口：
  起草提示词 → 可编辑 → 出图（上限 4 张）→ 选一张入库/设为头像 →
  自动跑 `describeLoreImage` 写描述
- 用量写 `token_usage`（`task = "image-gen"`）

**验收**：在设定库里给一个角色出一张立绘，落进图集并带自动描述，费用可查。
自动化覆盖：`imageClient.test.ts`（三种响应形状 + size 参数取舍 + 安全拦截）、
`imageDomain.test.ts`（尺寸匹配、两种计费、data URL 解码）。

PR1 刻意留给 PR2 的：`ImageRequest.images`（占位，调用即报错）、
`ImageCaps.edit`（已可配置、已有默认值，但还没有消费方）、
`.ai-writer/imagegen.json` 生成记录、`imageStore` 会话。

### PR2 · 改图 — ✅ 已实现

- `ImageRequest.images` / `mask` 与三条路径的编辑实现：Gemini 与对话接口是
  「同一端点 + 附带输入图」，OpenAI 协议是**换 URL 换编码**
  （`/images/edits` + multipart，单图 `image`、多图 `image[]`）
- 降级分两层：`caps.edit === false` 时**不浪费一次调用**直接重新生成；
  运行期失败经 `isEditUnsupportedError()` 归类后再降级。两种情况都在轮次上
  标记 `degraded` 并在界面明说，否则作者会以为模型没听懂
- 降级用的提示词是**原始 brief + 历次全部指令**，不是最后一条 —— 只带最后
  一条会丢掉前面几轮攒下来的方向
- `stores/imageStore.ts` 会话：改图链是**树不是线**（作者常回退两轮换个方向
  再分叉），每个轮次记 `parentId` 与起始候选图
- `lib/image/session.ts`：候选图即时落 `.ai-writer/tmp/imagegen/<session>/`，
  store 只存路径（§4.2 的内存约束）；`.ai-writer/imagegen.json` 记录留下来的
  图是怎么来的；开新会话时清扫上次崩溃遗留的临时目录
- 模态框：候选图网格 + 对话输入框 + 轮次历史（点回早先轮次即分叉）

**PR1 的占位全部兑现**：`ImageRequest.images` 从「调用即报错」变成三条真实
路径，`ImageCaps.edit` 从「可配置但无消费方」变成降级开关。

### PR3 · 正文插图 — ✅ 已实现

- **弹窗抽成 target 驱动**（`lib/image/target.ts` + `components/ai/ImageGenModal.tsx`）：
  素材从哪来、参考哪些已有图、存到哪去，由 `ImageGenTarget` 描述。
  `LoreImageGenModal` 与 `DocImageGenModal` 各自只组装一个 target，弹窗本身
  不知道 lore 实体或文档存在 —— 这正是「靠数据而非分支扩展」在 UI 层的落法
- `lib/image/assets.ts`：图存到文档旁的 `assets/<文档名>/`，**返回相对路径**
  （绝对路径一换机器就全断），文件名过滤掉能创建目录的字符；插入的 markdown
  自成一段（贴着正文会渲染成行内图）
- 编辑器右键菜单加「AI 配图…」，紧挨 `insertLink`（同为「在光标处插入新东西」，
  而非「重排已有内容」）。没有配置生图模型时不显示该项
- 素材取选区；没有选区就取光标前后各一段，而不是整篇 —— 用两万字生成的
  brief 描述的是整本书，不是此刻这一幕
- **`export.ts` 图片内联**：把相对 `<img src>` 换成 data URL。判断逻辑
  （`needsInlining` / `assetPathFor`）抽成纯函数以便测试，DOM 遍历本身留在
  浏览器环境
- 「插入{{doc}}」走 `useTerms()`，标书项目不会被告知图片插进了「章节」

**遗留发现**：`lib/fs/export.ts` 与 `editor.export*` 文案俱在，但**全项目没有
任何 UI 调用它** —— 导出功能尚未接线。图片内联因此是「接线那天就正确」，
而不是修好了一个用户当下能碰到的 bug。

### PR4 · 接进统一 agent — ✅ 已实现

- `generate_image` / `edit_image` 注册为 **L2（write-approval）** 工具，挂进
  `AGENT_ASSIST_PRESET`（对话助手 + AiPanel Agent 模式；lore 模态框与批量运行
  没有审批通道，工具在那里直接拒绝而不是无人看管地花钱）
- **批准即出图，而不是先出图再问要不要留**。`IllustrateProposal` 带着提示词、
  目的地、模型与预估价进审批队列，`applyProposal` 才真正调用 provider ——
  被拒的提案花费为零。这是本 PR 与其他几种提案最大的不同：别的只是搬文字，
  这个一按就是钱
- `ApprovalCard` 的 illustrate 分支：提示词占主位（它才是被批准的东西），
  头部指标显示预估费用，改图时**显示原图**——「把头发改成银白」这句话，
  看不到是谁的头发就没法审
- `edit_image` 结果**另存为新图**，绝不覆盖原图（原图可能已被别处引用）
- 降级逻辑与交互式会话共用：声明不支持编辑就不浪费调用，运行期失败经
  `isEditUnsupportedError()` 归类后重新生成，并在回给模型的结果里明说，
  让它转告作者
- `ai.instructions.agent` 增补配图段落：提示词只写画面里看得见的东西、
  不要写人物名字、动笔前先读条目

**PR4 判断失误、后续补上的**：对话消息流里的图片缩略图。

当时的理由是「图存进图集/assets 后立刻可见，日志里也有文件名」，据此判断不值得
为它给执行日志的事件加字段。**实测这个理由不成立**：应用什么都不显示，而助手
手上唯一的证据是工具返回的一句 `Saved to …`——从那句话推不出「图已经在作者眼
前了」，于是它老老实实道歉说自己无法把图发到聊天窗口。

补法不是给执行日志加缩略图，而是让 `ChatTurn` 带上 `images`，**由审批填、不由
模型说**：哪个文件刚被写出来是应用知道的事实，让模型去描述等于猜一件已知的事。
同时给工具结果加一句「这张图已经展示给作者了」——两个毛病必须一起修，只修显示
助手还会继续道歉，只修提示词它会说「图在下面」而下面什么都没有。

---

### PR5 · DashScope 原生 route（千问/万相出图）— ✅ 已实现

qwen-image / wan / z-image 系列不走 DashScope 的 compatible-mode——出图只有
原生 `/api/v1` 协议（`input.messages` + `parameters` 两段式，协议事实见
`docs/api/landscape.md` §7）。body 形状与 OpenAI images API 完全不同，按
`provider-layering.md` §4 的标准配得上第四个 `ImageRoute` 值：`"dashscope"`。

三个决策及理由：

- **原生 base 从既有供应商行推导，不要求建第二个供应商。**
  `dashscopeNativeBase()` 剥掉 base URL 尾部的 `/compatible-mode/v1` 再拼
  `/api/v1`——同一行、同一个 keyring 密钥同时服务文本与出图，国内/intl 域名
  都成立；已是原生地址或裸 host 的输入原样通过。
- **同步/异步是声明的能力（`ImageCaps.asyncTask`），不是 model-id 嗅探。**
  wan2.7 的文生图只有异步任务接口（提交带 `X-DashScope-Async: enable`，轮询
  `GET /tasks/{id}`，~3s 起步、10 次后放缓到 5s，整个任务 600s 封顶，轮询的
  瞬时失败连续 3 次才算真错）；qwen-image\*、qwen-image-edit\*、z-image-turbo
  与 wan 改图都是同步。哪条路由对，作者在 ModelDrawer 勾选，猜错会收到
  DashScope 自己的明确报错——与 caps 体系「声明而非探测」的既有规则一致。
  任务 id 在提交后立刻记进 API 日志（`ImageCallLogger.note`），轮询挂死时
  不至于无从查起。
- **`extraBody` 并进 `parameters` 而非顶层。** 那里才是 DashScope 的旋钮
  命名空间（`negative_prompt`/`watermark`/`seed`/`prompt_extend`…）；顶层
  只有 `model` 和 `input`。v1 不给这些旋钮做配置 UI（layering §5 的长尾
  原则），负面描述继续折进 prose。

配套小改动：`sizeForAspect` 的尺寸分隔符放宽为 `x`/`*`/`×`（DashScope 写作
`宽*高`），route 内把作者写的 `1024x1024` 归一成 `1024*1024` 再上线；
`parseErrorBody` 补读顶层 `{code, message}`——`DataInspectionFailed` 这类
内容审核拒绝因此带上结构化 code，不会被 `isEditUnsupportedError` 的 prose
正则误读成「端点不能编辑」而触发第二次计费的降级重生成。生成的图片 URL
24 小时过期，`urlToDataUrl` 当场下载落盘（既有行为，正好覆盖）。

**PR5 上线后发现、随即补上的：图片静默不显示（第一轮诊断，结论后被推翻，见其后一段）。** 现象：wan2.7 生成的
图片在对话历史里就是个空白框，永远不变。用真实用户的调试日志 + 磁盘文件核实
（`file`/`xxd` 看 magic bytes，直接 `Read` 打开图片看内容）排除了协议层——
API 日志显示这次调用 200 成功、返回 1 张图；磁盘上那张 2048×2048 PNG 完整
有效、内容正确，是这个工作区迄今生成过的最大图片（5.5MB，比这之前项目里任何
一张图都大一个数量级）。问题在纯前端：聊天记录的缩略图是 148px 的 CSS 盒子，
但渲染用的是 `useImageDataUrls` 读回的**原始分辨率** data URL——把 5.5MB
搬进 `<img src="data:...">` 至少浪费内存，WebKit 对超大 `data:` URI 还有一个
真实的解码上限，超过了就是**渲染不出来、不报任何错**（`.catch(()=>{})` 恰好
把唯一的线索也吞了）。对策不是去猜 WebKit 的具体阈值，而是从根上不发这么大的
payload：新增 `imageToThumbnailDataUrl`（`lib/fs/images.ts`）用 `<canvas>`
在编码前先按目标尺寸降采样，配套 hook `useImageThumbnails`（保留
`useImageDataUrls`/`useImageDataUrl` 给需要看清像素本身的场景，如审批卡片的
改图原图、lore 封面）。聊天缩略图（`AgentChat.tsx`）与生图候选格
（`ImageGenModal.tsx`）都切过去；点击缩略图仍然打开磁盘上的原图，选中候选也
仍从文件路径而非缩略图 data URL 落盘，降采样只影响预览。三个 hook 的
`.catch()` 都补上 `console.warn`——静默失败必须至少在控制台可查，这条本可以
更快定位。

**真正的原因（第二轮，实证）：`tauri-plugin-fs` 的 glob scope 不让通配符匹配
`.ai-writer`。** 上一段的 WebKit 解码上限是一个**没有被验证过的猜测**，而且是
错的：那次读取根本没拿到过字节。真相在下一轮暴露——生图工作台把候选写进
`.ai-writer/tmp/imagegen/…` 再读回时，报错终于走到了 UI 上：
`forbidden path: …/.ai-writer/tmp/imagegen/K0Jx79il/DtVwe2-0.png`。

链路是这样的（逐层查 crate 源码 + 一个 `glob` 最小复现确认，非推测）：

1. 前端的二进制图片读取（`imageToDataUrl` / `imageToThumbnailDataUrl` /
   `fileio.readBinaryFile`）走的是 **`tauri-plugin-fs`**，它有一套**独立于**
   `src-tauri/src/scope.rs` 那个 `FsScope` 的 scope——项目里同时存在两套路径
   校验，而且语义不同。
2. 打开项目时 `allow_for_plugin_fs` 调 `allow_directory(root, recursive)`，
   插件侧落成 glob：`<root>` 和 `<root>/**`。
3. 这个 **runtime scope 是用 `FsScope::default()` 构造的**
   （`tauri-plugin-fs/src/lib.rs` 的 `setup`），于是 unix 下取
   `require_literal_leading_dot: true`。`tauri.conf.json` 里的
   `requireLiteralLeadingDot` 开关**救不了它**——那个值只流进 `resolve_path`
   里按 capability 静态条目临时构造的另一个 scope。
4. glob 在该选项下**拒绝让 `*`/`**` 匹配以点开头的路径段**：
   `<root>/**` 匹配 `<root>/writing/ch1.md`，但不匹配
   `<root>/.ai-writer/任何东西`。

也就是说：**macOS / Linux 上，`.ai-writer/` 下的每一张图片，经插件读都是
`forbidden path`**——lore 图集与头像、对话历史里的插图、生图候选，全都在里面。
文档正文不受影响，因为那些走的是自己的 `fs_*` 命令（`FsScope` 没有点目录特例）。
之所以拖到现在才现形，是因为图片读取的失败一路被 `.catch()` 吞掉，只留一个空
白框；生图工作台是第一个把这个错误显示出来的地方。

修法在 `allow_for_plugin_fs`：在授予 `<root>` 之外，**再显式授予
`<root>/.ai-writer`**——点目录在 pattern 里字面写出来，leading-dot 规则就不再
生效，其后的 `**` 正常展开。上一轮的降采样不是白做（148px 的格子本来也不该内联
5.5MB 原图，省内存），但它当时并没有修好那个 bug；这一条才是。

教训有两条，都比这个具体 bug 更值钱：**同一个进程里维护两套路径 scope，就要
预期它们的语义会分叉**（真正的收口做法是让项目内的二进制读取也走自己的
`fs_*` 命令，只把对话框选中的项目外文件留给插件）；以及**猜测型根因必须标注为
猜测**——上一段如果当时写成「WebKit 上限（未验证）」，第二轮就不会从零开始。

### PR6 · 参数方言（nanoBanana / GPT Image 2）与生成参考图 — ✅ 已实现

此前的参数模型是为 Gemini 设计的：画幅固定 5 选 1（`IMAGE_ASPECTS`）+
自由文本 `caps.sizes` 列表。GPT-Image 系模型在这个模型里没法被正确描述——
它没有 aspect 参数、size 有自己的整除与比例规则、还有一根 quality 轴。
解法是**参数方言**（对 2026-08 官方文档校准，协议事实收在
`docs/api/landscape.md` → 出图参数的两套方言）：

- `lib/ai/imageDialects.ts` 是方言表：每个方言声明画幅候选、分辨率档位、
  质量档位，以及把作者选择翻成 wire 字段的 `params()`。现有两个方言：
  - **nanobanana**：十档画幅 + `imageSize` `1K/2K/4K`（默认档发空——
    gemini-2.5-flash-image 没有该参数，省略是人人都收的请求）；
  - **gpt-image-2**：同十档画幅（都在 1:3~3:1 内），`size` 由
    `gptImageSize()` 按档位算出（短边 1024/1440/2160，两边取整到 16 的
    倍数，长边 3840 封顶时缩短边保比例；1K 档恰好复现三个官方预设，
    2K/4K 档在 16:9 恰好落在 2560x1440 / 3840x2160 两个文档上限），
    另有 `quality` `low/medium/high`。**编辑请求不带 size**
    （`omitSizeOnEdit`——/images/edits 文档只列预设值，且编辑默认跟随
    原图画幅）。
- `ImageCaps.dialect` 声明（ModelDrawer 下拉：通用 / Nano Banana /
  GPT Image 2）。选了方言就隐藏自由文本尺寸框——方言自己知道尺寸；
  「通用」完全保留旧行为，已有配置零迁移。
- `ImageRequest` 增加 `imageSize`（gemini route 并进 `imageConfig`）与
  `quality`（openai 两个端点都发）；chat route 把 imageSize 折进 prose，
  与 aspect/size 同理。
- 统一入口 `imageRequestParams(caps, sel)`（`lib/image/index.ts`）：
  有方言走方言表，没有走旧的 explicit size → sizeForAspect 链。
  弹窗、agent 审批（illustrate.ts）、会话 store 三个调用方共用。

**同期：`generate_image` 支持参考图。** 工具新增 `references[]`——
工作区路径或图库文件名皆可（裸文件名先在目标实体图库找，再全库唯一匹配，
歧义即报错让模型给全路径）。参考图作为输入图与提示词一起发
（`IllustrateProposal.refPaths`，与 `sourcePath` 走同一条 image-conditioned
通道和同一个 `caps.edit` 门），审批卡片上显示缩略图——靠参考图的提示词
只有摆在参考图旁边才审得了。声明不收输入图的模型（`caps.edit === false`）
在提案前就报错，`caps.maxRefs` 超限同理——都不花一次调用去证明。

## 9. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| ~~multipart body 在 tauri http 插件里不可用~~ | —— | **已排除**（§2.3）。残留约束：adapter 不得手动设 `Content-Type` |
| 中转站不代理 `/images` 端点或改了形状 | 作者配好模型却一直 404/500 | 错误信息明确区分「端点不存在」与「模型拒绝」，并提示改用直连 provider |
| xAI 无编辑端点 | 「Grok Imagine 能改图」的预期落空 | 能力声明 + 可见降级（§2.4）；UI 不得默认三家都能改 |
| 安全过滤拦截 | 小说场景（战斗/黑暗向）出图被拒 | `IMAGE_SAFETY` 已在 `GEMINI_BLOCKED_FINISH_REASONS` 里；错误文案要说清是被过滤而非失败，并建议换 provider |
| base64 大图撑爆内存 | 多轮改图后卡顿 | 结果即时落临时文件，store 只存路径（§4.2） |
| 出图费用失控 | 一次误点烧掉几十次调用 | 张数上限（默认 1，最大 4）+ 审批卡片前置显示预估费用 |
| 模型 id 命名随平台变动 | 硬编码模型名很快过时 | 全程不硬编码：模型 id 由作者在设置里填，能力由 `caps` 声明 |
| **`tauri-plugin-fs` 的 glob scope 不匹配 `.ai-writer`**（2026-08 发现，见 §8 第二轮诊断） | unix 上 `.ai-writer/` 下所有图片经插件读一律 `forbidden path`——lore 图集/头像、对话插图、生图候选全部空白；文档正文不受影响，掩盖了问题 | `allow_for_plugin_fs` 额外显式授予 `<root>/.ai-writer`（点段字面写出，绕开 `require_literal_leading_dot`）；根治方向是项目内二进制读取收回自己的 `fs_*` 命令 |
| 超大图作为缩略图的完整 data URL 塞进 `<img src>` | 148px 的格子内联 5.5MB 原图，纯属浪费内存（**注**：曾被误判为上一行那个 bug 的成因，见 §8） | 小尺寸展示位改用 `useImageThumbnails`（`imageToThumbnailDataUrl`：`<canvas>` 降采样后再编码）；读取失败额外 `console.warn`，不再纯静默 |

## 10. 明确不做

- 视频生成（`ModelType.video` 继续留空）—— 时长/轮询/体积是另一套问题；
- 图像放大 / 局部重绘遮罩编辑器 —— 遮罩参数留在协议里，UI 不做；
- 本地模型（SD/ComfyUI）—— 形状差异大，等上面三家的抽象稳定后再说；
- 图片版本管理与 diff —— `imagegen.json` 只记录，不做回滚 UI。
