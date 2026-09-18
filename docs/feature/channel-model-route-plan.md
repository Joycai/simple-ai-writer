# 「供应商与模型」重构：渠道 × 模型 × 线路

> 状态：`proposal`（2026-09-18）。设计稿是 Claude design 画布
> [供应商与模型 · 渠道×模型×协议](https://claude.ai/artifact/2HjRGWX4SnbxBfrJhhkU2S)（屏 01–08）。
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
                                  // | "xai" | "minimax" | "orcarouter" | "newapi" | "ollama" | "comfyui" | "custom"
  name: string;
  /** 这个平台提供哪些线路，各自的默认地址与鉴权。newapi / custom 只给路径约定，主机作者填。 */
  endpoints: Partial<Record<ProtocolFamily, { baseUrl: string; official: boolean; authMode?: AuthMode }>>;
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
  family TEXT NOT NULL,                                    -- openai | responses | gemini | anthropic
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
| 01 渠道与模型 · 总览 | 列表该按什么分组？ | 左栏是**渠道**（平台徽标 + 线路格 ①②③④ + key 状态），右栏是该渠道的模型；每行尾部一个 mono 线路签 `② Responses`——一眼看出哪个模型走哪条路 |
| 02 添加渠道 · 选平台 | 「添加」时作者先选什么？ | 先选**平台**，不再选协议。选中后右侧预览这个平台会建哪几条线路、每条线路认哪些服务端工具、起步模型；只要填**一把 key** |
| 03 渠道抽屉 · 线路表与路径 | 一个渠道的多个协议在哪里配？路径怎么改？ | 渠道抽屉里一张线路表：每族一行（路径 / 鉴权 / 连通测试 / 启用）。主机填一次；每条线路的路径默认取平台约定，可单独改成另一段路径或一整条 URL，「恢复默认」回到约定；每行下方显示实际请求地址（§5.1.1） |
| 04 模型抽屉 · 线路切换 | 同一渠道下怎么切一个模型的协议？ | 抽屉头部一条**线路条**（渠道提供的线路，已启用的实底、未启用的虚线 `+`）；下面的节标出作用域：「模型」节与「本线路」节，本线路节的标题带线路签 |
| 05 服务端工具 · 可用性矩阵 | 「这个工具这里能不能用」怎么说清？ | 能力声明里服务端工具变成矩阵：行 = 工具（作者的授权开关），列 = 线路，格 = 能拼 / 拼不出 / 未实测；当前线路那一列高亮。声明了但当前线路拼不出 = 开关仍亮 + 一行「本线路不发」 |
| 06 切换线路 · 差异 | 切线路时哪些参数变了？ | 点另一条线路时，线路条下方就地展开一张差异卡：思考 / 最大输出 / 结构化 / 服务端工具 各一行 `旧 → 新`，没配过的线路显示虚线「未设置 · 不发」——**不从旧线路抄参数**（不变量 3） |
| 07 合并同一渠道 | 迁移后的重复渠道怎么收拢？ | 列表顶部提示条 → 合并预览（线路并入、同名模型合一、被替换的引用计数）→ 确认 |
| 08 同一模型 · 两个渠道 | 「同一模型在不同平台能力不同」给作者看得见吗？ | DeepSeek-V4-Pro 在「DeepSeek 官方」与「百炼」两个渠道下的对照：线路、服务端工具、看图各不相同。这是说明屏，产品里的落点是模型行悬停时的「同名模型」提示 |

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
- **生图 / ASR 模型的线路化**：它们今天已经有自己的路由（`ImageRoute`、`asrFormat`），与对话协议不是一回事。本方案只覆盖对话模型；生图模型挂在渠道下，但不显示线路条。
- **画像进配置备份或可由作者编辑**：画像是实测结论，作者要表达「我知道这个中转站也认 X」时，用的是 `custom` 平台 + 协议原生工具的「未实测」开关，而不是改画像。

## 10. 待决问题

1. 模型选择器里同名模型（两个渠道都有 `deepseek-v4-pro`）是否需要按渠道分组？今天的 `ModelSelector` 已按供应商分组，P4 之前不动。
2. `custom` 平台上 ② 族的 `{type:"web_search"}` 是否默认可开？目前倾向「可开、标未实测」，与 ④ 族今天一致；需要一次中转站实测来定。
3. 迁移推断平台的主机表放在哪——`platforms.ts` 每个画像带 `hosts: string[]`，还是单独一张表。倾向前者（一个平台的事实在一处）。
