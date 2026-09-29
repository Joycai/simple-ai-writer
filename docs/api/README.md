# LLM API 对接知识库

> 状态：`living`。
>
> **这个目录写"业内是什么样"，不写"本项目怎么选"。**
>
> 两者混在一起是本项目此前的问题：`provider-standards.md` 里那些关于三个协议族
> 实际差异的描述，本身是通用知识，却被写在一份"重构方案"里，跟着那次重构的
> 结论一起过期。所以这里立一条硬规矩：
>
> - **`docs/api/`** — 协议事实。四个协议族各自长什么样、彼此差在哪、第三方
>   兼容层的坑在哪。不含本项目的取舍、不含 `src/` 的文件名。
> - **方案文档**（`*-plan.md` 与能力判定那一组，**同在本目录**）— 本项目的方案与取舍。引用
>   协议事实，不复制。两类文档的分组见下方[索引](#索引)。
>
> 判断标准：**换一个项目还成立的，写这里；只对本项目成立的，写那边。**

## 调研一个 provider / 模型的能力：先读文档，再测，最后回写

新接一个 provider、或核实某个模型某项能力（思考档位、工具、结构化输出、多模态……），**只按这三步走**：

1. **读官方文档。** 这个模型支持什么、怎么开关、有哪几档、默认是哪档——厂商文档（含模型页、
   错误码表、拒绝报文里点名的枚举）通常已经写明。记下链接与日期。文档没列的档位，就当它没有。
2. **调 API，只测文档列出的东西**，确认官方说的档位真的有效：请求被收下，并且档位之间可观测地
   不同。文档与实测冲突时以实测为准，两者都记。
3. **回写文档。** 结论落进本目录对应的一份；逐家的实测落成 [`landscape.md`](landscape.md) §7 的
   下一个编号样本，开头先写第 1 步查到的文档链接与档位。

两类知识的分工：**模型有哪几档、怎么开关，问官方文档；某条线路（中继、兼容层）有没有照做，
问实测。** 中继丢字段、改写字段，是那条线路的事实——按同样三步测一次、记一次，不在那条线路上
换写法去试。

**反模式**：跳过第 1 步，从「我要把它关掉 / 打开」出发，一种写法不行换一种（`disabled` →
`reasoning_effort` → `enable_thinking` → 最低档……），最后记一笔「待后续验证」。这样攒下的是一串
「某写法在某处无效」，回答不了「这个模型有哪几档、每档有没有用」。思考档位的细则与实例见
[`reasoning.md`](reasoning.md) §0。

## 四个协议族

业内主流的模型 API body 形状收敛成了四种。它们不是"同一件事的四种方言"——
消息容器、system 的放法、工具结果的关联方式、流式的机制各不相同，一个 adapter
换不到另一族去。

| # | 协议族 | 端点 | 谁在用 |
| --- | --- | --- | --- |
| 1 | **OpenAI Chat Completions** | `POST /v1/chat/completions` | OpenAI + 事实上全行业的兼容层 |
| 2 | **OpenAI Responses** | `POST /v1/responses` | OpenAI 自家新接口（有状态） |
| 3 | **Google GenAI** | `POST /v1beta/models/{model}:generateContent` | Gemini Developer API / Vertex AI |
| 4 | **Anthropic Messages** | `POST /v1/messages` | Claude API / Bedrock / Vertex |

Chat Completions 和 Responses 同属 OpenAI 却分成两族，是因为它们的差别
（`input` vs `messages`、扁平 vs 嵌套的工具定义、类型化事件流 vs delta 拼接、
服务端存不存状态）比 Gemini 与 Anthropic 之间的差别还大。合并会让后面每一张
对照表都要开例外。

详见 [`landscape.md`](landscape.md)。

本项目另接了一种**厂商自有格式**——DashScope 原生（`input` + `parameters` 两段式）。它不算业内的第五个
协议族，事实在 [`landscape.md`](landscape.md) §8，接进来的理由在 [`dashscope-native-plan.md`](dashscope-native-plan.md)。

## 三个正交的轴

对接一个端点时要同时回答三个互不相关的问题，混为一谈是大多数踩坑的来源：

1. **协议族** —— body 长什么样。上面那四个。
2. **部署** —— 同一族的 body，换个地方托管：URL 形状、鉴权方式、模型标识都会变，
   body 基本不变。Azure OpenAI、Vertex AI、Bedrock 属于这一轴。
3. **马甲** —— 谁"兼容"了谁。第三方厂商与中继绝大多数选择兼容
   **Chat Completions**，但兼容 ≠ 等价：各家有私有扩展（DeepSeek 的
   `reasoning_content`、OpenRouter 的 `provider` 路由）也有缺失（`stream_options`、
   `/models`、工具调用）。**这一轴的偏差**没有任何官方文档会写，只能实测攒——但模型本身
   有哪几档、怎么开关，仍先查原厂文档（见上一节的三步）。

## 本目录不覆盖

- **AWS Bedrock Converse** —— 它其实是又一种独立 body（与本项目接的 DashScope 原生不是一回事；见
  [`landscape.md`](landscape.md) §8），但需要 SigV4 签名，本项目短期不会接。
  记录存在性即可，不展开。
- **MCP** —— 工具与上下文的协议，与模型 API 正交，不在这一层。
- **OpenAI Realtime / 各家语音通道** —— WebSocket/WebRTC，不是请求-响应模型。
- **Embedding / rerank / 微调端点** —— 另一组端点，与对话补全无关。

## 索引

状态栏用 [`docs/README.md`](../README.md) 开头那张词表里的词，与各文档自己的状态行一致（`docStatus.test.ts` 核对）。

### 协议事实（换一个项目还成立）

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| [`landscape.md`](landscape.md) | 四族总览、逐族骨架、部署变体；§7 马甲层——逐家、逐条线路的实测样本（开头有按厂商的索引）；§8 仍存活的自有格式 | `living` |
| [`tools.md`](tools.md) | 工具定义 / 调用 / 结果回传 / tool_choice 四族对照，含配对硬要求 | `living` |
| [`streaming.md`](streaming.md) | SSE 机制、结束原因、**失败怎么送达**（四种「看起来成功」的失败） | `living` |
| [`reasoning.md`](reasoning.md) | §0 核实思考档位的三步（先读文档再测）；思考强度、思维链取回、以及**回传义务**（唯一会让请求被拒的一件） | `living` |
| [`usage.md`](usage.md) | token 计数的两个口径陷阱、输出上限、上下文窗口为何只能靠探测 | `living` |
| [`structured.md`](structured.md) | JSON mode / schema / 强制 tool_choice 的四族做法，含 `json_object` 的隐藏前置条件 | `living` |
| [`responses.md`](responses.md) | ② 族的骨架、字段、流式事件序列、回传与错误——GPT-5.4 / 5.5 / 5.6 经中转站实测；§10 是 5.6 的新字段与内置 `web_search` | `living` |
| [`tool-search.md`](tool-search.md) | 工具按需加载（tool search / `defer_loading`）的各族对照：形状、缓存、回传、限制（文档调研，未实测） | `living` |

### 本项目的取舍：架构

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| [`provider-layering.md`](provider-layering.md) | 分层模型（协议族 / 端点 / 模型 + 探测维）与「新参数放哪一层」的裁决——**加 provider、族或能力之前先读** | `living` |
| [`provider-standards.md`](provider-standards.md) | 协议族 × official / compat 怎么落成 `ApiStandard` 值（设计记录） | `shipped` |
| [`reasoning-plan.md`](reasoning-plan.md) | 思考强度与思维链：四族的写侧、读侧、回传与面板控件；写侧按厂商的**思考类目**而非一套抽象档位 | `shipped` |
| [`structured-output-plan.md`](structured-output-plan.md) | 逐模型的结构化输出声明（自动 / 关闭 / JSON 模式 / JSON Schema）与「自动」档怎么从 400 学 | `shipped` |
| [`refusal-plan.md`](refusal-plan.md) | 被拒请求的报文：五个适配器共用一个读取器——认哪些形状、留下什么、为什么不与连接测试的判据合并；事实在 `streaming.md` §3.5 | `shipped` |

### 本项目的取舍：能力判定（一个系统，四份文档）

按这个顺序读：先看现状，再看决定，然后是实现，最后是由来。

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| [`capability-matrix.md`](capability-matrix.md) | **现状**：能力表的渲染结果（每个能力一张 平台 × 协议族 表，带原因码）；由测试生成，勿手改 | `living` |
| [`capability-resolution-hld.md`](capability-resolution-hld.md) | **决定**：能力解析层的重构与作者拍板的七个决定（D1–D7） | `shipped` |
| [`capability-resolution-lld.md`](capability-resolution-lld.md) | **实现**：HLD 的逐模块设计与分片（P0–P7） | `shipped` |
| [`capability-gating-plan.md`](capability-gating-plan.md) | **由来**：「能不能 X」原先在四处各算一遍引出的三类缺陷，与能力表、裁决函数、三道闸（C0–C4） | `shipped` |

### 本项目的取舍：按协议族与厂商

实测事实在 `landscape.md` §7 对应的样本里，这里只放本项目据此做了什么。

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| [`anthropic-plan.md`](anthropic-plan.md) | ④ 族的审计与接入，含 MiniMax-M3 的方言（§10）；§7 待实测 | `shipped` |
| [`gemini-plan.md`](gemini-plan.md) | ③ 族的盘点与接入（Gemini 3+）；§5 待实测 | `shipped` |
| [`gpt56-plan.md`](gpt56-plan.md) | GPT-5.6 支持度盘点：已通的、缺口、逐条方案 | `partial` |
| [`qianwen-compat-plan.md`](qianwen-compat-plan.md) | 千问AI平台的逐模型实测后的修复切片，以及接入 ② 族（Responses）的决定 | `shipped` |
| [`dashscope-native-plan.md`](dashscope-native-plan.md) | 百炼新地址、Token Plan 平台，与 DashScope 原生格式为什么接、为什么不复用 ① 的适配器 | `shipped` |
| [`zhipu-plan.md`](zhipu-plan.md) | 智谱 BigModel：原样可用的、十个缺口、P1（已做）与 P2–P5 方案 | `partial` |
| [`orcarouter-probe-plan.md`](orcarouter-probe-plan.md) | OrcaRouter 四个面的付费实测：哪些观察算厂商行为、落地的三处修复 | `shipped` |

思考支持还差的实测汇总在 [`../issues/thinking-verification.md`](../issues/thinking-verification.md)（`open`）。

## 接一个新协议族时，先看这四条

两轮实践（① 族与 ④ 族）下来重复出现的形态，比任何单条协议事实都耐用：

**① 先问"失败会不会响"。** 这决定了紧迫性与验证方式：

| 族 | 做错了会怎样 |
| --- | --- |
| ① DeepSeek 系 | 工具轮不回传 `reasoning_content` → **400**，会逼你修 |
| ④ Anthropic | 工具轮不回传 thinking block → **静默关掉思考**，没有任何现象 |
| ③ Gemini | 不回传 `thoughtSignature` → 多轮工具调用失效 |

**静默的那种最危险**：它不会自己暴露，只能靠对照文档发现，也只能靠"响应里
还有没有 thinking block"这类间接观察来验证。

**② 再问"默认值是什么"，而且要按模型问。** 三族都有"同一段代码在两代模型上
行为相反且都不报错"的情况：Anthropic 的思考默认值分两派、`display` 默认
`omitted`（拿不到文本却照全额计费）、Gemini 2.5 Pro 关不掉思考。**"省略字段
= 用默认"从来不是一个统一的答案。**

**③ 然后问"兼容层砍了什么"。** 各家样本的共同
规律见 [`landscape.md`](landscape.md) §7。最狠的一次是 MiniMax 的 ④ 族端点
**砍掉了 `tool_choice` 的强制档**，直接让"强制工具调用"这个四族官方都有的
手段失效。**兼容层文档不能当能力清单**：没列既可能是不支持，也可能只是没跟上。

**④ 一条读文档的方法：指南页与参考页要分开读。**

- **指南页**（`docs/*`）反映"官方希望你怎么用"。它会为了推新 surface 而不提
  旧的 —— Gemini 3 的思考指南只讲 Interactions API，读完会以为经典
  `generateContent` 上没法配思考。
- **参考页**（`api/*`）反映"接口实际接受什么"。`ThinkingConfig` 在参考页里
  定义得完整无缺。

**判断能力边界看参考页，不看指南页。**

配套的一条操作习惯：**大文档要抓原文自己搜**。那份参考页 295KB，网页摘要工具
连着两次都没扫到 `ThinkingConfig`；`curl` 下来 grep 一次就找到了。摘要在这个
量级会整节丢失，而丢掉的恰好可能是唯一的权威定义。

## 写作约定

- **每条协议事实都要能被一次 HTTP 请求验证。** 写不出请求骨架的描述说明还没搞清楚。
- **区分"文档写了"和"实际如此"。** 兼容层的行为常与文档不符；实测结论标注
  「实测」并写明日期与端点，别与官方文档混排。
- **不写 `src/` 的路径。** 需要指向实现时，在方案文档里指，不在这里指——否则
  这份知识会随重构烂掉。本项目在某处怎么做，写一句「见 某方案文档 §x」即可。
  **唯一的例外是实测出处**：可以写 `live.*.test.ts` 的文件名（不带目录），因为它就是那次
  请求的可复现版本——「每条事实都能被一次请求验证」靠的正是它。
- **过期比缺失更糟。** 模型代次相关的结论（哪些模型支持哪个档位之类）写"截至
  某日期"，或干脆不写具体型号，只写机制。
