# 能力解析层重构：LLD

> **状态：`shipped`——HLD §6 的七个决定已由作者于 2026-09-27 全部按推荐拍板（§0），D3 于 2026-09-28 改判；P0–P5 已落成（§9.1–§9.6），P6（逻辑与界面）与 P6b 已落成（§9.7–§9.9），旧思考方言一次性迁移（§9.10），B6 按实测只落在 `doubao-switch` 上（§9.11），思考回退在最低档类目上加提示（§9.12），P7 与 D3 的持久化已落成（§9.13）。§10 无待决。**
> HLD：[`capability-resolution-hld.md`](capability-resolution-hld.md)。本文回答：分几个 PR、每个 PR 动哪些文件哪些函数、
> 类型长什么样、算法怎样逐格复现今天的行为、怎么测、怎么回滚。对照的是 2026-09-27 的 `main`（`d31ab9fc`，#717 之后）；引用一律写文件 + 符号，不写行号（`docSourceRefs.test.ts`）。

## 0. 定下来的取舍（作者 2026-09-27 拍板）

| 决定 | 结论 | 影响的期 |
| --- | --- | --- |
| D1 模型值是运行时缺省 | 是；只作用于有「未设」状态的字段 | P6 |
| D2 Anthropic `max_tokens` 只信作者值与探测值 | 是 | P6 |
| D3 学到的降级 | ~~会话级，不持久化~~ **2026-09-28 改判**：落进 `config.db`，7 天过期，作者改声明或重新探测时作废（§9.13） | P3、§9.13 |
| D4 回退执行器 | P3 合存储；P7 合执行器（已落，§9.13） | P3、P7 |
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
  // （B6 之后换成 temperatureIgnored，读 temperatureHeard，§9.11。）
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
  /** 这次请求能带哪几类媒体（image / video / pdf）——capability/media.ts；streamCompletion 按它投影 messages（2026-09-28，B17）。 */
  media: MediaAdmission;
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
  （落地时有四处出入——强制看「发出了」、终止性不靠 `noteLearned` 的返回值、薄包装直接删掉、计划多一个 `json` 字段——见 §9.13。）

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
| B6 | Anthropic 族的温度：类目声明「关思考时听温度」、且线上真关时才发 | B6（§9.11） | 只有 `doubao-switch` 设为关闭时开始带温度；minimax 不变（实测收下但不理会） | 两家实测：[`issues/anthropic-temperature-thinking-off.md`](../issues/anthropic-temperature-thinking-off.md)。原写法「整条按 `wireThinks`」对 minimax 是错的 |
| B7 | 规范化 id 去掉作者前缀与 `[…]` | P6b | 中转站上 `[x]gpt-5…`、`[x]claude-…` 开始命中目录。自动档里，Azure 上游 GPT 的 JSON 会提到 json_schema（该上游 `jsonSchema: true`）；规划用的上限会变。排在 P6 之后，所以不会再改 Anthropic 的 `max_tokens`（§3.1） | 同一个模型不因前缀失去已知事实 |
| B10 | 「将发送」摘要读计划 | P5 | 摘要写线上真实的 effort（gpt-6-astra 设 off 显示 `low`）；④ 行总显示 `max_tokens`（§3.8） | 摘要与适配器逐字一致，不再靠测试钉 |
| B11 | Chat 与 Gemini 适配器的温度开始问格 | P5 | 零：这两族今天没有温度的 `false` 格 | 同 B3 |
| B12 | 火山方舟 Plan 上手加的 Doubao Seed id 得到预填 | P2 | 只在模型抽屉：窗口、上限、多模态、PDF、`doubao` 类目，与起步行相同。线上请求零差异 | 起步行与手加的行不再不一致（§9.3） |
| B8 | agent 的思考回退问 `effortMenuOnWire` | P4 | OrcaRouter gpt-6-astra 在预算耗尽时从「关思考」变成「提示立即作答」 | 今天那个 off 在线上是 low，回退其实没生效 |
| B9 | `vlHighResolution` 带着 subject（id 与上游）裁决 | P5 | 零：没有哪个上游写了这一格。请求路径上 subject 仍不带模型类型——`ConnOptions` 没有这个字段，本方案不加（后来由 B17 加上） | 与其它能力同一种问法 |
| B13 | 新建模型不再预填类目、窗口、上限 | P6 界面 | 只影响此后新建、这三项留空的行：Anthropic 线路的 `max_tokens` 发 32,768 而非平台行的数；发送前不按平台窗口拦截。规划不变。已存的行不变 | D2 只让作者写下的值上线；平台以后更新的数能到达这一行（§9.9） |
| B14 | 结构化任务的 JSON cue 并进最后一条 user 消息 | P7 | 结构化任务走 JSON 路径、且需要 cue 的请求：cue 从单独一条 user 消息变成接在最后一条 user 消息末尾（字符串空一行接上，分块追加一块）。条目生成今天就是这样 | 两条连续的 user 消息在要求严格交替的本地模板上会报错；两个调用方各拼一份是 P7 要去掉的 |
| B15 | 条目生成在 JSON 被拒时只重发那一次请求 | P7 | 执行日志里不再先出现一条错误事件、再整轮重跑；请求体不变 | 拒绝在生成之前，重跑整轮与重发一次等价；错误事件是假的 |
| B16 | 学到的上限跨重启保留，7 天过期 | D3（§9.13） | 重启后第一次结构化任务不再先撞一次已知的 400；矩阵悬停与抽屉说明不再写「本会话」。另：已被类目或格降成 `auto` 的强制请求，再收到点名 `tool_choice` 的 400 不再原样重发一次 | 作者 2026-09-28 改判 D3；后一条是 `Attempt` 改读「发出了」 |
| B17 | 计划持有媒体放行：`ConnOptions` 带模型类型 / `videoInput` / `pdfInput`，`plan.model` 带类型，`plan.media` 决定历史里的图 / 视频 / PDF 发不发 | 媒体按请求放行（2026-09-28） | 历史里有当前线路或模型收不下的媒体时：换成说明句而不是适配器报错 / 上游 400。计划里问到的 `modelTypes` 规则（`vlHighResolution`；`videoInput` 经 `plan.media`）对不看图的模型生效（`videoFps` 计划不问，由 `sentVideoFps` 与将发送按线路问）；金标零差异，`canReadVideo` 在全部线路 × 上游上与旧写法逐格一致 | 附加门、将发送、发送时是同一个答案（[`video-input.md`](../feature/video-input.md) §4） |

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
- `learned.ts` 的 `TAKES_AWAY` 改读 `jsonObjectTier`：一族没有 JSON 对象档时，`json_object` 上限也拿掉 `structuredOutput`（§9.4 出入 4）。
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

### P7 —— 回退执行器合一（可选，`refactor/`）——已落（§9.13）

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

### 9.1 P0：护栏先行（2026-09-27）

两样东西入库，生产代码一行未动。

**请求体金标**：`src/lib/ai/__tests__/requestGolden.test.ts`，快照在 `__snapshots__/requestGolden/<平台>.txt`，
每个平台一个文件，共 16 个，合计约 1.5 MB，生成一次不到一秒。与 §6 P0 的写法相比，有四处出入：

1. **走真实的接缝，而不是手搭参数袋。** 模型行与渠道行经 `connOptions()` 变成请求：
   思考类目的解析、`effectiveMaxOutput`、中转上游都在这里发生，P6 的 B1 / B2 才能在金标里现形。
   请求再经 `streamCompletion()` 发出，只打桩 `fetch`：记下 URL 与 body，然后让请求失败。
   渠道按 `platformEndpoints` 建出全部线路，用 `routeProvider` 取每条线路的视图，与新建渠道时的路径相同。
2. **网格**：
   - 每个平台 × 它的每条线路 × 11 个模型 id。一致性测试的 7 个 id 之外，加了 `claude-sonnet-5`、`gemini-3.8-flash`、`glm-5.3`、`deepseek-v4-pro`，
     让平台的模型校准与两张模型 id 前缀表各有一个 id 被触到。
   - 上游用例（7 个上游 × 2 个 id）只在中转平台上跑：别的平台上 `relayUpstream` 不起作用，跑了只会得到重复的 body。
   - 6 组声明：空；全开关都声明；`structuredOutput: json_schema` 加类目 off；effort high 加 budget；effort off；effort max。
   - 结构化那一组经 `jsonModeShaping()` 取 `extraBody`，行上记下实际档位与有没有加 cue。
   - 带「函数工具 + 强制 `required`」的请求只配给空、effort high、effort off 三组：effort 与强制调用在这三组里相互作用，其余三组加上它不会多测出东西。
3. **「将发送」摘要**：每个（模型, 声明）一行 `wireSummary()` 的输出，写在对应 body 的上方。
   它今天与适配器不一致的两处（B10）因此已经白纸黑字在快照里，P5 让它们一致时，diff 就是证据。
4. **可复核**：连跑两次结果相同。把 xAI Responses 的 `web_search` 格改成 `false` 时，恰好只有 `xai.txt` 一个文件失败，证明它确实在看线上的变化。

**棘轮扩面**：`capabilityFamilyRatchet.test.ts` 新增一段，数三种写法：`standard` / `apiStandard` 比字面量、
`platform…` 比字面量、在名为 `modelId` 的变量上跑 `.test(` / `.includes(` / `.startsWith(` / `.endsWith(`。

- 白名单是 `WIRE_SHAPE` 加 `relayUpstream.ts` 和 `lib/asr/formats.ts`。
- 上限等于入库时的实际计数，「超过」与「数少了」两个方向都已验证：

| 文件 | standard | platform | modelId |
| --- | --- | --- | --- |
| `lib/ai/anthropic.ts` | 1 | | |
| `lib/ai/types.ts` | 2 | | |
| `components/settings/panes/ProviderDrawer.tsx` | | 4 | |
| `lib/ai/responses.ts` | | | 1 |
| `lib/ai/reportedCost.ts` | | | 1 |

与 §6 P0 原文的差别有两处。一是 `types.ts` 的 `authModesFor` 被认定为鉴权的拼法，上限不再下降。
二是 `reportedCost.ts` 属于计费范围（HLD §2 的非目标），上限也不再下降。
其余三处按 §4 在 P1、P2、P4 降到 0。

模型 id 的写法按变量名数，是启发式的，`mid.includes(…)` 数不到。那几处在能力表与上游解析里，本来就在白名单内。

### 9.2 P1：拆目录（2026-09-27）

`capabilities.ts` 从 843 行缩成 122 行的门面，实现按 §1 搬进 `src/lib/ai/capability/`：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `facts.ts` | 97 | 能力 id、状态与原因码、`CAPABILITY_IDS`、`SERVER_TOOL_CAPABILITIES` |
| `rules.ts` | 146 | `CAPABILITY_RULES` |
| `cells/platform.ts` | 244 | `PLATFORM_CAPABILITIES` 与 DashScope 的代码解释器表 |
| `cells/upstream.ts` | 184 | `UPSTREAM_CAPABILITIES` |
| `resolve.ts` | 110 | `familyVerdict` / `capabilityVerdict` / `hasCapability` / `upstreamApplies` |

门面里留下的是建立在裁决之上的东西：effort 阶梯的三个函数、`hasAnyServerTool`。

**搬迁是逐行的。** 把旧文件自第 37 行起的每一行与新文件逐行比对：旧代码里只有被删掉的 `CapabilityWire` 那四行找不到对应，其余全部原样落在新文件里。
改动只有三种：

- 给跨文件用到的类型加上 `export`；
- `CapabilityWire` 改名为 `Wire`；
- 新文件各有一段头注。

**验收**：矩阵文档、16 个金标文件零差异；`pnpm test` 全绿，`tsc` 通过。
`exportReach.test.ts` 拦下了两个多加的 `export`（`ModelMatcher`、`CapabilityRule` 只在自己文件里用），已经去掉。

**与 §6 P1 原文的三处出入**：

1. **表的名字这一期不改。** §4 把 `CAPABILITY_RULES` 改名为 `PROTOCOL_RULES`、`PLATFORM_CAPABILITIES` 改名为 `PLATFORM_CELLS`，这两次改名推迟到它们的**形状**真正改变的那一期（P2 引入模型行）。
   这一期只挪位置，改名会让同一样东西在门面与新文件里有两个名字。
2. **两个相同的接口合成一个 `Wire`，定义在 `platforms.ts`。** 原来是 `platforms.ts` 的 `ServerToolWire` 与能力表的 `CapabilityWire`。
   `serverTools.ts` 对 `ServerToolWire` 的转出没有人用，一并删掉。受影响的是两个源文件和两个测试，只改了类型名。
3. **`ProviderDrawer.tsx` 的 `pickPlatform` 改问 `platformHasHosts`，而不是 §6 写的 `isRelayPlatform`。** 这一处的语义是「没有主机名能认出的平台，改地址时保留作者的选择」。
   `platformForAddress` 用的正是 `platformHasHosts` 这个判据。中转站标记今天恰好圈出同一组平台（newapi、custom），但语义不同。
   B5 零差异；棘轮里 `ProviderDrawer.tsx` 的 platform 上限从 4 降到 2，剩下的两处是 ComfyUI 的界面分支。

### 9.3 P2：模型 id 轴合一（2026-09-27）

这一期拆成两个提交：

1. **先钉住旧行为**，不动表。`modelIdAxis.test.ts` 用当时的代码生成 `__snapshots__/modelIdAxis.txt`：
   约 110 个 id，每个取 5 种写法（原样、大写带空格、带命名空间、带日期、带中转方括号），记下四样东西：
   - 输出上限；
   - 是否在严格 schema 名单上；
   - 各平台的校准；
   - 12 个按模型裁决的格，对每个 id 的裁决。

   请求体金标同时加了一个 xAI 的 non-reasoning id，把 Responses 的 `include` 也钉住。
2. **再重构**。

新增两个文件：

- `capability/modelId.ts`：
  - 一种模式类型 `ModelPattern`，可以是精确 id、普通 `startsWith` 或正则；
  - `bySpecificity` 把行排成「精确 → 更长的前缀 → 正则按书写顺序」；
  - `rowSetting` 取第一个「说了这个事实、且匹配」的行；
  - 两种匹配键：`rawModelKey`（小写去空格）与 `canonicalModelId`（再去掉 `vendor/`）。
- `capability/cells/catalog.ts`：全局模型目录，合并了三处——
  - `KNOWN_OUTPUT_CAPS`；
  - `KNOWN_JSON_SCHEMA`（前缀完全相同的两行并成一行）；
  - `responses.ts` 里的 `/non-reasoning/i`。

  `knownMaxOutput` / `knownJsonSchemaModel` 保留原签名，改为读目录；`normalizeModelId` 删除，由 `canonicalModelId` 代替。

平台格的改动（`cells/platform.ts`）：

- `ModelMatcher {runs, refuses}` 改成块上的值 `"per-model"`，加上 `models` 行。refuses 行写在前面。
- 「块只要为某个能力写了行就拥有它」，这条语义由 `platformCell` 一处实现，与旧的 `cellFor` 等价。
- `PROFILES[*].models` 的校准迁成 `all` 块里的精确 id 行：
  - `set` 里放思考类目、窗口、上限；
  - `prefill` 里放类型与 PDF。
- 起步行里写死的 Doubao 三件套迁进火山方舟 Plan 的格：`doubao` 类目在 `all` 块，`doubao-switch` 在 `anthropic` 块。
  `platformModelCalibration(platform, id, family?)` 带族时只读那一族的行。
- xAI 的 `responsesInclude` 迁成 responses 块上的值。
- `platformModelCalibration` 与 `platformResponsesInclude` 从 `platforms.ts` 迁到这里，经门面转出。
  `platforms.ts` 只剩地址、主机、线路与计费上报。
- 两张格表改名：`PLATFORM_CAPABILITIES` → `PLATFORM_CELLS`，`UPSTREAM_CAPABILITIES` → `UPSTREAM_CELLS`。
  上游的 `models` 类型改成 `ModelPattern`。

**验收**：

- 请求体金标、矩阵文档零差异；
- 模型 id 轴快照只多两行，就是 B12：`doubao-seed-2.0-lite` 的原样与大写两种写法，现在得到校准；
- `pnpm test` 全绿，`tsc` 通过；
- 棘轮里 `responses.ts` 的 modelId 上限降到 0；
- 新增冲突守卫：同一个块里两个正则行命中同一个 id、却对同一个事实给出不同的值，就失败。
  故意加一条与 refuses 冲突的 runs 时，它会报红。

**与 §6 P2 原文的出入**：

1. **OrcaRouter 免费档留在起步行。** `platforms.test.ts` 钉着一条既有规则：校准行只收**实测过**的 id。
   免费档的数值来自中转站的模型页，不是样本，所以不进格。起步行里写死的 `deepseek` 类目也随之保留，并写明理由。Doubao 的三件套是第十二个样本实测过的，所以迁了。
2. **校准里的思考类目这一期仍放在 `all` 块。** 类目 id 自带族，抽屉按族过滤，行为因此不变。
   只有 Doubao 的 Anthropic 路由需要不同的类目，它写在 `anthropic` 块里。所有类目按族归位，等 P6 让值类事实进裁决链时再做。
3. **`CAPABILITY_RULES` 不改名。** 它的形状从 P0 到现在没变过，名字也准确。§4 里改名为 `PROTOCOL_RULES` 的那一行作废。
4. **`/non-reasoning/` 目录行匹配的是 `canonicalModelId`**，也就是去掉 `vendor/` 之后的 id。旧写法对原始 id 做不分大小写的匹配。
   两者只在「命名空间那一段里含 non-reasoning」时不同，没有这样的真实 id。

### 9.4 P3：学到的降级合成一个存储（2026-09-27）

新建 `capability/learned.ts`。原来的两份记忆合成了这一个存储：`toolChoice.ts` 里的 Set 和 `jsonMode.ts` 里的 Map。

- **存储**：每个端点 + 模型、每个事实一个上限。键沿用旧的 `${standard} ${baseUrl} ${modelId}`，两份记忆原本就用这个键，所以同一个端点的两个事实现在落在同一条记录里。
  `noteLearned` 只降不升；`learnedCeiling` 读；`__resetLearned` 代替原来的两个 `__reset…Memo`。
- **分类表 `LEARN_RULES`**：每个事实一行，写三样——
  - 报错里要出现的参数名；
  - 这次请求有没有用上这个事实（`used`）；
  - 要学的上限（`lower`）。

  两个 `is…Rejection` 由此删除，它们的正则和注释搬进了对应的行。`classify(err, attempt)` 只在「报错点了这个参数的名」且「请求用上了它」时才学。
  例如一条同时提到 `tool_choice` 与 `response_format` 的报错，学到的是请求实际用上的那一个。
- **两处重试改走分类表**：`streamCompletion` 的强制降级、`withJsonModeFallback` 的逐档下降。重试的条件与降到哪一档都和以前逐条相同。
- **门面 `capabilityVerdict(id, wire, model, baseUrl?)`**：给了地址时，在表的结果上套学到的上限，原因码 `learned`。
  对应关系由 `TAKES_AWAY` 这张小表给出：
  - 强制被拒，拿掉 `forcedToolChoice`；
  - 严格档被拒，拿掉 `jsonSchema`；
  - JSON 模式也被拒，再拿掉 `structuredOutput`。

  表上已经是 `no` 的格保留它自己的原因。`resolve.ts` 没有改动，它仍然只读表。
- **抽屉**：`CapabilityMatrix` 多了一个 `baseUrlFor` 属性，模型抽屉传入每条线路的地址。学到的格显示「—」，悬停写「本会话实测：端点拒绝过它」。
  这里没有新增元素，只是已有的格多了一种原因，所以没有先出设计稿（D7 管的是 P6 的新界面）。
  抽屉里有学到状态的只有输出一栏的两行（`structuredOutput`、`jsonSchema`）；`forcedToolChoice` 不在任何抽屉矩阵里。
- 语言文件新增 `aiConfig.capReason.learned`，两种语言。

**验收**：

- 请求体金标、矩阵文档、模型 id 轴快照零差异；
- `pnpm test` 全绿，`tsc` 通过；
- 新测试 `learned.test.ts`：
  - 两条规则各自的正反例（`aiJsonMode.test.ts` 里的识别用例迁来，强制那一条补了 DeepSeek V4 的原文）；
  - 只降不升；
  - 逐档重试必然终止（每次学到的上限都严格低于发出的那一档）；
  - 抽屉的裁决在学到之后变成 `no / learned`，且不带地址时仍是表的答案。

**与 §3.7、§6 P3 原文的出入**：

1. **`used` 与 `lower` 读的是 `Attempt`，不是 `RequestPlan`。** 计划要到 P5 才有。`Attempt` 只记两样：请求了强制没有、实际拼进 body 的 JSON 档位。
   到 P5，它由计划推出，规则本身不用改。
2. **门面保留四个函数名**：`forcedToolChoiceRefused`、`noteForcedToolChoiceRefused`、`jsonModeCeiling`、`noteJsonModeRefused`，改成转调存储。
   两个 `is…Rejection` 与两个 `__reset…Memo` 直接删掉，前者成了分类表的行，后者由 `__resetLearned` 代替。
3. **「`effective()` 接上上限」落在 `effectiveStructuredOutput` 上。** `effective()` 本身要到 P4 / P5 才建，今天与它对应的就是这个函数，它读同一个存储。
4. **Anthropic 上的一个缺口，留到 P4。** 严格档被拒之后，上限是 `json_object`。Anthropic 没有这一档，所以线上实际是 off，但矩阵里的 `structuredOutput` 仍按表显示 ✓。
   要判断「这一族有没有 JSON 对象档」，就得在 `learned.ts` 里写族分支，而这正是 P4 用 `jsonObjectTier` 事实去掉的东西。
   P4 的 `TAKES_AWAY` 改成读这个事实即可；在那之前，抽屉的「本会话实测 · 端点拒绝了…」一句仍然写明线上实际发的是哪一档。
5. **`streamCompletion` 仍然只学强制这一个事实**，JSON 的逐档下降仍在 `withJsonModeFallback` 里。两个执行器合一是 P7 的事（D4）。

### 9.5 P4：请求条件与思考状态进表（2026-09-27）

同样拆成两个提交。

1. **先钉住旧行为。** `wireThinks.test.ts` 用当时的代码生成 `__snapshots__/wireThinks.txt`，网格是全部 15 个类目 × 9 种 effort（含未设），记三样：
   - 强制 tool_choice 是否降级；
   - 四族上温度发不发；
   - DashScope 两条 OpenAI 线路在声明了服务端工具、带与不带函数工具时，实际带哪些服务端工具。
2. **再重构。** 快照零差异。

**改了什么**：

- **思考状态只有一个定义**：新建 `capability/conditions.ts`，内有 `wireThinks(category, effortOnWire)`。
  类目数据多了两个字段：`offSpelling`（`disable` / `lowest`）与 `unsetThinks`，逐类目的取值就是 §3.5 那张表，`wireThinks.test.ts` 逐格断言。
  `thinkingIsOn` 只剩开关的显示，注释里写明了。
- **请求条件是规则上的数据**：`CAPABILITY_RULES` 的 `thinkingOff` 字段换成按族的 `unless`。三种条件：
  - `functionTools`：带函数工具；
  - `categoryThinks`：类目不是 off，缺类目算在想；
  - `thinking`：线上思考状态，`unknown` 按条件自己说的方向读。

  挂上条件的有四处：
  - Anthropic 的温度（原 `thinkingOff`）；
  - Chat 上的网页读取与代码解释器（带函数工具时不发，原来写在 `openaiServerToolsBody` 里）；
  - Responses 上的代码解释器（思考关掉时不发，原来是 `responsesServerTools` 看 body 里的 `effort === "none"`）。

  `effectiveServerTools` 多收一个请求上下文，两个适配器把各自的上下文传进去，自己不再判断。
  条件触发时的原因码：`categoryThinks` 仍是 `thinking`，另两种是新的 `condition`，两种语言都加了说明。
- **表里新增两个事实**：
  - `jsonObjectTier`：Chat / Resp / Gemini 有「任意 JSON 对象」档，依赖 `structuredOutput`。
    `structuredOutputModesFor(wire)` 改读它；`resolveStructuredOutput` 改成 §3.4 的 `below` 写法，Anthropic 分支就此消失。
  - `promptCache`：规则 `{families: ["anthropic"], origin: "private", official: "yes"}`。`anthropic.ts` 的 `cachesPrompt` 删掉，改问这个事实；
    棘轮里 `anthropic.ts` 的 standard 上限降到 0。
- **B8**：agent 的思考回退改问 `effortMenuOnWire(category.menu, wire, model)`。
  OrcaRouter 的 `openai/gpt-6-astra` 在预算耗尽时，由「关思考」（线上其实是 low）改成「提示立即作答」；同平台的 `gpt-6-sol` 仍是关思考。
  由 `agentRuntimeThinkingGuard.test.ts` 钉住。
- **补上 §9.4 出入 4**：`learned.ts` 的 `TAKES_AWAY` 改读 `jsonObjectTier`。
  Anthropic 上严格档被拒之后，抽屉里 `structuredOutput` 与 `jsonSchema` 都显示 `no / learned`。

**验收**：

- 请求体金标、模型 id 轴快照、思考状态快照零差异。
- 矩阵文档的差异只有三处：新增 `jsonObjectTier`、`promptCache` 两节，以及表头一行说明「每格按平台自己的那条线路问官方还是兼容」。原有的格一个没变。
- `capabilityConsistency.test.ts` 的 `PROBES` 为两个新事实各加了提问者：
  - `jsonObjectTier` 问「将发送」；
  - `promptCache` 问适配器 body 里有没有 `cache_control`。
- 变异测试：
  - 把 Responses 代码解释器条件的 `unknownAs` 改成 `off`，快照报红；
  - 去掉 Chat 网页读取的函数工具条件，快照报红。
- `pnpm test` 全绿，`tsc` 通过。

**与 §2、§3.3、§6 P4 原文的出入**：

1. **条件挂在规则上，按族分，不挂在 DashScope 的块上。**
   今天的三处丢弃在各自那一族上是无条件的，不分平台。挂在规则上才逐格等价；挂在块上会让别的平台上同名工具的行为变。
   块上的 `unless` 这一期不建，等哪个平台与规则不同时再加。
2. **`RequestContext` 并进了 `CapabilityModel`（`extends`），不是独立的第四个参数。** `thinkingCategory` 原本就在那里。
   把「模型」与「请求」分开，是 P5 请求计划的事。
3. **`Resolution.conditions`（未求值的条件）不建。** 今天没有读它的地方，抽屉里「带函数工具时不发」的提示仍是手写的。
4. **规则多了一个 `official` 字段，`familyVerdict` 多了同名参数。** §4 给 `promptCache` 定的规则形状要求裁决知道标准。
   矩阵生成器按平台自己那一族线路的官方或兼容去问。
5. **`strictSchemaModel` 与 `reasons` 不进能力 id。** 它们是目录里的固有类事实，由 `catalogFact` 读。
   要经裁决链问，就得先有 §3.3 的第 4 层（按作用域查目录），而这一层今天没人需要。
   它们的读者（自动档提升、Responses 的 `include`）已由模型 id 轴快照和金标钉住。到 P6 值类事实进链时一起做。
6. **`jsonObjectTier` 依赖 `structuredOutput`。** 这样中转站 Kiro 上游（`structuredOutput` 为 no）上，它与「将发送」一致。

### 9.6 P5：请求计划（2026-09-27）

新建 `capability/plan.ts`：`planRequest(opts)` 把一次请求要带什么一次决定完，四个适配器和「将发送」摘要只负责拼写。它是纯函数，只读传入的参数、能力表和学到的存储。
`streamCompletion` 算一次，放进 `StreamOptions._plan`；直接调适配器的调用方（一致性测试、live 探针）由适配器自己算，两条路径结果相同。

**计划里有什么**，对照 §3.8 的迁移表逐项搬过来：

- 思考：类目、线上的 effort（`effortOnWire` 之后）、预算、`wireThinks` 给出的思考状态；
- 温度：问格，带上请求条件；
- `maxTokensOnWire`：原 `resolveMaxTokens`。`DEFAULT_MAX_TOKENS` 迁进 `modelLimits.ts`，与新函数 `requiredMaxTokens` 放在一起；
- `toolChoice`：记请求的值、实际发出的值，以及降级原因——类目、格、学到的，三选一。
  原 `openai.ts` 的 `toolChoiceFor` 删除；`anthropic.ts` 的 `toolChoiceBody` 只剩拼法；Gemini 与 Responses 第一次读这一格（B3）；
- `serverTools`：已经按线路和请求条件裁好的 id 列表。四个拼法函数改成只收 id 列表，不再判断；
- `structured`：`effectiveStructuredOutput` 的结果；
- `textVerbosity`、`vlHighResolution`（带上模型 id 与上游，B9）、`instructionsField`、`responsesInclude`、`promptCache`。

**「将发送」摘要**：`wireSummary` 的签名不变，内部改成先按 `connOptions()` 的算法求出计划（输出上限用 `effectiveMaxOutput`），再交给 `spellSummary`。
四族的拼法差异收进一张 `Record<ProtocolFamily, SummarySpelling>`，六处 `family ===` 全部去掉，棘轮里 `modelSummary.ts` 的上限从 6 降到 0。

**`structured.ts`**：`forcedToolIsWasted` 改成 `plan.toolChoice.downgradedBy !== undefined && plan.structured === "json_schema"`（B4）。

**金标差异**：请求体一行没变。改的全是摘要行，共 747 行，都属于 B10：

- 744 行：④ 线路的摘要多了 `max_tokens`，值与请求体一致。有 32768（缺省）、目录值（128000、131072、65536、393216）。
  非 Claude 的 id 走 ④ 时发出目录值，这正是 B1 要在 P6 处理的事，摘要现在如实显示；
- 3 行：OrcaRouter 上的 effort 改成线上实际发出的值。`openai/gpt-6-astra` 设 off，Chat 与 Responses 上显示 `low`；`openai/gpt-5.6-sol` 设 max，Chat 上显示 `xhigh`。

B3、B9、B11 在网格里零差异：
- 网格中没有哪条 Gemini / Responses 线路的 `forcedToolChoice` 格是 `false`，只有作者在智谱主机下手建的 ② / ③ 渠道会碰到（账本 B3 原话）；
- 没有上游给 `vlHighResolution` 写格；
- Chat 与 Gemini 两族没有温度的 `false` 格。

**测试**：

- 新增 `plan.test.ts`：
  - 计划是纯函数；
  - 把计划传给适配器，与适配器自己算计划，发出的 body 逐字节相同；
  - **适配器只从计划读决定**：给适配器一份「什么都不发」的计划，而参数里声明了全部内容，body 里七类字段一个都不许出现。
    变异测试：让 Gemini 的温度改回读参数，四条 Gemini 线路都报红；
  - 强制降级的三种原因各有一例。
- `agentStructured.test.ts` 加了 B4 的三种线路：Kiro 的 Claude 走 ④ 并声明严格档、anti 的 Claude 走 ①、Azure 的 GPT 走 ① 的自动档。
  变异测试：换回旧判法（只看类目和学到的），三条都报红。
- `capabilityConsistency.test.ts` 的三个 effort 格（`reasoningOff` / `effortMax` / `effortMinimal`）加了摘要作为提问者，补上 B10 那个一直没被抓到的缺口。

**与 §2、§3.8、§6 P5 原文的出入**：

1. **`withheld`、`effortRewrittenBy`、`categorySource`，以及带出处的 `maxTokens {value, source}` 都没建。** 今天没有读它们的地方：
   - 抽屉里「已声明、不发送」的提示仍按字段问 `capabilityVerdict`；
   - 出处是 P6 的事。计划里只有 `maxTokensOnWire`。
2. **一致性测试的「总断言」收窄了。** 没有逐事实比对 body 的拼法，而是用两样东西代替：
   - `plan.test.ts` 的「适配器只从计划读决定」，覆盖全部平台与线路；
   - 三个 effort 格补上摘要提问者。

   旧的 `PROBES` 照旧保留。
3. **`streamCompletion` 仍在请求前把学到的强制降成 `auto`。** 重试执行器合一是 P7 的事。
   计划里 `learned` 这个原因在直接问计划时生效，例如 `structured.ts`。

### 9.7 P6：值类事实与出处——逻辑部分（2026-09-27）

思考类目、窗口、单次输出上限这三个值类事实走同一条链，每个值带着出处；消费方按出处决定信不信。
界面上的出处显示（抽屉的占位与说明、矩阵组件的值类一栏）按 D7 等设计稿，另开一期，本期只动逻辑。

**新文件与挪动**：

- `capability/intent.ts`：
  - `Source`（`author` · `platform` · `catalog` · `protocol` · `default`）、`Sourced`；
  - `TRUST` 表：`planner` 收全部出处，`contextGate` 与 `anthropicMaxTokens` 只收 `author`；
  - `trusted()`；
  - `carried()`：把请求里带的数和它的出处配成对；没有出处的手搭参数袋算调用方自己的值。
- `capability/values.ts`：
  - 取值链：作者值 → 平台格里这个 id 的行（先族块，后 `all` 块；只取本族能拼的类目）→ 全局目录（只对固有类事实）→ 协议族缺省 → 应用缺省；
  - `modelValue`（窗口、上限）、`thinkingCategoryOf`、`resolveThinkingCategory`。
- `facts.ts`：新增 `ValueFactId`、`ValueFactMap`、`VALUE_FACTS`。原 `reasoning.ts` 里 `defaultCategoryId` 的按族 switch，变成 `thinkingCategory.familyDefault` 这一行数据。
- `cells/platform.ts`：新增 `platformValue`。`cells/catalog.ts` 给 `contextSize` 留了位置，但今天没有行。
- `resolveThinkingCategory` 从 `reasoning.ts` 挪进 `values.ts`，经 `capabilities.ts` 门面导出；它多了一个可选的 `platform` 参数。
  - 挪的原因：它要读平台格，平台格要读类目表，留在 `reasoning.ts` 会成环。
  - `reasoning.ts` 只留两个拼法层的函数：`fitsFamily`（类目能不能在这一族上拼），`migrateDialect`（旧方言迁到哪个类目）。
- `modelLimits.ts` 删掉 `effectiveMaxOutput`，头注第 1 条改写成「由 `TRUST` 保证」。`knownMaxOutput` 保留，作为读目录的门面。

**请求路径**：

- `connOptions()` 用 `conn.ts` 内部的 `sourcedLimits` 算出窗口与上限，连同出处放进新字段 `ConnOptions.provenance`（`StreamOptions` 同名）。
  - 类目按链解析，带上平台。
- 请求计划的 `maxTokensOnWire` 只收作者值（D2），否则用 `DEFAULT_MAX_TOKENS`。
- `streamCompletion` 发送前的窗口闸只收作者值。
- agent 运行时拿 `opts.contextSize` 算思考预算和截断原因，属于规划，收全部出处。
- 计划、agent 的思考回退（B8 那一处）、摘要都按同一条链解析类目，带上模型 id 与平台。
  - 摘要的上限也按 `connOptions()` 的算法求出并带出处，所以 ④ 的 `max_tokens` 行与请求体一致。

**规划路径**：新增 `conn.ts` 的 `plannedLimits(pair)`、`plannedLimitsOf(model, providers)`，以及组件用的 `usePlannedLimits`。
所有预算、上限、压缩触发线和预估都改读它们，不再直接读 `model.contextSize`：

- stores：`aiTaskStore`、`agentStore`、`agent/chatJob`、`roleplayStore`（两处）、`memoryStore`、`digestStore`、`consistencyStore`；
- `lib`：`agent/packs`、`consistency/review`；
- 组件：`AiPanel`（三处）、`AgentChat`、`RoleplayChat`、`ContextMemoryPane`、`ModelSelector`（窗口标签与「长上下文」筛选）。

顺带修掉一处不一致：`AiPanel` 的预估用的是行上的原值 `maxOutput`，`runTask` 用的却是 `effectiveMaxOutput`。现在两边都读 `plannedLimits`。

**`pdf_input` 列**：`configDb.ts` 保存时写成 `m.pdfInput ? 1 : null`，存不出「未设」与 `false` 的区别。按 D1，它仍只做预填。

**金标差异**恰好是 B1 与 B2，共 851 行：

- **B1**：504 条请求体、336 行摘要，都是 ④ 线路上的 `max_tokens`。
  - 目录值（GPT 128000、GLM 131072、DeepSeek 393216、Gemini 65536）退回 32768，出现在每个平台的 ④ 线路上。
  - 「设了应用缺省的 Anthropic 行」不在网格里（金标不设偏好），由 `values.test.ts` 钉住。
- **B2**：7 条请求体、4 行摘要。
  - DeepSeek 平台上 `deepseek-v4-pro` 设关：从 `reasoning_effort:"none"` 变成 `thinking.type:disabled`，是 `deepseek` 类目的拼法。
  - 智谱上 `glm-5.3` 设了档位：多带 `thinking.clear_thinking:false`，是 `glm` 类目的拼法。
  - 同一个 id 走智谱或火山方舟 Plan 的 ④ 时不变：`all` 块里的类目是 ① 族的，按族过滤后落回 `claude-adaptive`；火山方舟 Plan 的 ④ 有自己那一块的 `doubao-switch`。

**矩阵文档**多出两节：

- 「思考类目缺省」：各族缺省，以及各平台、各线路上由平台行给出的类目；
- 「输出上限来源」：`TRUST` 表，以及各平台、各线路上由平台行给出的窗口与上限。

两节都由解析函数渲染，不从行里抄。

**测试**：新增 `values.test.ts`，全部走真实的 `connOptions` / `planRequest` / `streamCompletion`：

- 链的顺序；类目的族过滤（Doubao 在 ①、③、④ 上各得其所）；
- **留空的行与预填过的行解析出同样的值**：遍历每个平台、每条线路、每个精确 id 行；
- ④ 只发作者的上限：应用缺省与目录值都不发；
- 规划读到的值等于请求携带的值；
- 窗口闸只按作者的窗口拦截；
- 手搭参数袋里的上限算调用方自己的值。

变异检查（用备份还原，逐字节比对）：

- 让 `anthropicMaxTokens` 也收表值：金标 9 个平台报红，`values.test` 报红；
- 让窗口闸收平台值：窗口闸那条报红；
- 去掉平台行的按族过滤：金标 DeepSeek 与 `values.test` 报红。

**与 §2、§3.3、§3.9、§6 P6 原文的出入**：

1. **值类事实有自己的解析函数（`values.ts`），没有并进 `resolve.ts` 的 `resolve()`。**
   开关事实的链上有原因码、请求条件、`"per-model"` 这些东西，值类事实一样都不用。
   两者共用的是格、模型 id 轴与目录。硬塞进一个函数，只会多出一堆对两边都不适用的分支。
2. **`Source` 里没有 `upstream` 与 `learned`，`TRUST` 里没有 `placeholder`。**
   - 今天没有上游写值类格，也没有学到的值类事实；
   - 占位符属于界面那一期。

   等其中任何一样出现时再加。
3. **`responsesInclude` 没有进 `VALUE_FACTS`。** 模型行上没有这个字段，也就没有「未设」可言。它仍由 `platformResponsesInclude` 读格。
4. **抽屉的预填照旧。** 停掉预填、改成留空加「出处」占位，是界面那一期的事。在那之前，新建的行仍会把预填值存成作者值。
   `values.test.ts` 保证预填过的行与留空的行解析出同样的值，所以两种行在线上没有区别。
5. **`ASSUMED_INPUT_CEILING_TOKENS` 仍是常量。** §3.9 的原意是「规划可信的 `contextSize`，否则 32000」，
   这一点已经由规划路径改读 `plannedLimits` 做到了。常量只在谁都不知道窗口时才起作用。
6. **已有界面元素里的值变了，但没有新增元素。**
   - 抽屉「自动」的注释（`noteCatAuto`）与档位菜单改显示平台给的类目，原来显示族缺省；
   - 窗口标签、上下文条与预估改读 `plannedLimits`。

   这些不涉及新的界面，所以不等设计稿。

### 9.8 P6b：规范化 id 生效（2026-09-27）

`canonicalModelId(raw, relay?)` 启用 §3.1 的前两步：在中转站上，先去掉作者的前缀，再去掉 `vendor/` 命名空间。
去前缀时，渠道前缀表里最长的一行命中就按它去；没有命中就去掉开头的 `[…]`。
中转站上同一个模型因此不再因前缀而失去目录里的已知事实，也就是严格 schema 名单、上限和 `reasons`。

- 前缀表按最长前缀匹配，这段逻辑现在只有一份：`modelId.ts` 的 `longestPrefix`，`relayUpstream.ts` 的 `matchUpstreamPrefix` 改为调用它。
- `ConnOptions` 新增 `canonicalModelId`（`StreamOptions` 同名），由 `connOptions()` 用渠道的前缀表算好（`conn.ts` 的 `catalogIdOf`），只在中转平台上带前缀表。
- 读目录的地方都改读它，缺省时退回 `modelId`：
  - 请求计划的 `reasons`；
  - `jsonMode.ts` 自动档的严格名单（`JsonModeTarget.canonicalModelId`）；
  - `values.ts` 取上限的目录那一步（`ValueSubject.canonicalModelId`）。
- 「将发送」摘要 `wireSummary` 多了第六个参数 `canonicalModelId`；抽屉用同样的规则自己算，自动档提档的判断也读它。

**金标差异恰好是 B7**，共 20 行，全是摘要，请求体一行没变：
`newapi` 与 `custom` 上 Azure 上游的 `[x]gpt-5.6-sol`，① 与 ③ 各 5 组声明，自动档从 `json_object` 提到 `json_schema`。
- 该上游的 `jsonSchema` 格是 `true`；前缀去掉后 id 命中目录的 `gpt-5` 严格行。
- 金标里结构化那一组声明的是 `json_schema`，所以请求体不动；自动档只在摘要行里现形。

B7 的另外两项不在金标里，由 `values.test.ts` 钉住：
- 规划用的上限会变：`特价kiro | gpt-5.6-sol` 在中转站上取到目录的 128000；
- ④ 的 `max_tokens` 不变：`[x]kimi-k3` 规划得 1,000,000，发出去仍是 32768。这就是 P6b 必须排在 P6 之后的原因（§3.1）。

**测试**：`values.test.ts` 新增一组 4 条：
- 去前缀的顺序，以及「只在中转站上去」；
- 前缀表经 `connOptions()` 生效，非中转平台上前缀表不起作用；
- Azure 上游自动提档，`jsonModeShaping` 与计划的答案一致；
- 目录上限只进规划，不进 `max_tokens`。

变异检查三处，都报红：
- 忽略前缀表；
- 在所有平台上都去前缀：金标 8 个非中转平台报红；
- `connOptions()` 不带规范化 id。

**与 §3.1、§6 P6b 原文的出入**：

1. **平台格仍按原始 id 匹配，没有改写成规范化模式**，例如 OrcaRouter 的 `openai/gpt-6-astra` 保持原样。
   - 平台格描述的是这个平台自己供应的 id，而作者前缀只出现在中转站上，中转站没有模型行，改写得不到任何命中。
   - 反过来，对规范化 id 匹配会让平台不供应的写法命中它的行，出现 B7 以外的差异。例如 api.openai.com 上的 `openai/gpt-5.6-sol`，以及 OrcaRouter 上不带命名空间的 `gpt-5.6-sol`。
2. **非中转平台上不去 `[…]`。** 那样的 id 不是平台供应的 id。第一版在所有平台上都去掉，结果官方平台上的 `[特价kiro量]claude-opus-5` 也开始提档，与账本「中转站上」不符，已收回。
3. 上游格照旧按原始 id 做子串匹配，与 §3.1 原文一致。

### 9.9 P6：值类事实与出处——界面部分（2026-09-27）

P6 的逻辑部分让留空的类目、窗口、上限跟随平台行、目录与缺省，但抽屉看不出来，新建的行还会把预填值存成作者值（§9.7 偏离 4）。
本期把出处说给作者看，并停掉这三项的预填。设计稿是在 Vite 里用抽屉的真实组件拼出的十屏（新建留空、④ 线路、旧的预填行、手填覆盖、中转站目录、未知模型、折叠摘要、两张矩阵），作者看稿后定为照稿实现。

**数据**：`modelSummary.ts` 新增 `valueFacts(m, standard, platform?, canonicalModelId?)`，是设置界面的第三个只读视图，与「将发送」同处。
它对三个值类事实各给出：
- `own`：作者值；
- `table`：链去掉作者一层后的答案，用作占位，也是「覆盖了什么」；
- `inForce`：请求实际带的值。族拼不出的手选类目不算作者值，因为请求不发它。

另外两项由消费方自己的规则回答，界面不重述：
- 窗口的 `gates`：`trusted(inForce, "contextGate")`；
- 上限的 `onWire`：只在拼法表声明要 `max_tokens` 的族上有，取请求计划的 `maxTokensOnWire`。

**抽屉**：
- 窗口：留空且表值恰是某个档位时，该档位显示为虚线 chip，借用「选中但不发送」的既有约定；不是档位时，值写在精确值框的占位里。
- 上限：占位是表值，谁都不知道时写「未知」。
- 字段下一行写出处与用途，文案选择在 `panes/valueNotes.ts`：
  - 留空：「平台 · 智谱 BigModel 131,072 · 预算按它算，不发送」；在 ④ 上改为「max_tokens 发默认 32,768（只认手填的值）」；
  - 谁都不知道：「未知 · 发送前不拦截，预算用默认」，所以「空 ＝ 跟随下方的来源」下方总有一行；
  - 手填且与表值相同：「与…一致 · 清空后跟随它」，这是给旧的预填行的出路。清空有代价时补一句：窗口「但发送前不再拦截」，④ 的上限「max_tokens 改发 32,768」。
    代价由视图的 `gatesIfEmpty` / `onWireIfEmpty` 回答，与 `gates` / `onWire` 同一条链、同一份计划；
  - 手填且不同：「手填 · 覆盖…」，与实测徽标同一句式；字段非空且有探测记录时，实测徽标优先；清空探测过的字段后补「实测 … 未采用」。
- 类目「自动」的说明带出处；作者手选了与表不同的类目时，写「自动时为…」。
- 折叠摘要：限额写「跟随 · 窗口 … · 上限 …」，思考写「自动 → …」。
- 新建模型输入 id 时只预填类型与 PDF（D1：这两项没有「未设」）。
- 改 id 时（新建与已有同样），类目留在「自动」的线路按新 id 解析出的类目矫正档位，当前线路与停放线路都算；声明了类目的线路不动。
  原因：不预填之后，行会一直留在「自动」，glm-5.2 上选的「关闭」改成 glm-5.3 后若原样落盘，模型照想。「自动」chip 的档位矫正也按解析出的类目。
- 探测面板收在用的窗口与上限中描述这个模型的那些（手填、平台行、目录），不收表单原文：新建的已知模型留空后，深度探测仍按平台的窗口二分、按它估算费用。应用默认不给：它与这个模型无关，拿它定输出测试的规模可能超过模型的上限而 400。
- 说明文案里「留空用应用默认」「自动 ＝ 协议族默认」这类 P6 之前的说法一并改正。

**值类矩阵**：`panes/ValueFactMatrix.tsx`，在限额节底部，只在多线路时出现。
- 行是类目、窗口、上限，列是渠道的线路。
- 每格是那条线路的 `valueFacts`：手填的实色；表里来的淡色，旁边标出处小字。
- ④ 上发的 `max_tokens` 与格里的数不同时，第二行写明。
- 当前线路读表单，其余线路读各自停放的字段；每列按自己线路的平台求目录键，与 `catalogIdOf` 同规则。

**测试**：
- `values.test.ts` 新增一组：遍历每个平台、每条线路、每个平台行 id，外加目录 id 与未知 id，留空与手填两种行。
  视图的值与出处等于 `connOptions()` 带的；`gates` 等于窗口闸的判法；`onWire` 等于真实请求体的 `max_tokens`。
- `panes/__tests__/valueNotes.test.ts`：文案取自真实的 `valueFacts` 与发货的 zh-CN 文件；遍历平台行核对出处名，并钉住「留空不拦截」与 `gates` 同真；清空代价两格；改 id 时的档位矫正（真实的 `thinkingCategoryOf`）。
- 新建行不预填三个值类字段，由 Browser pane 里挂真实抽屉核对；`applyCalibration` 是组件内状态，没有单测。
- 变异检查两处，都报红：`gates` 不看 `TRUST`；`onWire` 不看拼法表。
- 金标零差异。

**与 §6 P6 原文、§9.7 偏离的出入**：

1. **没有「本次会话学到」。** 今天没有学到的值类事实，`Source` 里也没有 `learned`。开关事实的学到降级仍在可用性矩阵的悬停原因里（P3）。
2. **没有 `TRUST.placeholder`。** 占位显示的是「链去掉作者」，它不是一次信任裁决，没有东西会因此被拒。加一行只为对齐 HLD §4.3 的表格，是装饰。
3. **「`CapabilityMatrix` 多出一栏」落成另一张表。** 可用性矩阵的格是 `capabilityVerdict` 的三态字形，值类格是数值加出处，两者只共享表格样式。
   并进一个组件会在每一格分支。
4. **视图放在 `lib/ai/modelSummary.ts`，没有放在 pane 目录。** `max_tokens` 发不发要看拼法表 `SPELLING`，拼法表在那里；「将发送」也在那里读同一份请求计划。
5. **旧的预填行不迁移。** `values.test.ts` 已经钉住它们与留空行解析出同样的值；界面上它们显示「与…一致 · 清空后跟随它」。
6. **列表行的 `ctx` 不变**，仍只显示作者值。

**行为变化（账本 B13，新建的行）**：停掉预填不只是界面——预填过的值存成作者值，受 `TRUST` 里只收作者的消费方采用；留空的行不受。
§9.7 偏离 4 说「两种行在线上没有区别」，只对规划成立：
- 在 Anthropic 线路上新建、上限留空的行，`max_tokens` 发 32,768，不再是平台行的数（例：DeepSeek ④ 的 `deepseek-v4-pro`，原来预填 393,216）；
- 窗口留空的行，发送前不再按平台的窗口拦截。

这正是 D2 的本意：表里的上限高于端点所收是每次都 400，只有作者（或探测）写下的值才发。说明行把两件事都写在字段下，作者要原来的行为就手填或探测。
已存的行不变：它们存的预填值仍是作者值。

**剩余已知问题**：
- ~~迁不出的旧方言~~：已由 §9.10 的一次性迁移消除。
- 探测费用的预估与运行时的 `declared` 不同源（`planProbeCost` 不看 `/models` 报的窗口）。

### 9.10 旧思考方言一次性迁移（2026-09-27）

作者看了 §9.9 的剩余问题后决定：把还带着旧 `thinkingDialect` 的行一次迁掉，而不是在抽屉里继续补旧方言的边界情况。

**为什么**：分类目之前，模型行用粗粒度的方言（`adaptive` · `extended` · `switch` · `none`）说自己怎么想，行上与每条停放线路上都有。
请求在发送时现场解析它：作者声明的类目合本族就用，否则按本族迁移方言，再否则由表回答。
于是抽屉的初值、换线路、改 id 矫正档位、值类视图、值类矩阵，每处都得把这一步重做一遍，两轮 review 在这里各找出一种新的边界情况。
行一旦按请求的解析方式改写一次，下游就不必知道方言存在。

**规则**（`lib/ai/legacyThinking.ts` 的 `migrateLegacyThinking`，与请求原来的解析逐条相同）：
- 声明的类目合本族：保留；
- 否则取方言在本族上的类目（`migrateDialect`），且只在它合本族时取：`switch` 在 Responses 与 Gemini 线路上也会给出 Chat 族的类目，那条线路拼不出它，原来发出去的就不是它；
- 否则不写，即「自动」。请求原来在这里就由表回答，所以线上不变。

行自己的字段按它钉住的线路的族迁——即使渠道已经没有那条线路，请求路径也认为这些字段属于它（宁可拒发也不挪用）；没钉就按渠道首条线路。
每条停放线路按自己的族迁，并删掉那里的 `thinkingDialect` 键。
只动带方言的行与线路，第二次运行不做任何事。

**两个入口，同一个函数**：
- `config.db`：`ensureAiSchema` 里、计费组迁移之后运行 `migrateThinkingDialects`，失败只告警、下次启动再试。列 `thinking_dialect` 留在表结构里，不再有人读写。
- 备份与同步：`parseConfigBundle` 在解析模型时迁移；本地备份与服务器同步都走它。没钉线路、渠道又不在同一个包里的行，族无从得知：保留声明的类目、丢掉方言。

**接受的风险**：库迁移失败时（只告警），这些行在内存里已没有方言，请求按表回答；若在下次启动前被保存过，方言就随整行重写而丢失，落到「自动」。
为这个窗口再加一条内存里的迁移路径，就是又一处认识方言的代码，正是本节要消除的。失败只在启动时库出错才发生，结果是「自动」而不是报错。

**删掉的**：`Model.thinkingDialect`、`RouteProfile.thinkingDialect`；`thinkingCategoryOf` 链上的方言一步；抽屉初值、换线路、改 id 矫正、保存时清空方言这四处；值类视图与矩阵的方言参数。
`migrateDialect` 只剩迁移在用。

**测试**：`legacyThinking.test.ts`：
- 每种方言在各族上的结果；迁不出时留「自动」；合族的声明优先；
- 穷举方言 × 族 × 声明（无或每个类目）：写下的类目一定合族，合族的声明一定保留；
- 停放线路按各自的族迁；没有方言的行不动；
- 迁移后的行解析出的类目，与迁移前请求会用的类目相同；
- 库迁移按行钉住的线路取族（渠道已没有那条线路时也是），停放线路按自己的族；
- 旧备份解析后只有类目、没有方言。

变异检查四处，都报红：库迁移改用渠道的首条线路取族；钉住的线路不在渠道里时改按首条；迁移不看合族；解析备份时不迁停放线路。

金标零差异。

### 9.11 B6：Anthropic 族关思考时的温度（2026-09-28）

**实测**（[`issues/anthropic-temperature-thinking-off.md`](../issues/anthropic-temperature-thinking-off.md)，数据在 landscape.md 第四、第十二个样本的「B6 补测」）：
两家的 ④ 面关思考都发 `thinking:{type:"disabled"}`，结论相反。
火山方舟关思考时温度生效（0.01 让 20 次挑选收敛到 19–20 次同一个答案），但 `0` 等于没发；
MiniMax 收下、200、不理会（0.01 与 1、与不发分不开，① 面也一样）。
两家开思考时都 200（不是官方的 400）而不收敛——今天「在想就不发」仍然对，理由从「会 400」换成「发了没人听」。

所以账本原来的写法——条件整条换成 `{when:"thinking", is:"on"}`——对 minimax 是错的：它会让 MiniMax 关思考时发一个没人听的字段，
抽屉还要画一个改了没用的框。

**作者拍板**：落在类目上，不落在平台格上。
- 这是厂商的事实，与 `forcing: "always"`（MiniMax 把强制工具降成 auto）同一种：拼法相同的两个类目，差在对面听不听。
  事实跟着类目走，中转站上作者手选了 `doubao-switch` 的行也得到它。
- 平台格做不到：解析顺序里请求条件先于平台格（`capability/resolve.ts` 的 `familyVerdict`），条件触发就返回，
  要让格子盖过 `unless` 是给求值顺序加特例。

**改动**：
- `ThinkingCategory.temperatureWhenOff?: { zeroIsUnset?: true }`，只在 `doubao-switch` 上。
- `capability/conditions.ts`：条件 `categoryThinks` 换成 `temperatureIgnored`，读上下文的 `temperatureHeard`（缺 = 没听，照旧触发）。
  `temperatureHeard(category, effort)` 是唯一定义：`off` 类目听（今天就发）；否则只有声明了 `temperatureWhenOff`、且 `wireThinks` 为 `off` 时听。
  上下文不再带 `thinkingCategory`——它只为这一个条件存在。原因码仍是 `thinking`，抽屉与矩阵文档不变。
- `capability/resolve.ts` 的 `temperatureReaches(wire, model, category, effort)`：规划器发不发、抽屉显不显示问的是这一个函数，两边不会分叉。
  抽屉传表单的强度，不经 `effortOnWire`——它只动 OpenAI 两族的档位，那两族没有温度条件。
- 抽屉：`doubao-switch` 选「关闭」时温度栏出现，开或跟随默认时收起（值留着）。
  这一类目上，温度栏下的一行说明换成「这条线路把 0 也当作没填，要最稳的输出，填 0.01」，填 0 时不再挂「确定性」标签。
  只换说明、不改作者的值：适配器把 0 改发一个极小正数是改写作者写下的东西，没有做。

**测试**：`temperatureSupport.test.ts` 改成按「标准 × 类目 × 强度」逐格比对抽屉的问法与 `planRequest` 的决定，另钉 doubao-switch 只在关闭时发、
minimax 任何强度都不发、声明了 `temperatureWhenOff` 的类目关闭必须是真关（`offSpelling: "disable"`）。
`wireThinks.test.ts` 的温度段先在单独一个提交里改成问规划器、逐强度列出（540 格与旧表逐格相同），本期的快照差异因此只有一格：
Anthropic 族 `doubao-switch` 的 `off` 从 `-` 变 `yes`。
变异检查四处，都报红：去掉 doubao-switch 的字段；`temperatureHeard` 不看强度；规划器不再问 `temperatureReaches`；给 minimax 也加上字段。
请求体金标零差异（金标没有关思考又带温度的 doubao-switch 行）。
抽屉在浏览器里挂真实组件核过：火山关闭 + 0 显示新说明、将发送带 `temperature 0`；切到开启温度栏收起、将发送不带；MiniMax 关闭 + 0.3 温度栏收起、不发。

### 9.12 思考回退：最低档类目既发 off 又带提示（2026-09-28）

**问题**（原 §10 第 1 条）：agent 的思考护栏中止一轮后，回退在档位菜单里有「关闭」的类目上发 off，没有的带一条「不要展开思考」的提示。
gemini3 与 claude-adaptive 的菜单里有「关闭」，但线上没有真正的关（`offSpelling: "lowest"`：Claude 发 `effort: low`，Gemini 发 `thinkingLevel: LOW`）。

**实测**（landscape.md 第十八个样本「思考回退补测」，OrcaRouter 上的 Claude Sonnet 5 与 Gemini 3.8 Flash，一道计数题每格 5 次，
输出 token 中位数）：Claude 不设 6,962 → 关闭 2,270 → 关闭 + 提示 1,396；Gemini 不设 1,980 → 关闭 1,977 → 关闭 + 提示 1,300。
Gemini 不设档位时本来就在最低档附近，只发 off 等于没回退。只换提示（保留作者档位）会两极，Gemini 有两次整段不想、都答错。

**作者拍板**：最低档类目**既发 off 又带提示**。
- 原来的反方理由（「作者可以在菜单里选 off，选了它就该是 off」）在这里不成立：off 照发，作者点得到的值没有被换掉，只是多一句提示。
- 真能关的类目（通用、DeepSeek、豆包、开关型……）不变：只发 off，不带提示。没有「关闭」的（`off` 类目、B8 的 gpt-6-astra）不变：只带提示。
- 受益面小：护栏只在一轮思考超过窗口剩余一半时触发，这些模型窗口 20 万到 100 万。改动也小，所以照做。

**改动**：`runAgent` 的 `thinkingFallback` 从 `"off" | "nudge"` 改成 `{ off, nudge }`——`off` 照旧（菜单在这条线路上有 off，或开关型），
`nudge` = 没有 off，或 `offSpelling === "lowest"`。执行日志的 `recovery` 多一种 `thinking-low`（两份 locale 各一句）。

**测试**：`agentRuntimeThinkingGuard.test.ts` 加一例——gemini3 与 claude-adaptive 中止后余下每个请求都带 off 与提示、提示发完即撤、日志是 `thinking-low`；
真能关的类目的例子补一条「不带提示」。变异检查四处都报红：最低档类目不带提示（即旧行为）；最低档类目只带提示不发 off；所有类目都带提示；日志仍写 `thinking-off`。

### 9.13 P7：回退执行器合一；D3 改判为持久化（2026-09-28）

**P7**。`streamCompletion` 是唯一的回退执行器。

- `StreamOptions.structured?: { schema? }` 是调用方唯一要说的：这次要 JSON。计划多一个 `json` 字段（`JsonModeShaping`：实际拼进去的档、字段、cue），
  只在有这个意图时算；`structured`（档位）照旧，`forcedToolIsWasted` 与摘要仍读它。「消息里有没有 json 这个词」改由 `messagesText(messages)` 从消息本身读。
- `streamCompletion` 是一个循环：每轮 `planRequest` → 把 `json.extraBody` 并进 `extraBody`、cue 接到最后一条 user 消息末尾 → 发送（日志、看门狗、上下文闸每轮新开，与原来的递归一致）。
  首块之前的错误交给 `classify`，比对的是计划里**实际发出的**强制与档位；学到就记下、重新计划、再发，否则原样抛出。返回 `{ structured? }`，即成功那次的档位。
- 调用方：结构化任务的 JSON 路径与条目生成只传意图（条目生成经 `runAgent`，其 `extraBody` 参数换成 `structured`）。结构化任务按返回的档位决定要不要去掉严格模式的 null。
- 删除：`withJsonModeFallback`、`noteJsonModeRefused`、`toolChoice.ts`（`isForcedToolChoice` 并进 `plan.ts`）。

**与 §3.7、§6 P7 原文的出入**：

1. **强制看「发出了」，不看「请求了」。** 执行器改读 `plan.toolChoice.sent`。已被类目或格降成 `auto` 的请求再收到点名 `tool_choice` 的 400，原来会学一次、原样重发一次再失败，现在直接抛出（B16 的后一条）。
2. **终止性不靠 `noteLearned` 的返回值。** 原文要「`noteLearned` 严格降低才许重试」。变异测试表明这条对终止性是空的：`LEARN_RULES` 只在请求用了该事实、且存在更低一档时才报，
   下一轮计划受该上限约束，所以每次重试发出的必然严格更少——与这次是不是它降的无关。反而并行请求先学到同一上限时，它会让本请求抛错而不重试。所以是「学到即重试」，补了并发一例。
3. **薄包装直接删掉。** 两个调用方都能直接传意图，留一层只是多一个名字。
4. **`plan.structured` 没有拆成 `{tier, shaped}`**，而是另加 `plan.json`：`structured` 有别的读者（跳过强制工具的判断、摘要），它们要的正是档位本身。

**D3 改判**。原决定「会话级，不持久化」，理由是持久化等于替探测维做决定、而 provider-layering §7 未决。作者 2026-09-28 要求一起做，§7 第一条随之定下（见那里）：
学到的是端点的事实，不是作者的配置——所以它有时间、会过期，作者的新说法能作废它。

收益要照实说：拒绝发生在生成之前，重学一次只花一个 400 的往返，不花 token。省下的是每次重启后第一次结构化任务多出来的那一趟；
本地模型上强制工具那一趟可能是几十秒，`forcedToolIsWasted` 靠学到的上限跳过它。

- **存储**：`config.db` 的 `learned_ceilings`（`learnedDb.ts`），一行一个端点 + 模型 + 事实，带强度 `rank` 与学到的时间。
  **读仍只读内存、仍同步**——计划、四个适配器、抽屉都不改签名。启动时 `aiStore` 先注册写出口、再删过期行并读回内存，与内存里已学到的取更低者；
  每次降低经出口异步写库，库侧的 upsert 只在更弱、或旧行已过期时覆盖，多个窗口各自学到的不会互相抬高。
  出口里写与删串成一条链：紧跟在写入后面的「忘掉」不能先落库。
- **年龄**：学到的时间在未来一小时以上（学到后时钟被拨回）不算数，否则它会多活出时钟错开的那么久；载入时一并删掉。
  留一小时余量，是因为两个窗口用同一个时钟盖时间、落库却不分先后，差几毫秒是常事，不是时钟被拨回。
  更低者保留它自己的时间：它过期时，后来学到的弱一档随之丢掉，代价是再撞一次 400——为省这一次给存储第二种形状，不值。
- **过期与作废**：

  | 事件 | 作废什么 | 理由 |
  | --- | --- | --- |
  | 学到后满 7 天（读时判断） | 该条 | 端点与中转站会升级，重学只花一个 400；这个数没有实测依据 |
  | 作者改了该行的结构化输出声明（同一渠道、同一线路） | 那条线路的 `structuredOutput` | 作者的新声明值得再试一次；换线路时载入的是停放的声明，不算（`learnedForget.ts`） |
  | 作者在抽屉里探测，且端点答上了话 | 被探测那条线路的全部事实 | 「重新看看这个端点」；探测一次只走一条线路，别的线路没被重新看过。取消了的、端点一次都没答的不算 |
  | 应用重置 | 整表与内存 | 刚装好的应用什么都没学过 |

  换地址、换模型 id 不需要规则：键变了，旧条目不再命中，7 天后被清掉。
- **不随配置备份与配置同步走**，也不进项目库：这台机器、这条网络上端点说过的话，换一台机器未必成立。
- **界面**：没有新控件（作者不要「忘掉」按钮，点探测就能清）。矩阵悬停与抽屉结构化输出下的两句说明去掉「本会话」，写明什么时候会再试。
  存储可以订阅（`subscribeLearned` / `learnedVersion`），模型抽屉用它重绘：在抽屉里探测清掉之后，说明与矩阵当场变回来。
- **已知缺口**：导入配置备份不经过 `updateModel`，备份里的结构化输出声明与现有的不同时，那条线路学到的上限不作废，最多再压 7 天，点一次探测即清。
  要补，更干净的是「导入配置即清空全部学到的」一条规则，而不是在导入路径上再放一处声明比对。

**测试**：

- `fallbackExecutor.test.ts`（新，真实适配器、只替换 `fetch`）：逐档降到 off 并记住、下一次从那里开始；无关错误原样抛出、不学；off 不重试；首块之后不重试；
  并行请求先学到时照样重试；强制被拒后以 `auto` 重发、之后直接发 `auto`；已发 `auto` 的不重发；cue 的三种位置；随机 400 序列 200 例：请求数 ≤ 4、上限只降、每次重试发出的严格更少。
- `learnedDb.test.ts`（新，`node:sqlite` 内存库走插件同样的 `execute` / `select`）：只降的 upsert、过期行可被覆盖、载入时删过期、跳过读不懂的行、与内存取更低者、按事实删除。
- `learnedForget.test.ts`、`aiStoreLearned.test.ts`（新）：键取自 `connOptions`，与请求同源；改声明只忘那一项、换线路不忘、探测只忘那一条线路；`updateModel` 真的调用它。
- 条目生成与结构化任务的 JSON 路径改为走真实的 `runAgent` / `streamCompletion`；请求体金标的结构化预设改为经 `streamCompletion` 带意图出请求，零差异。
- 变异检查都报红：首块之后仍重试；比对请求的强制而不是发出的；分类不看计划的档（循环不终止）；金标里不合并 `extraBody`；SQL 去掉「只降」或「过期可覆盖」；`updateModel` 不调用作废。

## 10. 待决

1. ~~**agent 思考回退要不要看 `offSpelling`。**~~ 已量、已落（§9.12）：最低档类目既发 off 又带提示。
2. ~~**B6（Anthropic 族关思考时带温度）**~~ 已量、已落（§9.11）。
3. ~~**学到的存储持久化**（D3）随 provider-layering §7 一起决定。~~ 已改判、已落（§9.13），§7 第一条同时结案。
