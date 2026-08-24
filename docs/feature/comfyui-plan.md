# 本地 ComfyUI 生图接入方案

> **状态：PR1（生成链路 + Beta 开关）、PR2（参考图/图生图 + 负面提示词）已实现；PR3（人设校准循环）待做。**
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

### PR3 · 人设校准循环
- 从实体 facets 结构化生成可判定检查清单（发色/瞳色/服装：是/否）
- 生成 → vision 子代理评审（结构化输出：不符项 + 修正建议 + 换seed还是改词）
  → 调整重试，轮数上限 + 历史最佳兜底 + 每轮结果可见可叫停
- 授权复用「批准并连批 N 张」的计数授权语义；本地出图免费，钱只在评审 VLM

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 作者导入 UI 格式而不是 API 格式 | 专门检测（`nodes[]` + `links[]` 形状）并在导入时用人话报错，指向「导出 (API)」菜单 |
| 工作流依赖的自定义节点/checkpoint 在 ComfyUI 侧变动 | `/prompt` 的 `node_errors` 原样透出；提示先在 ComfyUI 里跑通 |
| 相同图重发命中缓存不出图 | seed 默认每次随机化；显式 seed 下出空结果报 NoImageError，文档记明 |
| 盲发 /interrupt 打断作者自己的任务 | 先 queue delete，再核对 queue_running 里的 prompt_id 才 interrupt |
| 识别错节点（把词填进负面） | 导入时展示识别结果；标题约定可显式覆盖；测试锁住负面先于正面的判定顺序 |
| 长渲染超时 | 600s 任务级 deadline（与 DashScope 异步一致），UI 的停止按钮全程有效 |
