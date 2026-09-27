# 能力解析层重构：LLD

> **状态：`planned`——HLD §6 的七个决定已由作者于 2026-09-27 全部按推荐拍板（§0）；P0 起按 §6 分期实施，尚未开工。**
> HLD：[`capability-resolution-hld.md`](capability-resolution-hld.md)。本文回答：分几个 PR、每个 PR 动哪些文件哪些函数、
> 类型长什么样、算法怎样逐格复现今天的行为、怎么测、怎么回滚。对照的是 2026-09-27 的 `main`（`d31ab9fc`，#717 之后）；引用一律写文件 + 符号，不写行号（`docSourceRefs.test.ts`）。

## 0. 定下来的取舍（作者 2026-09-27 拍板）

| 决定 | 结论 | 影响的期 |
| --- | --- | --- |
| D1 模型值是运行时缺省 | 是；只作用于有「未设」状态的字段 | P6 |
| D2 Anthropic `max_tokens` 只信作者值与探测值 | 是 | P6 |
| D3 学到的降级 | 会话级，不持久化 | P3 |
| D4 回退执行器 | P3 合存储；P7 合执行器（可选） | P3、P7 |
| D5 门面加子目录 | `capabilities.ts` 门面 + `capability/` | P1 |
| D6 棘轮扩面 | 是 | P0 |
| D7 界面先出设计稿 | 是 | P6 |

## 1. 文件布局

```
src/lib/ai/
  capabilities.ts            门面：只做转出。保留 capabilityVerdict / hasCapability / familyVerdict /
                             effortOnWire / effortMenuOnWire / hasAnyServerTool / CAPABILITY_* 的名字与签名
  capability/
    facts.ts                 FactId、FactSpec、FACTS 登记表（Record<FactId, FactSpec>：不登记就编译不过）
    rules.ts                 协议规则（原 CAPABILITY_RULES）+ 值类事实的族缺省（原 defaultCategoryId 的 switch）
    modelId.ts               canonicalModelId、ModelPattern（eq / prefix / re）、matchRows、specificity
    cells/platform.ts        平台格（原 PLATFORM_CAPABILITIES + PROFILES[*].models + responsesInclude）
    cells/upstream.ts        上游格（原 UPSTREAM_CAPABILITIES）
    cells/catalog.ts         全局模型目录，只收固有类事实（原 KNOWN_OUTPUT_CAPS、KNOWN_JSON_SCHEMA、/non-reasoning/）
    resolve.ts               resolve()：§3.3 的裁决链
    intent.ts                gate / override / tier 三个策略 + 出处信任表
    conditions.ts            RequestContext、Condition、wireThinks()
    learned.ts               学到的存储 + LEARN_RULES + classify()
    plan.ts                  RequestPlan、planRequest()
  platforms.ts               只剩地址、主机识别、线路、reportsCost、source（`models` 与 `responsesInclude` 迁走）
  modelLimits.ts             只剩应用偏好（DEFAULT_MAX_OUTPUT_KEY / defaultMaxOutput）；effectiveMaxOutput 变成门面
  jsonMode.ts                只剩拼法（jsonModeShaping 的按族 switch、JSON_ONLY_CUE、isJsonModeRejection 转给 LEARN_RULES）
  toolChoice.ts              删除（P3 并入 learned.ts，P4 的判定并入 plan.ts）
```

测试仍在 `src/lib/ai/__tests__/`。被测对象在 `lib/ai/` 之下，不能放进平铺目录，`testPlacement.test.ts` 不需要加行。

## 2. 类型

```ts
// capability/facts.ts
export type FlagFactId =
  | CapabilityId                 // 今天的 20 个，名字不变
  | "jsonObjectTier"             // 这一族有没有「任意 JSON 对象」档（替 structuredOutputModesFor 的按族分支）
  | "promptCache"                // 显式缓存断点（替 anthropic.ts 的 cachesPrompt 里的 standard ===）
  | "strictSchemaModel"          // 模型守不守严格 schema（原 KNOWN_JSON_SCHEMA）——固有类
  | "reasons";                   // 模型有没有可加密的推理（原 /non-reasoning/i）——固有类
export type ValueFactId = "thinkingCategory" | "maxOutput" | "contextSize" | "responsesInclude";
export type FactId = FlagFactId | ValueFactId;

interface FactValueMap {
  thinkingCategory: ThinkingCategoryId;
  maxOutput: number;
  contextSize: number;
  responsesInclude: readonly string[];
}

type ScopeClass = "transport" | "intrinsic";
type IntentPolicy = "none" | "gate" | "override" | "tier";

interface FactSpecBase {
  scope: ScopeClass;
  intent: IntentPolicy;
  /** 请求条件：满足即 no / condition。与格上的 unless 合并。 */
  unless?: readonly Condition[];
}
interface FlagFactSpec extends FactSpecBase {
  kind: "flag";
  rule: CapabilityRule;          // 原样搬过来，去掉 thinkingOff（改成 unless 里的条件，§3.5）
}
interface ValueFactSpec<V> extends FactSpecBase {
  kind: "value";
  /** 族缺省；undefined = 该族没有缺省（落到兜底常量）。 */
  familyDefault?: Partial<Record<ProtocolFamily, V>>;
  /** 兜底常量或读偏好，调用时读（不在模块作用域读 prefs）。 */
  fallback?: () => V | undefined;
}
```

```ts
// capability/modelId.ts
export type ModelPattern =
  | { eq: string }               // 规范化后整串相等
  | { prefix: string }           // 规范化后的普通 startsWith——与今天两张表相同。"glm-5" 要命中 "glm-5v-turbo"、
                                 // "gpt-5" 要命中 "gpt-5.6-sol"，所以不加分段边界
  | RegExp;                      // 正则，对规范化 id；不强制锚定——上游的 /claude/、/gpt/ 与 /non-reasoning/ 今天就是子串匹配

export interface Subject {
  raw: string;                   // 模型行上的原样 id
  canonical: string;             // §3.1
  upstream?: RelayUpstreamId;
  type?: ModelType;
}
```

```ts
// capability/cells/*.ts
type FlagCellValue = boolean | "per-model";      // "per-model" 就是今天 ModelMatcher 带 runs 的语义（§3.2）
type CellValue<F extends FactId> = F extends ValueFactId ? FactValueMap[F] : FlagCellValue;

type CellBlock = { [F in FactId]?: CellValue<F> } & {
  /** 模型行：按 §3.2 的具体度排序后逐事实首个命中。 */
  models?: readonly ModelRow[];
  /** 这一块上的请求条件，只作用于块内写了的事实。 */
  unless?: Partial<Record<FactId, readonly Condition[]>>;
};
interface ModelRow {
  match: ModelPattern;
  set: { [F in FactId]?: F extends ValueFactId ? FactValueMap[F] : boolean };
  /**
   * 只给抽屉预填、永不进裁决链的值——今天 ModelCalibration 里的 `type` 与 `pdfInput`。
   * `type` 没有「未设」状态；`pdfInput` 是作者的声明而不是线路能力，写成开关行会把
   * 这些 id 的裁决原因从 protocol 改成 measured。所以两者留在这里。
   */
  prefill?: { type?: "multimodal"; pdfInput?: true };
}

interface PlatformCells {
  relay?: true;
  families?: Partial<Record<ProtocolFamily | "all", CellBlock>>;
}
interface UpstreamCells {
  models: ModelPattern;          // 原 /claude/、/gpt/，改成对规范化 id 的模式
  modelsLabel: string;
  families: Partial<Record<ProtocolFamily | "all", CellBlock>>;   // 上游块里不写 models（今天就是这条约束）
}
interface CatalogRow extends ModelRow {
  source: string;                // 厂商文档或 landscape.md 样本
}
```

```ts
// capability/conditions.ts
/** 每个字段都可缺：抽屉只知道类目，适配器全知道。缺的输入按条件自己的 `absent` 处理。 */
export interface RequestContext {
  functionTools?: boolean;
  thinkingCategory?: ThinkingCategoryId;         // 已解析的类目（今天 CapabilityModel.thinkingCategory 的位置）
  thinking?: "on" | "off" | "unknown";           // wireThinks() 的结果
}
export type Condition =
  // 带函数工具时不可用。缺输入 → 不求值，留在 Resolution.conditions 里给抽屉写说明。
  | { when: "functionTools"; absent: "defer" }
  // 类目不是 off 就不可用——今天 thinkingOff 的原样语义。缺输入 → 触发（今天「缺类目算在想」）。
  | { when: "categoryThinks"; absent: "fire" }
  // 按线上思考状态。unknown 按 unknownAs 算；缺输入 → 不求值。
  | { when: "thinking"; is: "on" | "off"; unknownAs: "on" | "off"; absent: "defer" };
```

```ts
// capability/resolve.ts
export type Source =
  | "author" | "learned" | "upstream" | "platform" | "catalog" | "protocol" | "default";
export interface Resolution<V = never> {
  status: "yes" | "unknown" | "no";   // 值类事实：有值 = yes，无值 = no
  reason: CapabilityReason;           // 今天的 13 个 + learned / catalog / condition / author / default
  source: Source;
  value?: V;
  /** 没有 RequestContext 时未求值的条件，给抽屉写「带函数工具时不发」。 */
  conditions?: readonly Condition[];
}
export interface Wire { platform: PlatformId; standard: ApiStandard }   // CapabilityWire 与 ServerToolWire 合成这一个
```

```ts
// capability/plan.ts
export interface RequestPlan {
  wire: Wire;
  subject: Subject;
  thinking: {
    category: ThinkingCategory; categorySource: Source;
    effort?: ReasoningEffort;                     // effortOnWire 之后
    effortRewrittenBy?: "effortWithTools" | "reasoningOff";
    budget?: number;
    state: "on" | "off" | "unknown";
  };
  temperature?: number;                           // 缺 = 不发
  maxTokens: { value?: number; source: Source; onWire?: number };   // onWire 只给 Anthropic 用（§4.3）
  toolChoice?: { requested: ToolChoice; sent: ToolChoice; downgradedBy?: "category" | "cell" | "learned" };
  structured?: { tier: StructuredOutputMode; shaped: StructuredOutputMode; source: Source };   // shaped：没 schema 时降一档；P7 前只由 structured.ts 读
  serverTools: readonly ServerToolId[];          // 过完声明、格、请求条件
  textVerbosity?: TextVerbosity;
  vlHighResolution: boolean;
  videoFps?: number;
  instructionsField: boolean;
  responsesInclude: readonly string[];
  promptCache: boolean;
  /** 声明了但没发的，逐项带原因——「将发送」的「已声明、不发送」读这里。 */
  withheld: readonly { fact: FactId; reason: CapabilityReason }[];
}
```

## 3. 算法

### 3.1 `canonicalModelId(raw, prefixes?)`

```
id = raw.trim().toLowerCase()
if prefixes 里有最长命中的前缀 p：id = id.slice(p.length).trim()   // 作者的前缀表，已有 matchUpstreamPrefix
else if id 以 "[" 开头且有 "]"：id = id.slice(id.indexOf("]") + 1).trim()
if id 含 "/"：id = id.slice(id.lastIndexOf("/") + 1)                // 同 normalizeModelId
return id
```

- **P2 不启用前两步**，canonical 就等于今天的 `normalizeModelId`。平台格与上游格的正则仍对**原始 id** 匹配，
  所以 OrcaRouter 的 `openai/gpt-6-astra` 原样保留。结果逐字节不变。
- **P6b 才启用前两步**，平台格同时改写成对规范化 id 的模式（`{eq: "gpt-6-astra"}`，作用域 orcarouter）。
  它排在 P6 之后，因为 P6 之前 `effectiveMaxOutput` 的结果会被当作 Anthropic 的 `max_tokens` 发出去（`conn.ts` 的 `connOptions` →
  `anthropic.ts` 的 `resolveMaxTokens`）；先扩大目录命中面，就会把 `[x]kimi-k3` 的 1,000,000 发到中转站的 ④ 线路上。差异见 §5 的 B7。
- **请求路径上要有前缀表**：`ConnOptions` 今天只带解析好的 `relayUpstream`，不带渠道的前缀表（`conn.ts` 的 `connOptions`）。
  P6b 在 `ConnOptions` 加一个字段 `canonicalModelId`，由 `connOptions()` 用渠道的前缀表算好。按 Hard Rule，
  它声明在 `ConnOptions` 这一处。否则抽屉会剥掉 `特价kiro | `，线上却不剥，两边答案不同。
- 上游格的 `models`（`/claude/`、`/gpt/`）保持子串匹配：`特价kiro | claude-opus-4-6` 的上游来自产品名推断，
  没有前缀行能剥掉前面那段，P6b 之后仍是这样。
- 产品名推断（`relayUpstream.ts` 的 `PRODUCT_NAMES`）不动，仍对原始 id 做 `includes`。
  它是读作者数据里的产品词，不猜中转站主自创的缩写。在棘轮的白名单里写明理由。

### 3.2 模型行的匹配与具体度

- 块内的 `models` 在模块加载时排序一次：`eq` → `prefix`（长者在前）→ 正则（保持书写顺序）。
- 查某个事实时，取**第一个命中、且 `set` 里写了这个事实的行**。一行没写这个事实，就继续往下找。
  例如 `gpt-5.6-sol` 行只写了上限，严格 schema 仍由 `gpt-5` 行给出。
- **冲突守卫**（测试）：对每个块、每组样本 id，若两个正则行都命中同一 id，且对同一事实给出不同的值，就失败。
  要有意例外，就改用 `eq` 或更长的前缀，因为它们的具体度本来就更高。今天 DashScope 的 `runs` / `refuses` 没有重叠，守卫从第一天起就是绿的。
- **`"per-model"` 的语义**，逐格复现今天 `ModelMatcher` 带 `runs` 的行为：
  - 行里写 `true` / `false`：返回 `yes / measured` 或 `no / model`。
  - id 不在任何一行：返回 `unknown / model-unlisted`。
  - 没有 id（抽屉里还没填）：返回 `yes / measured`，因为平台确实对某些模型跑这个能力。
  - 今天只写 `refuses` 的格，块上不写这个事实，只写 `false` 行。没命中的 id 落到**协议规则**，与 §8.10 相同。
  - **一个块只要为事实 F 写了模型行，它就「拥有」F**：没命中任何行的 id 直接落到协议规则，跳过同平台的 `all` 块。
    这就是今天的行为——族格里有 matcher 时，`cellFor` 不会再看 `all`（`capabilities.ts` 的 `cellFor` 与 `familyVerdict` 里「refuses-only matcher」那一支）。
    今天没有平台同时写了两者，所以这一条暂时零差异；写明它，是为了不让迁移悄悄改掉它。

### 3.3 `resolve(fact, wire, subject, ctx?)`

```
spec   = FACTS[fact]; family = familyOf(wire.standard)
// ── 0 守卫（开关事实） ──
if subject.type && spec.rule.modelTypes && subject.type ∉ modelTypes   → no / model-type
                                  // 只在有类型时才查（familyVerdict 的第一行）：请求路径不带类型
for dep in spec.rule.requires: if resolve(dep).status == no → no / requires
conds  = spec.unless ∪ 命中那一块的 unless[fact]
for c in conds:
  input 在 ctx 里 → 求值；触发 → no / condition（categoryThinks 的原因码仍是今天的 thinking）
  input 缺       → absent == "fire" ? no / 同上 : 记进 deferred
// deferred 随结果带出（Resolution.conditions），status 不受影响——与今天 hasCapability 的答案相同
// ── 1–3 格 ──
blocks = []
if isRelay(platform) && subject.upstream && upstreamApplies(subject):
  blocks += [UPSTREAM[up].families[family], UPSTREAM[up].families.all]      // source=upstream
blocks += [PLATFORM[platform].families[family], PLATFORM[platform].families.all]   // source=platform
for b in blocks:
  v = lookup(b, fact, subject)          // 先查 models 行（§3.2），再查块上的值
  if v !== undefined: return finish(v, source(b), conds 未求值的部分)
// ── 4 目录（只对固有类） ──
if spec.scope == "intrinsic": v = lookupRows(CATALOG, fact, subject); if v: return finish(v, catalog)
// ── 5 协议规则 ──
flag:  与今天 familyVerdict 的尾部逐行相同（families / origin / relay / assumed）
value: spec.familyDefault?.[family]
// ── 6 兜底 ──
value: spec.fallback?.()
```

**学到的上限不在 `resolve` 里**，`resolve` 是纯的，只读表。学到的上限在两处套上去，两处用的是同一个存储：

- `effective()`：先合成意图，再封顶（§3.4）。作者的声明也要被它封顶，与今天 `effectiveStructuredOutput` 的顺序相同。
- 门面 `capabilityVerdict(id, wire, model, endpoint?)`：给了端点键时，在 `resolve` 的结果上再套一次，原因码 `learned`。
  抽屉由此看得到学到的状态。

`planRequest` 分别问 `resolve` 和学到的存储，所以降级能正确地归到「格」还是「学到」（§3.6）。

**等价性**：对 20 个开关事实，第 0–3 层与第 5 层逐行对应今天的 `familyVerdict`（`capabilities.ts`）。
唯一的形式变化是 `thinkingOff` 改成了条件（§3.5）。P1 用矩阵文档逐字节相同来证明。

### 3.4 意图合成：`effective(fact, intent, resolution, learned)`

| 策略 | 实现 |
| --- | --- |
| gate | `intent === true && resolution.status !== "no" && learned !== "no"` |
| override | `value = intent ?? resolution.value`；`source = intent !== undefined ? "author" : resolution.source` |
| tier | 见下；最后与学到的上限取较低者 |
| none | `resolution` 原样；学到的 `no` 仍然生效 |

`structuredOutput` 档位，逐格复现 `resolveStructuredOutput`（`jsonMode.ts`）：

```
if resolve(structuredOutput).status == no:  return off
strict = resolve(jsonSchema).status
below  = resolve(jsonObjectTier).status != no ? json_object : off      // 规则只含 openai / responses / gemini
tier   = declared
           ? (declared == json_schema && strict == no ? below : declared)
           : (strict == yes && resolve(strictSchemaModel).status == yes ? json_schema : below)
tier   = min(tier, learnedCeiling)
if tier == json_object && resolve(jsonObjectTier).status == no: tier = off   // 原 effectiveStructuredOutput 尾部
```

逐支核对：

- **Anthropic**：
  - 声明 `json_object` → 被最后一行改成 off。✓
  - 声明 `json_schema` 但 `strict == no` → `below = off`。✓
  - 自动档 → 线路实测守严格 schema、且模型在目录里时取 `json_schema`，否则 off。✓
- **其余三族**：`below = json_object`，与今天逐行相同。✓

`strictSchemaModel` 是固有类开关，规则写成 `origin: "native", assumed: "unknown", families: 全部`。
目录没写的 id 得 `unknown`，因此不会自动提档，与 `knownJsonSchemaModel` 返回 false 同效。

### 3.5 思考状态：`wireThinks(category, effortOnWire)`

`ThinkingCategory` 加一个数据字段 `offSpelling: "disable" | "lowest"`：off 在线上是真关，还是落到最低档。
再加 `unsetThinks?: boolean`，取代 `defaultOn` 在线上的含义。`off` 类目什么都不发，结果是端点缺省，它的状态恒为 `unknown`，不需要这两个字段。
逐类目如下：

| 类目 | off 在线上 | 未设在线上 | off → | 未设 → |
| --- | --- | --- | --- | --- |
| `off`（类目） | 不发 | 不发 | unknown（火山方舟的 ④ 什么都不发也在想，见 `reasoning.ts` 里 `doubao-switch` 的注释） | unknown |
| openai-generic | `reasoning_effort:"none"` | 不发 | off | unknown |
| deepseek / glm-effort / doubao | `thinking:{type:"disabled"}` | 不发 | off | unknown（doubao：on，第十二个样本） |
| qwen-budget / qwen-effort | `enable_thinking:false` | 不发 | off | unknown |
| glm | 菜单里没有 off；若由导入带进来，仍然在想 | 不发 | on | on |
| glm-switch | `thinking.type:disabled` | 不发 | off | on（`defaultOn`） |
| responses-effort | `reasoning.effort:"none"` | 不发 | off | unknown |
| gemini3 | `thinkingLevel: LOW` | 不发 | on | unknown |
| claude-adaptive | adaptive + effort low | adaptive | on | on |
| claude-budget | enabled + budget | enabled | on | on |
| minimax / doubao-switch | `thinking:{type:"disabled"}` | adaptive | off | on |

今天有三个消费方各自判断「在思考吗」。下表是它们改用条件之后怎样**逐格不变**：

| 消费方 | 今天 | 改成 | 是否逐格相同 |
| --- | --- | --- | --- |
| `temperature` 在 Anthropic 族（`thinkingOff: ["anthropic"]`） | 类目不是 `off` 就算在想；缺类目也算 | P4：规则上的 `{when:"categoryThinks", absent:"fire"}`，只挂在 anthropic 族 | 是（矩阵文档里那一格仍是 `· thinking`）。换成 `{when:"thinking", is:"on"}` 会让 minimax / doubao-switch 关思考时开始带温度，这是 **B6**，等实测 |
| `forcesToolChoiceAuto`（`while-thinking`） | effort 显式且不是 off 才算在想 | `unknownAs: "off"` | 是：未设 → unknown → off；off → off；其余 → on |
| Responses 的代码解释器（`serverTools.ts` 的 `responsesServerTools`） | 请求体里 `effort === "none"` 才丢 | 块条件 `{when:"thinking", is:"off", unknownAs:"on"}` | 是：只有 responses-effort 的 off 是 off（effortOnWire 之后） |
| agent 的思考回退（`runtime.ts` 的 `runAgent`，`thinkingCut` 分支） | `menu` 含 off，或者是开关型 | 改问 `effortMenuOnWire(category.menu, wire, subject).includes("off") \|\| isOnOffCategory` | 否：gpt-6-astra 在 OrcaRouter 上从 `off` 变 `nudge`。这是 **B8**，属于修正：`reasoningOff` 格说这个模型没有关闭档，今天发出的 off 被 `effortOnWire` 改成了 low，回退其实没生效 |

gemini3 与 claude-adaptive 的 off 在线上也是最低档（`offSpelling: "lowest"`），回退同样关不掉思考。
但它们的菜单里有 off，而且是作者可以选的档，所以本方案不改它们。
要不要让回退改看 `offSpelling`，记为 §10 的待决项。

`thinkingIsOn` 留作界面上开关的显示状态，不参与任何线上判定。它的注释里写明这一点。

### 3.6 强制 tool_choice：三源合一

```ts
// plan.ts
function toolChoiceOf(req, category, effort, wire, subject, learned): RequestPlan["toolChoice"] {
  if (!isForced(req.toolChoice)) return req.toolChoice && { requested: req.toolChoice, sent: req.toolChoice };
  const by =
    forcesToolChoiceAuto(category, effort) ? "category"           // 类目数据：minimax always，qwen while-thinking
    : resolve("forcedToolChoice", wire, subject).status === "no" ? "cell"   // 纯表：智谱、Kiro、anti、Azure Chat
    : learned.has("forcedToolChoice") ? "learned"                 // 存储：DeepSeek V4 的 400
    : undefined;
  return { requested: req.toolChoice, sent: by ? "auto" : req.toolChoice, downgradedBy: by };
}
```

改动的调用方：

- 四个适配器都读 `plan.toolChoice.sent`。
  - `openai.ts` 删掉 `toolChoiceFor`。
  - `anthropic.ts` 的 `toolChoiceBody` 只管拼法。
  - `gemini.ts` 的 `toolConfig` 与 `responses.ts` 的 `tool_choice` 第一次受这个格约束，这是 **B3**。平台自己列出的线路上零差异。
    但智谱的格写在 `all` 上（`PLATFORM_CAPABILITIES.zhipu`），而作者在 `open.bigmodel.cn/api/paas` 下手建的
    `openai_responses_compat` / `gemini_compat` 渠道也会被推断成智谱（`platforms.ts` 的 `inferPlatform`）。那样的渠道上，强制会变成 `auto`。
- `structured.ts` 的 `forcedToolIsWasted` 改成 `plan.toolChoice.downgradedBy !== undefined && plan.structured.tier === "json_schema"`。
  这是 **B4**，不是零差异：今天它看不到格，所以在格为 `false`、档位却到了 json_schema 的线路上，会白跑一轮注定降成 `auto` 的强制调用。
  这样的线路有三种：
  - 中转站 Kiro / anti 上游的 Claude 走 ④，且作者声明了 json_schema（中转站的 `jsonSchema` 是 `unknown`，声明照发）；
  - anti 上游的 Claude 走 ①，且作者声明了 json_schema（anti 在 ① 上没有 `structuredOutput` 格，见 `UPSTREAM_CAPABILITIES.anti`）；
  - Azure 上游的 GPT 走 ①（该上游 `jsonSchema: true`）。

  智谱与 Kiro ① 不在其中：前者 `jsonSchema` 是 `false`，后者 `structuredOutput` 是 `false`。
  改后这几种直接走 JSON 路径，省一轮请求。金标看不到 `structured.ts`，由 `agent/__tests__/agentStructured.test.ts` 逐条钉住。
- `index.ts` 的 `streamCompletion` 里的预降级与失败后的重试，改走 §3.7 的执行器。

### 3.7 学到的降级

```ts
// learned.ts
type Ceiling = false | StructuredOutputMode;           // 开关 → false；档位 → 上限档
interface LearnRule {
  fact: "forcedToolChoice" | "structuredOutput";
  match: RegExp;
  /** 这次请求里这个事实确实用上了（否则这个 400 不是它的）。 */
  used: (plan: RequestPlan) => boolean;
  lower: (plan: RequestPlan) => Ceiling | undefined;   // undefined = 已经到底，不学
}
export const LEARN_RULES: readonly LearnRule[] = [
  // 看「请求了」强制，不看「发出了」：今天 streamCompletion 的重试条件就是 requested，即使适配器已经降成 auto。
  { fact: "forcedToolChoice", match: /tool[_ ]?choice/i,
    used: (p) => isForced(p.toolChoice?.requested), lower: () => false },
  // 降的是实际拼进 body 的那一档（今天 withJsonModeFallback 里的 shaping.mode）。没有 schema 时它会低于计划档，
  // 所以 plan.structured 记两个值：tier（决定的）与 shaped（拼出来的）。
  { fact: "structuredOutput", match: /response_format|text\.format|response_?json_?schema|output_config\.format|output_format/i,
    used: (p) => !!p.structured && p.structured.shaped !== "off", lower: (p) => downgradeJsonMode(p.structured!.shaped) },
];
export function learnedCeiling(key: EndpointKey, fact: FactId): Ceiling | undefined;
export function classify(err: unknown, plan: RequestPlan): { fact: FactId; ceiling: Ceiling } | undefined;
export function noteLearned(key: EndpointKey, fact: FactId, ceiling: Ceiling): void;   // 只降不升
export function __resetLearned(): void;
```

- 键沿用今天的 `${standard} ${baseUrl} ${modelId}`，两个存储本来就用同一个键。
- `AbortError` 一律不学，与两个 `is…Rejection` 相同。
- **P3**：`toolChoice.ts` 与 `jsonMode.ts` 的内存 Map 和 Set 改成调这里，函数名作为门面保留一期。
  门面 `capabilityVerdict` 给了端点键时套上学到的上限（§3.3 末），抽屉由此看得到它，原因码为 `learned`。`resolve()` 本身不变。
- **P7**：`streamCompletion` 变成循环（HLD §4.5）。`withJsonModeFallback` 变成「把 `structured` 意图放进 StreamOptions」的薄包装。
  终止性：每次重试前，`noteLearned` 必须严格降低某个事实的上限，否则抛出原错误。
  格是有限的（开关两级、档位三级），所以最多重试三次。

### 3.8 请求计划与适配器

- `planRequest(opts: StreamOptions): RequestPlan` 是纯函数：只读 opts、表和学到的存储，不做 I/O。
- 挂进 StreamOptions 的方式与 `_onRequestBody` 一样，用一个私有字段 `_plan?: RequestPlan`：
  - `streamCompletion` 算一次，塞进 `wrapped`；
  - 适配器写 `const plan = opts._plan ?? planRequest(opts)`；
  - 直接调适配器的调用方（一致性测试、live 探针）因此不用改。
- 下表逐项列出今天在适配器里的判定，和它们搬去计划的哪个字段：

| 今天 | 行 | 计划字段 |
| --- | --- | --- |
| `resolveThinkingCategory` + `effortOnWire` | `streamOpenAI` · `streamResponses` · `streamGemini` · `anthropic.ts` 的 `thinkingFor` | `thinking` |
| 温度的 `hasCapability` + 类目 | `streamResponses` 的 `sendsTemperature` 等 | `temperature` |
| `resolveMaxTokens` | `anthropic.ts` | `maxTokens.onWire` |
| `toolChoiceFor` / `toolChoiceBody` | `openai.ts` · `anthropic.ts` | `toolChoice.sent` |
| 温度（**不问格**） | `streamOpenAI` · `streamGemini` | `temperature`（开始问格，B11） |
| 服务端工具的 `effective*` 与请求期丢弃 | `serverTools.ts` 的 `effectiveServerTools` 起的一组函数 | `serverTools`（拼法函数改收 id 列表） |
| `vl_high_resolution_images` | `streamOpenAI`（没带 subject） | `vlHighResolution`（带 subject，**B9**：今天 upstream 为空时零差异） |
| `include` + `/non-reasoning/i` | `streamResponses` | `responsesInclude`（`reasons` 事实为 no 时为空） |
| `cachesPrompt` | `anthropic.ts` | `promptCache` |
| `instructionsField` | responses.ts | `instructionsField` |

`wireSummary`（`modelSummary.ts`）改成 `spellSummary(planRequest(summaryOpts))`：

- 六处 `family ===` 退到拼法层，与适配器共用 `spell*` 片段。
- `capabilityFamilyRatchet` 里 `modelSummary.ts` 的上限从 6 降到 0。
- `withheld` 替掉它自己拼的「已声明不发送」。

摘要今天有两处与适配器不一致，读了计划以后会变成一致。这是 **B10**，金标里摘要那一列会动：

- 摘要用的是原始 effort（`wireSummary` 里的 `reasoningBody(category, m.reasoningEffort, …)`），不是 `effortOnWire` 之后的值。OrcaRouter 的 `openai/gpt-6-astra` 设了 off，
  摘要写 `none`，线上发的是 `low`。
- 摘要只在行上填了 `maxOutput` 时才写 `max_tokens`，适配器却总是发。计划的 `onWire` 会让每条 ④ 行都显示一个值。
  P6 之前这个值是表值、应用缺省或 32768；P6 之后按 `TRUST` 表来。

一致性测试的 `PROBES.reasoningOff` 从不比对摘要（`capabilityConsistency.test.ts`），所以前一处一直没被抓到。
P5 的总断言会把它补上。

### 3.9 值类事实的出处信任（P6）

```ts
// intent.ts
export const TRUST: Record<Consumer, readonly Source[]> = {
  planner:        ["author", "upstream", "platform", "catalog", "default"],
  contextGate:    ["author"],                 // 探测值今天写进作者字段，所以 "author" 已经包含它（provider-layering 偏离三）
  anthropicMaxTokens: ["author"],             // D2；不收则用 DEFAULT_MAX_TOKENS
  placeholder:    ["upstream", "platform", "catalog", "default"],
};
```

`connOptions()` 不再把 `effectiveMaxOutput` 的结果当成 `maxOutput` 传下去，改为传 `{value, source}`。
`budget.ts` 的 `ASSUMED_INPUT_CEILING_TOKENS`（32000） 改为「planner 可信的 `contextSize`，否则 32000」。

## 4. 符号迁移表

| 旧 | 新 | 期 |
| --- | --- | --- |
| `CAPABILITY_RULES` | `capability/rules.ts` `PROTOCOL_RULES`（经 `FACTS[*].rule`） | P1 |
| `PLATFORM_CAPABILITIES` | `cells/platform.ts` `PLATFORM_CELLS` | P1 |
| `UPSTREAM_CAPABILITIES` | `cells/upstream.ts` `UPSTREAM_CELLS` | P1 |
| `ModelMatcher` `{runs, refuses}` | 块值 `"per-model"` + `models` 行 | P2 |
| `PROFILES[*].models` / `ModelCalibration` / `platformModelCalibration` | 平台块的 `models` 行：`thinkingCategory` / `contextSize` / `maxOutput` 进 `set`（P6 前不参与裁决，只供预填），`type` / `pdfInput` 进 `prefill`；函数保留为读格的门面，预填照旧 | P2 |
| `ProviderDrawer.tsx` 起步模型里写死的类目（`doubao(…)`、OrcaRouter 免费 DeepSeek） | volcengine-plan / orcarouter 的 `models` 行，起步模型改读格 | P2 |
| `KNOWN_OUTPUT_CAPS` / `knownMaxOutput` | `cells/catalog.ts` 的 `maxOutput` 行；函数成为门面 | P2 |
| `KNOWN_JSON_SCHEMA` / `knownJsonSchemaModel` | 目录的 `strictSchemaModel` 行 | P2 |
| `normalizeModelId` | `canonicalModelId`（P2 行为相同） | P2 |
| `/non-reasoning/i`（`streamResponses`） | 目录行 `{match: /non-reasoning/, set: {reasons: false}}` | P2 |
| `platformResponsesInclude` | 值类事实 `responsesInclude`（xAI 块） | P2 |
| `CapabilityWire` + `ServerToolWire` | `Wire` | P1 |
| `toolChoice.ts` 的 Set、`jsonMode.ts` 的 Map | `learned.ts` | P3 |
| `thinkingOff` 规则字段 | 规则上的 `unless` 条件 | P4 |
| serverTools 的请求期丢弃（:320、:330、:360） | DashScope 块的 `unless` | P4 |
| `structuredOutputModesFor` 的按族分支 | `jsonObjectTier` 事实推出 | P4 |
| `cachesPrompt` | `promptCache` 事实：规则 `{families:["anthropic"], origin:"private", official:"yes"}`——官方标准上缺省 yes，兼容标准上照 private 缺省 no，直到某个平台格写了实测。**不能**写成 anthropic 平台格：指向 api.anthropic.com 的 `anthropic_compat` 渠道也解析成 anthropic 平台（`platforms.ts` 的 `resolvePlatform`），今天它不带缓存断点 | P4 |
| `ProviderDrawer.tsx` 的 `pickPlatform` 里的 `newapi \|\| custom` | `isRelayPlatform()` | P1 |
| `toolChoiceFor` / `forcedToolIsWasted` 各拼两源 | `plan.toolChoice` | P5 |
| `defaultCategoryId` 的 switch | `FACTS.thinkingCategory.familyDefault` | P6 |
| `effectiveMaxOutput` | `maxOutput` 值类事实 + `TRUST` | P6 |

## 5. 行为变化账本

每一条只出现在点名的那一期，并在金标差异里逐条对上。

| # | 变化 | 期 | 今天的差异 | 为什么是对的 |
| --- | --- | --- | --- | --- |
| B1 | Anthropic `max_tokens` 只收作者值 | P6 | 没填上限、又设了应用缺省的 Anthropic 行；④ 线路上不是 Claude 的 id | `modelLimits.ts` 头注第 1 条；D2 |
| B2 | 平台格的思考类目、窗口、上限成为运行时缺省 | P6 | 在有格的平台上把这些字段留空的行 | zhipu-plan G11；D1 |
| B3 | Gemini 与 Responses 读 `forcedToolChoice` 格 | P5 | 平台自己列出的线路上零差异；作者在智谱主机下手建的 ② / ③ 渠道上强制变 `auto`（§3.6） | 一张表对所有族说话 |
| B4 | `forcedToolIsWasted` 读格 | P5 | 中转站 Kiro / anti 的 Claude 在 ④ 上声明了 json_schema，以及 Azure 上游 GPT 在 ① 上：结构化任务不再白跑强制调用那一轮（§3.6） | 「强制会不会被执行」只有一个答案 |
| B5 | `ProviderDrawer` 的中转站判定走 `isRelayPlatform` | P1 | 零（集合相同） | 一个判据 |
| B6 | Anthropic 族的温度按 `wireThinks` | **不排期** | minimax / doubao-switch 关思考时开始带温度 | 需要一条 ④ 关思考加温度的实测，先记进 `issues/` |
| B7 | 规范化 id 去掉作者前缀与 `[…]` | P6b | 中转站上 `[x]gpt-5…`、`[x]claude-…` 开始命中目录。自动档里，Azure 上游 GPT 的 JSON 会提到 json_schema（该上游 `jsonSchema: true`）；规划用的上限会变。排在 P6 之后，所以不会再改 Anthropic 的 `max_tokens`（§3.1） | 同一个模型不因前缀失去已知事实 |
| B10 | 「将发送」摘要读计划 | P5 | 摘要写线上真实的 effort（gpt-6-astra 设 off 显示 `low`）；④ 行总显示 `max_tokens`（§3.8） | 摘要与适配器逐字一致，不再靠测试钉 |
| B11 | Chat 与 Gemini 适配器的温度开始问格 | P5 | 零：这两族今天没有温度的 `false` 格 | 同 B3 |
| B8 | agent 的思考回退问 `effortMenuOnWire` | P4 | OrcaRouter gpt-6-astra 在预算耗尽时从「关思考」变成「提示立即作答」 | 今天那个 off 在线上是 low，回退其实没生效 |
| B9 | `vlHighResolution` 带着 subject（id 与上游）裁决 | P5 | 零：没有哪个上游写了这一格。请求路径上 subject 仍不带模型类型——`ConnOptions` 没有这个字段，本方案不加 | 与其它能力同一种问法 |

## 6. PR 分期

### P0 —— 护栏先行（`chore/`，无生产代码）

- **`src/lib/ai/__tests__/requestGolden.test.ts`（新）**。仿照 `toolDefinitionsSnapshot.test.ts`，用真实适配器生成：
  - fetch 打桩，用 `_onRequestBody` 截取 body；
  - 网格：每个平台 × 它的每条线路 × `capabilityConsistency` 的 `CASES`（22 组：7 个 id，加 7 个上游 × 2 个 id，加 1 组「Kiro id 解析为 none」）× 4 组声明 × 2 种请求；
  - 4 组声明：空；全开关都声明；`structuredOutput: json_schema` 加类目 off；effort high 加 budget；
  - 2 种请求：不带工具；带函数工具加强制 `required`；
  - body 去掉 `messages` / `input` / `contents` / `system`，键排序后按平台分文件写快照；
  - 同一网格再跑一遍 `wireSummary`，与 body 并排存。
  规模大约 3000 格，每格百余字节。
- **`src/lib/__tests__/capabilityFamilyRatchet.test.ts`** 加三种模式，起点等于当时的实际计数：
  - `\b(standard|apiStandard)\s*[!=]==\s*["']`：今天 `anthropic.ts` 的 `cachesPrompt`（1 处）、`types.ts` 的 `authModesFor`（2 处）；
  - `\bplatform\w*\s*[!=]==\s*["']`：今天 `ProviderDrawer.tsx` 的 `pickPlatform`（2 处）、`comfyMode`、`PlatformPreview` 各 1 处；
  - 格文件之外对 `modelId` 的 `.test(` / `.includes(` / `.startsWith(`：今天 `streamResponses` 的 `/non-reasoning/i`、`reportedCost.ts` 的 `reportsCostFor`，搜索框两处除外。
  白名单沿用 `WIRE_SHAPE`，所以 `routes.ts` 的 `newChannelEndpoints` 不计入。另外加两项：`relayUpstream.ts`（理由见 §3.1）与 `lib/asr/`（不在本方案范围，照 HLD §2 非目标），
  所以 `asr/formats.ts` 的 `looksLikeFiletransModel` / `looksLikeSyncAsrModel` 不计入。以上计数是 grep 的估计，入库时以词法扫描的实际结果为起点。
- 验收：`pnpm test` 绿，快照入库。

### P1 —— 拆目录、建登记表（`refactor/`）

- 新建 `capability/facts.ts`、`rules.ts`、`cells/platform.ts`、`cells/upstream.ts`、`resolve.ts`，从 `capabilities.ts` 原样搬迁。
  `capabilities.ts` 只剩转出与 `effortOnWire` / `effortMenuOnWire` / `hasAnyServerTool`。
- 合并 `Wire` 类型；把 `ProviderDrawer.tsx` 的 `pickPlatform` 改用 `isRelayPlatform`（B5）。
- 验收：
  - `capability-matrix.md` 逐字节相同；
  - 金标零差异；
  - `capabilities.test.ts` 与 `capabilityConsistency.test.ts` 只改 import 路径（门面在，所以理应不改）。

### P2 —— 模型 id 轴合一（`refactor/`）

- 新建 `modelId.ts`（`canonicalModelId`，此期只做 `normalizeModelId` 的那一步）和 `cells/catalog.ts`。
- 按 §4 迁移 P2 的各行。其中 `ModelCalibration` 转成平台块的 `models` 行：
  `thinkingCategory` 写在对应族的块里（doubao 在 openai 块，doubao-switch 在 anthropic 块），其余写在 `all` 块。
- `platformModelCalibration(platform, modelId)` 保留签名，改成从格里读出 `ModelCalibration` 的形状。抽屉的 `applyCalibration` 与起步模型不改逻辑。
- 新测试 `modelIdAxis.test.ts`，覆盖四样：
  - 冲突守卫（§3.2）；
  - 旧表与新格逐 id 等价：对旧 `KNOWN_*` 与 `PROFILES.models` 里的每个 id，以及它们的带日期、带厂商前缀变体，新旧函数给出相同的值；
  - `"per-model"` 在空 id 时的答案；
  - 作用域等级：传输类事实不得出现在全局目录里。编译期用类型约束（`CatalogRow.set` 只收固有类事实），运行期再遍历断言一次。
- 验收：矩阵文档与金标零差异。

### P6b —— 规范化 id 生效（`feat/`，带版本号；必须在 P6 之后）

- 启用 `canonicalModelId` 的前两步；平台格里的原始 id 模式改成规范化模式；`ConnOptions` 加 `canonicalModelId`（§3.1）。
- 金标差异必须**恰好**是 B7 列出的格。在 `landscape.md` 或本文实施记录里逐条写明。

### P3 —— 学到的降级合一（`refactor/`）

- 新建 `learned.ts`（§3.7）。`toolChoice.ts` 与 `jsonMode.ts` 的存储改成转调；`effective` 与门面 `capabilityVerdict` 接上学到的上限（§3.3 末），原因码为 `learned`；`resolve` 仍是纯的。
- 语言文件新增 `aiConfig.capReason.learned`，两种语言。
- 测试：
  - 两条学习规则各自的正反例，直接从 `toolChoice` / `aiJsonMode` 的测试迁来；
  - 「学到之后，抽屉的裁决变成 `no / learned`」；
  - `__resetLearned` 在 `afterEach` 里调用。
- 验收：金标零差异（网格里没有学到的状态）。

### P4 —— 条件、思考状态、表里新增四个开关（`refactor/`）

- `conditions.ts`：给类目加 `offSpelling` / `unsetThinks` 两个字段；`thinkingOff` 与 serverTools 的三处请求期丢弃改成条件。
- 新增 `jsonObjectTier`、`promptCache` 两个事实的规则与格。`strictSchemaModel`、`reasons` 已在 P2 随目录落地，此期只给它们补提问者。
  `structuredOutputModesFor` 与 `cachesPrompt` 改读表；`capabilityConsistency.test.ts` 的 `PROBES` 为它们各加一个提问者。
  `PROBES` 是 `Record`，不加就编译不过。
- agent 的思考回退（B8）。
- 新测试 `wireThinks.test.ts`：§3.5 两张表逐格断言，外加「三处旧判法 ≡ 新条件」的穷举：15 个类目 × 8 个 effort × 4 族。
- 验收：金标除 B8 外零差异。B8 不在请求体里，它在 agent 事件里，由 runtime 测试钉住。

### P5 —— 请求计划（`refactor/`）

- 新建 `plan.ts`；`streamCompletion` 算一次，塞进 `_plan`。四个适配器按 §3.8 的表删掉判定、只读计划。
- `modelSummary.ts` 改成 `spellSummary(plan)`（B10）；`structured.ts` 改读 `plan.toolChoice`（B4）。适配器读计划带来 B3、B9、B11。
- `capabilityFamilyRatchet` 的 `modelSummary.ts` 上限降到 0。
- 一致性测试新增一条总断言：对每一格，`planRequest` 决定发的每个事实，body 里都能找到它的拼法；决定不发的，body 里都找不到。
  这比按事实写 `PROBES` 更强，旧 `PROBES` 保留一期作为对照。
- 验收：请求体金标零差异；摘要列的差异恰好是 B10。

### P6 —— 值类事实与出处（`feat/`，带版本号；界面在设计稿之后）

- `thinkingCategory`、`maxOutput`、`contextSize` 走链（§3.3），`TRUST` 表生效（§3.9）。
- `connOptions()` 传出处；`resolveThinkingCategory` 保留签名，内部改走 `resolve("thinkingCategory")`。它的旧方言迁移保持在最前面，排在作者声明之后、格之前。
- 开工前先查 `pdf_input` 列能不能区分「未设」与 `false`。不能，就维持预填（D1）。
- 界面：
  - 抽屉的占位符与说明显示出处（「来自平台实测」「来自模型目录」「本次会话学到」）；
  - `CapabilityMatrix` 多出值类事实的一栏；
  - **先出 Claude Design 稿**（D7）。逻辑部分可以先合。
- 矩阵生成器多出「思考类目缺省」「输出上限来源」两节。
- 验收：金标差异恰好是 B1、B2；其余零差异。

### P7 —— 回退执行器合一（可选，`refactor/`）

- `StreamOptions` 加 `structured?: { schema?: JsonSchemaSource; promptText: string }`。计划决定档位，`streamCompletion` 负责插入 cue 与 `extraBody`。
- `withJsonModeFallback` 变成薄包装；`lore/generator.ts`、`agent/structured.ts` 两处调用方随之简化。
- 验收：金标零差异，`aiJsonMode` 的回退测试全部通过。

## 7. 测试清单

| 测试 | 状态 | 守的是什么 |
| --- | --- | --- |
| `requestGolden.test.ts` | 新（P0） | 每期逐字节不变；有意的差异可审 |
| `capabilities.test.ts` | 保留；P6 起生成器扩出值类事实 | 表的渲染即文档 |
| `capabilityConsistency.test.ts` | P4 加提问者，P5 加总断言 | 提问者与表一致 |
| `capabilityFamilyRatchet.test.ts` | P0 扩三种模式 | 判定不回流 |
| `modelIdAxis.test.ts` | 新（P2） | 模式冲突、旧表等价、作用域等级 |
| `wireThinks.test.ts` | 新（P4） | 思考状态只有一个定义，且复现旧行为 |
| `learned.test.ts` | 新（P3，迁自 `toolChoice` / `aiJsonMode` 的相关用例） | 学习只降不升、会终止、抽屉看得到 |
| `plan.test.ts` | 新（P5） | 计划是纯函数；同一输入同一计划；`withheld` 完整 |

所有新测试都调用真实的生产者（适配器、`planRequest`、`resolve`），不手写「它应该产出什么」的样本。

## 8. 文档

- `docs/README.md`：登记本文与 HLD（本 PR）。
- `capability-gating-plan.md`：状态行加一句指向本文（本 PR）。
- 每期落地时：
  - 在本文末尾加「§9 实施记录」小节；
  - 更新 `docs/reference/codemap.md` 的 `src/lib/ai/` 一节（服务端工具、能力表两段的措辞）；
  - P6 更新 `provider-layering.md` 偏离三（被动的探测维有了位置）；
  - 若改了 `CLAUDE.md` 的 Hard Rules（例如加一条「判定只经 `resolve` / `planRequest`」），运行 `node scripts/gen-agents-md.ts`。

## 9. 实施记录

（空——各期落地时回填。）

## 10. 待决

1. **agent 思考回退要不要看 `offSpelling`。** 如果看，gemini3 与 claude-adaptive 在预算耗尽时也会从「关思考」改成「提示作答」。
   反方理由：作者可以在菜单里选 off，作者选了它，它就该是 off。要先量一次，看 LOW 或 low 档是否仍会把预算耗尽。
2. **B6（Anthropic 族关思考时带温度）** 需要一条 ④ 上 minimax / doubao-switch「disabled + temperature 0.3」的实测。记进 `issues/` 后再排期。
3. **学到的存储持久化**（D3）随 provider-layering §7 一起决定。
