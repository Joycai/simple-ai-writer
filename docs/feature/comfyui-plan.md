# 本地 ComfyUI 生图接入方案

> **状态：PR1~PR3 已实施**——PR1（生成链路 + Beta 开关）、PR2（参考图/
> 图生图 + 负面提示词）、PR3（人设校准循环）。**PR4（配置流程，§7）实施中，
> PR5（负面提示词打通 agent 链路，§8）待实施。**
>
> 目标：让一台本地 ComfyUI 实例成为应用的第五条出图路由——作者在 ComfyUI 里
> 搭好并跑通工作流，导出 API 格式 JSON，在应用里登记成一个「模型」；应用只做
> 占位注入（提示词 / seed / 尺寸 / 张数）和提交-轮询-取图，**绝不自己构造节点
> 图**。后续把知识库人设接进来：参考图注入（IPAdapter 类工作流）与
> 「生成 → vision 评审 → 修正重试」的校准循环。
>
> 本文是 `image-generation-plan.md` §10「明确不做：本地模型（SD/ComfyUI）」的
> 解除条件成立后的续篇——当时的理由是「形状差异大，等三家的抽象稳定后再说」,
> PR1~PR6 落地后 `ImageRoute`、caps 声明、异步轮询先例（DashScope）都已就位。

---

## 1. 总体形状：一个 Model 行 = 一张工作流

ComfyUI 没有 model id 的概念——它吃的是整张节点图。对到应用的抽象上，最自然
的映射是**一张导出的工作流登记为一个 image Model**：作者可以有「SDXL 立绘」
「Flux 场景图」两个"模型"，各自背着不同的 checkpoint/LoRA/采样参数，而这些
参数全部由作者在 ComfyUI 里调好、原样照发。

- **Provider**：一个指向 `http://127.0.0.1:8188` 的普通供应商行（协议随意，
  keyless——本地端点无鉴权，与 LM Studio 的先例一致）。路由声明
  （`caps.route = "comfyui"`）使协议字段实际不参与分派。
- **Model**：`type: "image"`，`caps.route: "comfyui"`，
  `caps.comfy.workflow` 存导出的 API 格式 JSON 原文。
- 工作流存在 `caps` 里而不是新开列：caps 已是 models 表的 JSON 列，随
  配置备份/同步（`lib/configsync`）自动走，不需要迁移。`route`/`asyncTask`
  已开了「caps 里放的是怎么调用而不只是能不能」的先例。

### 1.1 为什么收"API 格式文件"而不是"工作流名字"

ComfyUI 的工作流有两种格式，能提交给 `POST /prompt` 的只有**API 格式**
（菜单「导出 (API)」）。UI 保存格式（服务端 `user/default/workflows/` 里按
名字存的那个）记的是画布——节点位置、连线、`widgets_values` 数组——按名字
经 userdata API 拉取后还要自己做 UI→API 转换，而那层转换（Primitive、
Reroute、mute/bypass、自定义节点的动态输入）恰好是整条链路上最脆的一环。
导出文件只多一步手动操作，却把转换问题整个消掉；「按名字拉取 + 自动转换」
留作以后的便利性升级，不做地基。

### 1.2 占位符识别：节点标题约定 + 采样器回溯

应用需要知道图里哪个节点是"正面提示词"。两层识别，全部是**读取时纯函数**
（`lib/comfy/workflow.ts`），不在导入时固化 node id——存的永远只有原始 JSON，
识别逻辑升级后老配置自动受益：

1. **标题约定**（作者显式指定，最高优先）：API 导出带 `_meta.title`，作者在
   ComfyUI 里把节点改名即可——`positive`/`正面` 命中正面，`negative`/`负面`/
   `反向` 命中负面。判定顺序**负面先于正面**（「负面提示词」含「提示词」）。
2. **采样器回溯**（零配置的默认路径）：找 inputs 里同时有 `positive`、
   `negative` 连线的节点（KSampler 及其变体），沿连线找到带字符串 `text`
   输入的目标节点（CLIPTextEncode 类）。中间隔着 ConditioningCombine 之类
   就回溯不到——那正是标题约定兜底的场合。

其余占位：`seed`/`noise_seed`（数值输入，所有命中节点都注入）、
EmptyLatentImage 类的 `width`/`height`/`batch_size`（数值输入）、
LoadImage（PR2 参考图入口，PR1 只检测报告）。

导入时跑一遍识别并把结果展示给作者（「正面提示词 ✓（标题）· seed ×2 ·
尺寸 ✓」），识别不到正面提示词就拒绝保存——一张填不进词的工作流当模型
只会在运行期报更晦涩的错。

## 2. 协议层：第五个 `ImageRoute`

`"comfyui"` 加入 `ImageRoute`，adapter 与其余四条并列在 `lib/ai/image.ts`：

```
POST {base}/prompt          {"prompt": <注入后的图>}   → {prompt_id}
GET  {base}/history/{id}    轮询；完成前是 {}，出错带 status.messages
GET  {base}/view?filename=&subfolder=&type=            → 图片字节
POST {base}/queue {"delete":[id]} / POST {base}/interrupt   （取消）
```

照抄 DashScope 异步路由的骨架：提交后任务 id 记进 API 日志、整任务一个
600s deadline、轮询瞬时失败连续 3 次才算真错。差异点：

- **轮询节奏 1s 恒定**——本地回环，一次 GET 近乎免费，没有必要退避；
- **seed 每次提交都随机化**（除非 `extraBody.seed` 显式给定）：ComfyUI 按
  节点输入哈希缓存，原图重发会命中缓存、不出新图——「重试」的语义靠随机
  seed 才成立；
- **取图区分 `output`/`temp`**：SaveImage 产出 `type: "output"`，
  PreviewImage 产出 `temp`；有 output 就只取 output，只有 temp 才收 temp
  （作者的调试预览节点不该混进结果）；
- **取消是两步**：先 `queue delete`（还在排队），再查 `/queue` 的
  `queue_running`，确认跑的是我们的 prompt_id 才 `/interrupt`——盲发
  interrupt 会打断作者自己正开着的 ComfyUI 任务；
- **错误透出**：`/prompt` 的 400 带 `node_errors`（缺自定义节点、checkpoint
  改名都在这），history 的 `execution_error` 带 `node_type` +
  `exception_message`——都原样进 `ImageHttpError`，提示作者「先在 ComfyUI
  里跑通再导出」。

PR1 明确不做（PR2 已兑现前两条）：`req.images`（参考图/图生图）；负面提示词
的运行期注入；WebSocket 进度（轮询够用，进度条不值一个新依赖——仍不做）。

## 3. Beta 开关

`lib/comfy/flag.ts`（`app:comfyuiBeta`，默认关），设置 → 通用 → 实验功能。
它管的事：**ModelDrawer 的路由下拉里 "ComfyUI（本地）" 这一项存不存在**。
已配好的 comfyui 模型在开关关掉后仍然能用、编辑时仍显示该选项——开关管的
是入口不是既有配置，与 translate 开关「关掉 = 工具不装载而不是调用被拒」
同一哲学。

## 4. 计费与能力

- 本地出图免费：`pricePerImage` 留空即 0，用量照记 `token_usage`
  （`task = "image-gen"`，cost 0）——链路统一，作者在用量页看得到张数。
- `caps.edit`/`maxRefs`（PR2 起）：保存时从工作流的 LoadImage 数**推导**，
  不是作者声明。没有槽位的工作流 edit=false，审批卡/会话的降级逻辑自动把
  改图请求变成带累积指令的重新生成，不需要任何新分支。
- 方言不参与：comfyui 路由走 generic 的自由尺寸表（`caps.sizes`），
  `req.size` 解析成 width/height 注入 latent 节点；没有 latent 节点就忽略。

## 5. 分期

### PR1 · 生成链路（本文实现的部分）— ✅
- `lib/comfy/flag.ts` + 设置 → 通用的 Beta 行
- `lib/comfy/workflow.ts`：解析（含 UI 格式误导入的专门报错）、占位识别、
  注入——全部纯函数，`lib/comfy/__tests__/workflow.test.ts` 覆盖
- `ImageRoute` += `"comfyui"`；`ImageCaps.comfy`；`ImageConn.comfy`；
  adapter + 取消 + 错误透出；`imageClient.test.ts` 增加 comfy 路由用例
- ModelDrawer：路由选项（flag 门控）、工作流导入（文件对话框）+ 识别结果
  展示 + 无正面提示词拒存；comfyui 路由下隐藏方言/编辑声明
- conn 组装点（`stores/imageStore.ts`、`lib/image/illustrate.ts`）带上
  `caps.comfy`

验收：本地 ComfyUI 跑通的工作流导出导入后，在图集/正文/agent 三个入口出图,
落盘、入库、记用量，与云端模型无异。

### PR2 · 参考图与图生图 — ✅
- `POST /upload/image`（multipart，约束同生图方案 §2.3：不得手动设
  Content-Type）。上传名**每次随机 + overwrite**：文件名和字节都重复的
  LoadImage 会命中节点缓存——和 seed 随机化是同一件事的另一半
- LoadImage 槽位注入：输入图按槽位顺序逐个填入，**标题带 ref/参考/source/
  输入 的槽位排最前**（作者显式指定哪个槽吃应用的图），没喂到的槽位保持
  模板默认。槽位数在**上传前**核对，超了直接报错（普通 Error，刻意不进
  `isEditUnsupportedError` 的降级——对同一张图重试一次生成不会更好）
- **`caps.edit`/`maxRefs` 从工作流推导，不是复选框**：有没有 LoadImage 是
  导入的图的事实，声明会和图漂移，推导不会。没有 LoadImage 的工作流
  edit=false，改图请求自动走既有的累积指令降级重生成
- 负面提示词：`ImageRequest.negative` 只有 comfyui 路由消费（唯一有该
  wire 字段的路由）；弹窗对 comfy 模型**不再**把负面折进 prose——SD 会画
  出它读到的东西，正面里的 "Avoid: watermark" 反而招来水印。工作流没有
  负面节点时静默丢弃（导入摘要里可见 负面 ✓/—），绝不折回正面
- **comfy 的图生图编辑发累积描述，不发增量指令**（`imageStore.edit` 的
  一处路由分支）：SD 提示词描述的是结果不是修改动作，「把头发改成银色」
  单独作为完整正面提示词只会画出一撮头发；对话式云端模型仍收增量

### PR3 · 人设校准循环 — ✅
落点：**交互式弹窗**（`ImageGenModal` 的「按人设校准」区，随同一 Beta 开关
显隐），不是 agent 工具——计数授权的 agent 通道留给以后真有需求时再接。
机制本身与路由无关（任何 image 模型都能跑），但免费重试的成本结构是本地
出图才有的，所以挂在这把 Beta 伞下。

- `lib/image/calibrate.ts` 三件套，职责分开：
  - **清单**（`buildImageChecklist`，提示词模型 + 结构化输出）：把主体资料
    提炼成 3–8 条**看一眼图就能判定**的标准（「银白色长发」是标准，「气质
    出众」不是）。一次生成、全程复用。
  - **评审**（`reviewImageAgainstChecklist`，vision 连接经 `resolveVisionConn`
    ——与图集「AI 描述」同一个「谁在读图」的答案）：逐条判定 + **双诊断**：
    提示词写得不到位 → 给出修订后的**完整**正面提示词；这次抽卡不好
    （肢体/构图崩了）→ `seedOnly`，同一提示词换 seed 再来——正好落在
    comfy 路由「seed 每次随机」的默认行为上。
  - **循环**（`runCalibration`，纯函数）：提前达标即停、revisedPrompt 换词
    而 seedOnly 不换、硬轮数上限（2–5，作者选）、到上限选**历史最佳**
    （通过项最多，并列取更晚的——它在更多修正之后）。生成与评审都是注入
    的回调，行为全部可单测。
- 每轮是会话树里的**普通一轮**（`imageStore.generate` 新增 append 语义 +
  `annotateTurn` 挂评审结果）：作者可以随时从任何一轮分叉继续手动改，评审
  徽标（n/m 项达标 + 未达标项原文）跟着轮次走。停止按钮全程有效（abort）。
- 评审员噪声的三道防线：硬上限、历史最佳、以及**判定对齐**——verdicts 数量
  与清单对得上时以清单原文为准显示，评审员的转述不许替换作者要问的问题。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 作者导入 UI 格式而不是 API 格式 | 专门检测（`nodes[]` + `links[]` 形状）并在导入时用人话报错，指向「导出 (API)」菜单 |
| 工作流依赖的自定义节点/checkpoint 在 ComfyUI 侧变动 | `/prompt` 的 `node_errors` 原样透出；提示先在 ComfyUI 里跑通 |
| 相同图重发命中缓存不出图 | seed 默认每次随机化；显式 seed 下出空结果报 NoImageError，文档记明 |
| 盲发 /interrupt 打断作者自己的任务 | 先 queue delete，再核对 queue_running 里的 prompt_id 才 interrupt |
| 识别错节点（把词填进负面） | 导入时展示识别结果；标题约定可显式覆盖；测试锁住负面先于正面的判定顺序 |
| 长渲染超时 | 600s 任务级 deadline（与 DashScope 异步一致），UI 的停止按钮全程有效 |

---

## 7. PR4 · 配置这条路本身（2026-08-26）

> 状态：本节为 PR4 的设计，随 PR4 实施。

三期落地后暴露的不是功能缺口，而是**配置流程**的缺口：作者知道 ComfyUI 在
本机跑着，却配不出一个能出图的模型行。原因有三条，都不在 ComfyUI 一侧。

### 7.1 症状：这条路由上的反馈全是假阴性

实测（作者机器，ComfyUI 默认参数启动于 `127.0.0.1:8188`）：

| 请求 | 结果 |
| --- | --- |
| `GET /system_stats`，不带 Origin | 200 |
| `GET /system_stats`，`Origin: http://localhost` | **403** |
| `GET /system_stats`，`Origin: http://127.0.0.1:8188` | 200 |
| `POST /prompt`，不带 Origin | 400（handler 跑到了，空 body 被拒） |
| `POST /prompt`，`Origin: http://localhost` | **403** |
| `GET /不存在的路径`，`Origin: http://localhost` | **403**（不带 Origin 是 404） |

最后一行是判据：**不存在的路径也 403，说明拒绝发生在路由之前**。ComfyUI 默认
挂 `origin_only_middleware`（未传 `--enable-cors-header` 时启用的防 DNS
rebinding 检查）：Origin 的 host 与 Host 头不一致就 403。而 `lib/http.ts`
对所有本地地址强制附一个 `Origin: http://localhost`——那是为 Ollama 在打包
Windows 版上的白名单写的（见该文件顶部注释）。

后果不只是失败，是**失败得毫无信息**：请求根本没到 `/prompt`，所以改提示词、
去掉 `quality` / 2K 这类参数全都不会有任何变化，作者会一路怀疑到提示词和模型
参数上去。叠加上另外两个必然失败的按钮（「测试连接」探 OpenAI 式 `/models`、
「拉取模型列表」同理），作者拿到的每一个信号都指向「我配错了」，而实际上
ComfyUI 一直好好地跑着。

**处置：不改 `lib/http.ts`。** 曾评估过把 Origin 镜像成目标自身的 origin
（实测可行，见上表第三行），作者决定不做——那条改动的验证成本落在打包 Windows
版 + 一台没设 `OLLAMA_ORIGINS` 的干净 Ollama 上，而收益只是省掉一个启动参数。
于是 **`--enable-cors-header` 是这条路由的正式前置条件**，这句话必须出现在
作者会看到的地方（测试连接的 403 分支 + 预设说明），而不是只躺在文档里。

### 7.2 症状：配置顺序是反的

- ComfyUI 借用「供应商 = 一个 LLM 端点」的抽象，但表单里三个必填项对它全是
  空仪式：API 标准不参与分派（`image.ts` 按 `caps.route` 分派）、模型 ID 从不
  上线、API Key 不存在。
- 唯一那句说明（`comfyWorkflowHint` 的「供应商地址填 ComfyUI 的地址」）写在
  **模型抽屉**里——作者必须先猜对供应商怎么建，才能看到告诉他供应商怎么建的
  那句话。

### 7.3 决策：不升格为第七个 `apiStandard`

诱人，但错。`ApiStandard` 有 70 余处引用、背后是三个 `ProtocolFamily`，
`familyOf` / `authModesFor` / `conn` / 探测都要多一个永远不说话的分支；而
ComfyUI 根本不是一个协议族——它没有 chat、没有 embedding，只有出图。
**怪的是流程顺序，不是标志位放错了地方。** `caps.route` 保持不动，改流程。

同理不给 `providers` 表加 `kind` 列：那要连带改 `configTransfer` 与配置备份
信封，而"这个供应商是 ComfyUI"这件事在需要它的两个时刻都能免费推出来。

### 7.4 形状：预设 chip + 保存直通 + 一次性提示

1. **`PROVIDER_PRESETS` 加一行 `ComfyUI（本地）`** → `http://127.0.0.1:8188`，
   `openai_compat`（不参与分派，仅为让表单有个合法值）。选中后表单**收缩**：
   API 标准与 API Key 两行折叠成一句说明，Base URL 保留（端口会变）。
2. **保存后直通模型抽屉**：新建成功即以新供应商 id 打开 ModelDrawer，预置
   `type = image`、`caps.route = "comfyui"`，作者落在「导入工作流 JSON」上。
   全程两个动作：点预设、导入工作流。这条是 UI 流程状态（`Drawer` 类型多一个
   可选 `comfy` 位），**不落盘**。
3. **测试连接改探 `GET /system_stats`**：仅当供应商是 comfy 预设时。403 翻成
   人话并点名 `--enable-cors-header`；200 报 ComfyUI 版本。这是整条路上唯一
   能把「服务在跑但拒绝了我们」和「服务没跑」分开的地方。
4. **后续新建模型默认同路由**：该供应商下**已有** comfyui 模型时，新模型默认
   `type=image` + `route=comfyui`。读现成的 models 即可，零新状态。

### 7.5 明确不做

- 不改 `lib/http.ts` 的 Origin（见 7.1）。
- 不自动探测 ComfyUI 是否在跑、不做端口扫描——一个按钮按下去才发请求。
- 不做「按名字拉取工作流 + UI→API 自动转换」，理由同 §1.1，未变。

## 8. PR5 · 负面提示词打通 agent 链路

> 状态：本节为 PR5 的设计。

负面提示词不是「不支持」，是**半支持**——弹窗有、工具没有：

| 环节 | 现状 |
| --- | --- |
| 工作流识别 + 注入负面节点（`comfy/workflow.ts`） | ✅ |
| wire 字段 `ImageRequest.negative`（仅 comfyui 路由消费） | ✅ |
| 交互式弹窗的负面输入框（`ImageGenModal`） | ✅ |
| `generate_image` / `edit_image` / `redraw_lore_image` 的 schema | ❌ |
| `IllustrateProposal` | ❌ |
| `illustrate.ts` 组 request | ❌ |
| 校准循环的评审诊断（`calibrate.ts`） | ❌ 只改正面 |

即：**作者从弹窗画图有负面词，助手替作者画图恒定没有**——工作流模板里的默认
负面还在跑，但模型和作者都够不着它。

### 8.1 作用域：只服务 comfyui 路由

作者拍板：负面提示词只在 comfyui 路由上存在，**不为其他路由折进正文**。
（弹窗对非 comfy 模型仍走它自己既有的 `specToPrompt` 折叠，那是既有行为，
PR5 不动它。）这条把 PR5 的表面积压到最小：新字段只有一个消费者，没有第二种
语义要维护。

### 8.2 落点

1. `generate_image` 增加 `negative` 参数。**会撞 `agentToolBudget.test.ts` 的
   棘轮**——那不是测试坏了，是它设计成这样：描述压到一行，并在同一个 commit 里
   抬 cap 且写明理由。
2. `IllustrateProposal.negative` + 审批卡显示：作者要看得见这张图在「避免」
   什么，否则这个字段就是一个模型能写而作者看不见的隐藏参数。
3. `illustrate.ts` 组 req 时带上——**仅 comfyui 路由**，其余路由丢弃（不折回
   正面：SD 会画出它读到的东西，这条在 §5 PR2 已经付过一次学费）。
4. 校准循环的双诊断加 `revisedNegative`：评审员报「有水印」「多余的手」时，
   负面词正是唯一该写的地方。（可选，PR5 落地后再评估值不值。）
