# 智谱 BigModel 开放平台：现状对照与接入方案

> **状态：`partial`——P1（按量平台 + 对话模型）已实现并实测；P2–P5 是 `proposal`，每片写明还缺什么。**
> P2 的两个独立端点（网络搜索、网页阅读）已于同日实测，事实在第十四个样本的「独立工具端点」一段。
> 协议事实（逐条实测，2026-09-19，`GLM_KEY` 按量 key，glm-4.5-air / glm-4.7 / glm-5.3-flash）在
> [`landscape.md`](landscape.md) §7 第十四个样本；本文只放**本项目的对照、取舍与计划**。
> 实测工具：`src/lib/ai/__tests__/live.zhipu.test.ts`——走真实的 `streamCompletion` /
> `testProviderConnection`，设 `GLM_KEY` 才运行。

## 1. 一句话结论

智谱的标准端点 `https://open.bigmodel.cn/api/paas/v4` 是一个**相当忠实的 ① 族兼容端**：本项目的
`openai_compat` adapter 不改一个字节就能流式对话、读推理、跑工具轮、读图读 PDF。真正的缺口不在报文
形状，而在**四处「看起来成功」**——关不掉的思考、被无视的强制工具、被无视的 `json_schema`、只在
`finish_reason` 里说的中途失败——以及作者没有平台可选、只能手填一个 `custom` 渠道。

## 2. 原样可用的（不需要改）

| 能力 | 本项目怎么发 / 怎么读 | 智谱实测 |
| --- | --- | --- |
| 地址 | 线路 path `/api/paas/v4` + adapter 追加 `/chat/completions` | ✅ |
| 连通测试 | `GET {base}/models` | ✅ 200，OpenAI 形状，错 key 401 |
| 流式 | `stream:true` + `stream_options.include_usage` | ✅ usage 在最后一块，`[DONE]` 收尾 |
| 推理显示与回传 | `readReasoningDelta` 认 `reasoning_content`；工具轮原样回传 | ✅ 回传 200 |
| 函数调用 | 标准 `tools` / `tool_calls` | ✅ 三款都通 |
| JSON 模式 | 自动档对 GLM 发 `json_object`（`KNOWN_JSON_SCHEMA` 不列 GLM） | ✅ 合法 JSON，不查 "json" 字样 |
| 图片 / PDF | `imagePart`（data URL）/ `{type:"file", file:{file_data, filename}}` | ✅ glm-5.3-flash 两样都读到 |
| 用量 | `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | ✅ |
| 错误 | 非 2xx → 把正文原样抛出 | ✅ 智谱的错误文案是中文且具体（除下文 G3） |
| 文本模型收到图 | — | 400 并说明只收 `text`，不静默 |

## 3. 缺口（对照当前实现）

| # | 缺口 | 现象 | 严重度 |
| --- | --- | --- | --- |
| G1 | **没有平台**。作者只能选「自定义」：没有起步模型、没有主机识别、没有上限、没有提示 | 能用，但每个模型都得手填 | 中 |
| G2 | **旧代 GLM 的思考关不掉、档位是假的**。可选的类目里：`openai-generic` 的「关闭」发 `reasoning_effort:"none"`——4.5 / 4.7 静默无视，**照想照计费**；`deepseek` 类目在报文上碰巧对（关=`thinking.disabled`），但菜单里 low/high/max 三档在 4.x 上完全一样；`glm` 类目只给 5.3 代（没有「关」，档位 low/high/max） | 作者以为关了思考 / 调了档位，实际没有 | **高**（静默 + 计费） |
| G3 | **强制 `tool_choice`**。文档「仅支持 auto」；实测 5.3-flash 与 4.7 **静默不强制**，4.7 思考开时具名强制 **400 且报错不提 `tool_choice`**——`toolChoice.ts` 按参数名认「强制被拒」再降级重试的机制认不出，这次请求直接失败 | 结构化输出 / handoff 首轮失败 | **高** |
| G4 | **`finish_reason` 的三个私有值**：`sensitive`（审核拦截）、`network_error`（推理异常）、`model_context_window_exceeded`。adapter 只认 `content_filter` 与 `length`，其余当正常结束 | 回答半截而无提示；审核拦截不进「安全拦截」记忆 | 中（静默） |
| G5 | **上限表缺 GLM**：`modelLimits.ts` 只有 `glm-5.2` | 未填上限的 GLM 模型按全局默认规划，不是它真实的 128K / 96K | 低 |
| G6 | **`json_schema` 静默无视**：自动档不会选它，但作者能在模型抽屉里手动声明 | 声明了也只拿到代码块包着的文本 | 低（要作者主动选错） |
| G7 | **temperature 上限是 1**：抽屉允许到 `MAX_TEMPERATURE` | 400，报错明确 | 低（会响） |
| G8 | **联网**：对话内的 `web_search` 是 `tools[]` 项，本项目 ① 族服务端工具只会拼顶层字段（千问），且默认意图识别会让模型**没搜也说搜了**；另有独立的 `/web_search` 与 `/reader` 端点，本项目没有「应用执行的联网工具」这一类 | 暂时不提供，无害 | 功能缺失（P2） |
| G9 | **GLM Coding Plan 的三条编程端点**（① `/api/coding/paas/v4`、④ `/api/anthropic`、② `/api/v1`）同一把 key 都通，但走哪条决定扣套餐还是余额，且套餐条款只许「指定工具」 | 不提供 | 需作者决策 |
| G11 ✅ | **手动添加的模型不会自动拿到对的类目**：类目的「自动」按协议族取默认（① 族 = `openai-generic`），不看模型 id。作者在智谱渠道里手动加一个起步清单之外的 GLM，思考开关就是「发 `reasoning_effort:none`」——在全部 11 款上都关不掉思考 | 起步三款之外都要作者自己选对类目 | 中（静默 + 计费） |
| G12 ✅ | **千问的视觉旋钮漏到了智谱**：「高分辨率读图」（`vl_high_resolution_images`）与视频的「抽帧频率」（片段上的 `fps`）按「① 族 + 能看图」显示，不看平台；智谱两者都收下、200、token 不变（landscape.md 第十四个样本补测）——开关是假控件，抽帧频率旁的计费说明也不成立 | 已修：归平台（§4 P6） | 低（静默，无额外花费） |
| G10 | **保留式思考**：`glm` 类目恒发 `thinking.clear_thinking:false`（厂商对 5.3-flash 的推荐值）。它要求**跨轮**原样回传历史 `reasoning_content`，本项目只在工具轮内回传 | 效果未量 | 未知 |

## 4. 方案

### P1 ✅ 按量平台 + 基础对话（本次）

- **平台 `zhipu`**（「智谱 BigModel」）：`origin https://open.bigmodel.cn`，只列 ① `/api/paas/v4` 一条线路，
  `hosts: ["open.bigmodel.cn/api/paas"]`（带路径，理由见 §5 末「审查修正」）。**不列** ②④ 与 coding ①（G9）。① 族没有已接的服务端工具（`serverTools.openai: []`，G8）。
  PDF 走默认（①② 两族）。
- **新类目 `glm-switch`**（「GLM 开关」，① 族，`onoff`）：开发 `thinking:{type:"enabled"}`，关发
  `thinking:{type:"disabled"}`，**不发 `reasoning_effort`**——4.x 与 5.0/5.1 收了也无视，发它只是给无效的档位
  一个假象（G2）。这是 ① 族第一个 `onoff` 类目；`isOnOffCategory` / `onEffort` 本就按 shape 判断，抽屉的开关
  UI 直接复用。5.3 代仍用既有的 `glm`（low/high/max，不能关）。
- **新类目 `glm-effort`**（「GLM-5.2」，① 族，`levels`）：菜单 关 · high · max。5.2 是唯一「能关又能调」的一代，
  但 `reasoning_effort:"none"` 关不掉它（校准实测），所以「关」发 `thinking.disabled`（与 `deepseek` / `doubao` 同一拼法）；
  low / medium 被端点折成 high，不单列。
- **平台声明「只认 auto」**：画像加 `forcedToolChoice: "ignored"`；`openai.ts` 的 `toolChoiceFor` 在这个平台上
  把 `required` / 具名降成 `auto`（G3）。理由与 MiniMax 同：两个会强制的调用方（`agent/structured.ts` 的 JSON 回退、
  handoff 的散文回退）本来就不依赖强制；不降级是 4.7 上的必然 400，降级的代价是 4.5-air 失去它唯一生效的强制
  ——换来的是回退提前一轮。**按平台而不按类目**：这是端点的规则，与思考开关无关（4.7 关思考时也不强制）。
- **`finish_reason` 的三个值**（G4），在 `openai.ts` 里对**所有** ① 族端点生效——这三个名字不会与别家的正常值撞车：
  `sensitive` 抛错且文案含 `content_filter`（进 `isSafetyBlockMessage` 的拦截记忆）；`network_error` 抛错；
  `model_context_window_exceeded` 记为截断（与 `length` 同）。
- **上限表**（G5）：`glm-5`（覆盖 5 / 5-turbo / 5.1 / 5.2 / 5.3 / 5.3-flash(x) / 5v-turbo）131,072；`glm-4.7` 与
  `glm-4.6` 131,072；`glm-4.6v` 32,768；`glm-4.5` 98,304；`glm-4.5v` 16,384。数字是文档「核心参数」表，
  4.5-air 的 98,304 实测（超了 400 报范围）。
- **起步模型**：实测过的三款——glm-5.3-flash（多模态 + PDF，1M / 128K，`glm`）、glm-4.7（200K / 128K，
  `glm-switch`）、glm-4.5-air（128K / 96K，`glm-switch`）。
- **抽屉提示条**（复用设计稿 05k TURN 2 的 `previewNote`，没有新组件，所以这一片不需要新的设计稿）：
  说明这是按量的标准端点，套餐 key 在这里扣余额、套餐额度要走编程端点且条款限定工具。

### P2 联网：两条路，先定走哪条（`proposal`，缺：作者决定）

**先说清归属：服务端工具是平台的，不是模型的。** 同一个 GLM，在千问（百炼）或火山方舟上由平台替它执行搜索，
在智谱自家端点上则没有可靠的服务端工具——对话内的 `web_search` 要关掉意图识别才真搜、结果量又控制不住，本项目
不把它算作服务端工具（画像里 `serverTools.openai: []`）。所以在智谱渠道上，联网只能来自应用自己调用的独立端点；
这类端点千问也有，适合抽象成与渠道无关的「联网服务」单独立项，而不是智谱渠道的一个开关。

智谱给了两种形态，本项目**现在只有第一种的框架**：

| | A. 对话内工具（端点执行） | B. 独立的搜索 / 阅读端点（应用执行） |
| --- | --- | --- |
| 报文 | 对话请求 `tools[]` 里一项 `{type:"web_search", web_search:{…}}` | `POST /api/paas/v4/web_search`、`POST /api/paas/v4/reader`，与对话无关 |
| 谁能用 | 只有这个渠道上的 GLM 模型 | **任何模型**——DeepSeek、本地 Ollama 都能借一把智谱 key 联网 |
| 本项目的位置 | `serverTools`（`lib/ai/serverTools.ts`）：按模型声明、端点执行、日志只读 | **没有这一类**：今天所有联网都是服务端工具；B 是第一批「应用自己发 HTTP 的联网工具」 |
| 看得见吗 | 默认意图识别会**没搜也说搜了**；须 `search_intent:false` | 结果是结构化数组，没搜就是 0 条，天然可记进执行日志 |
| 代价 | 结果整段灌进 prompt：`search_pro` 24k token、`search_std` 6.7k，`count` 无效，控制不住 | 应用自己截断：取前 N 条、摘要限长后再给模型，token 可控 |
| 网页阅读 | 对话内没有这个工具 | `reader` 返回 markdown 正文，补上「打开链接读全文」 |

**建议走 B**，理由是它补的是本项目的结构性缺口而不是一个厂商的开关：

1. **能力与模型解耦。** 现在「搜索子代理」只能绑在自带服务端搜索的模型上（`subAgentModel("search")` 查
   `serverToolsSent(...).includes("web_search")`）——DeepSeek、GLM、本地模型都绑不上。B 把联网变成应用的能力，任何
   模型都能用。
2. **结果由应用掌握。** 条数、正文长度、去重、来源展示都在应用这侧决定，不受 `count` 失效之累；「没搜」也不会被话术掩盖。
3. **阅读补上了没有的一环。** 千问的 `web_extractor` 必须和搜索绑在同一次请求里；`reader` 是独立的一次调用，可以只读作者贴来的链接。

B 要先回答的设计问题（所以是提案，不是这次顺手做）：

- **放在哪。** 两个应用执行的工具（暂名 `web_search` / `read_webpage`）进 `lib/agent/registry.ts`，只挂在搜索子代理上，
  不进 `AGENT_ASSIST_PRESET`——主预设的固定头成本有 `agentToolBudget.test.ts` 的棘轮，而且「委派给搜索子代理」已经是
  主代理的联网入口（[`agent-tool-context.md`](../feature/agent/agent-tool-context.md)、[`tool-presence.md`](../reference/tool-presence.md)）。
- **钥匙从哪来。** 子代理设置里选「联网服务：智谱」并指向一个 `zhipu` 渠道（复用它的 key），而不是再存一份。
- **要不要逐次批准。** 两个工具只读，但**按次计费**，且查询词会离开本机发给智谱。倾向：不逐次审批，但每次运行设调用上限，
  执行日志逐条记查询词与来源——与服务端搜索「开启即允许」的口径一致（`serverToolsHint` 的措辞）。
- **引擎与过滤。** 默认 `search_std` + `search_intent:false`；只在 `search_pro` / `sogou` 上发域名过滤（`std` 无视它），不发时间过滤
  （三个引擎都无视），`count` 不发、由应用截断。`reader` 只用 `markdown`（`text` 有损）。
- **错误。** `reader` 的 404 / 死链都是 500 `1234`，工具结果要写成「这个页面读不到」，不能让模型当成平台故障去重试。

A 作为补充仍可做（给直接在 GLM 上聊天、不走子代理的场景），拼法固定为 `search_std` + `search_intent:false` +
`search_result:true`，把响应顶层的 `web_search[]` 映射进日志；但它的 token 代价控制不住，优先级低于 B。

### P3 GLM Coding Plan 平台（`proposal`，缺：作者决定是否提供）

照火山方舟的做法另立 `zhipu-coding`：① `/api/coding/paas/v4`、④ `/api/anthropic`、② `/api/v1`，`hosts` 带路径前缀
区分。难点不在技术：**同一把 key 在两个平台都通**（不像方舟会 401 把选错的人拦下），而套餐条款写明「仅限指定
工具」、违规限流乃至封号——本应用不在它的工具清单里。提供它等于替作者承担条款风险，这个决定该作者来做。
另需一次 ②④ 的完整实测（本次各只探两次；② 的推理在 `content[].reasoning_text`，`responses.ts` 已处理
`response.reasoning_text.delta`，待流式实测确认）。

### P4 保留式思考的取舍（`proposal`，缺：一次对照实测）

量 `clear_thinking:false` + 本项目「只在工具轮内回传」对多轮长会话的影响；若无益，`glm` 类目的 `extra`
改为只在 DashScope 转发以外不发——或者反过来，让聊天历史保留 `_reasoning` 跨轮回传。二者都动 prompt 成本，
所以先量再定。

### P5 `json_schema` 的平台上限（`proposal`，低优先）

画像加「本平台无 `json_schema`」，抽屉里不给这一档或给出提示（G6）。温度上限（G7）同理可以按平台给，
但它会响（400 文案明确），不急。

### P6 ✅ 千问视觉旋钮归平台（2026-09-19，G12）

平台画像加 `qwenVisionParams`：只有千问两个平台为真；没有 host 的中转平台（New API、自定义）缺省为真，因为它们可能
转发千问；其余有 host 的平台（智谱、火山方舟、DeepSeek、xAI、OrcaRouter、Ollama……）缺省为假。它同时管三处：抽屉里的
两个控件（高分辨率读图、抽帧频率）、请求体（`openai.ts` 只在为真时发 `vl_high_resolution_images`；对话里片段的
`fps` 经 `sentVideoFps()` 取值，AgentChat 的 token 估算也用它）、「将发送」一行。已存的声明不迁移、不清除，只是在不认
它的平台上不发——与服务端工具「声明留在模型上、不认就不发」同一条规则；在抽屉里重新保存时随控件隐藏而清掉。

理由：这两个字段是千问的私有词汇，不是 Chat Completions 的；「按协议族判断」正是 `platforms.ts` 开头说的那种误把
`openai_compat` 读成千问的错误。视频输入本身**不**收窄：智谱实测读得出 `video_url`，按平台砍掉会丢一个真能用的能力。
OrcaRouter 背后可能也有千问，但它是有 host 的平台且没有实测，按「只在测过的平台上发私有字段」归为假。

## 5. 模型校准表（2026-09-19，全部 11 个 id 实测，逐项数据见 landscape.md 第十四个样本）

| 模型 | 类目 | 上下文 | 输出上限 | 类型 |
| --- | --- | --- | --- | --- |
| glm-5.3 | `glm` | 1M | 128K | 文本 |
| glm-5.3-flash · glm-5.3-flashx | `glm` | 1M | 128K | 多模态 + PDF |
| glm-5.2 | `glm-effort` | 1M | 128K | 文本 |
| glm-5.1 · glm-5 · glm-5-turbo | `glm-switch` | 200K | 128K | 文本 |
| glm-4.7 · glm-4.6 | `glm-switch` | 200K | 128K | 文本 |
| glm-4.5 | `glm-switch` | 128K | 96K（上限表取保守值；端点实际收到 128K） | 文本 |
| glm-4.5-air | `glm-switch` | 128K | 96K | 文本 |

上限表（`modelLimits.ts`）的 `glm-4.5` 行保持 98,304：它同时覆盖 4.5-flash / 4.5-x（文档都写 96K），取低值不会 400。
PDF 只在 5.3-flash 上实测过，flashx 按同一个模型的提速版推定。

**G11 的解法（2026-09-19 作者选定第二种，已实现）**：两个候选是 ① 把起步清单扩到全部 11 款（纯数据，但新建渠道时一次灌进
11 行）、② 平台画像加一张「模型 id → 类目 / 上下文 / 上限 / 类型 / PDF」校准表，按 id 预填。选 ② 的理由：作者手动添加或从
`/models` 拉取的那条路径才是 G11 发生的地方，起步清单管不到它；而且方舟、千问以后可以往同一张表里填，不必各自再发明一次。

落点与三条约束：

- **表在平台画像里**（`platforms.ts` 的 `models` / `ModelCalibration`，`platformModelCalibration()` 查），按精确 id（小写）匹配——
  这张表只描述这个平台自己的 id，不做前缀推断（`glm-4.5` 是 `glm-4.5-air` 的前缀，参数却不同）。
- **是预填，不是运行时默认。** 模型抽屉在作者点选拉取到的 id、或输完 id 离开输入框时写进表单；保存后与作者手填的值一样存进行里，
  线上发什么不再依赖这张表。所以不迁移旧行、不改「自动」的含义，改表也不会悄悄改变已存模型的请求。
- **只写作者没动过的字段。** 一个字段在「未设置」或「仍是上一次预填的值」时才归预填管：改错 id 会重新预填，作者手选的类目、
  手填的上限不会被覆盖。档位不预填（保持「跟随默认」＝端点默认）；但类目被预填换掉时，旧档位若不在新类目的菜单里，
  按与类目芯片同一规则（`reasoning.ts` 的 `effortForCategory`）纠正。
- 起步模型也从同一张表取值（`ProviderDrawer` 的 `zhipuStarter`），两处不会不一致；`platforms.test.ts` 断言表里的输出上限
  与 `modelLimits.ts` 的上限表一致。

**审查修正（2026-09-19，PR 审查时发现并修掉）**：

- **预填换了类目，档位也要跟着合法。** 先填 glm-5.2 选「关」，再改成 glm-5.3：类目换成 `glm`，档位却还是 `off`，
  请求发 `reasoning_effort:"none"`，GLM-5.3 对它 400（不能关思考），而且两个表盘上都没有高亮。修法：纠正规则从类目芯片的
  onClick 抽成 `effortForCategory()`，芯片与预填共用，菜单外的档位退回类目默认（`glm` → max），否则「跟随默认」。开关类
  类目（`glm-switch` / MiniMax / 千问开关）只看「关与不关」，任何档位都合法，原样保留——否则从别处带来的「关」会被悄悄变成开。
- **同一个 id 再失焦不重写。** 「未设置」同时也是作者能主动选的值（类目点回「自动」、关掉 PDF、清空上下文）；每次失焦都预填
  就会把这些手动选择悄悄改回去。修法：预填记住上次处理的 id（小写去空白），id 没变就不动。
- **host 带上标准路径。** 只写裸 host `open.bigmodel.cn` 时，作者手建的「自定义」渠道若走 Coding Plan 的
  `/api/coding/paas/v4` 或 `/api/anthropic`，会被推断成本平台：标上「按量扣余额」的平台名，并套用强制 `tool_choice` → `auto`
  的降级（4.5-air 本来能真强制）。改成 `open.bigmodel.cn/api/paas` 后，只有标准路径的完整 URL 推断为智谱。
  渠道抽屉的主机栏只存裸 host、本来就分不出两种计费，所以 `platformForAddress` 对裸 host 补一条：没有平台整名占这个 host 时，
  归「host 落在它上面」的那个平台——作者在智谱渠道里逐字重敲主机，中途经过「自定义」，敲完仍回到智谱（浏览器实测）。

## 6. 为什么不把旧代 GLM 放进 `deepseek` 类目

报文上 `deepseek` 类目碰巧可用（关发 `thinking.disabled`、开发 `reasoning_effort`）。但类目存在的理由是
「抽屉里的档位 = 端点真认的档位」（[`reasoning-plan.md`](reasoning-plan.md) §0）：在 4.7 上给出 low / high / max
三个效果完全相同的档位，正是类目要消灭的那种假控件。所以另立 `glm-switch`，只给开 / 关。
