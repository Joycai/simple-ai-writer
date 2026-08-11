# Provider 协议标准重构方案（3 协议 × official/compat）

> **状态：已全部实现**（PR #119 / #120 / #121 / #122，见 §8）。本文保留为设计
> 依据 —— 那些"为什么是这样而不是那样"的取舍不在代码注释里就没有别处可查。
> 与实现不一致的地方以代码为准，并请顺手改这里。

> 目标：把 `ApiStandard` 从今天的 4 个值（其中一对是空壳）重构成
> **3 个协议族 × official/compat = 6 个值**，让 official 有明确契约（地址锁定、
> 鉴权锁定、能力默认值乐观），compat 承载"接第三方兼容端点"的全部弹性
> （地址自填、鉴权可选、探测可降级、默认值保守）。
>
> 直接动机：第三方 Anthropic 兼容端点**当前接不通**（§1.3），而修复所需的
> 行为差异没有地方安放 —— 官方端点不能跟着一起改。

## 1. 现状盘点

### 1.1 枚举与分发

`ApiStandard = "openai" | "openai_compat" | "gemini" | "anthropic"`（`lib/ai/types.ts:11`）。

分发只有三条（`lib/ai/index.ts:35-41`）：`gemini` → `streamGemini`，
`anthropic` → `streamAnthropic`，**其余全部（含未知值）** → `streamOpenAI`。

### 1.2 三个协议族的实际差异

| | 鉴权 | 流式请求 URL | 模型列表 |
| --- | --- | --- | --- |
| OpenAI 系 | `Authorization: Bearer`（无 key 时整个头省略，`openai.ts:16`） | `base` + `/chat/completions` | `base` + `/models` |
| Gemini | `x-goog-api-key` 头（`gemini.ts:158`；注释明确拒绝 `?key=`，避免泄进日志） | `base` + `/models/{id}:streamGenerateContent?alt=sse` | `base` + `/models` |
| Anthropic | `x-api-key` + `anthropic-version` + `anthropic-dangerous-direct-browser-access`（`anthropic.ts:51-58`） | `base` + `/messages` | `base` + `/models` |

各族默认 base：`DEFAULT_GEMINI_BASE`（`gemini.ts:89`）、`DEFAULT_ANTHROPIC_BASE`
（`anthropic.ts:26`）；OpenAI **没有**默认常量，靠 `aiTaskStore.ts:663-669` 兜底。
Gemini 的默认值还在 `providerProbe.ts:11` 和 `endpointProbe.ts:37` 各抄了一份。

### 1.3 为什么第三方 Anthropic 端点接不通

三个独立原因，都不在报文层（报文构造本身符合 Messages API 规范）：

1. **baseUrl 语义与生态相反。** `anthropic.ts:304-305` 拼的是 `base + /messages`，
   因此 base 必须自带 `/v1`。而生态里的 `ANTHROPIC_BASE_URL`（官方 SDK、
   Claude Code、所有第三方文档）是**根地址**，由客户端补 `/v1/messages`。用户
   照文档粘贴 `https://xxx/anthropic`，实际打到 `.../anthropic/messages` → 404。
2. **只发 `x-api-key`。** 生态有两套约定：`ANTHROPIC_API_KEY` → `x-api-key`，
   `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`。大量第三方网关只认后者 → 401。
3. **连接测试与模型列表都打 `/models`**（`providerProbe.ts:32-43,75-83`）。很多兼容
   端点只实现 `/v1/messages`，没有 `/v1/models` → 即使正文可用，"测试连接"也失败、
   模型下拉框为空。

### 1.4 `openai` 与 `openai_compat` 今天几乎没有差异

全仓库两者被区别对待的地方只有 **一处**：`configDb.ts:40-60` 的图像能力默认值
（official `{edit:true,maxRefs:16}` / compat `{edit:false}`）。此外仅有 UI 预设地址
（`ProviderDrawer.tsx:17-22`）和"未知值兜底成 compat"（`configDb.ts:352`）。
`providerProbe.ts:85` 把两者写在同一个 if 里，`streamOpenAI` 完全不区分。

**结论：直接扩成 6 个值而不定义 official 契约，只会得到 6 个值 + 3 种行为。**

### 1.5 按 standard 分叉的全部位置

重构时必须逐一覆盖：

| 位置 | 作用 |
| --- | --- |
| `lib/ai/index.ts:35-41` | 适配器分发 |
| `lib/ai/types.ts:11` | 枚举定义 |
| `lib/ai/jsonMode.ts:22-51` | JSON 模式：OpenAI 系 `response_format` / Gemini `responseMimeType` / Anthropic 无参数（发了 400），并决定是否追加文本提示 |
| `lib/ai/configDb.ts:40-60` | 图像能力默认值 |
| `lib/ai/configDb.ts:339,352` | 读取白名单 + 未知值兜底 |
| `lib/ai/configTransfer.ts:122` | 导入白名单 |
| `lib/ai/providerProbe.ts:19,32,64,75,85` | 模型列表 + 连接测试 |
| `lib/ai/endpointProbe.ts:280-298,318-370,500+,606` | 端点能力探测的鉴权头/base/请求体/跳过规则 |
| `lib/ai/image.ts:39-42,212` | 图像路由默认值 |
| `stores/aiTaskStore.ts:663-669` | 默认 baseUrl |
| `components/settings/panes/ProviderDrawer.tsx:17-22,30-36,69-74,102,209` | 端点预设、供应商预设、下拉选项、safetySettings 归属 |
| `components/onboarding/Onboarding.tsx:33-35` | 引导页预设 |
| `i18n/locales/{en,zh-CN}.json` → `aiConfig.apiStandards` | 显示名 |

### 1.6 本地服务（Ollama / LM Studio）不是枚举

它的全部特殊行为都由 **"URL 指向本机"** 推导：

- `ProviderDrawer.tsx:38-41,78` —— 本地则 API key 变可选
- `lib/http.ts:46-63` —— 本地则覆盖 `Origin` 头（打包版 Windows 下 Ollama 403 的修复）
- `lib/ai/endpointProbe.ts` 的 `looksLocal` —— 额外用常见本地端口做启发
- `ProviderDrawer.tsx:35`、`Onboarding.tsx:35` —— 只是一条 `openai_compat` 预设

## 2. 目标模型

### 2.1 六个枚举值

```ts
export type ApiStandard =
  | "openai"  | "openai_compat"
  | "gemini"  | "gemini_compat"
  | "anthropic" | "anthropic_compat";
```

### 2.2 official / compat 契约

| | official | compat |
| --- | --- | --- |
| baseUrl | **锁定**：UI 只读展示常量，存储写空串，由适配器 fallback | 用户自填，按 §3 归一化 |
| 鉴权 | **锁定**为该协议的官方方式 | 下拉可选（选项集见 §4） |
| 能力默认值 | 乐观（如 OpenAI 图像 `{edit:true,maxRefs:16}`） | 保守（`{edit:false}`），**除非该能力是协议本身的性质** |
| `/models` 缺失 | 视为错误 | 降级探测（§5） |
| 额外请求头 | 官方需要的全带（如 `anthropic-dangerous-direct-browser-access`） | 只带协议必需的 |

那条"除非"是有分量的，不是措辞留白。`openai_compat` 的 `{edit:false}` 之所以对，
是因为 OpenAI 把编辑放在**另一个端点**（`/images/edits`，multipart），中转常常
只实现 `/images/generations`；而 Gemini 的编辑就是同一次 `:generateContent` 调用
多挂几个 part —— **没有第二个端点可缺**，所以 `gemini_compat` 跟着 official 取
乐观值。判断依据是"这个能力有没有独立的东西可缺失"，不是"是不是 compat"。

official 的 baseUrl **存空串而非常量**：域名变更时不需要数据迁移，且和
`aiTaskStore.ts:663-669` 现有的"空串 = 让适配器用自己的默认值"约定一致。
读取端两种都接受（存量行存着完整 URL，照常工作）。

> 待办：`streamOpenAI` 目前没有默认 base 常量，需补 `DEFAULT_OPENAI_BASE`
> （`https://api.openai.com/v1`）并在 `openai.ts:9` 做同样的 fallback。
> 同时把 Gemini 默认值的三份拷贝（`gemini.ts:89`、`providerProbe.ts:11`、
> `endpointProbe.ts:37`）收敛成一处 import。

### 2.3 Ollama：保持 preset，不升为枚举

**本方案不新增 `ollama` 枚举值**，理由：

1. 它的特殊行为全部由"URL 是本机"推导，而 `lib/http.ts` 的 Origin 覆盖位于
   更底层，拿不到 provider 的枚举值 —— 只能按 URL 判断。做成枚举会出现两套
   判断，且允许"选了 Ollama 却填远程地址"的矛盾状态。
2. 协议上它就是 OpenAI 兼容层（`/v1/chat/completions`），没有第四种报文。

**唯一值得推翻这个决定的场景**：想要读 Ollama 的**原生** API（`/api/tags` 列出本机
已下载模型、`/api/pull` 下载进度）。那是另一套端点，届时应新增 `ollama` 枚举，
而不是继续挂在 compat 下。此项列为未决问题（§9）。

## 3. URL 归一化规则

三个协议族的生态约定**不同**，所以归一化规则不对称 —— 这是有依据的差异，不是随意：

- OpenAI 生态的 base 惯例**含版本段**（`OPENAI_BASE_URL=https://api.openai.com/v1`）
- Gemini 同理（`.../v1beta`）
- Anthropic 生态的 base 惯例是**根地址**（`ANTHROPIC_BASE_URL`，由客户端补 `/v1`）

### 3.1 official 锁定值

| 协议 | 锁定 base |
| --- | --- |
| openai | `https://api.openai.com/v1` |
| gemini | `https://generativelanguage.googleapis.com/v1beta` |
| anthropic | `https://api.anthropic.com/v1`（内部仍按 §3.2 拼成 `/v1/messages`） |

### 3.2 anthropic_compat（重点，本次修复的核心）

归一到"根"，再由适配器拼版本段：

```
root = input.trim()
     去尾部 "/"
     若以 "/messages" 结尾 → 去掉
     若以 "/v1" 结尾       → 去掉
请求 URL = root + "/v1/messages"
模型列表 = root + "/v1/models"
```

覆盖用户可能粘贴的三种写法：

| 用户填入 | 实际请求 |
| --- | --- |
| `https://xxx.com/anthropic` | `https://xxx.com/anthropic/v1/messages` |
| `https://xxx.com/v1` | `https://xxx.com/v1/messages` |
| `https://xxx.com/v1/messages` | `https://xxx.com/v1/messages` |

代价：若某个中转真的把接口放在根下的 `/messages`（无 `/v1`），本规则会打错。
这不符合 Anthropic 规范，且错误信息里会带上实际 URL（§3.5），可诊断。

### 3.3 openai_compat

**保持现状**（仅去尾斜杠，拼 `/chat/completions`）。不自动补 `/v1`：OpenAI 生态的
base 惯例本就含版本段，自动补会破坏存量配置（如 `https://api.deepseek.com`
这类两种写法都支持的端点）。

### 3.4 gemini_compat

仅去尾斜杠；若以 `/models` 结尾则去掉。**不自动补 `/v1beta`** —— 中转对
Gemini 原生协议的路径前缀没有统一惯例，猜错的代价高于收益。

### 3.5 错误信息带上 URL

三个适配器的 `throw new Error(...)`（`anthropic.ts:340`、`openai.ts:31`、gemini 同位置）
都改为带上实际请求的 URL。§1.3 的 1 号问题只要错误里出现
`.../anthropic/messages` 就能一眼诊断，现在用户只看到 404 和一段 HTML。

## 4. 鉴权矩阵

三家的"第二种方式"性质完全不同，**不做统一抽象**，每个 compat 的下拉选项集独立：

| 协议 | 方式 A（官方 / 默认） | 方式 B | 本版是否给 UI |
| --- | --- | --- | --- |
| Anthropic | `x-api-key: <key>` | `Authorization: Bearer <token>`（`ANTHROPIC_AUTH_TOKEN`） | **给**：A / B / 两者都发 |
| OpenAI | `Authorization: Bearer` | `api-key: <key>`（Azure） | 不给（见下） |
| Gemini | `x-goog-api-key` 头 | `?key=<key>` 查询串 | 不给（见下） |

- **Anthropic 必须做**：方式 B 是生态一等公民，大量第三方只认它。允许"两者都发"
  是因为部分网关行为不明；但**官方端点绝不能双发**（同时出现两种凭证会 401），
  所以这个选项只在 `anthropic_compat` 下存在。
- **OpenAI 暂不做**：方式 B 只对 Azure 有意义，而 Azure 的 URL 结构也完全不同
  （`/openai/deployments/{id}/chat/completions?api-version=`），只加一个头救不了它。
  要支持应当单独做 Azure，不在本方案范围内。
- **Gemini 暂不做**：方式 B 是**故意**不实现的（`gemini.ts:109-110`、
  `providerProbe.ts:21-22` 都写了原因：查询串会进代理日志和报错信息）。若将来要给，
  必须标注风险且不得设为默认。

### 4.1 数据模型

`Provider` 新增可选字段：

```ts
/** compat 端点的鉴权方式；official 与未配置过的供应商恒为 undefined。 */
authMode?: "default" | "bearer" | "both";
```

`default` = 该协议自己的方式（Anthropic 即 `x-api-key`）。**实现时去掉了原计划里
的 `x_api_key`**：它和 `default` 在 Anthropic 下完全同义，两个值表示同一件事只会
让"存了哪个"变成一个需要回答的问题。

存储：`providers` 表新增 `auth_mode TEXT` 列，复用现有的 `addColumn` 幂等迁移助手
（`configDb.ts`，`safety_settings` 就是这么加的）。`default` **存 NULL 而非字符串**，
所以没碰过这个设置的供应商读回来和这个字段存在之前逐字节一致。

读取时按下表收窄，且**用 standard 校验**：一个供应商从 compat 改回 official 时，
旧的 `bearer` 会留在行里，照发就会给 api.anthropic.com 送去它不接受的凭证 ——
按 standard 读使这种陈旧值失效而不是失败。

| standard | 合法 authMode |
| --- | --- |
| `anthropic_compat` | `default` / `bearer` / `both` |
| 其余全部 | 仅 `default` |

## 5. 探测与模型列表降级

仅 compat 生效。`/models` 返回 404 / 405 / 501 时，改用一次**最小正文请求**判定连通性：

| 协议 | 降级请求 |
| --- | --- |
| anthropic_compat | `POST {root}/v1/messages`，`max_tokens: 1`，一条极短 user 消息 |
| gemini_compat | `POST {base}/models/{id}:generateContent`，`maxOutputTokens: 1` |
| openai_compat | `POST {base}/chat/completions`，`max_tokens: 1` |

**判定规则**：连接测试发生在作者还没填模型 id 之前，所以降级请求**故意用一个不可能存在的模型名**（`__connection_probe__`，`max_tokens: 1`）—— 它读的是"被拒绝的形状"，不是结果：

- `401` / `403` → 鉴权失败（提示检查 key 或换鉴权方式）
- 其它非 2xx，但响应体是**该协议自己的 JSON 错误结构**（带 `error` 对象 / `message`）→ **视为连通成功**：只有真在说这套协议的服务才会这样回话
- 响应体是 HTML / 空 / 非 JSON → 报错。**这正是本判定要抓的情况** —— base URL 指向了一个不是该 API 的东西（nginx 404、登录页、CDN），它和"没有 /models"一样是 404，唯一的区别就是回话的形状
- 2xx → 连通（端点忽略了 model 字段，少见但仍说明可达且收下了 key）

模型列表拿不到时，UI 必须允许**手填 model id**（已确认 `ModelDrawer` 的模型 ID 是自由输入，抓取列表只是可选便利），且报错要说清"这是正常配置"而不是甩一个状态码。

## 6. 存量迁移

### 6.1 读取时映射（幂等，放在 `configDb.parseApiStandard` 相邻处）

```
若 apiStandard === "anthropic" 且 baseUrl 非空 且 归一化后 ≠ 官方  → "anthropic_compat"
若 apiStandard === "gemini"    且 baseUrl 非空 且 归一化后 ≠ 官方  → "gemini_compat"
若 apiStandard === "openai"    且 baseUrl 非空 且 归一化后 ≠ 官方  → "openai_compat"
```

`baseUrl` 为空串 = 使用默认值 → 判为 official。反向映射（compat → official）不做：
用户显式选了 compat 就尊重它。

**不做一次性 DB migration**，只在读取层映射；保存时按新值写回，自然收敛。

### 6.2 导入路径

`configTransfer.ts:122` 的白名单加入三个新值，并调用**同一个**映射函数 —— 否则从
旧版导出的配置在新版导入后仍是 `anthropic` + 自定义地址，等于绕过迁移。

### 6.3 向下不兼容（记录，不修复）

新版导出的配置在**旧版** app 导入时，`anthropic_compat` 会被
`parseApiStandard`（`configDb.ts:352`）兜底成 `openai_compat` —— 结果是用 OpenAI
报文打 Anthropic 端点。旧版代码无法改，属于已知单向兼容性损失，在 release note 提示。

## 7. 改动清单

按文件，逐条对应 §1.5：

| 文件 | 改动 |
| --- | --- |
| `lib/ai/types.ts` | 枚举扩到 6 值；新增 `AuthMode` |
| `lib/ai/urls.ts`（**新增**） | 三族的 base 常量 + 归一化函数 + 各端点拼装，供适配器/两个 probe 共用 |
| `lib/ai/index.ts` | 分发加 `*_compat` 分支（走同一适配器） |
| `lib/ai/anthropic.ts` | 用 `urls.ts` 拼 `/v1/messages`；`authHeaders` 接受 `authMode` + 是否官方；错误带 URL |
| `lib/ai/openai.ts` | 补 `DEFAULT_OPENAI_BASE` fallback；错误带 URL |
| `lib/ai/gemini.ts` | base 常量迁到 `urls.ts`；错误带 URL |
| `lib/ai/jsonMode.ts` | 两个 switch 各加三个 compat 分支（与对应 official 同行为） |
| `lib/ai/configDb.ts` | `defaultImageCaps` 加分支；`API_STANDARDS` 扩容；新增 `auth_mode` 列 + `addColumn`；`listProviders`/`upsertProvider` 读写该列；§6.1 映射 |
| `lib/ai/configTransfer.ts` | 白名单扩容 + 复用映射 |
| `lib/ai/providerProbe.ts` | 用 `urls.ts`；compat 降级探测；传 `authMode` |
| `lib/ai/endpointProbe.ts` | 同上；`:606` 的跳过条件改为按协议族判断 |
| `lib/ai/image.ts` | `resolveImageRoute` 改为 `族 === "gemini" ? "gemini" : "images-api"` |
| `stores/aiTaskStore.ts` | `defaultBaseUrl` 改为按族返回空串 |
| `components/settings/panes/ProviderDrawer.tsx` | 下拉 6 项；official 的 URL 输入框**只读展示**（不隐藏，用户要看得见地址才知道该不该换 compat）；compat 显示鉴权下拉；预设整理 |
| `components/onboarding/Onboarding.tsx` | 预设沿用 official |
| `i18n/locales/{en,zh-CN}.json` | `aiConfig.apiStandards` 六项 + 鉴权方式文案 + compat 的 baseUrl 占位提示 |
| `lib/__tests__/aiClient.test.ts` | 新增 URL 归一化用例（§3.2 三种写法）、鉴权头用例 |
| `lib/__tests__/providerProbe.test.ts` | 新增 `/models` 404 降级用例 |

## 8. PR 切片

每片独立可测、可回滚；作者在每片后用真实第三方端点验证再进入下一片。

**PR1 — 枚举 + URL 归一化 + 迁移**（无用户可见新功能，行为等价）
- 新增 3 个枚举值、`lib/ai/urls.ts`、§6.1 读取映射、白名单扩容、分发分支
- 下拉出现 6 项；official 的 URL 只读
- 验收：现有全部 provider（OpenAI / Gemini / Anthropic 官方 / DeepSeek / Ollama）配置不变、照常出字；`anthropic` + 自定义地址的存量行在 UI 上自动显示为 anthropic_compat

**PR2 — Anthropic compat 鉴权方式**
- `auth_mode` 列 + `AuthMode` + compat 鉴权下拉 + `authHeaders` 分支
- 验收：用只认 `Authorization: Bearer` 的第三方端点跑通一次续写

> `authMode` 是继 `safetySettings` 之后第二个"每供应商连接附加字段"，同样要在
> ~10 个 options 类型和 ~14 个调用点各写一遍。第三个字段出现前，应该把
> `baseUrl/apiKey/standard/safetySettings/authMode` 收成一个 `ProviderConn`
> 类型 + 一个 `connFor(provider)` 构造函数，让调用点 spread 而不是逐字段抄 ——
> 漏抄一处的症状是"某个功能忽略该设置"，编译器抓不到。本片没做，因为它会把
> PR2 的改动面从"鉴权"扩散到全部 AI 入口，真机回归时无法归因。

**PR3 — 探测降级**
- `/models` 缺失时的最小正文探测 + 错误形状判定；确认模型 id 可手填
- 验收：没有 `/v1/models` 的端点，"测试连接"通过、能手填模型出字。不需要特殊端点也能验一半：把 base URL 故意填错一个字符，应报失败而不是"连接成功"

**PR4 — Gemini compat + 收尾**
- `gemini_compat` 全链路、Gemini 默认值三份拷贝收敛、错误信息带 URL、i18n、测试补全
- 验收：`pnpm tsc --noEmit` + `pnpm test` + 一次 `pnpm tauri build` 冒烟

PR1 与 PR4 的"错误信息带 URL"若想提前，可并入 PR1（成本极低，对诊断帮助最大）。

### 实际落地情况

| 切片 | PR | 与计划的出入 |
| --- | --- | --- |
| PR1 | #119 | "错误信息带 URL" 按上面那句提前并入；顺带修掉 `aiTaskStore` / `memoryStore` 两处会把非 OpenAI 供应商指向 `api.openai.com` 的兜底；Gemini 默认值三份拷贝也在这里收敛完了（PR4 无事可做） |
| PR2 | #120 | `AuthMode` 去掉了计划里的 `x_api_key`（与 `default` 同义）；`default` 存 NULL 而非字符串 |
| PR3 | #121 | 判定规则从"看状态码"细化成"看回话的形状"（§5），因为"没有 /models"和"地址指错地方"都是 404 |
| PR4 | #122 | `gemini_compat` 的图像能力默认值取乐观而非保守（§2.2）；`gemini_compat` 端到端用例补齐 |

**真机验收状态**：PR1 已用 MiniMax 的 Anthropic 兼容端点验过。PR2 的 Bearer
路径、PR3 的"端点无 `/models`"路径、PR4 的 `gemini_compat` 都只有单测覆盖 ——
它们各自需要一个具备该特征的真实端点，遇到时补验。

## 9. 未决问题（本轮的结论与触发条件）

三项都**明确不做**，但各自记下什么信号出现时该重新考虑 —— 否则下次遇到只会
把同一场讨论再走一遍。

**1. Ollama 原生 API —— 不做，保持 preset。**
它的特殊行为全部由"URL 指向本机"推导，而 `lib/http.ts` 的 Origin 覆盖位于更底层，
拿不到枚举值，只能按 URL 判断；做成枚举会有两套判断，还允许"选了 Ollama 却填
远程地址"的矛盾态。协议上它就是 OpenAI 兼容层，没有第四种报文。
**重新考虑的信号**：想要列出本机已下载的模型或看下载进度 —— 那要打 `/api/tags`
`/api/pull`，是另一套端点，届时新增 `ollama` 枚举并另开方案。

**2. Azure OpenAI —— 不做，需要独立立项。**
它不只是换个鉴权头：URL 是 `/openai/deployments/{deployment}/chat/completions`，
带 `api-version` 查询串，且 deployment 名与模型名解耦（同一个模型可以有多个部署名）。
把它塞进 `openai_compat` 会让 base URL 语义和模型 id 语义同时变形。
**重新考虑的信号**：确实要用 Azure。届时它是第四个协议族（`azure`），不是 compat 的
一个选项。

**3. `gemini_compat` 的 `?key=` —— 不做。**
现有代码在两处明确注释了拒绝理由（`gemini.ts`、`providerProbe.ts`）：查询串会进
代理日志、浏览器历史和报错信息，而 API key 一旦进日志就等于泄漏。
**重新考虑的信号**：出现一个只支持查询串、不支持 `x-goog-api-key` 的真实中转。
届时按 compat 的鉴权下拉加一个选项（`authModesFor` 已经是按 standard 给选项集的），
并在 UI 上标注泄漏风险 —— 但不得设为默认。

## 10. 已知的后续清理

**连接字段的重复铺设。** `safetySettings` 与 `authMode` 都是"每供应商连接附加
字段"，各自要在 ~10 个 options 类型和 ~14 个调用点抄一遍（见 §8 PR2 下的说明）。
第三个这类字段出现时，先把 `baseUrl/apiKey/standard/safetySettings/authMode`
收成 `ProviderConn` + `connFor(provider)`，让调用点 spread 而不是逐字段抄。
漏抄一处的症状是"某个功能忽略该设置"，类型系统抓不到 —— 本轮是靠 grep 对拍
（`safetySettings` 出现的每个文件对 `authMode`）验证覆盖的，那是一次性手段，
不是可持续的保障。
