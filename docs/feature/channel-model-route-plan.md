# 「渠道与模型」重构：渠道 × 模型 × 线路（原「供应商与模型」）

> 状态：`shipped`（2026-09-18 提出；P0 已实施，见 §11；P1–P4 已实施，见 §12；火山方舟两个平台见 §13——与本文的出入都记在那里，包括唯一没做的一项：§5.1.2 专用接口仍走 `caps.route` / `asrFormat`，没有进 `provider_endpoints`）。设计稿在 claude.ai/design 项目（本 app 的设计项目）的
> [`05k 渠道与线路 Channel × Route.dc.html`](https://claude.ai/design/p/17a6a5ce-f60e-4996-8f94-5948958206d0?file=05k+%E6%B8%A0%E9%81%93%E4%B8%8E%E7%BA%BF%E8%B7%AF+Channel+%C3%97+Route.dc.html) TURN 1，屏 1a–1h + 1n 设计说明（沿用 05c 抽屉与 05d 列表的组件语汇，Tweaks 可切深浅）。
> 下文 §6 的「屏 01–08」依次对应 1a–1h。
> 本文是**方案**：数据模型、字段归属、迁移、分期、不变量。UI 口径以设计稿为准，本文 §6 只记每屏回答了哪个问题。
>
> 与相邻文档的关系：
> - [`api/provider-layering.md`](../api/provider-layering.md) — 三层加一维的裁决法。本方案**不推翻**它，而是把 L2、L3 各拆一刀（§2），
>   并补上它 §3「已知缺口 2：L2 没有通用的 preset 机制」。
> - [`api/landscape.md`](../api/landscape.md) §7 — 本方案所有「同一模型在不同平台/协议上不同」的判断都来自那里的实测样本，本文只引用。
> - [`model-drawer-redesign-brief.md`](model-drawer-redesign-brief.md) — 现行模型抽屉的视觉口径（虚线 ＝ 什么都不发、按有值折叠、「将发送」）全部保留。

## 1. 问题：今天的「供应商」把三样东西绑成了一行

今天一个 `Provider` 行 = `baseUrl` + `apiStandard`（协议族 × 官方/兼容）+ 一把 key；「添加供应商」是在表单上套一个预设（`ProviderDrawer.tsx` 的
`PROVIDER_PRESETS`），**套完预设就消失了**——保存下来的行里没有任何字段记得它是「千问」还是「DeepSeek」。模型挂在这一行下面，所有参数都在模型行上。

这个形状对「一家一个协议」的官方端点够用，但真实世界里平台与模型的关系比协议紧得多。按 landscape.md 的实测样本：

| 作者的观察 | 实测证据 | 今天的形状怎么处理 |
| --- | --- | --- |
| ① 同一模型在同一平台可走不同协议 | 千问：`/compatible-mode/v1`（①）、同路径 `/responses`（②）、`/apps/anthropic`（④）；OrcaRouter 一台主机 ①③④；DeepSeek 官方 ①②④ 三族都通（§2.1） | 每个协议一个供应商行：「通义千问 (DashScope)」「通义千问 (Claude 格式)」、「OrcaRouter」×3、「MiniMax」×2——**同一把 key 存三份、同一个模型建三次** |
| ② 同一模型在同一平台、不同协议能力不同 | 千问 `qwen3.8-flash`：代码解释器 ① 面 400、② 面可用；以文/以图搜图只有 ② 面有；网页抓取在 ① 面是 `agent_max` 策略、② 面是独立 tool；② 面关思考就拒绝代码解释器 | 能力声明挂在模型行上，模型行属于某一个协议的供应商行，所以「换协议」= 换一行，声明要重填一遍 |
| ③ 同一模型在不同平台走不同协议 | DeepSeek-V4-Pro：官方直连 ①②④；千问上架的 `deepseek-v4-pro-0813` ①②④；OrcaRouter 上 `deepseek/…` 经 ① | 可表达（不同供应商行），但没有任何地方说明「这些是同一个模型」 |
| ④ 同一模型在不同平台能力不同 | 千问 ② 面上的 `deepseek-v4-pro` **可以**跑代码解释器（landscape §7 代码解释器表），DeepSeek 官方没有任何服务端工具；千问上架的 deepseek 不看图，官方 `deepseek-flash` 看图 | **表达错了**，见下 |

第 ④ 行不只是体验问题，是一个**现存的行为缺陷**：服务端工具的拼写按协议判断，不按平台判断。
`serverTools.ts` 的 `supportsServerTool("openai_compat", "web_search")` 恒为真，`openaiServerToolsBody` 在任何 `openai_compat` 端点上都发
DashScope 私有的 `enable_search` / `search_options` / `enable_code_interpreter`——DeepSeek 直连、New API、OrcaRouter、Ollama 都是
`openai_compat`。作者在这些行上勾「联网搜索」，请求里就带着一个千问字段出去：好一点的被静默忽略（作者以为联网了，其实没有），坏一点的 400。
根因是「`openai_compat` ≈ 千问」这条隐含假设，它之所以一直没暴露，是因为服务端工具目前只在千问上实测过。

**结论**：「协议」回答的是 *消息长什么样*；「平台」回答的是 *这台服务器在这个协议上额外认哪些字段*。今天只有前者是一等概念，后者只在预设按钮上短暂存在过。

## 2. 目标形状：三个实体 + 一张平台画像

```
平台画像 PlatformProfile     代码里的数据表，不是配置      「千问在 ② 面上认 code_interpreter，qwen3.8-* 才行」
   │ (platform id)
渠道 Channel                 作者配置的一行 = 一把 key     「我的百炼账号」
   └─ 线路 Endpoint ×N       渠道下每个协议族一条          ① compatible-mode/v1 · ② 同 · ④ /apps/anthropic
模型 Model                   渠道下的一行                  qwen3.8-flash
   └─ 模型×线路 RouteProfile  每条可用线路一份参数         ② 面：思考 effort=high、结构化 json_schema
       + 当前线路 activeRoute                              「这个模型现在走 ②」
```

对应 provider-layering 的三层：

| 层 | 今天 | 之后 | 为什么拆 |
| --- | --- | --- | --- |
| L1 协议族 | `ApiStandard` / `familyOf` / 4 个 adapter | **不变**。仍是唯一允许「每族一份代码」的层 | — |
| L2 端点 | `Provider` 一行 | **渠道**（key + 平台）＋ **线路**（每族一条 baseUrl / 鉴权 / 族方言） | 渠道的身份是*凭据*，线路的身份是*地址*。同一把 key 能打三个协议，这两件事就不是一行 |
| L3 模型 | `Model` 一行 | **模型**（与协议无关的部分）＋ **模型×线路**（随协议变的部分） | 思考类目本来就是按族的（`resolveThinkingCategory` 会丢弃跨族类目），`jsonModeCeiling` 本来就按 `standard+baseUrl+modelId` 记——代码早已按线路粒度思考，只是存储没有 |
| 平台画像 | 不存在（预设用完即弃） | `lib/ai/platforms.ts`：一张数据表 | provider-layering §4「L2 必须是数据，不能是代码」——今天这条只做到了一半：预设是数据，但它**不留在行上** |

### 2.1 为什么「渠道」以 key 为身份，而不是以平台或主机为身份

- 同一平台两把 key（New API 按分组发 token，分组决定能用哪些模型）是两个渠道——它们的模型清单不同。
- 同一把 key 打三个协议是一个渠道——这正是要合并的情形。
- 主机不能当身份：千问国内站与国际站是两台主机、两把 key；OrcaRouter 是一台主机、一把 key、三个协议。
- **线路不单独带 key**。如果真有一个平台三个协议要三把 key，那就是三个渠道，今天的样本里一个都没有，不为它加字段。

### 2.2 「当前线路」挂在模型上，不挂在渠道上

作者的第三条诉求是「同一渠道下可以单独切换模型的协议」。样本里恰好是这样分布的：同一台 New API 上 GPT-5.x 该走 ②、Claude 该走 ④、Gemini 生图走 ③、
其余走 ①（landscape §7 第八～十样本）。所以 `activeRoute` 是模型字段，渠道只声明「我提供哪几条线路」。

一个模型**可用的线路** = 渠道提供的线路 ∩ 这个模型启用过的线路。默认只有创建时的那一条；作者在模型抽屉里点「+ 线路」加别的（设计稿屏 04）。
不自动给每个模型开全部线路：`qwen3-vl-plus` 拒绝 ② 面（landscape §7 视觉理解），一条没人验证过的线路出现在切换器里就是一个会 400 的按钮。

## 3. 字段归属

用 provider-layering §2 的判断法再过一遍今天 `Model` 的每个字段，多加一问：**「同一渠道、同一模型，换一个协议会变吗？」** 会变 → 模型×线路。

| 字段 | 今天在 | 之后在 | 判据 / 证据 |
| --- | --- | --- | --- |
| `name` `baseUrl`→ | Provider | 渠道 `name` ＋ 渠道 `host` ＋ 线路 `path`（缺省 = 平台约定，§5.1.1） | 地址 = 主机 + 路径：主机随渠道填一次，路径每条线路各自可改 |
| `apiStandard` | Provider | 线路 `family` ＋ `official`（由平台画像给出） | `ApiStandard` 继续作为**派生值**存在，adapter 一行不改（§4） |
| `authMode` | Provider | 线路 | OrcaRouter ① 面 Bearer、④ 面也 Bearer，但千问 ④ 面两种都收——鉴权随线路 |
| `safetySettings` | Provider | 线路（仅 ③ 族） | 本来就只有 Gemini 族有 |
| key | keyring[provider.id] | keyring[channel.id]，**id 不变** | 见不变量 2 |
| — | — | 渠道 `platform` | 新字段。迁移时由 baseUrl 主机推断，推不出 = `custom` |
| `modelId` `name` `type` `enabled` | Model | 模型 | 身份 |
| 价格五项 | Model | 模型 | 同一渠道同一模型换协议计费不变（样本里没有反例） |
| `contextSize` | Model | 模型 | 权重的窗口，不随 wire 变 |
| `prefix` `translateFormat` `asrFormat` `caps` `videoFps` | Model | 模型 | 身份 / 与 wire 无关 |
| `pdfInput` `videoInput` | Model | 模型（声明）＋ 线路可用性由画像过滤 | 与服务端工具同一处理，见下 |
| **`serverTools`** | Model | **模型（声明 = 作者的授权）** ＋ **画像 × 线路决定能不能拼出来** | 作者要的是「渠道+模型」粒度的差异化：授权是*我允许这个模型联网*，属于模型；*这条线路上能不能说出来*属于画像。切到拼不出的线路时声明**保留、不发**，抽屉照实说（屏 05） |
| `thinkingCategory` `reasoningEffort` `thinkingBudget` | Model | **模型×线路** | 类目本来就按族（`THINKING_CATEGORIES[*].family`）；千问 ① 面 `enable_thinking`+`thinking_budget`，② 面 `reasoning.effort`，④ 面 `thinking:{type}`——同一模型三种说法 |
| `maxOutput` `probedMaxOutput` | Model | **模型×线路** | ④ 族每次必发 `max_tokens`，其余族只作规划；千问 ① 面上 DeepSeek V4 的 `max_tokens` 是正文+思维链之和（landscape §7）|
| `temperature` | Model | **模型×线路** | `supportsTemperature(standard, category)` 已经依赖族；④ 族开思考时钳到 1 |
| `structuredOutput` | Model | **模型×线路** | 千问 ④ 面有 `output_config.format`，② 面文档没有 `text.format`；`jsonModeCeiling` 的记忆键本来就含 standard |
| `textVerbosity` | Model | **模型×线路**（仅 ② 族） | 本来就只在 ② 族出现，抽屉在别的族清空它 |
| `vlHighResolution` | Model | **模型×线路**（仅 ① 族） | DashScope ① 面的 body 字段 |
| `probedAt` `probedContextSize` | Model | **模型×线路** | 一次测量测的是一条 wire。上下文窗口的*值*属于模型，但「某日在哪条线路上测得」属于线路；抽屉显示当前线路的实测 |

**只有「会随协议变」的字段下沉到线路**，其余一律留在模型上。这是 provider-layering §2「同时命中两层放细的那层」的反向约束：
下沉是有代价的（每条线路各填一次），所以只下沉有实测证据的字段。

## 4. 平台画像（`lib/ai/platforms.ts`）

今天的 `PROVIDER_PRESETS` 升级为一等数据，并且**被渠道行引用**，不再是一次性表单填充：

```ts
interface PlatformProfile {
  id: PlatformId;                 // "dashscope" | "dashscope-intl" | "deepseek" | "openai" | "anthropic" | "google"
                                  // | "xai" | "minimax" | "volcengine" | "volcengine-plan" | "orcarouter" | "newapi" | "ollama" | "comfyui" | "custom"
  name: string;
  /** 官方主机；newapi / custom / ollama 缺省，由作者在渠道上填。 */
  host?: string;
  /** 这个平台提供哪些线路，各自的默认路径与鉴权。路径是默认值，线路可覆盖（§5.1.1）；official 线路不可覆盖。 */
  endpoints: Partial<Record<ProtocolFamily, { defaultPath: string; official: boolean; authMode?: AuthMode }>>;
  /** 服务端工具：每条线路上哪些 id 有拼写，以及按模型 id 的闸门（supportsCodeInterpreter 搬到这里）。 */
  serverTools: Partial<Record<ProtocolFamily, ServerToolSpelling[]>>;
  /** 每条线路建议的思考类目（抽屉把它排在前面；不限制作者选别的同族类目）。 */
  thinking?: Partial<Record<ProtocolFamily, ThinkingCategoryId[]>>;
  /** 起步模型；可带每条线路的建议值（qwen3-vl-plus 只开 ①）。 */
  starterModels?: StarterModel[];
  /** 出处：landscape.md 的哪一节、哪天实测。画像里的每一条都应当能指回一次实测。 */
  source: string;
}

interface ServerToolSpelling {
  id: ServerToolId;
  /** 模型 id 闸门；缺省 = 这条线路上所有模型都有。返回 "unknown" 时抽屉显示「未实测」。 */
  gate?: (modelId: string) => "yes" | "no" | "unknown";
}
```

三条规则：

1. **拼写函数按 `(platform, family)` 分派，不再按 `standard`。** `openaiServerToolsBody` 里 DashScope 的字段只在 `platform ∈ {dashscope, dashscope-intl}` 时出现；
   `custom` / `newapi` 平台在 ① 面上**没有任何服务端工具**（这就是 §1 那个缺陷的修复）。协议原生的工具（④ 族 `web_search_2025…`、② 族 `{type:"web_search"}`）
   在中转平台上标「取决于上游 · 未实测」，允许作者自担风险开启——与今天的 ④ 族行为一致。
2. **`custom` 是合法平台，不是错误。** 迁移推不出平台、作者接自建网关，都落在 `custom`：只有协议标准部分，没有任何私有扩展。这正是今天 `_compat` 的本意
   （「能力要么问要么降级」），只是它终于不再被千问的字段污染。
3. **画像是代码，不进配置备份。** 渠道只存 `platform` 这个 id。画像随版本更新（新实测、新闸门）时，所有渠道自动得到新知识，不需要迁移——这是它相对今天「预设填完就忘」的全部收益。
   代价：旧版本 app 读到一个不认识的 `platform` id 时按 `custom` 处理（向前兼容写进 `parsePlatform`）。

`ConnOptions` 仍是唯一的接缝（CLAUDE.md 硬规则），只加**一个**字段 `platform: PlatformId`；`standard` 由线路的 `family + official` 派生，四个 adapter 的签名不变。
`connOptions()` 的输入从 `{provider, model, apiKey}` 变成 `{channel, endpoint, model, route, apiKey}`，由新的 `resolveConn` 一次解析出来（渠道没了 / 线路没了 / 模型没这条线路，三种失败各自有文案，沿用今天「三种失败分开说」的做法）。

## 5. 存储与迁移

### 5.1 表

```sql
-- providers 表保留名字与 id（= 渠道）。appReset 的「keyring 先于数据库」依赖它记录有哪些 keyring 账号。
ALTER TABLE providers ADD COLUMN platform TEXT;            -- NULL = 未迁移，读时按 baseUrl 推断
ALTER TABLE providers ADD COLUMN host TEXT;                -- scheme+主机(+端口)；官方平台可空，取画像的主机

CREATE TABLE provider_endpoints (                          -- 线路
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  family TEXT NOT NULL,                                    -- openai | responses | gemini | anthropic；专用接口见 §5.1.2
  official INTEGER NOT NULL DEFAULT 0,
  path TEXT,                                               -- NULL = 平台约定；'/…' 接在渠道主机后；'https://…' 整条替换（§5.1.1）
  auth_mode TEXT,
  safety_settings TEXT,
  sort_order INTEGER,
  UNIQUE (provider_id, family)                             -- 一个渠道每族至多一条线路
);

ALTER TABLE models ADD COLUMN active_route TEXT;           -- family；NULL = 渠道的第一条线路

CREATE TABLE model_routes (                                -- 模型×线路
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  profile TEXT NOT NULL,                                   -- JSON：§3 表里「模型×线路」那几列
  PRIMARY KEY (model_id, family)
);
```

#### 5.1.1 线路路径：默认 + 可改

每条线路的地址 = 渠道主机 + 线路路径。路径**有平台默认值，但每条都能单独改**（设计稿屏 03）：

| `path` 存的值 | 含义 | 抽屉里的样子 |
| --- | --- | --- |
| `NULL` | 用平台画像的约定（New API：`/v1` · `/v1` · `/v1beta` · 根） | 空输入框 + 占位符显示默认值 + 「默认 /v1」虚线标签；「恢复默认」置灰 |
| `/openai/v1` | 接在渠道主机后面 | 实线框 + 「已改 · 默认 /v1」 |
| `https://claude.relay.example.com` | 整条替换，连主机一起换（有的中转把 ④ 放在单独子域名） | 主机位显示「独立主机」+「已改 · 独立主机」 |

每行下面一行 mono 显示请求实际打到的地址（`POST https://…/chat/completions`），由各族 adapter 自己的 URL 函数（`lib/ai/urls.ts`）算出——和「将发送」同一个理由：第二份「adapter 会怎么拼」的表迟早会漂。

两条规则：
- **存覆盖值，不存结果。** `NULL` 与「填了一个恰好等于默认的值」是两回事：前者以后跟着画像的约定走（平台改了路径约定，所有没改过的渠道一起变），后者钉死。「恢复默认」写回 `NULL`，而不是把默认值抄进去。输入框失焦时若值与默认相同，也写 `NULL`。
- **路径里只放路径。** 各族 adapter 自己补尾巴（`/chat/completions`、`/responses`、`/v1/messages`、`/models/{id}:…`），路径字段填到 adapter 补尾巴之前为止，与今天 `baseUrl` 的约定一致（`urls.ts` 的 `openaiUrl` / `anthropicRoot` / `geminiUrl` 各自的修剪规则照旧生效，作者多填一个 `/v1` 不会拼出 `/v1/v1`）。

官方平台（OpenAI、Anthropic、Google 官方）今天锁定地址；这里同样锁定：画像标 `official: true` 的线路路径不可改——那正是「官方」与「兼容」在 provider-standards §2.2 里的区别。要改地址的作者选「自定义」平台。

#### 5.1.2 专用接口：出图与转写也是「线路」，但不是协议线路

出图、转写走的是特殊 endpoint（`/images/generations`、`:generateContent` 出图、DashScope 原生 `/services/aigc/…` 与
`/services/audio/asr/transcription`、ComfyUI）。它们对这两类模型来说就是线路——**选哪一条决定请求发到哪里、长什么样**——
但和对话协议不是一回事，所以：

- **不上徽标。** 渠道头与模型行的徽标只回答「这个渠道说哪几种对话协议」。出图 / 转写模型的列表行不画徽标，写一行 mono「出图 · DashScope 异步」。
- **按类型换线路带。** 模型抽屉里，类型选了**图片生成**，线路带换成**出图线路**（Images API · 对话内出图 · Gemini 出图 · DashScope 原生 · ComfyUI）；
  选了**音频 ASR**，换成**转写线路**（同步识别 · 录音文件转写）。单选，每行带实际请求地址；平台不提供的一行置灰写「本平台不提供」。设计稿 05k 屏 1i。
- **地址从哪来。** 挂在协议线路上的专用接口不另存地址：Images API / 对话内出图跟 Chat 线路走，Gemini 出图跟 Gemini 线路走。
  有独立前缀的（DashScope 原生 `/api/v1`、ComfyUI 的本机地址）是渠道的一条**专用接口**，在渠道抽屉「专用接口」块里有自己一行路径，
  规则同 §5.1.1（空值 = 平台约定，可覆盖）。
- **存储不新增字段。** 「选了哪条出图 / 转写线路」今天已经存在：`caps.route`（`ImageRoute`）与 `asrFormat`。这一轮只是把它们从
  抽屉深处的「出图」「转写」节提到线路带的位置，并让选项由平台画像过滤。独立前缀的专用接口进 `provider_endpoints`，`family` 取
  `dashscope-native` / `comfyui`，另加一列 `special INTEGER NOT NULL DEFAULT 0`——对话模型的线路带与徽标只读 `special = 0` 的行。

`UNIQUE (provider_id, family)`：一个渠道同一族两条线路（比如同族两个区域）在样本里没有出现，那种情况是两个渠道。

线路参数用一列 JSON 而不是十列：这些字段按族出现（`textVerbosity` 只有 ②、`vlHighResolution` 只有 ①），拉成列会是一张大部分为 NULL 的宽表；
而它们从来不被 SQL 查询，只整行读进内存。解析沿用 `parseServerTools` 的做法——逐字段收窄，不认识的丢掉。

### 5.2 迁移（一次，幂等，一个 `sqlTx`）

1. 每个 `providers` 行 → 自己的一条线路（`family = familyOf(api_standard)`，`official = !isCompatStandard`，`auth_mode` / `safety_settings` 原样）。`platform` 由主机推断；`base_url` 拆成渠道 `host`（origin）与线路 `path`（其余部分）——**路径等于画像约定时写 `NULL`**，否则原样存为覆盖值，所以迁移后请求地址逐字节不变。
2. 每个 `models` 行 → 一条 `model_routes`（family 同上），把 §3 表里下沉的列原样搬进 JSON；`active_route` = 该 family。
3. 旧列**不删**，只停止读写（SQLite 删列要重建表；`configTransfer` 的旧版备份仍要能导入）。
4. **不自动合并**。「MiniMax」与「MiniMax (Claude 格式)」迁移后仍是两个渠道，各一条线路；合并由作者触发（§5.3）。
   理由：合并要判断两把 key 是不是同一把、两边同名模型是不是同一个——猜错了会让一个模型悄悄换了计费账号。迁移只做不可能错的事。

迁移后行为**逐字节不变**，唯一例外是 §4 规则 1：`custom` / 非千问平台上的 `openai_compat` 模型不再发 `enable_search` 等字段。
迁移日志里列出受影响的模型（「DeepSeek 直连上的 deepseek-flash 声明了联网搜索，但这个平台没有服务端搜索——声明已保留，不再发送」），抽屉里同一句话常驻（屏 05）。

### 5.3 合并同一渠道（作者触发）

检测：两个渠道 `platform` 相同、主机相同、**keyring 里的 key 相同**（在内存里比较，不外露）、族不相同 → 列表顶部一条提示（屏 07）。

合并预览逐条列出：线路 A + 线路 B 并入渠道 A；两边 `modelId` 相同的模型合成一个，保留渠道 A 那一行的 id，把 B 的线路参数作为第二条 `model_routes`；
被合掉的模型 id 在**同一个事务里**改写所有引用——`PREF_KEYS` 里的 `ai:*ModelId` 与 `ai:subagent:*:modelId`、`token_usage.model_id`、会话存档里的 `modelId`。
B 的 keyring 项在事务提交**之后**删（与 appReset 的顺序反过来：这里数据库先确认不再引用它）。

### 5.4 配置备份 / 同步

`CONFIG_BACKUP_VERSION` +1，新增 `endpoints` 与 `modelRoutes` 两段。导入旧版本：走 §5.2 同一个迁移函数（一份代码，不写第二个）。
旧版 app 读新备份：`version` 已大于它认识的，按现有逻辑拒绝——这是今天就有的行为，不需要为向后兼容做任何事。

## 6. UX（设计稿屏 01–08）

| 屏 | 回答的问题 | 要点 |
| --- | --- | --- |
| 01 渠道与模型 · 总览 | 列表该按什么分组？ | 渠道组的头上是平台标签 + **线路徽标**（`Chat` `Resp` `Gemini` `Anth` `DashScope`，只列平台提供的），组内是模型；每行尾部一枚写全名的徽标 `Responses`——一眼看出哪个模型走哪条路 |
| 02 添加渠道 · 选平台 | 「添加」时作者先选什么？ | 先选**平台**，不再选协议。选中后右侧预览这个平台会建哪几条线路、每条线路认哪些服务端工具、起步模型；只要填**一把 key** |
| 03 渠道抽屉 · 线路表与路径 | 一个渠道的多个协议在哪里配？路径怎么改？ | 渠道抽屉里一张线路表：每族一行（路径 / 鉴权 / 连通测试 / 启用）。主机填一次；每条线路的路径默认取平台约定，可单独改成另一段路径或一整条 URL，「恢复默认」回到约定；每行下方显示实际请求地址（§5.1.1） |
| 04 模型抽屉 · 线路切换 | 同一渠道下怎么切一个模型的协议？ | 抽屉头部一条**线路条**（渠道提供的线路，已启用的实底、未启用的虚线 `+`）；下面的节标出作用域：「模型」节与「本线路」节，本线路节的标题带线路名（`本线路 · Resp`） |
| 05 服务端工具 · 可用性矩阵 | 「这个工具这里能不能用」怎么说清？ | 能力声明里服务端工具变成矩阵：行 = 工具（作者的授权开关），列 = 线路，格 = 能拼 / 拼不出 / 未实测；当前线路那一列高亮。声明了但当前线路拼不出 = 开关仍亮 + 一行「本线路不发」 |
| 06 切换线路 · 差异 | 切线路时哪些参数变了？ | 点另一条线路时，线路条下方就地展开一张差异卡：思考 / 最大输出 / 结构化 / 服务端工具 各一行 `旧 → 新`，没配过的线路显示虚线「未设置 · 不发」——**不从旧线路抄参数**（不变量 3） |
| 07 合并同一渠道 | 迁移后的重复渠道怎么收拢？ | 列表顶部提示条 → 合并预览（线路并入、同名模型合一、被替换的引用计数）→ 确认 |
| 1i 出图 / 转写 · 专用接口 | 出图和转写模型的「线路」在哪选？ | 类型选了图片生成 / 音频 ASR，线路带换成出图线路 / 转写线路，单选，每行带实际请求地址；不上徽标（§5.1.2） |
| 08 同一模型 · 两个渠道 | 「同一模型在不同平台能力不同」给作者看得见吗？ | DeepSeek-V4-Pro 在「DeepSeek 官方」与「百炼」两个渠道下的对照：线路、服务端工具、看图各不相同。这是说明屏，产品里的落点是模型行悬停时的「同名模型」提示 |

### 6.1 线路的显示：协议名徽标，不是编号

设计稿第一版用 1–4 编号方块表示线路，作者否决了：编号要背，徽标一眼能读。改为一枚 mono 徽标写协议名——
`Chat` · `Resp` · `Gemini` · `Anth` · `DashScope`；挤的地方（渠道头、服务端工具矩阵表头、合并表）用简写，宽的地方（模型行、抽屉线路带、线路表）写全名
（`Chat Completions` · `Responses` · `Anthropic`）。状态只用填充与边框表达：墨底 = 当前 / 在用，细边 = 已配，虚线 = 渠道提供但本模型未启用；
**平台不提供的线路不出现**，不画空位——空位只在编号体系里有意义（「第 3 格是空的」），换成名字后它就是噪音。
正文里沿用 landscape.md 的 ①–④ 指协议族，那是文档的记法，不进界面。上一版把 DashScope 原生也做成了徽标，作者再次否决：出图、转写是专用接口，不是对话协议，见 §5.1.2。

## 7. 不变量

1. **模型行 id 在切线路、改线路参数时永不改变**；只有合并（§5.3）会让一个 id 消失，且其全部引用在同一事务里改写。偏好、用量、会话都按这个 id 存。
2. **key 仍按 `providers.id` 存 keyring**，渠道就是 providers 行，线路不带 key。appReset「keyring 先于数据库」不变。
3. **没配过的线路什么都不发。** 新增或切到一条线路时，思考 / 温度 / 最大输出 / 结构化**不从别的线路复制**——类目是按族的，把 ② 面的 `effort` 抄到 ④ 面是一个跨族字段（`resolveThinkingCategory` 今天就会把它丢掉）。虚线 ＝ 不发的视觉口径直接适用。
4. **服务端工具的拼写由 `(platform, family, modelId)` 决定**，查画像；声明是作者的授权，拼不出时保留不发，并在抽屉与「将发送」里说出来。
5. **`ConnOptions` 仍是唯一接缝**，只加 `platform`；adapter 仍按族一份，不出现按平台的 adapter 子类（provider-layering §4）。
6. **会话里跨线路的回放**：思维块 / Responses 项按 `modelId` 标记；同一模型换了族，新族的 adapter 读不到旧族的 carry，退化为今天「换了模型」的同一条路径。不需要新代码，但要有一个测试钉住。
7. `conversationalModels`、`SUBAGENT_KINDS` 的不变量不受影响——线路不改变模型的类型。

## 8. 分期（每期一个 PR，各自可合、可停）

| 期 | 内容 | 用户可见 | 风险 |
| --- | --- | --- | --- |
| **P0** | `platforms.ts` 画像表；`providers.platform` 列 + 主机推断；服务端工具拼写改按 `(platform, family)`；`ConnOptions.platform` | 修掉 §1 的错误拼写；渠道行显示平台名 | 低。纯收窄，外加一条迁移说明 |
| **P1** | `provider_endpoints` 表 + 迁移；`resolveConn` 经线路解析；渠道抽屉的线路表（屏 03）；添加渠道先选平台（屏 02） | 一个渠道能挂多条线路 | 中：16 个调用点经 `connOptions` 过，接缝已在，改的是解析 |
| **P2** | `model_routes` + `active_route` + 迁移；模型抽屉线路条、作用域标签、差异卡、服务端工具矩阵（屏 04–06）；探测按线路写 | 同一模型切协议 | 中：抽屉字段读写改道，`wireSummary` 按当前线路算 |
| **P3** | 合并同一渠道（屏 07）+ 引用改写；配置备份 v+1 | 旧的多行供应商可收拢 | 中高：唯一一处会删 id 的操作，必须有事务测试 |
| **P4** | 模型选择器显示线路签；同名模型提示（屏 08） | 可选 | 低 |

P0 独立有价值（它修一个 bug），即使后面几期不做也该合。

## 9. 明确不做

- **线路级的 key**、**同族多线路**：样本里没有，见 §2.1 与 §5.1。
- **按请求临时切线路**（例如 agent 某一轮临时走 ②）：线路是模型的配置，不是请求参数。需要时建第二个模型行。
- **出图 / 转写模型的「模型×线路」参数**：它们选的是专用接口（§5.1.2），出图参数（方言、尺寸、可改图）与转写参数仍各存一份在模型上，不按线路分份——一个出图模型换接口的场景在样本里没有出现过。专用接口**永远不出现在对话模型的线路带里**，与 `conversationalModels` 不变量同一个理由。
- **画像进配置备份或可由作者编辑**：画像是实测结论，作者要表达「我知道这个中转站也认 X」时，用的是 `custom` 平台 + 协议原生工具的「未实测」开关，而不是改画像。

## 10. 待决问题

1. 模型选择器里同名模型（两个渠道都有 `deepseek-v4-pro`）是否需要按渠道分组？今天的 `ModelSelector` 已按供应商分组，P4 之前不动。
2. `custom` 平台上 ② 族的 `{type:"web_search"}` 是否默认可开？目前倾向「可开、标未实测」，与 ④ 族今天一致；需要一次中转站实测来定。
3. 迁移推断平台的主机表放在哪——`platforms.ts` 每个画像带 `hosts: string[]`，还是单独一张表。倾向前者（一个平台的事实在一处）。

## 11. P0 实施记录（2026-09-18）

P0 按 §8 的范围落地：`lib/ai/platforms.ts` 画像表、`providers.platform` 列、服务端工具按 `(platform, family)` 拼写、`ConnOptions.platform`、
供应商抽屉的平台字段、列表组头的平台标签。实现时定下的几件事，按「下次有人会问」的顺序：

1. **推断在读时做，不写迁移；只存推断不出的平台。** `platform` 为 `NULL` 的行每次读都由地址推断（`resolvePlatform`）。
   保存时 `platformToStore` 只在作者选的平台**与地址推断不同**时写入（New API、千问的代理域名），与推断相同则写 `NULL`——
   否则一次保存就把当时的推断钉死，以后版本给画像加的主机永远到不了这一行（§4 规则 3）。
   §5.2 的「迁移日志」在 P0 没有一步迁移可以记，改为两处**常驻**说明：供应商与模型页顶部一行列出「开着但本平台不发送」的模型
   （改平台或关掉开关后消失）；模型抽屉里对应开关下一行说原因。理由：推断是纯函数、结果稳定，写一步迁移只多一个会半途失败的地方。
2. **官方标准永远按厂商算平台，覆盖存储值。** 一行先是千问兼容、后被改成 OpenAI 官方，存着的 `dashscope` 不能把 `enable_search`
   带到 api.openai.com。官方地址本来就是厂商常量（`defaultBaseFor`），平台也就是它。
3. **声明保存时不再按线路裁剪。** 模型抽屉以前保存时把「本线路拼不出」的工具从声明里删掉；现在保留（不变量 4），
   开关照亮、下面一行说「不发送」——平台没有这个工具，和平台有但这个模型 id 不跑（代码解释器的按模型闸门）分成两句话。
   能拼不能拼只在两处算：请求（`effectiveServerTools`，adapter 各自再防一道）与任何「承诺能力」的地方——
   搜索子代理在不在线、能不能读网页、模型列表上的「联网」「代码」标记，一律读 `serverToolsSent`，不读原始行。
   `subAgentModel` / `routeTools` / `plannedToolTokens` / `messageCeilingFor` / `planForecast` 因此都接收供应商列表，
   估算与运行两边传的是同一份，否则 `delegate` 的 schema 一边算一边不算、天花板对不上
   （`docs/feature/agent/subagent-lld.md` §5.2.3）。只有手里没有供应商列表的界面（输入框的子代理小签）退回读声明，
   最坏是多显示一个签，执行时会被 `executeDelegate` 拦下并说明原因。
4. **协议原生工具在没列出的平台上是「未实测」，不是「没有」。** ④ 族的 `web_search_*` 与 ② 族的 `{type:"web_search"}`
   在 OrcaRouter、New API、自定义平台（以及 DeepSeek 的 Anthropic 形路径）上照旧可开，开关下写「未实测」——这是 ④ 族今天在中转站上的既有行为，
   §10 第 2 条的待决问题在实测前按这个倾向执行。例外是本机服务：Ollama、ComfyUI 显式声明各族都没有服务端工具，不继承「未实测」。
   ① 族（Chat Completions）没有任何协议原生的服务端工具，所以非千问平台上一律没有。
5. **千问国际站与国内站用同一份拼写。** 实测只在国内站做过；国际站服务同样的兼容模式与 `/responses`，而今天指向它的行一直在发这些字段——
   沿用即不改变行为，等国际站有了反例再拆。
6. **New API 是唯一需要显式写平台的预设。** 其余预设的地址都能推断出平台；自建中转没有可识别的主机，不写就会落到 `custom`。
   两者在线路上今天没有区别（都只有协议标准部分），New API 只是作者能认出来的标签——P1 按平台给默认路径时才会有区别。
7. **抽屉里改地址会带着平台走，作者手选过的除外。** 没手选过时按 `platformForAddress`：新地址能认出平台就换过去；认不出时，
   原平台若按主机识别（千问、DeepSeek……）就退回 `custom`，若是 New API / 自定义就保留。作者在平台下拉里选过，或这一行存着一个
   与地址推断不同的平台（即以前手选过），改地址不再动平台——否则给千问代理改一个路径错字，平台就悄悄变回「自定义」、联网搜索跟着停发。

**行为变化**（都是「不再发送」，没有新增发送）：

- 非千问平台上的 `openai_compat`（DeepSeek 直连、中转站、Ollama、自定义）不再发 `enable_search` / `search_options` / `enable_code_interpreter`——§4 规则 1。
- 非千问平台上的 `openai_responses_compat`（xAI、中转站、自定义）只剩 `web_search`：`web_extractor`、两个图片搜索、代码解释器是千问的名字，
  xAI 会拒绝（landscape §7 第十一个样本）。
- 千问的**代理域名**（地址认不出是百炼）属于上面两条，直到作者把平台选成「阿里云百炼」——这正是页顶那行说明要提醒的情形。
- Ollama 上 ④ / ② 族的 `web_search` 不再发送（以前按协议照发）。

## 12. P1–P4 实施记录（2026-09-18）

P1–P4 在一个 PR 里落地（作者要求一次做完；§8「每期一个 PR」让位于这个要求，各期仍按 §8 的顺序写、各自有测试）。
代码的地图：`lib/ai/routes.ts`（渠道的线路、模型×线路的档案、按线路看渠道）、`lib/ai/channelMerge.ts`（合并）、
`platforms.ts` 的 `endpoints` / `origin`（每个平台提供哪几条线路、默认路径），界面在 `ProviderDrawer.tsx`（屏 02、03）、
`ModelDrawer.tsx`（屏 04–06）、`ProvidersModelsPane.tsx`（屏 01、07、08）、`ModelSelector.tsx`（P4 线路签）。
按「下次有人会问」的顺序：

1. **两个 JSON 列，不是 §5.1 画的两张表。** `providers.host` + `providers.endpoints`（线路数组）、`models.active_route` +
   `models.routes`（**当前线路以外**各线路的档案）。理由：线路从不被 SQL 查询，只整行读进内存（§5.1 给模型×线路用 JSON 的理由，
   对线路本身同样成立）；这样 `providerUpsert` / `modelUpsert` 仍各是一条语句，配置恢复与合并照旧把它们交给 `sqlTransaction`，
   不用为「一个渠道 = 一行 + N 行」重写事务；`UNIQUE (provider_id, family)` 由 `parseEndpoints` 保证（同族第二条丢弃）。
2. **旧列永远存当前线路。** 渠道的 `base_url` / `api_standard` / `auth_mode` / `safety_settings` 存主线路，模型的扁平列存
   当前线路的值，别的线路进 JSON。于是（a）旧版本读这个库，看到的就是它以前看到的；（b）运行时约 30 处「拿模型找供应商」
   的代码只需把 `providers.find(p => p.id === m.providerId)` 换成 **`providerFor(m, providers)`**——它返回「从这个模型的
   线路看过去的渠道」，扁平字段是那条线路的，后面读 `apiStandard` / `baseUrl` / 平台的逻辑一行不改。`resolveConn` 同理，
   `connOptions` 与四个 adapter 不动（不变量 5）。
3. **迁移在读时做，和 P0 一样。** 没有 `endpoints` 的行由 `legacyEndpoint` 现算：主机 = 地址的 scheme+host（按原字符串切，
   不经 `URL`，否则大写主机会差一个字节），路径 = 其余部分，**等于平台约定时存为空**。`routes.test.ts` 把每个旧预设的地址
   钉成「迁移后逐字节不变」。旧版本改过的行（它只写旧列、不知道 `endpoints`）由 `legacyColumnsDiverged` 认出，主线路按旧列重建，
   别的线路保留。已知的一个缺口：旧版本保存**模型**用的是 `INSERT OR REPLACE`，会把 `active_route` / `routes` 清空——
   那个模型回到主线路、别的线路的档案丢失。只在「升级后又回退再升级」时发生，不为它加机制。
   「分歧」靠一个标记认，不靠重算：保存时主线路带上当时写进 `base_url` 的值（`writtenBase`）。只比「按今天的画像算出的地址」
   会把「平台约定改了」误认成「旧版本改过」，把本该跟着平台走的空路径钉成覆盖值——代码审查找出的，`routes.test.ts` 钉住。
4. **「线路没了」是第四种失败。** 模型选的线路被从渠道上关掉后，`resolveConn` 报 `ai.errors.routeNotFound`，不悄悄换成主线路——
   那个模型的思考、结构化这些字段是按原来的协议族设的，换族发出去就是一个跨族请求（不变量 3）。列表和估算那边
   （`providerFor`）退回主线路，只为了不把页面算崩。渠道抽屉里，有模型在走的线路、以及唯一的一条线路，关不掉。
5. **PDF / 视频输入的声明不再按当前线路清掉。** 它们是模型的声明（§3 表），切到 ④ 再切回来不该重填。能不能用改在用的时候
   按线路问：`readsPdf(model, standard)`（PDF 子代理的资格、委派时的拦截、子代理页的提示）与既有的 `canReadVideo`。抽屉里
   当前线路没有拼法时开关仍在、写「走这条线路时不发」。子代理页与委派拦截同样分三种说法：没勾 PDF 说「未声明」；勾了但
   中转站上游丢 PDF 说是上游（capability-gating-plan §8.11）；勾了但线路 / 平台传不了，点名当前线路——
   这时说「未声明」会让作者去勾一个已经勾上的开关（2026-09-23 补上，此前第三种落在「未声明」里）。不论是上游丢还是线路传不了，
   都再问一句渠道上**别的线路**（`pdfRouteFor`）：有会发送的就点名它（`warnPdfOtherRoute` / `warnPdfUpstreamOtherRoute`），
   没有就只建议换模型（`warnPdfNotSent` / `warnPdfUpstream`）。「会发送」与 `readsPdf` 是同一个答案，所以未实测的线路按能力表的默认算能传
   ——提示与请求说同一句话；只看「有 PDF 拼法」不够，中转站上有拼法的线路仍可能被上游丢文件（Kiro 模型从 ④ 换到 ① 只会换来「上游丢 PDF」），
   而两种原因各给一套建议，会让同一个模型在 ① 上被劝换模型、在 ④ 上被劝换线路。
   已知的一处出入：千问文档说 DashScope 的 Responses 不支持 PDF（模型抽屉的提示也这么写），但能力表在那一面没有格子——
   按 capability-gating-plan §7.1「`false` 只留给实测过的否定」，文档一句话不够判「不发」。所以 Chat 线路被关掉或排在 Responses 之后时，
   这条提示会点名 Responses；默认线路顺序下点名的是 Chat。补一次 DashScope Responses + PDF 的实测后再定这一格。

   翻译格式仍按当前线路清——它把模型**移出**所有选择器，留着一个看不见的声明代价太大。
6. **新建渠道默认开平台提供的全部线路，自定义平台只开一条。** 「添加」先选平台（屏 02），右侧预览列出会建的线路、每条线路
   认哪些服务端工具、起步模型；自定义平台什么都不知道，作者验证一条开一条。旧的「OpenAI」「OpenAI (Responses)」「通义千问
   (Claude 格式)」「OrcaRouter ×3」这些按协议分开的预设都并进了一个平台的几条线路。
7. **模型切线路时什么都不带。** 抽屉里点另一条线路先出差异卡（屏 06），确认后当前线路的字段停放、目标线路的档案载入，
   没配过的线路是一片空白（「未设置 · 不发」）。实现上「保存会写什么」和「切换会停放什么」是同一个函数（`routeFieldsNow`），
   两边不会按不同规则清字段。实测值（`probedAt` 等）也随线路停放：探测面板按抽屉当前线路去测。
   没选过线路的模型跟着主线路走；所以渠道抽屉里「设为主线路」保存时，先把这些模型钉在旧的主线路上——否则它们会带着
   按旧协议族设的参数悄悄换协议。
8. **合并只检测、作者确认。** 候选 = 平台相同、主机相同、**key 相同**（在内存里比，不渲染）、协议族不相交；空 key 只和
   同一真实主机上的空 key 配对（两台本机服务在同一地址就是同一台）。同名（`modelId` 与类型都相同）的模型合成一个，保留
   被留下那个渠道的行，另一边的当前字段成为它的一条线路；其余模型搬过来，并把线路**钉死**在它原来的协议上——主线路变了，
   它不能跟着变。引用改写：配置行在一个事务里；主模型 / 记忆 / 出图 / 各子代理的选择经状态库改写（偏好由订阅落盘）；
   **当前打开的项目**的 `token_usage` 随后改写；其他项目的用量行够不到，显示为已删除的模型——与直接删掉那个模型的结果一样，
   不为它开一个跨项目扫描。被合掉的渠道的 key 在事务提交**之后**才从钥匙串删（与 appReset 的顺序相反，理由同 §5.3）。
   检测只读「平台与主机都和别的渠道相同」的那几把 key：签名变了的构建上每读一次钥匙串都可能弹窗
   （`docs/reference/macos-signing.md`），打开这一页不该弹一排密码框。
9. **配置备份 v2。** 渠道带 `host` / `endpoints`，模型带 `activeRoute` / `routes`；v1 备份走与旧库行同一个 `readChannel`。
   只认 v1 的旧版本会拒绝 v2 备份——那条版本检查本来就是为这个留的。同步服务器上的配置备份是同一个包，同样处理。
10. **界面词「供应商」改为「渠道」。** 屏 01 起设计稿就叫「渠道与模型」，新文案（线路表、合并、差异卡）也只能说「渠道」——
    一个东西两个名字比改名更糟，所以 39 条中文文案与对应英文（Provider → Channel）一起改了，记进 `terminology.md`。
    代码里的类型与存储（`Provider`、`providers` 表、`providerId`）不改名：它们被太多地方引用，而且改名换不来任何行为。
11. **徽标的状态只看「有没有模型在走」。** 列表组头与线路表里，有模型正走的线路是墨底，配了没人走的是细边，平台提供但没开的
    是虚线（§6.1）；模型抽屉的线路条里，墨底是这个模型当前的线路，细边是它配过的。图片 / 转写模型不画线路徽标（§5.1.2）。
12. **同名模型提示（屏 08）按「去掉 `厂商/` 前缀、忽略大小写」比。** OrcaRouter 的 `deepseek/deepseek-v4-pro` 与 DeepSeek 官方的
    `deepseek-v4-pro` 是同一个；带日期的快照（`deepseek-v4-pro-0813`）不算——猜错了的提示比没有提示更误导。

**没做的**：§5.1.2 的专用接口线路（`dashscope-native` / `comfyui` 进 `provider_endpoints`、出图 / 转写线路带按平台过滤）。
出图与转写仍由 `caps.route` 与 `asrFormat` 选接口、由渠道地址推出原生前缀，行为与之前相同；专用接口进线路表要等一个
「同一出图模型换接口」的样本（§9 同一理由）。

## 13. 第一个「一台主机、两种 key」的平台：火山方舟（2026-09-18）

实测在 [`landscape.md`](../api/landscape.md) §7 第十二个样本；设计稿是 05k 的 **TURN 2**（屏 2a–2c + 2n 设计说明，叠在 TURN 1 上面）。
这一期没有新组件，只有画像数据、两个思考类目、一条提示条。每条取舍的理由：

1. **拆成两个平台，而不是一个平台两条路径。** 按量 key 只认 `/api/v3`，套餐（Agent / Coding Plan）key 只认 `/api/plan`，在对方
   路径上都是 401。§2.1 说渠道以 key 为身份——同一把 key 永远到不了的线路不该出现在它的线路表里。于是 `volcengine`（Chat · Resp，
   按文档，未实测）与 `volcengine-plan`（Chat · Resp `/api/plan/v3` · Anth `/api/plan`，已实测）各是一个平台，平台卡上一眼看出线路不同。
2. **`hosts` 允许带路径前缀，最长者胜、只在段边界上匹配。** 旧行（没存 `platform` 的）要能从地址认回自己；两个平台共用主机，
   只有路径能分。`/api/planner` 不算 `/api/plan`。§4 规则 3 不变：地址能认出的平台照旧不存（`platformToStore`）。
3. **抽屉的主机框只填主机时，保留作者选的平台。** 主机框里从来只有主机，按规则 2 它会被认成按量平台，把作者刚点的套餐冲掉。
   `platformForAddress` 因此多一条：地址是**光主机**、且正是当前平台的主机时，不改；带了路径才由路径决定。
4. **能不能读 PDF 按「平台 × 线路」回答（`pdfFamilies` · `wireReadsPdf`；`pdfFamilies` 此后收进能力表 `capabilities.ts` 的 `pdfInput` 格，见 `docs/api/capability-gating-plan.md`）。** 以前按族：①② 能、④ 不能——因为多数 ④ 兼容端把
   `document` 块静默换成占位符（DeepSeek，§2.1），那是这道闸要挡的。方舟 Plan 的 ④ 面真读到了 PDF 内容，所以画像里列出 ④；
   没实测过的平台仍是默认的 ①②。`readsPdf` 的第二个参数因此从 `standard` 变成渠道（要平台）。
5. **两个思考类目，而不是借现成的。** ① 面：`doubao`（关闭 · low · medium · high）——拼法同 `deepseek`（关 = 只发
   `thinking:disabled`，否则 `reasoning_effort`），但 `medium` 是真的一档，而且「强度 + disabled」同发会 400，所以不能沿用
   `openai-generic`。④ 面：`doubao-switch`（adaptive / disabled）——豆包默认在想，Claude 两个类目都关不掉；拼法与 `minimax` 相同，
   但方舟在思考开时照样接受强制 `tool_choice`，借 `minimax` 会把结构化任务的强制调用无谓地降成 auto（`forcesToolChoiceAuto`
   因此改按 id 判 MiniMax，而不是按 `switch` 方言）。
6. **起步模型带好能力与另一条线路的参数。** 三个豆包 Seed 两条线路都读了图和 PDF，所以直接是「多模态 + PDF 输入」；④ 线路的思考
   类目以 `routes.anthropic` 停放好——作者切过去就是能关的那个，而不是关不掉的 Claude 默认。
7. **连通测试：兼容端 `/models` 回 401 / 403 也不算定论。** 方舟 Plan 的 ④ 面 `/v1/models` 对有效 key 回 401，而 `/v1/messages`
   收同一把 key。改为像 404 一样再发一次空补全；错的 key 在补全端点上仍是 401，所以不会把坏 key 报成通。
8. **提示条只说作者能行动的事。** 选中方舟平台时预览顶部一条：这种 key 属于哪条前缀、另一种 key 该选哪个平台，套餐加一句条款
   （只许在 AI 工具里用）。用设置页现成的 warn 两色，不新造颜色；其他平台没有这条——没有「选错就是 401、测试也解释不了」的问题。
9. **主机框末尾的 `/` 在保存前去掉。** 顺手修的旧问题：粘贴 `https://host/` 会得到 `host//api/…`，每个平台都会撞上，这次在方舟
   的预览地址里第一次看见。
10. **套餐平台补上 Responses 线路，联网搜索按线路记。** 首轮探测把 `/responses` 打在了没有 `/v3` 的路径上，得 404，于是漏了 ②；
    对照厂商「联网搜索工具」页（只列 Responses 与 Messages）复核时发现 `/api/plan/v3/responses` 是通的，三款模型的文本 · 图 ·
    PDF · 思考 · 工具轮 · 搜索都过了。所以 ② 进线路表、`pdfFamilies` 里本来就有它；搜索 ②④ 记 `yes`、① 记无。② 的
    `{type:"web_search"}` 不加文档写的 `sources:["doubao"]`：套餐 key 上不写也记在豆包搜索源下，而加这个字段就得给一个平台私有的
    参数开口子——没有它不工作之前不开。按量平台的 ② 搜索仍是 `unknown`：那把 key 上不写 `sources` 可能落到需要另开通、按次计费的
    「联网内容插件」，没有按量 key 测不了，就不说 `yes`。
11. **两个平台都带 Seedream 出图起步模型，钉在 Chat 线路。** 出图走渠道同一把 key 的 `{Chat base}/images/generations`（出图接口
    `ark`，见 `image-generation-plan.md` PR7），所以不另建渠道。图片模型用的是它的当前线路，而套餐的 Anthropic 线路 base 是
    `/api/plan`——作者把它排到首位时，没钉住的出图行会拼出不存在的路径，所以起步行写明 `activeRoute: "openai"`，
    起步模型也因此能携带 `caps` 与 `activeRoute`。
    按量平台的起步清单因此**只有**出图模型，而「第一个加进来的模型成为对话模型」这条规则不看类型——新装的应用第一个渠道选按量，
    对话模型就成了 Seedream，每次对话都失败。所以自动选对话模型（首次添加、选中项失效时的回落）一律跳过出图 / 视频模型
    （`canAutoSelectAsChat`）；作者手动选什么都行，这条只管应用替作者选的时候。

## 14. 一把 key 走遍所有路径的平台：智谱 BigModel（2026-09-19）

与 §13 的方舟正相反：智谱的一把 key 在 `open.bigmodel.cn` 的四个前缀上都回 200（① `/api/paas/v4`、① `/api/coding/paas/v4`、
④ `/api/anthropic`、② `/api/v1`），**路径决定扣余额还是扣 GLM Coding Plan**，套餐条款又只许「指定工具」使用。事实见
[`landscape.md`](../api/landscape.md) §7 第十四个样本，对照与分片见 [`zhipu-plan.md`](../api/zhipu-plan.md)。这里只记架构上的两条取舍：

1. **只立一个按量平台，只列标准端点一条线路。** 方舟的拆分靠 401 自证——选错的人连不上。智谱没有这道闸：把编程端点
   也挂进同一个渠道的线路表，作者换一条线路就可能在不知情时从余额切到套餐、进而踩到条款。所以 `zhipu` 只有 ①
   `/api/paas/v4`；编程端点是否另立平台（`zhipu-coding`）留给作者决定（plan P3）。平台提示条照实说明两种计费。
2. **「只认 `auto`」记在平台画像上（`forcedToolChoice: "ignored"`），不记在思考类目上。** 以前两处降级都挂在类目
   （Qwen 的 `switch` 方言、MiniMax），因为那两家的规则跟思考开关绑在一起。智谱的规则是端点的：文档写死只认 `auto`，
   5.3-flash 与 4.7 无视强制，4.7 在思考开时对具名强制回一个**不提 `tool_choice`** 的 1210——`toolChoice.ts` 按报错里的
   参数名学习降级，在这里认不出。与思考无关的事实放进与思考无关的那一层（§4 规则 1：按 `(platform, family)` 分派）。
3. **平台画像多了一张「模型 id → 预填值」的校准表（`ModelCalibration`）。** 协议族的默认思考参数在智谱的 11 款上全错（三代三种控制），
   作者手动加模型时拿到的「自动」就是错的。表是 L2（平台）上关于 L3（模型）的**预填**：模型抽屉按精确 id 把类目 / 上下文 / 上限 /
   类型 / PDF 写进新行的表单，存下后就是普通的模型字段，运行时不再查表——所以它不是第二个「默认值」来源，也不需要迁移。
   理由与约束见 [`zhipu-plan.md`](../api/zhipu-plan.md) §5。

## 15. 哪些渠道可以不填 API Key（2026-09-24）

以前渠道抽屉只在主机是回环地址（`localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]`）时把 key 放成选填。可 Ollama、
LM Studio 最常见的摆法是**跑在局域网里另一台机器上**（`http://192.168.x.x:11434`），这时抽屉照样要 key——作者手里根本没有
这把 key，只能随手填个假值糊过去。子代理与看图（`resolveSubAgentConn` / `resolveVisionConn`）更严：空 key 一律报「去填 key」，
连回环上的 Ollama 也过不去。

现在由一个谓词回答——`keyOptional(channel)`（`lib/ai/routes.ts`），抽屉、子代理、看图共用：

1. **平台是 `ollama`，不看主机。** Ollama 本身没有 key 这回事；放在反代后面、走公网域名的 Ollama 也一样可以留空。
2. **否则，渠道的每一条线路都落在本机或局域网**（`isPrivateNetworkUrl`，`lib/http.ts`）：回环、RFC 1918 三段、链路本地
   `169.254/16`、CGNAT `100.64/10`（Tailscale 发的就是这段）、IPv6 ULA `fc00::/7` 与链路本地 `fe80::/10`、mDNS 的 `.local`。
   LM Studio 没有自己的平台，落在 `custom`，靠这一条。**每一条**而不是「主机」：一条线路可以用整段 URL 换到公网主机，那条要 key。
3. **公网主机仍然必填。** 那里缺 key 几乎总是漏填，保存时拦下来比跑到一半回 401 好。「选填」只是不拦，不会替作者删掉已存的 key。

**为什么不直接放宽 `isLocalUrl`**：它回答的是另一个问题——要不要把请求的 `Origin` 改写成 `http://localhost`，好过
Ollama 的 `OLLAMA_ORIGINS`。把局域网也并进去，会悄悄改写发往局域网主机的每一个请求，而它们并没有要这个。两个问题各用一个谓词。

**转写（ASR）不跟着放宽**：那条路只通 DashScope，不存在免 key 的本地端点，空 key 仍是配置错误（`lib/asr/conn.ts`）。
