# Provider 分层模型（协议族 / 端点 / 模型 + 探测维）

> **状态：现行架构决策。** 本文定义"一个新参数该放在哪一层"，是加新供应商、
> 加新协议族、加新能力字段（思考强度、多模态开关…）时的裁决依据。
>
> 与相邻文档的关系：
> - [`api/README.md`](README.md) + [`api/landscape.md`](landscape.md) —
>   **协议事实**（四个族各自长什么样），换个项目也成立，本文引用它不复制。
> - [`provider-standards.md`](provider-standards.md) — 2025 年那次把 `ApiStandard`
>   重构成 6 个值的**具体方案**（已实现）。本文是它隐含的分层的显式说法。
> - [`reasoning-plan.md`](reasoning-plan.md) — 第一个按本文裁决字段归属的功能。

## 1. 三层加一维

```
L1  协议族      四种 wire format                   服务商定义，调用方不可协商
L2  端点        baseUrl / 鉴权 / 族方言参数         作者配置的一行
L3  模型        能力、档位、上限、价格               端点下的一行
────────────────────────────────────────────────────────────────
探测维          真实行为的实测结果                   机器写入，不是配置
```

前三层是**包含关系**（一个端点属于一个协议族，一个模型属于一个端点），
探测维**正交**于三层——它记录的是"实际测出来是什么样"，可以挂在 L2 也可以挂在
L3，但它不是作者填的，因此不属于配置层。

### L1 协议族

四种：OpenAI Chat Completions、OpenAI Responses、Google GenAI、
Anthropic Messages。定义见 [`api/landscape.md`](landscape.md)。

**身份**：wire format 本身。判据是 [`api/README.md`](README.md) 里那条——
*能不能只改 URL 与鉴权头就跑通？能，就不是新族。*

一个族对应一个 adapter。**这是唯一允许存在"每族一份代码"的层。**

### L2 端点

**身份是「作者配置的那个端点」，不是「供应商品牌」。** 这是本文最容易被搞错的
一条，三个反例：

| 反例 | 说明 |
| --- | --- |
| 同一品牌，两个端点 | Google 的 Gemini Developer API（`x-goog-api-key`）与 Vertex AI（OAuth + 区域化域名）同族同厂，鉴权与 URL 完全不同。Azure OpenAI 对 OpenAI 同理。 |
| 同一模型，多条路可达 | DeepSeek 可直连、可走 OpenRouter、可走某个中继。**可用的扩展参数随路线变，不随品牌变**——走 OpenRouter 才有 `provider` 路由字段。 |
| 一个端点，多家模型 | 中继就是这个形态：一套 baseUrl + 一个 key，后面挂十几家的模型。品牌:端点是**多对多**。 |

所以品牌**不是一层**，是填这一层的**预设数据**（见 §4）。

L2 承载：`baseUrl`、鉴权方式、以及**协议族专属的方言参数中"整个端点共用"的那部分**。
`safetySettings` 是这里的标准样例——Gemini 族专属，同端点下所有模型共用一套阈值。

L2 还承载 official/compat 这个"我能乐观假设多少"的开关。它从来不是身份区分
（官方也只是一种 provider），而是**默认值的乐观程度**：官方端点地址与鉴权锁定、
可选能力假定存在；兼容端点地址自填、能力要么问要么降级。详见
[`provider-standards.md`](provider-standards.md) §2.2。

### L3 模型

**身份是「端点下的一个模型条目」。** 承载所有**同端点下逐模型不同**的东西：

- 能力：工具调用、多模态、结构化输出
- 限额：上下文窗口、输出上限
- 档位：思考强度可用档、能否关闭思考
- 价格

放错到 L2 会立刻穿帮：同一个中继下面 `gpt-5` 与 `qwen-turbo` 的能力毫无关系。

### 探测维

兼容端点的真实行为**声明不出来，只能实测**：`/models` 可不可信、
`stream_options.include_usage` 认不认、工具调用是不是真能用、真实上下文窗口多大。

把这些塞进 L2/L3 的配置字段，等于让作者手填一堆他自己也不知道的值。它们由探测
写入、带时间戳（测量会过期——中继明天可能把同一个模型名路由到另一个上游），
UI 呈现为"某日实测"而非永久事实。

## 2. 归属判断法

给一个新参数定层，按顺序问：

| 问 | 答"是" → |
| --- | --- |
| 它决定 body 的形状本身吗？ | **L1 协议族** |
| 换一个 API key / baseUrl 会变吗？ | **L2 端点** |
| 同一端点下换个模型会变吗？ | **L3 模型** |
| 作者答不上来，只能发个请求试？ | **探测维**（不是配置） |

两条补充规则：

- **同时命中 L2 和 L3 的，放 L3。** 粒度细的那层永远能表达粗的，反过来不行。
  代价是重复填写，用 preset 或"从端点继承"的默认值缓解，而不是把字段上移。
- **同时命中配置层和探测维的，两边都要有位置。** 配置是作者的意图，探测是实测的
  事实，两者会不一致（作者填了 128k，实测只有 32k），冲突处理是产品决策不是
  数据模型问题。现有的 `contextSize` + `probedAt` 就是这个形态。

## 3. 字段归属现状

| 层 | 现有载体 | 已有字段 |
| --- | --- | --- |
| L1 | `ApiStandard` / `familyOf()` / 三个 adapter | — |
| L2 | `Provider` 行 + `lib/ai/urls.ts` | `baseUrl`、`apiStandard`、`authMode`、`safetySettings` |
| L3 | `Model` 行 | `contextSize`、`maxOutput`、`caps`、`prefix`、价格三项 |
| 探测 | `endpointProbe` / `probeAnalysis` / `modelHealth` | `Model.probedAt` |

已知缺口：

1. **L1 少一个族** —— OpenAI Responses 尚未实现，当前三个 adapter 覆盖四族中的三族。
   接它是加第四个 adapter，不是改现有的。
2. **L2 没有通用的 preset 机制** —— 目前只有 Ollama 一个硬编码预设。
3. **L3 缺能力字段** —— 思考强度档位等，见 [`reasoning-plan.md`](reasoning-plan.md) §4.1。
4. **探测维与 L2/L3 的关系没文档化** —— 谁覆盖谁、什么时候重测、过期怎么呈现。

## 4. L2 必须是数据，不能是代码

最容易走歪的地方：把"第二层封装"实现成每家一个 adapter 子类
（`DeepSeekProvider extends OpenAIProvider`）。

**不要这样做。** 第三方之间相同点 99%、不同点 1%，用继承会把那 99% 复制成 N 份，
之后每次协议演进要改 N 处；而那 1% 的差异（一个 header、一个额外字段、一个
不支持的参数）本来用一行配置就能表达。

正确形态：**运行时永远只有"每个协议族一个 adapter"；"某一家"是一张预设表**，
预填 baseUrl、鉴权方式、已知的扩展开关、模型列表种子。加一家新供应商 =
加一行数据，不是加一个文件。这与 [`provider-standards.md`](provider-standards.md)
§2.3 对 Ollama 的既有结论是同一条：**保持 preset，不升为枚举。**

推论：**枚举值是稀缺的。** 只有当"body 形状不同"时才配拥有一个 `ApiStandard`
值；鉴权不同、默认值不同、私有字段不同，全都用 L2 的数据字段表达。

## 5. 私有扩展参数怎么放

第三方在 Chat Completions 上的私有扩展（DeepSeek 的 `thinking`、OpenRouter 的
`provider` 路由与 `reasoning`）是 L2/L3 的常客，但**不要为每一个私有字段加一个
配置项**——那等于把中继的产品文档抄进设置界面。

分三类处理：

| 类别 | 例子 | 处理 |
| --- | --- | --- |
| **有跨族对应物** | DeepSeek `thinking` / OpenAI `reasoning_effort` / Anthropic `output_config.effort` | 抽象成本项目自己的语义（如"思考强度"六档），各 adapter 负责映射。作者看到的是概念，不是字段名。 |
| **单家独有但值得配** | OpenRouter 的 `provider` 路由偏好 | L2 的一个可选字段，仅该 preset 下显示 |
| **长尾** | 其余一切 | 不做 UI。真要用就走请求级 `extraBody`，不进配置层。 |

判据是**"它在别的族里有没有对应概念"**：有，就抽象；没有，就要么专属字段要么不做。

## 6. 代码对照与偏离（2026-08-13 审计）

### 遵守得好的

1. **L1 边界几乎无泄漏。** 全仓库每一处 `case "gemini"` / `case "anthropic"` 都在
   `switch (familyOf(...))` 之内。唯一按原始 `ApiStandard` 分叉的
   `defaultImageCaps` **不是违规**——它问的是"默认该多乐观"，属于 official/compat
   的问题，正是 L2 的职责。
2. **L2 preset 确实是数据。** `PROVIDER_PRESETS` 是一个五行数组，DeepSeek 与
   Ollama 在里面没有任何特权。符合 §4。
3. **品牌名没有渗进运行时分支。** 只出现在注释与探测启发式里。唯一的运行时
   本地端点判断按 **URL 形态**而非品牌名，写法正确。

### 偏离一：L2×L3 → 请求 的组装被复制了 18 处 ✅ 已修

每个调用点手工摊平同样的九个字段（`baseUrl` / `apiKey` / `standard` /
`safetySettings` / `authMode` / `modelId` / `prefix` / `contextSize` /
`maxOutput`），另有 **8 个参数类型**把这九个字段**重新声明**了一遍：
`AgentRuntimeOptions`、`StructuredTaskArgs`、`ScanArgs`、
`DescribeLoreImageOptions`、`ImagePromptOptions`、`SummarizeRequestConfig`，
以及 `generateLore` / `splitLore` 的内联参数类型。

其中两处的注释已经自陈了这件事——`ScanArgs` 写着 "same shape every structured
task takes"，`SummarizeRequestConfig` 写着 "same fields sendChat holds"。看见了，
但没有地方可以收。

**为什么是分层问题而非普通重复**：这些字段全部可选，漏掉一处**不会有编译错误，
只会静默地行为不一致**。任何新增的 L2/L3 字段都要在 18 个地方赌记忆力。

修法：`lib/ai/conn.ts` 提供 `AiConn`（L2+L3+密钥的三元组）与 `ConnOptions`
（传输配置，即 `StreamOptions` 中来自配置层的那一半），八个参数类型改为
`extends ConnOptions`。**新增 L2/L3 传输字段今后只改 `ConnOptions`、
`connOptions()`、`pickConnOptions()` 三处，且它们在同一个文件里。**

`pickConnOptions` 与 `connOptions` 是两份手写字段表，类型系统查不出它们的分歧
（漏掉的字段必然是可选的），所以由 `__tests__/aiConn.test.ts` 的往返测试盯着。

**未纳入**：`ImageConn`（图像端点不接受 `prefix`/`contextSize`/`maxOutput`，且多
一个 `route`）与探测目标（没有 `Model` 行）。两者是有意的不同形状，不是遗漏。

### 偏离二：模型解析有四份实现 ✅ 已修

`lore/aiTask.ts`、`memoryStore`、`consistencyStore`、`aiTaskStore` 各有一份
"从 id 找 model 再找 provider"的代码与各自的错误文案（其中一处把三种失败
都报成"未选择模型"）。收敛为 `resolveConn()`。

### 偏离三：探测维没有自己的位置

- **探测结果与作者配置共用字段。** 测出的 `contextSize`/`maxOutput` 直接覆盖
  `Model` 的同名字段，只留 `probedAt` 标记来源。§2 的补充规则说"两边都要有
  位置"，现在只有一个：作者填的值被覆盖后不可恢复，也无法回答"这个 128k 是
  填的还是测的"。
- **探测状态分三处存**：`Model.probedAt` 在 config.db、`modelHealth` 的
  blocked/recent 在 prefs、`endpointProbe` 的完整报告（多来源、多候选、判据）
  **不持久化**，apply 完两个数字就丢。

**未修**，因为它需要先决定 §7 的第一条未决问题。

### 偏离四：L2→L3 的隐式继承已经存在一处

`ImageCaps.route` 未设时由 provider 的 `apiStandard` 推导，而 `configDb.ts`
的注释自陈了后果：*"对官方端点对，对中继上托管 Gemini 图像模型的情况错"*。

§7 把"L2 继承默认值给 L3"列为未决且倾向不做，但代码里已经做了一次，并且已经
踩到它的失败模式。**认领为允许的模式**，附两条约束：继承值必须可被 L3 显式
覆盖，且必须能区分"未设"与"继承来的"（`route` 恰好满足两条）。

### 偏离五：L1 缺 Responses 族

已知缺口，非偏离。三个 adapter 覆盖四族中的三族。

## 7. 未决

- **探测结果与作者配置冲突时以谁为准**，以及探测值多久算过期。现在两者都写进
  `Model` 的同一批字段，只靠 `probedAt` 区分来源。
- **preset 机制的形态** —— 内置表、可导入、还是允许作者另存为模板。
- **L2 继承默认值给 L3** 要不要做（比如端点级的"默认思考强度"）。倾向于不做：
  多一层默认值来源就多一份"为什么它是这个值"的困惑。
