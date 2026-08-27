# 绑定与自动注入的粒度 · 详细设计（LLD）

> 状态：**shipped** —— 四片 PR 全部实现（§6 每格记着与设计的出入）。背景：第十轮审查确认，扮演 agent 的「绑定词条」语义与作者的
> 预期存在 6 个 gap，其中两个是**粒度错配**（账本按条目、期望按特征），一个是
> **匹配门槛**（特征要先命中条目名才可能激活，而扮演里作者对着角色说话不写名字）。
> 本文档是把现状改成 §1 那两条预期的执行设计。
>
> 用法：**每个 PR 只做 §6 里它那一格**，做完回来勾验收项。§5 的六条不变量是
> 改动期间不许破的东西——破了任何一条，这次改动就变成了另一个静默失效。

## 1. 目标行为（作者的原话，展开成可验收命题）

作者的预期，一字不改：

> 1. 选择主条目（也就是要扮演的那个角色），它的 `index.md` 会常驻记忆上下文。
>    然后在对话过程中，会自动去匹配，注入命中的 facets。
> 2. 在下方，已经绑定的主条目的 index 不可以再选（防止重复），但是可以选择
>    facets，选中的 facets 会常驻（而不再自动注入），剩下的依然自动注入。

展开成七条可验收命题（后文全部按编号引用）：

| # | 命题 |
|---|---|
| P1 | 主角条目的 `index.md` 恒在上下文里，**且只有一份** |
| P2 | 主角条目的特征按 keys / `mode` 自动激活，**不要求作者写出角色名** |
| P3 | 一段特征被勾成常驻 → 它恒在上下文，且不再由自动检索重复送 |
| P4 | 同一条目**没被勾**的特征，依然照常自动注入（勾一段 ≠ 整条失联） |
| P5 | 绑定器里主条目的 index 行不可再选，且旧数据里已经选了的要被剥离 |
| P6 | 已常驻的条目在下方被 `@` 引用时，不产生第二份正文 |
| P7 | 以上全部对**压缩**成立：折叠掉的东西可以重新注入，没折叠的不重复注入 |

## 2. 现状与 gap

证据列里，「实测」= 用一次性 vitest 跑真实 `seedRoleplayHistory` + 真实
`selectLore` 确认过，不是读代码推断。

| # | Gap | 证据 | 违反 |
|---|---|---|---|
| G1 | 特征的自动激活是两级 AND：先用 name/alias 命中**条目**，才比对 facet keys。扮演里作者写「你」不写名字，条目永不进候选 | `loreSelect.ts` 的 `autoDirs`；实测「你穿着那件外套做什么？」→ `seedContext` 为 `null` | P2 |
| G2 | 一旦命中，注入的是 L0 摘要 + L1 正文 + L2 特征——主条目正文和 system 层重复一份 | `loreSelect.ts` L0/L1 无条件执行；实测 | P1 |
| G3 | 主条目绑了整条 = 同一个文件读两遍，system 层一份、绑定块一份 | `run.ts:53` 与 `context.ts:100` 读的是同一个 `index.md`；实测两处内容相同 | P1 |
| G4 | 账本按 `dirPath` 记：绑了**任何一段**特征，整条退出自动检索 | `context.ts:356` + `run.ts:337`；实测：绑整条后 key 命中的 `mode:auto` 特征也进不来 | P4 |
| G5 | 绑定器不知道谁是主条目：index 行可点、「整条绑定」可按、`countFor` 分母含 index | `AgentComposer.tsx:349/359` | P5 |
| G6 | 绑定项超出 `BOUND_BLOCK_CHAR_CAP` 时只写一行占位，**却照样记进账本** → 正文既不在块里、也永远不会被检索补上 | `context.ts:110-118` 的占位分支仍 `entities.push(entity)` | P3 |
| G7 | `@` 引用无条件内联 `index.md`，从不查账本 | `chatRefs.ts:53-57`；实测：绑定 + `@` 同一条目 → 同一次请求两份 | P6 |

G4 与 G7 在**主聊天**里同样存在（`agentStore.ts:1279` 用的是同一个
`excludeDirsFor`）：第 2 轮提过沈砚、第 8 轮问「他的外套」，`outfit.md` 永远
拿不到。这决定了 §8 方案 A 被否——修在共享层，两处一起好。

## 3. 根因

三句话：

1. **账本的粒度是条目，期望的粒度是特征。**`InjectionRecord` 只记「这个条目
   进过上下文」，于是「进过」只能表达成「整条别再来」。
2. **`selectLore` 没有「只要特征，不要正文」的模式。**L0 摘要是保底层、L1 正文
   无条件读——任何一次命中都会把主条目正文再送一遍。
3. **「参与匹配」和「注入正文」被绑成了一件事。**主角需要的是前者恒成立、后者
   永不发生，今天没有任何入参能表达这个组合。

## 4. 目标设计

### 4.1 三个概念

| 概念 | 含义 | 从哪来 |
|---|---|---|
| **core 常驻**（`coreDone`） | 这个条目的摘要 + 正文已经在上下文的某个永久层里，自动检索**不要再送**，但条目本身照常参与匹配、照常带特征 | 账本 |
| **facet 常驻**（`excludeFacets`） | 这一**段**特征已经在上下文里，自动激活不要再送；它在互斥组里视为**已占位并胜出** | 账本 |
| **恒参与匹配** | 这个条目每轮都进 `selected`，不要求文字里出现它的名字 | 把主角条目当 `pin` 传给 `selectLore` |

第三条用现成机制表达是刻意的：pin 本来就是「作者明示，豁免 `excludeDirs` 和
取材范围」，而「这个 agent 就是这个角色」正是最强的明示。副作用也是想要的
——pin 在预算分配里排在自动命中之前（`candidates.sort` 的 `Number(b.pinned)`），
主角的特征因此不会被路人条目挤掉。

### 4.2 `selectLore` 的两个新入参

```ts
export async function selectLore(
  matchTarget: string,
  loreIndex: LoreIndex,
  pinPaths: string[],
  budgetChars?: number,
  opts?: {
    /** 既有：整条跳过（自动匹配阶段 `continue`）。改动后只剩记忆区检索在用。 */
    excludeDirs?: ReadonlySet<string>;
    /** 新：这些 dirPath 的 L0 摘要 / L0.5 配图行 / L1 正文全部跳过，只跑 L2。 */
    coreDone?: ReadonlySet<string>;
    /** 新：`dirPath#facetFile`。仅作用于**自动激活**的特征；pin 的特征豁免。 */
    excludeFacets?: ReadonlySet<string>;
    scope?: LoreScope;
  },
): Promise<LoreSelection>
```

语义，逐条钉死：

1. `coreDone` **不影响条目是否进 `selected`**——它仍要靠 pin 或自动命中进来。
   它只关掉 L0 / L0.5 / L1 三层。
2. `coreDone` 的条目在 L0 **不计** `## 名字` 的 header 成本；等它第一段特征入选
   时再补计。否则一个 20 条常驻条目的会话，光 header 就凭空吃掉预算。
3. `excludeFacets` 命中的候选：不产出文本，进 `droppedFacets`，reason 用新值
   `"resident"`。
4. **`excludeFacets` 的成员参与互斥组并且胜出**（优先级高于任何非 pin 成员）。
   漏掉这条的后果是：常驻了「战袍」，同组的「便装」照样被注入，上下文里同时
   存在两套形象——比不注入更糟。
5. pin 的特征（`pinnedFacets`）**不受 `excludeFacets` 影响**：pin 是明示。
6. 报告：`LoreEntityReport` 加 `coreResident?: boolean`，让 AiPanel 的注入报告
   能说清「这条只补了特征，正文早在上下文里」。

配套改动：`FacetDropReason` 加 `"resident"`；`AiPanel.tsx:678` 的 `dropReason`
加一条分支 + `ai.panel.loreDropResident` 的 en / zh-CN 两份文案（现在的 fallback
会把它显示成「仅手动」，纯误导）。

### 4.3 账本下沉到特征级

> 这一节**破了 01-overview 的「`lib/agent/*` 一行不改」**。那条原则是初次搭建时
> 「扮演完全复用现成运行时」的自我约束，不是长期不变量；而 G4 / G7 本来就同时
> 长在主聊天里（`agentStore.ts:1279` 用的是同一个 `excludeDirsFor`）。在共享层修，
> 两处一起好；在扮演侧另起一本账，只会多一份迟早漂移的真相（§8 方案 A）。

`lib/agent/compact.ts`：

```ts
export interface InjectionRecord {
  version: string;                              // entityVersion，语义不变
  coreCarrier: StreamMessage | null;            // 带来摘要+正文的那条消息
  facetCarriers: Map<string, StreamMessage>;    // facet 文件名 → 带来它的那条消息
}

export interface InjectedLayers { core?: boolean; facets?: readonly string[] }

/** 合并式记账：同一条目的 core 和某几段特征可以由**不同** carrier 带来。 */
export function recordInjection(
  meta: ChatSessionMeta, entity: LoreEntity, carrier: StreamMessage, layers: InjectedLayers,
): void;

/** 从一次 selectLore 的报告记账——层次由报告说了算，不靠调用方复述一遍。 */
export function recordInjectionsFromReport(
  meta: ChatSessionMeta, report: LoreActivationReport,
  byDir: Map<string, LoreEntity>, carrier: StreamMessage,
): void;

/** 一个 carrier 承载的全部账目一次清掉（刷新绑定块时用）。 */
export function clearCarrier(meta: ChatSessionMeta, carrier: StreamMessage): void;

export function coreDoneFor(meta: ChatSessionMeta, loreIndex: LoreIndex): Set<string>;
export function injectedFacetsFor(meta: ChatSessionMeta, loreIndex: LoreIndex): Set<string>;
/** 保留：整条语义（core 在上下文即算已注入）。改动后只有记忆区检索还在用。 */
export function excludeDirsFor(meta: ChatSessionMeta, loreIndex: LoreIndex): Set<string>;
```

**合并而不是覆盖**是这一节的要害。今天 `recordInjections` 用 `Map.set` 整条覆盖：
绑定块记了「沈砚」，第 5 轮自动带进一段特征时再 `set` 一次，carrier 就从绑定块
变成了那条轮消息——等那一轮被折叠，账目被逐出，**绑定块里明明还在的正文**会被
重新注入一遍。所以 core 和每一段特征各自记自己的 carrier。

逐出（`buildCompactedHistory` 末尾，替换现在的整条 `delete`）：

```ts
for (const [dir, rec] of meta.injected) {
  if (rec.coreCarrier && !live.has(rec.coreCarrier)) rec.coreCarrier = null;
  for (const [file, c] of rec.facetCarriers) if (!live.has(c)) rec.facetCarriers.delete(file);
  if (!rec.coreCarrier && rec.facetCarriers.size === 0) meta.injected.delete(dir);
}
```

`injectionCarriers()` 返回 core 与全部 facet carrier 的并集。

**序列化**（`lib/agent/chatSession.ts`）：三元组扩成四元组，`v` **不升**——升版本
号等于让每个已存在的会话重新开始。

```
旧： [dir, version, carrierIdx]
新： [dir, version, coreIdx, [[facetFile, idx], ...]]      coreIdx = -1 表示没有
```

读取：`length === 3` → `{version, coreCarrier: at(idx), facetCarriers: new Map()}`
（旧行记的就是整条注入，含 core，迁移是忠实的）；`length === 4` → 新形状，逐条
`at()`，解析不到的那一项丢掉。写入：一律写四元组。旧 build 读到新文件时
`length !== 3` 会 `continue`，账本变空——**降级是「多注入一次」，不是「会话读不
出来」**，这是可接受的方向。

### 4.4 扮演侧的装配

**`BoundContent` 增一个字段**，说明块里**实际**装了什么（不是配置说了什么）：

```ts
export interface BoundContent {
  text: string;
  entities: LoreEntity[];
  stalePaths: string[];
  /** 真正写进块里的东西。超预算的占位项**不算**——那一行只有标题。 */
  resident: { coreDirs: string[]; facets: string[] /* `dir#file` */ };
}
```

G6 就修在这里：占位分支不再进 `resident`，于是那个条目照常参与自动检索，正文
由检索补上（预算之内），而不是两头落空。

**播种**（`context.ts` `seedRoleplayHistory`）：

```ts
// 1) 绑定块：按块里实际有的东西记账，carrier = 绑定块（永不离场 → 永不逐出）
for (const dir of bound.resident.coreDirs) recordInjection(meta, byDir.get(dir)!, boundBlock, { core: true });
for (const key of bound.resident.facets)  recordInjection(meta, entityOf(key), boundBlock, { facets: [fileOf(key)] });

// 2) 主角条目的正文住在 system 层：carrier = system 消息（同样永不离场）
if (primaryEntity && opts.primaryText.trim()) recordInjection(meta, primaryEntity, system, { core: true });

// 3) 首轮检索：主角恒参与（pin），常驻的东西不重复
const { text, report } = await selectLore(matchText, loreIndex,
  agent.primaryDirPath ? [agent.primaryDirPath] : [],
  loreBudgetChars,
  { coreDone: coreDoneFor(meta, loreIndex),
    excludeFacets: injectedFacetsFor(meta, loreIndex),
    scope: loreScope });
recordInjectionsFromReport(meta, report, byDir, seedBlock);
```

旁白没有 `primaryDirPath`，`pinPaths` 自然是 `[]`，其余同路——不为旁白开分支。

**续跑**（`run.ts` `prepareContinuedHistory`）：`assembleTurnInjection` 增
`pinPaths?: string[]`（默认 `[]`，主聊天不传）并透传 `coreDone` / `excludeFacets`；
扮演传 `[primaryDirPath]`。记账改用 `recordInjectionsFromReport`。**排序一个字
不动**——修对配对 → 压缩 → 刷新记忆块 → 词条注入 → 区检索 → 提问。

**刷新设定**（`refreshBoundBlock`）：重建文本之前先 `clearCarrier(meta, boundBlock)`，
再按新的 `resident` 记账。少了这一步，取消勾选的那段特征会永远被当成常驻，从此
既不在块里也不会被检索——和 G6 同一种死法。

**`@` 引用**（G7 / P6）：作业队列的 job 增一个字段：

```ts
{ agentId, wire, match, refDirs: string[] }   // 问句里已经内联了正文的条目
```

`prepareSeededHistory` / `prepareContinuedHistory` 里：`coreDone ∪= refDirs`（本轮
问句里已经有它的正文了），并在**问句 push 之后**
`recordInjection(meta, entity, question, { core: true })`——carrier 是问句，那一轮
被折叠时账目正确逐出，之后再提到它会重新注入。

至于「已经常驻的条目要不要内联」，判断在 `send()`（§4.5），不在 `chatRefs`：
后者是纯装配，不认识会话状态（§8 方案 E）。

### 4.5 UI 与花名册

- **`AgentComposer.tsx`**：`active.dirPath === primary` 时，「主条目（index.md）」
  行禁用并标「已常驻（主条目）」，「整条绑定 / 取消整条」按钮隐藏；`countFor`
  对主条目用 `picked/facets.length`（分母不含 index）；`save()` 前
  `bound.filter((p) => p !== primary)`。
- **`lib/roleplay/store.ts` 的 `parseAgent`**：读花名册时同样剥掉等于
  `primaryDirPath` 的裸 pin——这是旧数据的迁移点，且和上面那条是同一个规则的
  两次落地（读一次、写一次），不能只做一边。
- **`RoleplayChat.tsx`**：`@` 候选列表给常驻条目加「已常驻」标；`send()` 拆分
  refs——常驻的 lore ref **不内联**（芯片仍显示，消息里作者写的 `@名字` 原样保留），
  其余照常内联，并把它们的 `dirPath` 放进 `refDirs`。
  「谁是常驻」优先读**账本**（`session.snapshot.meta.injected`，它是块里实际有
  什么的真相），没有活会话时（首问，块正要被建出来）退回读 agent 配置。
- **i18n**：`ai.panel.loreDropResident`、`roleplay.composer.primaryResident`、
  `roleplay.composer.refResident`，en + zh-CN 各一份。

## 5. 不变量（改动期间不许破）

1. **常驻由「它实际在哪一层」决定，不由配置声明。** 账本记块里真的有什么；
   超预算的占位项不算常驻。
2. **主角条目的正文只有一份，住在 system 层。** 绑定块和逐轮注入里都不该再有它。
3. **特征注入幂等**：同一段特征在它的 carrier 存活期内只进一次上下文。
4. **排除只作用于自动层**：pin 和 `@` 是作者明示，永远豁免 `coreDone` /
   `excludeFacets` 对*选中*的影响。但**内联**要先问账本——重复内联不是「作者
   坚持」，是浪费。
5. **`lib/agent/*` 只加字段、不改语义**；旧 session blob 必须仍能读，最坏退化是
   多注入一次。
6. **PR-1~3 不改绑定块的文本**，prompt 缓存前缀不作废。只有 PR-4 剥离主角裸 pin
   时块内容变一次——那正是要消掉的那份重复。

不变量二（绑定块 / 记忆块在 prelude、永不进 seed 块）和不变量四（记忆块四个
刷新时刻）**完全不动**，`context.test.ts` 现有断言必须一条不改地继续绿。

## 6. PR 切分与验收

### PR-1 · `selectLore` 的两个入参（纯层，无调用点改动）· ✅ 已实现

改：`lib/context/loreSelect.ts`、`components/ai/AiPanel.tsx`（一条 `dropReason`
分支）、两份 i18n。

测试（`src/lib/__tests__/loreSelect.test.ts` 新增）：

- a. `coreDone` 的条目只产出特征块——没有 `> 摘要`、没有正文、没有配图行
- b. `coreDone` 且没有新特征 → 该条目不出现在 `text` 里，且 `usedChars` 不因它增长
- c. `excludeFacets` 命中的特征不注入，报告里 `reason === "resident"`
- d. `excludeFacets` 的成员在互斥组里胜出，同组另一段记 `group-lost`
- e. pin 的特征即使在 `excludeFacets` 里也照常注入

**不做**：不改两级匹配规则、不改预算算法、不动任何调用点。

**实现出入**（三处，都是加法）：

1. 多导出了一个 `facetKey(dirPath, file)`——`dirPath#facetFile` 这个拼法从此只有
   一处，PR-2 的账本和 PR-3 的绑定块都从它拿 key。设计里只写了格式，没写由谁拼；
   两边各拼一次迟早写岔。
2. 「resident 先于 keys 判断」写进了代码注释和一条独立测试：常驻的那一段**这一轮
   字面没命中也照样占组**。设计 §4.2.4 只说了它参与互斥组，没说清判断顺序，而顺序
   反了就会在「只提了便装」的那种轮次里放亚军进来。
3. 测试比清单多两条：一条钉住 header 只计一次费（`usedChars` 精确等值），一条钉住
   两个选项都不传时 `text` / `report` 与从前逐字相同——PR-2 改调用点时，这条是
   「纯层没走样」的锚。

验收状态：`pnpm vitest run` 190 文件 2580 例全绿（含新增 8 例），`pnpm build`
（tsc + vite）通过。

### PR-2 · 账本下沉到特征级 · ✅ 已实现

改：`lib/agent/compact.ts`、`lib/agent/chatSession.ts`、`lib/context/rag.ts`
（`assembleTurnInjection` 增 `pinPaths` / `coreDone` / `excludeFacets` 三个透传参数）、
`stores/agentStore.ts`（改用 `recordInjectionsFromReport` + 两个新 selector）。

测试：

- a. `chatSession` 往返：新四元组读写一致；**旧三元组**读成 `coreCarrier` 有值、
  `facetCarriers` 为空
- b. 逐出：core 的 carrier 被折叠 → core 可重注、已记的特征不受影响；反之亦然
- c. 合并：绑定块记 core、轮消息记特征之后，两者的 carrier 各自独立（不覆盖）
- d. 主聊天回归：第 2 轮提过某条目、第 8 轮问它的某段特征 → 特征能注入（**今天
  拿不到**），而正文不重复

**验收**：主聊天除「特征可后续补注入」之外行为不变；旧 blob 能读。
**不做**：不碰 `lib/roleplay/*`。

**实现出入**（六处）：

1. `recordInjectionsFromReport` 收 `loreIndex` 而不是设计里写的 `byDir` map——三个
   调用点手上都有 index，让每处各建一次 map 只是把同一段代码抄三遍。
2. **`core` 只认 `core` 层，不认 `summary` 层。** L0 摘要是预算耗尽也会进的保底层，
   把它当成「这条已经给过了」，那份被预算挤掉的正文就永远到不了模型面前。代价是
   预算长期紧张时每轮重发一行摘要，换来的是正文终究会到——一条测试钉住了这个选择。
3. 多了一个 `contributingEntities(report)`：拿掉 `excludeDirs` 之后，报告里会出现
   「命中了但什么都没贡献」的条目（正文常驻、这轮没有新特征），执行日志那句
   「注入 N 个条目」会因此虚高。日志改数它。
4. `excludeDirsFor` 保留成 `coreDoneFor` 的同义实现，注释写明两者今天算出同一个集合
   但问的是两个问题——记忆区是整条注入，不该悄悄继承知识库的特征规则。
5. `assembleTurnInjection` 的 `excludeDirs` 由必填改可选（新增 `pinPaths` / `coreDone` /
   `excludeFacets` 三个可选参数，PR-3 用得上 `pinPaths`）。
6. 两个测试文件里 `.carrier` → `.coreCarrier` 的机械改名，其中一个在
   `lib/roleplay/__tests__/context.test.ts`——是断言字段名，不是行为改动，扮演侧的
   代码一行未动（它仍走 `recordInjections` + `excludeDirsFor`，行为与从前逐字相同）。

顺带修掉的（本来是 PR-3 的账，落在共享层就一起好了）：主聊天里第 2 轮提过某条目、
第 8 轮问它某段特征时那段特征**再也拿不到**——`chatInject.test.ts` 的第一条新测试就是
这个场景。

验收状态：`pnpm vitest run` 190 文件 2588 例全绿（新增 8 例），`pnpm build` 通过。

### PR-3 · 扮演的绑定语义 · ✅ 已实现

改：`lib/roleplay/context.ts`（`BoundContent.resident`、播种记账、刷新清账、
pin 主角）、`lib/roleplay/run.ts`（三个入参 + `refDirs`）、`stores/roleplayStore.ts`
（job 带 `refDirs`）。

测试（`lib/roleplay/__tests__/context.test.ts` + `run.test.ts`）：

- a. **绑一段特征 → 同条目其余特征仍能被自动注入**（本次的核心断言，对应 P4）
- b. 绑整条 → 正文不再自动重发，特征照常进（P3 + P4）
- c. 作者只写 key、不写角色名 → 主角的特征仍被注入（P2）
- d. 主角的正文不出现在任何逐轮注入块里（P1）
- e. 超预算占位的绑定项不算常驻，会被自动检索补上（G6）
- f. 取消一段特征绑定 + 刷新设定 → 该段回到自动池
- g. `@` 一个非常驻条目 → 本轮注入块里没有它，下一轮也不重复（P6）
- h. 压缩之后：折叠掉的特征可重新注入，绑定块承载的不重复（P7）

**验收**：`context.test.ts` / `run.test.ts` 既有断言一条不改地全绿。

**实现出入**（六处）：

1. `BoundContent.resident.facets` 是 `{ dirPath, file }[]`，不是设计里写的 `dir#file`
   字符串数组。账本要的就是这两半，拼成一个 key 再拆回来，等于把「dirPath 里含 `#`」
   那个坑重新挖一遍——而 `buildBoundContent` 刚刚才把它解析清楚。
2. 多了一个导出的 `recordPrimaryCore`，而且**「刷新设定」里也要调一次**：system 层
   刚被重写，主角条目的指纹也跟着换了，不重记这一笔，检索就会把刚写进 system 的
   同一份正文再注入一遍。设计里只写了播种那一次。
3. **记账顺序**：主角（carrier = system 消息）排在绑定块之后，于是同一条目两处都有
   正文时 system 那份赢。它活得更久——「刷新设定」清的是绑定块那一版的账，system
   里的那份不该跟着失效。这条写进了代码注释和一条测试。
4. `contributingEntities`（PR-2 加的）也接到了扮演的 `context-seeded` 事件上：主角
   每轮都在候选里，正文常驻、这轮没有新特征时它什么都不贡献，计数不该把它算进去。
5. `run.ts` 里那个只剩一个调用点的 `indexByDir` 删掉了。
6. 测试比清单多两条，都在**续跑**这条路上（`run.test.ts`）：主角 pin 生效、`@` 引用
   的 A/B。播种对了而续跑漏传一个入参，症状是「第一句能想起特征、之后再也不行」，
   而那是最难自查的一类。

**迁移**（新增的一条风险）：升级前就存在的 `session.json`，账本里绑定条目仍记着
「整条 core」。所以「勾一段 = 整条失联」在**那些正在进行的会话**里会保留到作者点一次
「刷新设定」（`clearCarrier` + 按新语义重记）或开新的一场。新会话立即生效。

验收状态：`pnpm vitest run` 190 文件 2599 例全绿（新增 11 例），`pnpm build` 通过。

### PR-4 · UI 与花名册迁移 · ✅ 已实现

改：`components/roleplay/AgentComposer.tsx`、`components/roleplay/RoleplayChat.tsx`、
`lib/roleplay/store.ts`、i18n。

测试：`parseAgent` 剥离主角裸 pin 的解析测试；`staleRefs` 回归不受影响。
手测三条：绑定器里主条目 index 行不可点且标「已常驻」；老项目打开后绑定块里
不再有主条目正文；`@` 已常驻条目时芯片显示「已常驻」且消息里没有第二份正文。

**实现出入**（六处）：

1. 多了一个 `residentCoreDirs(agent, meta, loreIndex)`（`lib/roleplay/context.ts`）：
   绑定器、`@` 列表和 `send()` 都要回答「这条常驻了吗」，各写一份判断必然漂移。
   它**优先读账本**（块里实际有什么），没有活会话才退回配置去推——反过来只信配置，
   就会在「改了绑定还没刷新」的窗口里把一段其实不在上下文里的东西当成常驻。
2. `MentionPicker` 学的是一个通用的 `noteFor?: (item) => string | null` 回调，不是
   roleplay 专用的 props：同一个组件还服务知识库弹窗和主聊天，不该学会任何一个宿主
   的词汇。
3. 主条目那一行**留在列表里**——禁用 + 打勾 + 虚线框 + 一句「已常驻」，而不是删掉。
   一行凭空消失只会让作者以为自己漏看了什么。
4. 选定主角时顺手把它的裸 pin 从草稿里摘掉（`choosePrimary`），否则它会以「已勾选
   但不可点」的样子停在那里直到保存。
5. 迁移做在**读取侧**（`parseAgent`），不重写作者的 `roster.json`；下一次保存自然写回
   干净的。旁白不过滤——它没有主角条目（`primaryDirPath` 读成 null）。
6. `@` 已常驻的条目时，芯片保留、作者敲的 `@名字` 也保留，只是不再内联正文；
   `refDirs` 只记**真的内联了**的那些，否则会把 carrier 换成这条问句，等它折叠掉，
   绑定块里还在的正文就被当成没了。

验收状态：`pnpm vitest run` 190 文件 2603 例全绿（新增 4 例：花名册迁移 2 条 +
`residentCoreDirs` 2 条），`pnpm build`（tsc + vite）通过。**手测三条没有做**——
这台机器没有桌面环境，UI 改动只经过类型检查、单测与构建。

## 7. 迁移与风险

| 风险 | 处理 |
|---|---|
| 剥离主角裸 pin 会改变 `boundText` → `contextHash` 变 → 全体 agent 亮一次「设定已更新」 | **接受**。点一次刷新即可，而「静默重算基线」要区分两种变化，复杂度不值 |
| 旧 `session.json` 的三元组账本 | §4.3 的兼容读；最坏是某条目多注入一次 |
| 主角 pin 之后，`mode:"always"` 的特征在每次折叠后会重新注入 | 按设计——`always` 就是作者要求它恒在 |
| 主角条目正文读不出来（条目被删）时，system 层为空而绑定块又不再兜底 | 既有行为不变：`buildSystemPrompt` 本来就跳过空的那一节，UI 报「主角条目已删除」。不新增兜底 |
| 主角条目正文被作者改了 → `entityVersion` 变 → core 会被自动重注入一份 | **接受且是想要的**：一份新正文进上下文，胜过角色继续按旧设定说话；此时「设定已更新」也正亮着 |

## 8. 被否掉的方案

**A. 扮演自建第二本账本，`lib/agent/*` 一行不改。** 否：同一个 bug 在主聊天里
同样存在（第 8 轮的「他的外套」），两本账本迟早漂移，而 `selectLore` 无论如何
都要改——省下的只有 `compact.ts` 那几十行。

**B. 不记账本，从 agent 配置推导常驻集。** 否：配置和绑定块之间有一个「作者改了
绑定但还没点刷新设定」的窗口。推导集会把一段**其实不在任何一层里**的特征当成
常驻，于是它彻底消失——正是 G6 那种死法，只不过换了个入口。账本记的是块里
实际有什么。

**C. 把 facet keys 提成一级匹配（不要求先命中条目名）。** 否：「外套」「伤疤」
这种通用词会让任意条目的特征在没提到那个条目时乱入。主角的「恒参与」用 pin
表达，作用域精确到一个条目。

**D. 把主角的全部 facets 直接常驻进 system 层。** 否：facet 存在的意义就是不
全量注入（`lore-facet-plan.md`）。20 段特征的主角会把窗口吃光，而其中 18 段和
这一句台词无关。

**E. 在 `buildChatMessage` 里查账本、跳过已常驻的 ref。** 否：`chatRefs` 是纯
装配层，不认识会话状态。判断留在 `send()`（它有 session），`chatRefs` 只按传进来
的 refs 干活。

## 9. 非目标

- 不动 transcript、记忆系统、转场、压缩阈值。
- 不做「特征自动常驻」（用了几次就自动钉住）——那是另一个功能，且需要作者可见
  的撤销入口。
- 不改取材范围（`scope`）的语义。
- 不给旁白单开分支：它没有 `primaryDirPath`，`pinPaths` 自然为空，走同一条路。
- 不改 `read_lore_entity`——「模型自己去读全部特征」始终是常驻之外的兜底路径。
