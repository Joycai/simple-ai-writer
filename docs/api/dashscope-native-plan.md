# 百炼新地址、Token Plan 与 DashScope 原生线路

状态：`shipped`（2026-09-28）。协议事实在 [`landscape.md`](landscape.md) §7 第二十一个样本；这里只写本项目怎么选、为什么。

## 1. 做了什么

1. **`dashscope` 平台换默认地址**：新建渠道用 `https://maas.qianwenaiapi.com`（百炼文档的新地址）。旧地址
   `dashscope.aliyuncs.com` 仍列在平台的 `hosts` 里。
2. **新平台 `dashscope-plan`（百炼 Token Plan）**：`https://token-plan.maas.qianwenaiapi.com`，只列 ①（`/compatible-mode/v1`）
   与 ④（`/apps/anthropic`）。
3. **第五个协议族 `dashscope`（DashScope 原生）**：与 Chat / Resp / Gemini / Anth 同级，百炼平台多一条线路（`/api/v1`），
   模型可以把线路切过去。适配器 `src/lib/ai/dashscope.ts`，只讲 `multimodal-generation` 端点。
4. 连接测试、上下文 / 输出上限探测、列模型在原生线路上各有自己的分支。

## 2. 决定与理由

**旧地址的渠道不迁移。**（作者决定。）旧地址同一把 key 全通；把已存行的 host 改写成新地址是一次谁也没要求的数据迁移，
而识别平台只看 host，把两个 host 都列进 `hosts` 就够了：已存渠道照旧被认作百炼、请求字节不变，新建的用新地址。

**Token Plan 单列一个平台，不做成百炼的一个开关。** 与火山方舟的套餐同理：key 决定能打哪个 host，两种 key 在对方的 host 上都是
401。放在同一个平台下，抽屉会给出这把 key 永远打不通的线路。只开 ① ④，是因为它的快速开始文档只列这两条对话面（作者决定，
「按文档」）；没有 `sk-sp-` key 实测过，所以能力格留空（只有协议本身的缺省）、不给起步模型，抽屉在选平台时提示两种 key 不通用。

**原生协议是一个协议族，不是 ① 上的平台开关。**（作者要的就是「与 chat/resp/messages/gemini 同级」。）URL、信封、SSE 分帧、
错误形状全都不同；塞进 ① 就是在 `openai.ts` 里按平台分支，正是平台表要消灭的写法。

**但不复制 ① 的适配器。** 原生的 `parameters` 就是 compatible-mode 请求体的那些字段，回包 `message` 的内部形状与 ① 的
`delta` 相同。所以 ① 抽出两个共享件：`chatParams`（拼参数）与 `chatDelta.ts`（读一个 choice：文本 / `<think>` 拆分 / 思考 /
工具调用累加 / `finish_reason` 家族）。原生适配器只写自己独有的三件：信封、content part 的拼法、带 `event:` 的 SSE 分帧。
累加逻辑修过多轮（空串 id、拼接的参数、智谱的三种 finish_reason），两份就会各修各的。① 的字节由请求金标守住。

**只接 `multimodal-generation`，不做端点自动选择。**（作者：只看 qwen3.7 flash/plus 与 qwen3.8 max/flash。）这四个只在多模态端点答。
自动选择要么靠模型 id 表（会过时），要么靠「url error 之后改打文本端点」（每轮多一次请求）。老的纯文本模型切到这条线路会得到
400 url error，报错里告诉作者改走 Chat 线路。

**标准只有 `dashscope_compat`，没有官方的一半。** 其余四族都是「官方锁定地址 / 兼容填地址」两半；原生协议只在百炼上、而且有两个 host，
没有一个地址能锁。加一个永远存不进来的官方值，就要在 `defaultBaseFor` / `inferPlatform` / 导入里各给它一条死分支。`_compat` 后缀
保住「地址归作者」这条所有 `isCompatStandard` 读者都依赖的不变量；`routes.ts` 的 `standardOf` 改成查 `COMPAT_STANDARD`（`Record`，
新族不写不编译）与 `OFFICIAL_STANDARD`（`Partial`）两张表，不再拼字符串。

**思考借用 ① 的类目。** 原生的思考字段与 ① 同名（`enable_thinking` / `thinking_budget` / `reasoning_effort`），`reasoning.ts`
的 `thinkingVocabularyOf` 让原生族借 ① 的类目，而不是每个类目复制一份。族缺省是 `qwen-budget`（百炼的通用开关 + 预算）。

**能力对齐 ①，但只开实测过的。**（作者决定。）温度、强制工具、JSON（object 与 schema）是协议本身的字段，规则的 `families` 列上原生族；
`jsonSchema` 实测是真约束，格子写 `true`；联网搜索是百炼私有字段，和 ① 一样由平台格给出。**视频、PDF、代码解释器、网页抓取、
`vl_high_resolution_images` 这次不在原生线路上开**：规则不列原生族，格子没有，缺省就是「不发」；它们在 ① 线路上照旧。
适配器遇到视频 / 文件 part 会以名字报错——正常路径里构造不出来，碰到就是上游的 bug。

**文生图 / ASR 不改。** 它们本来就在用原生协议（wan2.7 / qwen-image 走 `multimodal-generation`，录音文件识别走
`/api/v1/services/audio/asr/transcription`），但 base 是从渠道地址按路径后缀改写出来的（`dashscopeNativeBase`），与 host 无关；
新地址、原生线路的 `/api/v1` base 都推得对，各有一条测试钉住。

## 3. 已知的边界

- **旧版本导入含 `dashscope_compat` 的备份**：旧版本的 `parseApiStandard` 把不认识的值读成 `openai_compat`，请求会打到
  `/api/v1/chat/completions` 而失败。这是既有的跨版本降级语义，不为它加版本号。
- 两份手抄的 `API_STANDARDS`（`configDb.ts` / `configTransfer.ts`）这次都加了值，没有合并——合并是另一件事。
- qwen3.7-flash 不理强制 `tool_choice`（两条线路都一样，第二十一个样本；思考中也是 200 收下不理，第二十二个样本）。强制工具的调用方本来就处理「模型没调」，这里不另设格子。
- 原生 `/models` 不带上限，探测的第 0 步在原生线路上跳过。错误探测拿到的「Range of max_tokens should be [1, 131072]」
  取区间上端作输出上限（`probeAnalysis.parseLimitFromMessage`；① 在百炼上是同一句，一并受益）。上下文超限在原生端点上的措辞未测。
- 一段视频留在对话历史里（`elideOldVideos` 保留最近一段），再把模型切到原生线路，之后每一轮都会以名字报错——与 Gemini / Anthropic
  适配器对视频的现有处理一致，不在这次单独改。
- 图片模型的出图接口留在「自动」、而模型的线路被切到 DashScope 原生时，推出的仍是 `images-api`，打 `/api/v1/images/generations`
  会 404。图片模型本该显式选「DashScope 原生」出图接口（抽屉里的异步开关、改图能力都挂在这个显式选择上）。整体 review 第 1 轮
  曾把原生族的缺省改成 `dashscope`，第 2 轮发现抽屉的异步开关与改图缺省都只认显式选择，这个改法会在「改回自动」时丢掉
  `asyncTask`——于是撤回，保持出图代码不改，把这条留作边界。要做，应当是出图接口的选择整体按「有效路线」而非「声明值」重做一次。
- **思考不设时的强制 `tool_choice`：每个端点 + 模型每周一轮 400，由学到的降级接住；不为它改缺省。**（2026-09-28 实测，
  第二十二个样本。）原生族的类目缺省是 `qwen-budget`，不设档位时 `wireThinks` 给 `unknown`、`forcesToolChoiceAuto` 按「不想」读，
  强制选择照发；而线路上的四个模型什么都不发都在想。实测：qwen3.8-flash / -max 与 qwen3.7-plus 首发 400「The tool_choice
  parameter does not support being set to required or object in thinking mode」，学到的降级认出这句、以 `auto` 重发、200 作答；
  qwen3.7-flash 200 收下、不理。① 上 qwen3.8 两个结果相同（① 在百炼上落 `openai-generic`，本来就不预降级）。

  **决定：不让 qwen3.8（也不让整条原生线路）缺省按「在想」算。** 理由：
  1. **省下的只有一轮被拒的请求。** 拒绝在生成之前，回包不带 usage，本应用也就不记用量（厂商是否另计未实测）；学到的上限
     落盘记一周，这一周里强制请求直接降成 `auto`。「一轮」而不是「一次」：多稿并发时几路同时发出，在任何一路学到之前各吃一次。
     预降级与不预降级的**结果一样**——都是 `auto`、模型用文字答、调用方走它本来就有的兜底（`structured.ts` 退 JSON、
     handoff 用本轮文字），差别只是第一次多一个往返。这正是 anthropic-plan §10.2 给「降级」算过的账，数目没变。
  2. **「不设也想」是模型的事实，不是类目的。** `unsetThinks` 挂在类目上，而 `qwen-budget` 是百炼的通用开关，作者在 ① 上
     可以把它给任何千问模型——其中 qwen3-vl-plus 默认不想（qianwen-compat-plan §1.1），给这个类目打 `unsetThinks` 会让它的
     强制工具被白白降掉。只在原生族上换一个带 `unsetThinks` 的缺省，就得复制一份 `qwen-budget`——§2 已经为「借用 ① 的类目、
     不复制」做过决定；按模型 id 挂的话，就是在类目之外再造一个「按模型的默认思考」事实，要穿过 `wireThinks` 的每个读者。
  3. **只修原生线路会让两条线路分叉。** 同样的四个模型在 ① 上一模一样地吃这次 400（qianwen-compat-plan §1.1 的「400 →
     重试 auto ✅」就是它），只动原生族的缺省，同一个模型换条线路行为就不同，而收益仍是那一次往返。
  4. **强制在这里本来就不会被照办。** 即使预降级，发出去的也是 `auto`；3.7-flash 更是不论想不想都不理 `required`。没有
     一种缺省能让「不设思考 + 强制工具」在这些模型上真的强制——要强制，作者把思考关掉（第二十一个样本：关了之后 3.8 照办）。

  **什么时候重开：** 学到的降级接不住了（报错不再点名 `tool_choice`，每次都失败而不是每周一轮），或者出现「想着也能强制」的
  新一代，让预降级变成真的损失——那时该做的是「按模型的默认思考」这一个事实，两条线路一起，而不是在原生族上打补丁。
- 流没等到带真实 `finish_reason` 的结束帧就关掉，按失败处理，不把半截回答当整段交出（原生协议没有 `[DONE]`）。
- Token Plan 全部按文档，未实测。
