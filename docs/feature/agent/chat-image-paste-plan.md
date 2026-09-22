# 助手输入框贴图：会话暂存 + 像素租期

> **状态：`planned`。** 已定方案，未实现。§5 的「租期」数值（N=1）是建议值，
> 作者拍板后再动手；其余各节没有悬而未决的分叉。
>
> 一句话：**贴进来的图落成会话暂存区里的一个真文件，于是它就是一个 `@` 附图**——
> 现有的整条管线（降采样、每条消息的张数与字节上限、历史里的淘汰、存档时去图、
> 对话气泡里的缩略图）原样接住它。新增的只有三件事：粘贴入口、暂存区的生与死、
> 以及让「图从上下文里退场之后模型还找得回它」的那一行路径。

---

## 1. 现状：比想象的多

动手前先盘点，因为作者担心的「不能永远呆在上下文里」**有一半已经做了**：

| 已有 | 在哪 | 对贴图意味着什么 |
| --- | --- | --- |
| `@` 附图：`AttachedImage { file:{name,path}, dataUrl, downscaled }` | `lib/lore/aiTask.ts` `attachProjectFile` → `imageForModel` | 贴图只要变成一个有 `path` 的文件，就能走这条路，超 4096 长边 / 12 MB 自动缩 |
| 每条消息的上限：张数 `MAX_MESSAGE_IMAGES = 4`，合计 24 MiB | `lib/agent/chatRefs.ts` · `lib/ai/imagePart.ts` | 发不下的按路径列给模型，不静默丢 |
| 历史里只留最新 **3 条**带图消息，其余去图留字 | `runtime.ts` `elideOldImageResults`（`MAX_IMAGE_RESULTS`） | 图**已经不是**永驻的；但单位是「消息」不是「轮」，见 §5.1 |
| 合计超 24 MiB 从最老的去图；进行中的一轮与最新一条不动 | `runtime.ts` `elideImagesOverBudget` | 同上 |
| 超窗口时图与工具结果一起被裁 | `trimHistory` | 同上 |
| 存档时**所有**图去掉，只留文字 | `chatSession.ts` `DROPPED_IMAGE` | 重启后的会话里没有像素，只有「附过图」这件事 |
| 气泡里的缩略图靠 `turns[].images`（路径）从盘上现读 | `agentStore.sendChatTo` → `AgentChat` | 文件活着，缩略图就活着，重启也在 |
| `read_image` 能读项目内任意图片路径，含 `.ai-writer/tmp/` | `tools.ts`（`isPathWithin(projectPath)`）；`.ai-writer/tmp/convert/` 的抽图已经这样被读 | **被淘汰的图可以按路径再读一次**——这是 §5 整个机制的支点 |
| `.ai-writer/tmp/` 不进项目备份 | `lib/fs/projectBackup.ts` | 暂存区放这里，天然不备份、不同步 |

缺的：

1. 没有任何 `onPaste` / `clipboardData` 处理——输入框只认文字。
2. 图必须先是项目里的文件才能 `@`。截图、网页上复制的图、别的应用里复制的图，得先
   存盘、拷进项目、再 `@`，三步换一次 ⌘V。
3. 【附图】块只写了文件名（`1. foo.png`），没写路径。图被淘汰后，留下的文字里
   **没有能拿去 `read_image` 的东西**——`ELIDED_IMAGE` 说「再读一次」，但没说读哪。
   对 `@` 的图这只是不便（模型还能 `list_files` 找），对暂存区里的图是死路：
   `.ai-writer/` 不在 `list_files` 里。

---

## 2. 不变量

后面每一节都是这五条的展开。

1. **贴图 = 文件。** 粘贴的那一刻字节就落盘，之后应用里流动的只有路径。不存在
   「只活在内存里的附件」这第二种东西——否则 `turns[].images`、存档、回退、
   `read_image`、看图子代理每一处都要学会两种形状。
2. **暂存区归会话所有，随会话死。** 不进备份、不进同步、不进 `list_files` /
   `search_text`、写工具够不着（`isWorkspacePath` 本来就拒 `.ai-writer/`）。
3. **像素是租的，路径是留下的。** 图在上下文里有租期，到期只去像素；留下的文字里
   永远带着路径，模型需要时用 `read_image` 自己续租。
4. **淘汰只发生在新一轮的开头，从不在一轮中间。** 两个理由叠在一起：M1
   （`window-edge-plan.md`：模型马上要看的东西不裁），以及改写历史前缀会打掉
   provider 的前缀缓存——一轮开头本来就是缓存最便宜的断点。
5. **作者看得见每一步。** 贴进来是一枚带缩略图的芯片；超上限当场拒绝并说为什么；
   缩过的图 tooltip 里有数字（`downscaleNote`，已有）。没有任何一步是发送时才
   悄悄发生的。

---

## 3. 入口：粘贴

### 3.1 判定（纯函数，`lib/agent/pasteImages.ts`）

`classifyPaste(items: {kind, type}[], hasText: boolean)` → `"images" | "passthrough"`：

- 剪贴板里**有文字** → `passthrough`，一律当文字贴。从 Word / Excel / 网页复制一段
  内容时，剪贴板里常常同时有文字和一张「这段内容的渲染图」；拦下图片会让作者贴
  不进他真正要的那段字。**文字优先**是唯一不会错得离谱的规则。
- 没有文字，且至少一个 `kind === "file"` 且 `type` ∈ `image/png | jpeg | webp | gif`
  → `images`，`preventDefault()`。
- 其余（HEIC、TIFF、PDF、非图片文件）→ `passthrough`，外加输入区既有的那行错误
  提示说「这种格式贴不进来」。HEIC 不做的理由见 `image-normalize-plan.md` §3.0，
  不在这里重开。

`MIME → 扩展名` 用白名单映射，不信任剪贴板给的文件名（很多来源是 `image.png`
千篇一律，有的干脆没有）。

### 3.2 落盘与命名

```
.ai-writer/tmp/chat/<stashId>/<sha256 前 12 位>.<ext>
```

- **内容哈希做文件名**：同一张图贴两次是同一个文件、同一个 `attachedKey`，芯片
  自然去重，不用另写去重逻辑。
- **显示名**与文件名分开：芯片与【附图】块里叫「粘贴的图片 1 / 2 / …」（按本会话
  内的序号，i18n 参数化），因为一个哈希对作者和模型都不是名字，而「第二张贴图」
  是作者真会说的话。`ProjectFile.name` 放显示名，`path` 放真路径。
- 写盘用 `writeBinaryFile`，之后**照常**调 `attachProjectFile(file)`——降采样、
  12 MB 兜底、`unreadable` 错误路径全是现成的。不为贴图另开一条读图路径
  （Hard Rule：发给模型的只有 `imageForModel`）。

### 3.3 `stashId`：为什么不是会话行 id

`sessionId` 要到第一次 `persistChat` 才有（`types.ts:192`），而贴图发生在发送
之前。所以：

- `stashId` 是一个 uuid，**第一次贴图时**才生成，挂在 chat 状态上，并写进会话
  存档（`ChatSnapshot.stashId`，`deserialize` 对缺省值宽容，不用 bump `v`）。
- `chat_sessions` 加一列 `stash_id TEXT`（走 `project.ts` 里 `pinned` / `title`
  用过的同一个 `ADD COLUMN` 补列函数）。**要一列而不是 `json_extract(data)`**：
  清扫（§4）得在不解析每个会话 blob 的前提下拿到全部活着的 id，而 blob 可以有
  几百 KB。

### 3.4 上限：5 张，和 `@` 共用一个数

把 `MAX_MESSAGE_IMAGES` 从 4 改成 **5**，贴图与 `@` 图片**合计**。不另设
「贴图上限」：

- 两者是同一条线上的同一种 base64。分开计数就是 `MAX_IMAGE_RESULTS` 注释里说的
  那种「另一边可以径直走过去的上限」。
- 5 张的真实约束其实是 24 MiB 合计。截图通常 0.3–3 MB，5 张够得着；5 张
  4000px 的照片够不着，那时按现有规则「发得下的先发，其余按路径列出」。

**在粘贴时拒绝第 6 张**（输入区的错误行：「一条消息最多 5 张图」），而不是留到
`buildChatMessage` 里截断——`@` 的图超限留到发送时处理是因为提及可以打字打出来，
拦不住；粘贴是一个离散动作，当场说最清楚。一次粘贴带多张（Finder 多选复制）时
按顺序收到满为止，提示里说收了几张、拒了几张。

看图子代理的 8 张、`LoreMetaImproveModal` 的规则不动。

### 3.5 界面

- 贴图芯片 = 现有附件芯片 + 左侧 20px 缩略图（`imageToDataUrl`——**渲染给人看**
  的那个读法，不是 `imageForModel`）。点开走现有 `ImageLightbox`。
- 芯片上点 × ：移除引用。**不立刻删文件**——同一张图可能已经在更早的一轮里
  发过（同哈希同文件），那一轮的气泡缩略图还指着它。文件的死只由 §4 负责。
- 当前模型不是 multimodal：芯片照样能贴，走 `buildChatMessage` 既有的分支——有
  看图子代理时提示 `delegate(vision, refs:[路径])`，没有时说「当前模型读不了图」。
  暂存路径对子代理有效（它与 `read_image` 同一套路径规则，`tools.ts:687`）。
- 拖拽进输入框：同一个处理函数可以接 `onDrop`，但 Tauri 的文件拖放事件与 DOM
  的不是一回事，**不在第一片里**，别让它拖住粘贴。
- 写成一个 hook（`usePasteImages(chatKey)`），`RoleplayChat` 与
  `AttachmentTextarea` 以后要接时不用再写一遍。它们各自的「会话」生命周期不同
  （扮演的会话在 `.ai-writer/roleplay/`），**本方案只管助手**。

---

## 4. 暂存区的死：一条清扫，不是三个钩子

会话有三种死法，只有一种经过应用代码：

| 死法 | 经过哪 | 知道有目录要删吗 |
| --- | --- | --- |
| 作者删除会话 | `agentStore.deleteChatSession` | 知道 |
| 超过 5 个未命名未固定会话被**自动修剪** | `sessionDb.upsertChatSession` 里的一句 `DELETE … NOT IN (…)` | **不知道**——SQL 删的，没有逐行回调 |
| 从没发过消息的标签页被关掉 / 应用直接退出 / 崩溃 | 没有行，或根本没有代码跑 | 不知道 |

给每种死法各挂一个删除钩子，第三种永远漏。所以反过来做——**对账式清扫**：

```ts
// 纯函数，测试都在这
stashSweepPlan(
  dirs: { id: string; mtimeMs: number }[],   // tmp/chat/ 下实际有的
  live: Set<string>,                          // 所有行的 stash_id ∪ 所有打开标签页的 stashId
  now: number,
): string[]                                    // 该删的
```

规则：**不在 `live` 里，且 mtime 早于 24 小时前** → 删。

- 24 小时的宽限是为了多开：`window.lock` 只是警告不是阻止（`instance.ts`），同一个
  项目可以开两个窗口，另一个窗口里「贴了图还没发」的会话在本窗口看来就是孤儿。
  宽限期让清扫永远不会删掉别人手里正拿着的东西，代价只是孤儿多活一天。
- **例外：作者明确删除会话**时直接 `removeDir` 那一个目录，不等宽限——「删掉后也
  清理掉」是作者对这个动作的预期，而被删的会话不可能在别的窗口里还有效。

何时跑：**每个项目每次启动一次**，挂在项目打开后恢复会话列表的那一步（那时
活着的 `stash_id` 正好刚读出来）——与 convert 缓存 `sweepOnce` 同一个契约
（模块级的「本次启动已扫过」集合），只是触发点不同：convert 的是第一次使用，
这里没有「第一次使用」可等，因为孤儿恰恰属于不会再被使用的会话。
自动修剪之后**不**专门跑——修剪掉的会话等下次项目打开时自然被对账掉，不值得在
每次存档的热路径上加一次 `readDir`。

几个顺带的决定：

- **回退（`rewind.ts`）不删文件。** 被回退掉的那几轮的图变成目录里没人引用的文件，
  活到会话结束。按引用计数去删要求扫描所有 `turns[].images`，而收益是提前回收
  几 MB 的 tmp——不值。
- **`appReset` / 清空 tmp** 这类已有的整体删除天然覆盖它，不用加分支。
- 全部 best-effort、吞错：清扫失败退化成「tmp 里多几张图」，绝不能让会话打不开
  （与 `sessionDb` 头注释的立场一致）。

---

## 5. 上下文里的租期（作者没想好的那部分）

### 5.1 现有规则够不够

现状是「最新 3 条带图**消息**留像素」。对贴图有两个缺口：

1. **单位不对。** 3 条消息 × 5 张 = 15 张图跟着每一个工具轮次重发。估算器按每张
   800 token 计（`tokenEstimate.ts`），真实账单在多数 vision 端点上是每张
   1–1.5k——一个 10 轮的工具循环里，15 张旧图就是 15–20 万 token 的重复计费，
   而它们大概率早就聊完了。
2. **按条数淘汰与对话节奏无关。** 作者贴一张截图问一句，之后二十轮都在聊别的、
   再没附过图——那张图永远是「最新 3 条」之一，**一直不会退场**。这正是作者担心
   的那种情况，现有规则恰好管不到。

### 5.2 方案：按「轮」计的租期，叠在现有上限之上

> **作者附的图（贴的和 `@` 的一样）在它被发送的那一轮，以及之后的 N 轮里保留
> 像素；第 N+2 轮开头去掉像素、留下文字。建议 N = 1。**

- 「轮」= 作者的一次提问到下一次提问之前（`compact.ts` 的 `meta.turnStarts` /
  `segmentHistory` 已经在记这个边界，按对象同一性，不用新造标记）。
- **N = 1 的理由**：对一张图的追问（「那第二张呢」「左上角那行字是什么」）几乎
  总是紧跟着的下一句。隔了一轮还要回头看图是少数情况，而这少数情况有 §5.3 兜底，
  代价是一次 `read_image`（一轮）。反过来，N 每加 1，所有对话都多付一轮 × 全部
  工具轮次的图片钱。
- **只管作者附的图。** 工具循环读进来的图（`Visual reference for read_image: …`
  那种 follow-up）继续只受 `MAX_IMAGE_RESULTS` 管——它们的用途是一次运行内的
  相互比对，生命周期本来就是「这次运行」，而且它们所在的那一轮结束后，同样会被
  租期规则带走（它们不是 turn start，落在所属的轮里，整轮一起到期）。
  实现上因此更简单：**租期按轮算，轮里所有带图消息一起到期**，不用区分来源。
- 现有三道上限（3 条 / 24 MiB / 窗口）**全部保留**，先到者生效。租期是更早的
  一道，不是替代。
- 落点：`trimHistory` 开头那一行无条件的图片淘汰里加一项
  `elideExpiredTurnImages(history, meta)`。它只在**最后一条消息是新一轮的 turn
  start** 时动手（不变量 4）——同一轮里的后续工具轮次再调 `trimHistory`，它什么
  都不做，前缀保持稳定，缓存不被反复打掉。
- 一次性的 agent 运行（AiPanel 的 Agent 模式）没有轮的概念，`meta` 缺省时这一项
  直接跳过。

### 5.3 退场之后：路径留在文字里

【附图】块从

```
【附图】
1. 粘贴的图片 1
```

改成

```
【附图】
1. 粘贴的图片 1 — .ai-writer/tmp/chat/3f…/9a1c….png（会话暂存，随会话删除）
2. 人物立绘.png — assets/第三章/人物立绘.png
```

- 像素去掉之后，这段文字还在（`imageHistory` 的「字留下」规则），模型看到的是
  「这里曾有一张图 + 它的路径 + `ELIDED_IMAGE` 那句『还要的话再读一次』」——现在
  这句话第一次有了可执行的对象。`@` 的图同样受益，所以这一条不分来源都改。
- 存档恢复后（所有像素都被 `DROPPED_IMAGE` 去掉）同理：重启后问「刚才那张截图
  里……」，模型能自己 `read_image` 回来。今天做不到。
- 成本：每张图约 20 token，一次性的，不随轮次重复计费以外的方式增长。
- **「会话暂存，随会话删除」这几个字是给模型的约束**：暂存路径不能被写进正文
  （`![](.ai-writer/tmp/…)` 会在会话删除后变成坏链）。要把贴图用进稿子，得先
  另存进 `assets/`——那是另一个功能（§7），第一版里模型应当告诉作者「请先把图
  存进项目」。按 `tool-presence.md`：没有那个工具，就不能让话里显得有。
- 相对路径（相对项目根），与 `read_image` 的解析规则一致，也省 token。

### 5.4 考虑过、不做的

| 方案 | 为什么不 |
| --- | --- |
| **看完就写一段描述替换图** | 要么多一次模型调用（钱与延迟），要么指望主模型在回答里顺带描述（不可靠）。更要命的是：描述丢掉的恰好是之后会被追问的东西——`LoreDetail.tsx` 的注释就同一件事表过态。路径 + `read_image` 是**无损**的，而且只在真需要时付费 |
| **只在发送的那一次请求里带图，之后立刻去掉**（N = 0） | 紧跟的追问是最常见的用法，每次都逼出一轮 `read_image`（≈ 一轮的固定头成本，`edit-loop-plan.md` 的尺子是 15k token）比多带一轮图贵 |
| **让作者手动「从上下文移除」某张图** | 把一个本该自动的记账问题变成作者的家务。可以以后在上下文构成条上加，但不是机制本身 |
| **按 token 预算而不是按轮** | 每张图的真实 token 各家不同且探测不出来（同 `image-normalize-plan.md` §2.2 不做 per-provider 表的理由）；「轮」是作者能理解、测试能断言的单位 |
| **贴图不落盘，只放内存** | 违反不变量 1；重启后气泡里的缩略图没了；淘汰后无处可重读，§5.3 整个不成立 |

---

## 6. 分片

不叠 PR，两片都直接指向 `main`，第二片等第一片合并后再切。

**PR 1 — 贴图与暂存区**（功能完整可用；租期此时还是现有的「3 条消息」）

- `lib/agent/pasteImages.ts`（纯：`classifyPaste` · MIME 映射 · 显示名）、
  `lib/agent/chatStash.ts`（落盘 · `stashSweepPlan` 纯 · `sweepChatStash` 碰盘）
- `AgentChat.tsx`：`usePasteImages`、芯片缩略图、第 6 张的当场拒绝
- `chatJob` / `types.ts`：`stashId`；`chatSession.ts` 序列化；`project.ts` 补列；
  `sessionDb.ts` 写列；`agentStore.deleteChatSession` 删目录；项目打开时清扫
- `chatRefs.ts`：`MAX_MESSAGE_IMAGES = 5`；【附图】块带路径与暂存标注
- i18n 两种语言；`codemap.md` → `src/lib/agent/` 一节补一段；
  `image-normalize-plan.md` §2.9 表里的「每条 4 张」改 5；版本号随本 PR
- 测试：`pasteImages.test.ts`（文字优先、MIME 白名单、多张收满为止）、
  `chatStash.test.ts`（清扫计划：活的不删、宽限期内不删、显式删除不等宽限）、
  `chatRefs` 既有测试补路径断言、`chatSession` 往返带 `stashId`

**PR 2 — 按轮租期**

- `runtime.ts` `elideExpiredTurnImages` + `trimHistory` 接线；N 作为具名常量
  `IMAGE_LEASE_TURNS = 1`
- 测试：到期只在 turn start 触发；同一轮内多次 `trimHistory` 前缀不变；进行中的
  一轮不动；`meta` 缺省时跳过；与 3 条 / 24 MiB 两道上限的先到者关系
- `window-edge-plan.md` 与本文档互相指一下

---

## 7. 明确不在本方案里

- **把贴图存进项目 / 插进正文。** 需要一个「暂存 → `assets/<文档名>/`」的动作
  （很可能是贴图芯片或气泡缩略图上的一个作者侧按钮，而不是模型工具——它是一次
  文件拷贝，不需要模型）。单独立项。
- 拖拽、扮演与知识库 AI 输入框的贴图（§3.5）。
- HEIC / TIFF（`image-normalize-plan.md` §3.0）。
- 视频粘贴。

## 8. 动手前要实测的一件事

**WKWebView（macOS）与 WebView2（Windows）里 `paste` 事件的 `clipboardData.items`
到底给什么。** 已知的坑位：macOS 上某些来源（预览.app、部分截图工具）放进剪贴板
的是 TIFF，WebKit 通常会转成 `image/png` 交出来，但「通常」不是测量；从 Finder
复制**文件**再粘贴，WebKit 可能只给文件名文字而不给字节。GUI 自动化驱动不了这个
应用，所以用一个 `VITE_` 开关保护的启动探针把 `items` 的 `kind/type` 打到控制台，
作者在两个平台上各贴五种来源（系统截图、浏览器复制图片、Finder 复制文件、
Word 里复制一段带图内容、微信截图）记一张表，结果写回本节。§3.1 的判定规则以
这张表为准修正——尤其是「文字优先」在 Finder 复制文件这一格会不会误伤。
