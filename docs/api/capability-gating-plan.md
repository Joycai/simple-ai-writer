# 模型能力判定：一张登记表、一个裁决函数

> **状态：`partial`——C0–C3 已实现（能力表、裁决函数、三道闸：矩阵文档、一致性测试、源码棘轮；行为不变）；C4（视频按平台）搁置，记入待办 [`issues/video-capability-per-platform.md`](../issues/video-capability-per-platform.md)；模型 id 轴没登记的 id 判「未实测」（§8.7），只写 `refuses` 的格子只点名、不连累别的 id（§8.10）；中转站上按模型背后的上游裁决，上游由作者声明、能力由内置画像给出（§8.11）。实施记录见 §7、§8。**
> 表渲染出来的样子在 [`capability-matrix.md`](capability-matrix.md)（生成物）。§7 是实施记录与作者的三条决定。起因是 2026-09-19 的一次盘点（`ModelDrawer.tsx` 的全部能力选项）
> 和它之前的一个缺陷（千问的 `vl_high_resolution_images` 按协议族放行，出现在智谱的模型上，
> [`zhipu-plan.md`](zhipu-plan.md) G12 / P6）。那次修的是一个字段；本文要修的是**让这种缺陷能够出现的形状**。
> 分层的原则在 [`provider-layering.md`](provider-layering.md)，平台画像在
> [`channel-model-route-plan.md`](../feature/channel-model-route-plan.md) §4；本文只在它们之上加一层，不改它们的结论。

## 1. 问题：一个能力的答案，今天要在四五个地方各算一遍

「这个模型在这条线路上能不能 X」这个问题，对每个能力至少有四个提问者：

| 提问者 | 它要的答案 |
| --- | --- |
| 模型抽屉 | 这一行显不显示；显示了是「会发送」还是「已声明、不发送」 |
| 适配器（`openai.ts` 等） | 这个字段进不进 body |
| 「将发送」摘要（`modelSummary.ts`） | 同上，但要与适配器**逐字一致** |
| 会话面（`AgentChat` / `agentStore` / `chatRefs` / `subagent`） | 能不能挂附件、token 怎么估、子代理选谁 |

而今天每个能力各有一个签名不同的函数，有的连函数都没有：

| 能力 | 现在的判据 | 形态 |
| --- | --- | --- |
| PDF | `wireReadsPdf(wire)` + `readsPdf(model, provider)` | 平台画像 `pdfFamilies`，缺省 ①② |
| 高分辨率读图 | `wireTakesQwenVisionParams(wire)` | 平台画像 `qwenVisionParams`，无主机的中继缺省放行 |
| 视频 | `canReadVideo(model, standard)` | **只看协议族**，不经平台 |
| 抽帧 fps | `sentVideoFps(model, provider)` | 平台，同高分辨率 |
| 温度 | `supportsTemperature(standard, category)` | 协议族 × 思考类目 |
| 输出详细度 | 内联 `family === "responses"` | 抽屉 3 处 + `responses.ts` + `modelSummary.ts` |
| 翻译格式 | 内联 `family === "openai" && type === "text"` | 抽屉 3 处 |
| 结构化输出选项 | 内联 `family === "anthropic" ? ["off"] : …` | 抽屉 + `jsonMode.ts` 各一份 |
| 强制 tool_choice | `wireIgnoresForcedToolChoice(wire)` | 平台画像 `forcedToolChoice` |
| 服务端工具 | `serverToolStatus(wire, id, modelId)` → `yes / unknown / no` | 平台 × 族 × 模型 id，**唯一一个三值的** |

数一下：`family === "…"` 在 `platforms.ts` 之外有 50 余处，其中 `ModelDrawer.tsx` 17 处、`modelSummary.ts` 6 处。
它们不全是错的（适配器里决定 body 形状的分支就该按族写），但**能力判定**混在其中，没有任何东西能区分两者。

由此而来的三类缺陷，都已经发生过或正摆在那里：

1. **层级放错。** 平台私有的字段按族放行（G12）。视频开关现在仍是这个形状：OpenAI 官方、DeepSeek、xAI 的 ① 线路上，
   多模态模型都会出现「视频输入」，而 `video_url` 只在千问与智谱上实测过。
2. **提问者之间不一致。** 抽屉显示、适配器不发，或者摘要写了、适配器没发。现在靠每个能力各写一组测试把两边钉在一起，
   新增一个能力就要记得再钉一次——漏了是静默的。
3. **「没测过」没有表达。** 除了服务端工具，其余判据都是布尔：一个没有画像的中继（New API、自定义）只能硬选「放行」或「拦下」，
   抽屉无法告诉作者「这一项在这个平台上没人测过」。`qwenVisionParams` 为此写了一条特判（`hosts.length === 0`），下一个字段还得再写一条。

## 2. 目标形状

> **落成的形状与本节有三处出入，以 §7 为准**：平台一侧不是 `PlatformProfile` 上的一个槽，而是 `capabilities.ts` 里独立的一张
> 平台 × 协议族 × 能力表（第三轴模型 id）；服务端工具**并入**了这张表；裁决时平台格先于族检查。本节保留原样，是为了留下当时的推理。

### 2.1 一张能力登记表（`lib/ai/capabilities.ts`，新文件）

每个能力是一行**数据**，回答四件事：它在哪一层、缺省哪些族有拼法、依赖什么、谁能覆盖。

```ts
export type CapabilityId =
  | "pdfInput" | "vlHighResolution" | "videoInput" | "videoFps"
  | "temperature" | "textVerbosity" | "translateFormat"
  | "structuredOutput" | "forcedToolChoice";

interface CapabilityRule {
  id: CapabilityId;
  /** 缺省：哪些协议族的线上有这个拼法（L1）。平台画像没说话时用它。 */
  families: readonly ProtocolFamily[];
  /**
   * 缺省答案的可信度。"native" = 协议本身的一部分，任何说这一族的端点都该收（温度、PDF 片段）；
   * "private" = 某一家的私有字段，**没有画像点名的平台一律 no，无主机的中继 unknown**。
   */
  origin: "native" | "private";
  /** 模型类型门槛（看图的能力只对 multimodal / vision 成立）。 */
  modelTypes?: readonly ModelType[];
  /** 先决能力：fps 依赖视频已声明且可发送。 */
  requires?: readonly CapabilityId[];
  /** 少数需要读模型其它字段的（温度读思考类目）。纯函数，不读 store。 */
  modelGate?: (m: CapabilityModel) => ReasonCode | null;
}
```

`origin` 是整张表里最要紧的一列：它把 G12 的教训变成**缺省行为**而不是事后补丁。今后加一个私有字段，
写 `origin: "private"`，它就只在点了名的平台上出现——要让它泄漏到别的平台，得有人主动去写，而不是忘了拦。

### 2.2 平台画像里统一成一个槽

`PlatformProfile` 现有的三个零散字段收进一个：

```ts
capabilities?: Partial<Record<CapabilityId, PlatformCapability>>;
type PlatformCapability =
  | false                                        // 实测过：不收 / 收了但无效
  | { families: readonly ProtocolFamily[] };      // 实测过：这些族上有效
```

| 现字段 | 迁移后 |
| --- | --- |
| `pdfFamilies: ["openai","responses","anthropic"]`（volcengine-plan） | `capabilities.pdfInput.families` |
| `qwenVisionParams: true`（dashscope ×2） | `capabilities.vlHighResolution` / `videoFps`: `{ families: ["openai"] }` |
| `forcedToolChoice: "ignored"`（zhipu） | `capabilities.forcedToolChoice: false` |

~~`serverTools` **不并入**~~（**已作废，见 §7 第 3 条：服务端工具并入能力表**）：它带拼法（同一个 id 在不同平台是不同的 body），不只是有无。但它的裁决走同一个出口（§2.3），
三值语义本来就是从它那里借的。`models`（按 id 的校准表）也不并入：它是**预填**，不是门槛（zhipu-plan §5）。

### 2.3 一个裁决函数，三值加原因码

```ts
export interface Verdict { status: "yes" | "unknown" | "no"; reason: CapabilityReason }

export function capabilityVerdict(id: CapabilityId, wire: ServerToolWire, model: CapabilityModel): Verdict;
/** 作者声明了，且裁决不是 no —— 适配器、摘要、估算只问这一个。 */
export function capabilitySent(id: CapabilityId, wire: ServerToolWire, model: CapabilityModel): boolean;
```

裁决顺序固定，写一次：

1. 模型类型不符 → `no / model-type`
2. 先决能力不成立 → `no / requires`
3. 平台画像点了名 → 按画像：`yes / measured` 或 `no / platform-ignores` / `no / family`
4. 画像没说话：`native` → 族在缺省表里则 `yes / protocol`，否则 `no / family`；
   `private` → 有主机的平台 `no / platform-unlisted`，无主机的中继 `unknown / relay`
5. `modelGate` 最后过一遍（温度 × 思考类目）

`CapabilityReason` 是一个封闭的联合类型，**句子只在语言文件里**，两种语言各一份——与 `ThemeReasonCode` 同一个做法，
理由也相同：原因要能被测试断言，措辞要能被改而不动逻辑。现在抽屉里的 `declNotOnRoute`、各条 hint 里手写的
「仅千问平台」之类，都收成 `aiConfig.capReason.<code>`，带 `{platform}` / `{route}` 参数。

### 2.4 抽屉的三态，一条规则

| 裁决 | 作者已声明 | 抽屉 |
| --- | --- | --- |
| `yes` | — | 显示，正常 hint |
| `unknown` | — | 显示，附「此平台未实测」注（今天服务端工具已有这个样式） |
| `no` | 是 | 显示，标「已声明，不发送」+ 原因（今天 PDF / 视频 / 服务端工具各自实现了一遍） |
| `no` | 否 | 不显示 |

「已声明的授权留在行上、只是不发送」是既有不变量（channel-model-route-plan §7 第 4 条），本文不改，只是让它对每个能力都成立，
而不是只对想起来要这么写的那几个成立。抽屉里用一个 `useCapability(id)`（或等价的纯函数）返回 `{ show, sends, note }`，
`Fold open={…}` 里不再出现 `family`。

## 3. 怎样保证不再长回去

三道闸，按便宜到贵：

1. **矩阵快照测试**（`capabilities.test.ts`）。对 `PLATFORM_IDS × 四族 × CapabilityId` 生成一张裁决表，钉成快照。
   任何一次画像或规则的改动，都会在 diff 里显出「哪几格变了」——评审看的是一张表，不是五个文件里的五个条件。
2. **一致性测试**。对每个能力、每个平台：`capabilitySent` 为假 ⇒ 适配器的 body 与 `modelSummary` 里都没有这个字段；为真 ⇒ 都有。
   写成对登记表的**遍历**，所以新增一行能力自动被覆盖，不需要记得补测试。
3. **源码扫描守卫**（放 `src/lib/__tests__/`，与 `storeSelectorFreshObjects.test.ts` 同类）。
   `ModelDrawer.tsx`、`modelSummary.ts`、`videoInput.ts`、`AgentChat.tsx`、`SubAgentsPane.tsx` 里 `family === "` 的出现次数只许降、不许升（棘轮）。
   适配器、`reasoning.ts`、`jsonMode.ts` 的 body 整形分支、`platforms.ts`、`capabilities.ts` 在白名单里——**按族决定 body 形状是对的，按族决定能力有无才是要关掉的**。

## 4. 分期（每期一个 PR，各自可合、可停）

| 期 | 内容 | 行为变化 |
| --- | --- | --- |
| **C0** | `capabilities.ts` + `capabilityVerdict`；先收四个输入能力（PDF、高分辨率、视频、fps）；画像三字段迁进 `capabilities` 槽；旧函数（`wireReadsPdf` 等）留成一行转调，调用点不动。矩阵快照在**迁移前后必须逐格相同**——这就是「纯重构」的证明。 | 无 |
| **C1** | 调用点改问 `capabilitySent` / `useCapability`：抽屉、`openai.ts`、`modelSummary.ts`、`videoInput.ts`、`readsPdf`、会话面。删旧函数。一致性测试上线。 | 无 |
| **C2** | 收采样与输出：温度、输出详细度、翻译格式、结构化输出的选项集、强制 tool_choice。原因码与 i18n 归并。 | 仅措辞 |
| **C3** | 源码扫描棘轮上线，起点 = C2 合并后的实际计数。 | 无 |
| **C4**（**搁置**，§7；待办见 [`issues/video-capability-per-platform.md`](../issues/video-capability-per-platform.md)） | **第一次行为变化**：`videoInput` 标为 `private`-like 的实测能力——点名千问 ×2 与智谱（均已实测）；中继 `unknown`；其余平台在实测前 `no`。需要先跑的样本：OpenAI 官方、DeepSeek、xAI、火山方舟的 ① 线路各一条 `video_url`，结果记入 `landscape.md` 新样本。已声明视频的旧行不受伤：落在 `no` 上的按 §2.4 显示「已声明，不发送」。 | 有，需实测 |
| ~~**C5**（可选）~~（**取消**：已并入 C0，§7） | 服务端工具的裁决出口并到 `capabilityVerdict` 之下（拼法表留在原处）。只有当 C0–C4 证明这个形状顺手时才做。 | 无 |

C0–C3 不需要 key、不改行为，可以连续做；C4 依赖实测，单独决定。

## 5. 明确不做

- **不把画像做成作者可编辑的配置。** 「这个平台收不收这个字段」是实测事实，不是偏好；作者能改的是模型行上的**声明**，
  那一层已经有了。让作者改画像等于把 G12 交给每个作者各自重犯一次。
- **不为每家平台写适配器子类。** provider-layering §4 的结论不变：运行时一族一个适配器，「某一家」是数据。本文是把这条从
  「URL、鉴权、服务端工具」推到「所有能力判定」。
- **不动思考类目。** `THINKING_CATEGORIES` 已经是一张按族登记的表，`categoriesForFamily` 读的是数据。它与本表并列，不合并——
  类目是「怎么拼」，不是「有没有」。
- **不动图像区。** 方言 / 路由 / 尺寸是图像模型自己的一张表（`image.ts` / `defaultImageCaps`），提问者只有图像管线一个，没有「四处各算一遍」的问题。
- **不做自动探测能力。** 视频、PDF 这类能力探一次要花真钱、真文件（`videoInput.ts` 注释里写过原因）。探测维与配置层的关系仍是
  provider-layering §7 的未决项，本文不借机解决。

## 6. 待决

1. **`unknown` 发不发？** 本文取「发」——与服务端工具今天的行为一致（中继上的 `web_search` 标未知但照发），也与
   `qwenVisionParams` 对无主机中继的现行缺省一致。反方理由是「没测过就别发私有字段」；但中继背后多半就是点了名的那几家，
   拦下等于让 New API 上的千问用户失去高分辨率。抽屉的「未实测」注是折中。
2. **OrcaRouter 算中继还是算平台？** 它有主机、有画像，按规则 4 私有能力会是 `no`。它背后若转发千问，高分辨率就该是 `unknown`。
   需要一条实测，或者给画像加一个 `relay: true` 标记取代 `hosts.length === 0` 这个间接判据——后者更诚实，倾向于在 C0 里就这么做。
3. **C4 之前，视频在未实测平台上显示什么？** C0–C3 保持现状（按族放行）以守住「无行为变化」；是否提前给这些平台挂「未实测」注，等 C4 的样本出来再定。

## 7. 决定与 C0 实施记录（2026-09-19）

作者看过 §1–§6 后定了三件事，C0 按它们做，与上文有出入处以本节为准：

1. **C0–C3 照做。**
2. **C4（视频按平台）搁置。** 视频仍按族放行（`videoInput` 在规则表里是 `native`、只有 ① 族），没有平台格。
   待决 3 随之搁置。
3. **服务端工具不是 C5 的可选项，而是表的一部分。** 理由是作者给的：哪个工具能用是**平台 + 模型 id** 的事实，
   与其它能力同一性质。所以表的形状定为 **平台 × 协议族 × 能力，第三轴是模型 id**，服务端工具的 id 直接就是能力 id；
   §2.2 说的「`serverTools` 不并入」作废，C5 取消。拼法（同一个 id 在不同平台拼成什么 body）仍在 `serverTools.ts`——
   表只回答有无，不回答怎么写。

### 7.1 落成的形状（`src/lib/ai/capabilities.ts`）

- `CAPABILITY_RULES: Record<CapabilityId, …>`——协议一侧。`Record` 是故意的：新增一个能力 id，没有规则行就编译不过。
- `PLATFORM_CAPABILITIES: Record<PlatformId, …>`——平台一侧，`families[族 | "all"][能力] = true | false | 模型 id 正则组`。
  `true` = 实测可用；`false` = 实测不收或收了无效；正则组 = 只对点名的模型 id 可用（千问的代码解释器）。
  **不写 = 不知道**，落到规则缺省；`false` 只留给实测过的否定。
- `capabilityVerdict(id, wire, { modelId?, type? })` → `{ status, reason }`。顺序：模型类型 → 先决能力 → **平台格（实测永远赢）** →
  规则的族 → 规则缺省。与 §2.3 的出入：族检查挪到了平台格之后，因为有两个实测格落在规则缺省的族之外
  （千问 ① 族的 `enable_search`、火山方舟 Plan ④ 族的 `document` 块）；让格子先说话，就不需要为它们各写一条例外。
- 待决 2 按倾向做了：`relay: true` 是平台格上的显式标记（New API、自定义），取代 `hosts.length === 0` 这个间接判据。
  OrcaRouter 有主机、没标 `relay`，私有能力仍是 `no`——与迁移前相同，要改需一条实测。
- 待决 1 取「`unknown` 照发」，与迁移前的行为一致。

### 7.2 「纯重构」的证明

分两笔提交。第一笔只新增 `capabilities.ts` 和一个等价测试：在 16 平台 × 7 个 `ApiStandard` × 全部能力 × 8 个模型 id
（4480 余格）上，与当时仍在的 `serverToolStatus` / `wireReadsPdf` / `wireTakesQwenVisionParams` /
`wireIgnoresForcedToolChoice` / `wireHasServerTools` / `canReadVideo` 逐格比对，全部相同。第二笔才把这些函数改成对表的
一行转调、删掉画像里的 `serverTools` / `pdfFamilies` / `forcedToolChoice` / `qwenVisionParams` 四个字段和
`NATIVE_SERVER_TOOLS`，并把已成同义反复的等价测试换成 §3 的第一道闸。

### 7.3 第一道闸落成的样子

§3 说的「矩阵快照」没有用 vitest 的 snapshot（本仓库不用它），而是照 `AGENTS.md` 的套路：
[`capability-matrix.md`](capability-matrix.md) 是表的渲染结果，`capabilities.test.ts` 断言文件与渲染一致。好处是矩阵同时是一份
**人能读的文档**——「智谱上到底有哪些能力」不必读代码。另加一条**防泄漏**测试，它遍历规则表而不是点名：
任何 `private` 能力，在有主机且没有格子的平台上必须是 `no`，在中继上不得好于 `unknown`。明天新增的私有字段自动被罩住。

### 7.4 C0 没做的

- 调用点没动（C1）：`wireReadsPdf` 等旧名字还在，只是不再自己算（唯一的例外见 §7.5 第 3 条）；`canReadVideo` 仍是自己的族判断（它的签名里没有平台，改它就是改调用点）。
- `CapabilityReason` 的句子还没进语言文件（C2）；四个类型暂未导出，因为 `exportReach.test.ts` 不许没有第二个使用者的导出，C1 的调用点会用到它们。
- 表目前只到「平台 × 族 × 模型 id → 有无」。按模型 id 给**能力**（而不只是预填）下结论——比如智谱只有 glm-5.3-flash / flashx 读 PDF——
  形状上已经能写（一个正则组），但那是行为变化，且对没见过的新 id 该判 `no` 还是 `unknown` 需要先定，留到 C1 之后单独提。

### 7.5 审查修正（2026-09-19，同一个 PR）

对 C0 的一轮代码审查提了七条，全部在合并前修掉。值得记下的是它们的**同一个成因**：把散落的判据收成一张表的时候，
又顺手抄出了新的副本。

1. **模型类型抄了一份、抄的时候就漏了 `video`。** `capabilities.ts` 自己声明了一个类型列表，而 `configDb.ts` 早有 `ModelType`。改为类型导入。
2. **服务端工具的 id 抄了第三份**（`platforms.ts` 里给 `wireHasServerTools` 用）。新增一个工具 id 而漏了它，抽屉的区段就折着不开。
   改为 `capabilities.ts` 里一个 `Record<ServerToolId, true>`——漏写编译不过——并加一条测试钉住它与 `SERVER_TOOL_IDS` 相同。
3. **表里分开的两格，转调时又并成了一格。** `vlHighResolution` 与 `videoFps` 是两个能力、各有格子，但旧名字 `wireTakesQwenVisionParams`
   只读前者，fps 的三个提问者（`sentVideoFps`、摘要、抽屉）都跟着它走——哪天两格不同，矩阵文档与线上就静默不一致。
   拆成 `wireTakesVlHighResolution` / `wireTakesVideoFps`，各读各的格。这是 C0 里唯一动了调用点的地方；今天两格相同，行为不变。
4. **防泄漏测试对中继整个跳过。** 没标 `relay` 的私有能力（`web_extractor`、代码解释器）在 New API / 自定义上从未被断言为 `no`。
   改为逐格算出期望值：没有格子 ⇒ `no`，除非平台是中继、规则标了 `relay`、族在规则内、先决能力成立 ⇒ `unknown`。
5. **`requires` 是无保护的递归。** 规则表里写出一个环，就是抽屉和适配器里的栈溢出。加一条遍历规则表的无环测试。
6. **矩阵文档的章节顺序靠对象键顺序。** 整理规则表的行序会把整份文档重排，淹没真正变了的那一格。`CAPABILITY_IDS` 改为显式列出，测试保证齐全。
7. **§2–§4 的旧设计原地没有标注。** 已在各处加上指向本节的标记。

## 8. C1–C3 实施记录（2026-09-19）

**三期合成一个 PR、分三笔提交。** §4 原定每期一个 PR；但本仓库不叠 PR（CI 只对指向 `main` 的 PR 跑），而 PR 由作者合并，
三期串行开要等三轮合并。三期都不改行为，每笔提交各自能过全部门禁，评审时按提交看即可。

### 8.1 C1：调用点直接问表

- **删掉了全部转调函数**：`platforms.ts` 的 `serverToolStatus` / `wireHasServerTools` / `dashscopeRunsCodeInterpreter` /
  `wireReadsPdf` / `wireIgnoresForcedToolChoice` / `wireTakesVlHighResolution` / `wireTakesVideoFps`，`serverTools.ts` 的
  `supportsServerTools` / `supportsServerToolFor`。调用点（`openai.ts`、`modelSummary.ts`、`videoInput.ts`、`configDb.readsPdf`、
  `serverTools.ts` 自身、模型抽屉、渠道抽屉）一律问 `hasCapability(id, wire, { modelId?, type? })` 或 `capabilityVerdict`。
  「这条线有没有任何服务端工具」是唯一的聚合问题，收成 `capabilities.ts` 里的 `hasAnyServerTool`。
- **`canReadVideo` 的第二个参数从 `ApiStandard` 改成渠道**，读 `videoInput` 格。今天 `videoInput` 只有族缺省、没有平台格，
  所以行为不变；但 C4 一旦给平台写格子，聊天面与 `agentStore` 不必再改——它们本来就只看得到 standard，看不到平台。
- **抽屉的三个视觉开关带上模型类型问表**（`{ type: form.type }`），不再在表外再乘一个 `canSeeImages`：类型门槛本来就是规则行的
  `modelTypes`，fps 对视频的依赖本来就是 `requires`。
- **没有做 `capabilitySent` / `useCapability`**（§2.3、§2.4 的设想）。每个能力的「作者声明」形状不同（布尔、数组、fps 数值），
  而每个提问者手里本来就拿着自己那一个；做一个统一的 `capabilitySent` 需要再登记一张「声明怎么读」的表，那是又一份要保持同步的副本——
  正是 §7.5 那七条的成因。「声明 && `hasCapability`」是一个 `&&`，留在调用点。
- 被删函数的测试没有删：挪进 `capabilities.test.ts`，改成对表提问，每一格原样保留（它们都是有人花钱测出来的）。

### 8.2 第二道闸：一致性测试（`capabilityConsistency.test.ts`）

对 16 个平台 × 各自的线路 × 全部能力 × 三个模型 id，把**真正动手的地方**拿来问：适配器的请求体、「将发送」摘要、
聊天面的视频闸（`canReadVideo` / `sentVideoFps`）、PDF 的 `readsPdf`。判据是**观察**而不是复述：带声明构造一次、不带声明构造一次，
两者不同 = 发出去了；必须与 `hasCapability` 相同。

- 适配器的请求体在 `fetch` 处截获，不发网络请求。
- `PROBES` 是 `Record<CapabilityId, …>`：新增一个能力，不写它由谁执行就编译不过。
- 它也会抓到**反方向**的错：给某个族写了平台格，而那个族的适配器根本不读这个能力（例如给 Anthropic 线写 `forcedToolChoice: false`，
  而 `anthropic.ts` 没有这道闸），测试会报「表说不发，请求体照发」。
- 验过它会报：临时去掉 `openai.ts` 里高分辨率的闸，官方 OpenAI 的 Chat 线立刻三格报错。

### 8.3 C2：采样与输出收进表，原因码进语言文件

- **四个新能力**，都是 `native`：`temperature`（四族；Anthropic 上思考开着时 `no / thinking`——规则行的 `thinkingOff`）、
  `textVerbosity`（只有 Responses 族）、`translateFormat`（Chat 族，只对文本模型）、`structuredOutput`（Anthropic 以外三族有 JSON 模式）。
  `forcedToolChoice` 在 C0 已经进表。
- **`supportsTemperature` 删掉**，Anthropic 适配器、摘要、抽屉都问 `temperature` 格。裁决带上**解析后的**思考类目；
  类目不传就不查（与其它模型字段同一个约定），所以提问者必须先 `resolveThinkingCategory`——三个提问者本来就是这么拿到类目的。
- **抽屉里「有没有这个控件」一律问表**：一个 `can(id, model?)` 包住当前线路；`family` 只剩下选拼法和措辞
  （结构化输出三族的说明文字不同、服务端工具按族的「为什么」），这些是「怎么说」，不是「有没有」（§3 的白名单原则）。
- **结构化输出的强度不进表。** 表只回答「有没有 JSON 模式」；自动档抬升到 `json_schema`、被 400 过的降档，仍是 `jsonMode.ts` 的事——
  那是按族与按端点学来的拼法，不是能力有无。
- **`translateFormat` 在一致性测试里没有提问者**（探针返回空，写明是故意的）：这个声明不改任何请求体，它把模型从选择器里拿出来交给
  `lib/translate`，守门的是抽屉保存时的清除，纯函数测试看不到。
- **原因码的句子只在语言文件里**：`aiConfig.capReason.<code>`，两种语言各一份，`capabilities.test.ts` 保证每个码都有句子
  （与 `ThemeReasonCode` 同一个做法）。`CAPABILITY_REASONS` 是有序常量，原因码的类型从它推出来。
- **没有把抽屉里既有的「不发送」提示改成原因码句子。** 那几句（PDF 的 `declNotOnRoute`、服务端工具的三句）带着线路名、平台名、模型 id，
  读起来比通用的原因句更具体；原因句先用在矩阵的悬停说明上。要统一时，把它们换成 `capReason` 加参数即可，无需改逻辑。

### 8.4 可用性矩阵成为标准组件（作者提议，2026-09-19）

作者看了服务端工具那张「各线路可用性」矩阵（channel-model-route-plan 屏 05），提议做成标准的提示组件：只要这个模型的能力在表里，就用同一个样子说明。
落成 `panes/CapabilityMatrix.tsx`：

- 行 = 能力，列 = 渠道的线路，格 = `capabilityVerdict`，**悬停显示原因句**。矩阵的每一格都是表的裁决，所以它说不出适配器不做的事。
- 用在能力声明的三组末尾：服务端工具（原来那张，改用组件）、**输入**（PDF / 高分辨率 / 视频 / 抽帧频率）、**输出格式**（结构化输出 / 回答详略）。
- 何时出现：渠道有**不止一条线路**时（一条线路没有可比的，开关自己的提示就够了）；某一行出现的条件是**某条线路有它，或模型声明了它**——
  声明了而当前线路说不出来的，照样在矩阵里看得见、能去关掉。
- 采样温度没进矩阵：它随每条线路各自的思考类目变，矩阵需要逐线路的类目，而抽屉里只有当前线路的表单值；等有需要再接。

### 8.5 C3：源码扫描棘轮（`src/lib/__tests__/capabilityFamilyRatchet.test.ts`）

§3 设想的是在五个点名的文件里数 `family === "`。落成时反过来：**扫整个 `src/`**，点名的是**允许**按族分支的文件——
这样一个新文件长出按族判断的能力有无，不需要有人记得把它加进名单才会被抓到。

- 数的是去掉注释后「拿族和字面量比」的写法（`family === "…"`、`familyOf(…) !== "…"`、`x.family === "…"`）；`switch (family)` 不数，那几乎总是在选拼法。
- **`WIRE_SHAPE` 白名单**：`capabilities.ts`、`platforms.ts`、`routes.ts`、`urls.ts`、`reasoning.ts`、`jsonMode.ts`、`serverTools.ts`、
  两个探测模块、`image.ts`——都是在决定请求**长什么样**，每一条在测试里写了理由。适配器本身不按字面量比族（它们按 `familyOf` 分派），不必进名单。
- **`CEILING`**：其余文件的上限 = C2 之后的实际计数：`ModelDrawer.tsx` 6（结构化输出说明文字、图像模型 Gemini 方言预填、服务端工具「为什么」的措辞）、
  `modelSummary.ts` 5（按族拼字段名）、`ProviderDrawer.tsx` 3（Gemini 安全设置、ComfyUI 保存分支）。没列的文件上限是 0。
- **只许降**：数少了也失败，提示把上限改成新数，免得腾出来的名额被悄悄用掉。
- 拦下时的出路写在测试文件头注里：「有没有」去能力表加一行，调用点问 `hasCapability`；确实是在选拼法或措辞，才把上限加一并写明哪一处。

### 8.6 审查修正（2026-09-19，同一个 PR）

1. **温度：没给思考类目时判「思考开着」。** C2 的写法是「类目不传就不查」，于是没有模型信息时 Anthropic 各线路的温度都是 `yes`——
   矩阵文档照此把它们标成了 ✓，而一个没声明类目的 Anthropic 模型默认是在思考的，适配器会丢掉这个字段。
   旧的 `supportsTemperature(standard)` 在同样情况下答 false。改为：`thinkingOff` 规则把缺席的类目当作族的默认类目，
   而四族的默认类目都在思考（`defaultCategoryId`），所以只有显式的 `off` 才放行。忘了解析类目的调用方拿到的是安全的答案。
   矩阵文档里 Anthropic 线路的温度格随之从 ✓ 变成 ·。
2. **棘轮去注释改为按词法。** 原来用正则删 `/* … */`，字符串里的 `/*`（`FacetEditModal.tsx` 就有 `${id}/*.md`）会让它一直吞到下一个
   `*/`，把中间的真代码一起删掉——少数、放过违规；而行尾的 `//` 注释没删，又会多数。现在按词法走一遍：去注释、清空字符串与模板文字的内容、
   `${…}` 里照常扫，并有一条测试钉住这几种写法。

### 8.7 模型 id 轴：没登记的 id 判「未实测」，不判「不能」（作者决定，2026-09-19）

**问题。** 一个平台格可以是按模型 id 的正则（目前只有百炼的代码解释器）。原来的语义是「匹配的能发，其余一律不能」：
新模型上线后，在有人实测并把它加进正则之前，抽屉里连开关都没有。

**决定。** 服务端工具是跟着平台走的——平台有这个工具，模型不在已知范围内，就给开关、标「未实测」、照发。
所以模型格拆成两组：

- `runs`：实测能跑的 id → `yes / measured`。
- `refuses`：实测被拒（400、`Unsupported model`）或**静默忽略**的 id → `no / model`，优先于 `runs`。
- 两组都没有的 id → `unknown / model-unlisted`：开关照给，抽屉写「{{model}} 没实测过：开了照发，可能被拒绝，也可能被静默忽略」，
  矩阵格是 `?`。
- 模型 id 为空（还没填）→ 不查这一轴，和不传一样。

**为什么不怕静默忽略。** 百炼 ① 面按 id 判断，原本的理由是静默忽略：作者看不到报错，只拿到一个没算过的答案。
这个风险没有消失，而是交给了两处：实测过静默忽略的 id（`qwen-max`、`qwen3-max-preview`、`qwen3.5-omni-plus`）进 `refuses`，
仍然没有开关；没实测的 id 在开关旁明说「可能被静默忽略」，作者自己决定开不开。拿「不能」当默认，代价是每出一个新模型，
能力就得先等一次实测和一次发版。

**`refuses` 只收实测过的。** 3.8 一代在 ① 面测了 flash、max、27b 三个，全部 400，所以按整代收（`^qwen3\.8-`）。
其余只按具体 id 收。和 `runs` 共用前缀的 id（`qwen3-vl-plus` 在 ① 面）没有实测就是「未实测」，不因前缀相近就判「不能」。
整代收的例外也按此理解：`qwen3.8-livetranslate-flash-realtime` 在 ① 面被 `^qwen3\.8-` 判「不能」，是因为整代实测都拒，
不是因为前缀；它在 ② 面没有实测，仍是「未实测」。

**名单从哪来（作者补充，2026-09-19）。** 各平台会在官网文档里公布特性支持的模型列表，这份列表就是 `runs` 的正常来源：
官方文档更新、列出了新模型，就把它补进 `runs`，不必先等一次实测。补的时候在代码注释里写明文档地址和查阅日期。
两条例外：

- **实测优先于文档。** 文档和实测对不上时，以实测为准，比如代码解释器的「qwen3-max 需开思考」和「与 function calling 互斥」，
  实测都只部分成立（landscape.md §7 第六个样本）。
- **`refuses` 只收实测。** 文档没列出某个模型不等于它不支持——这正是「未实测」要表达的，写进 `refuses` 就又回到了原来一律判「不能」的做法。

文档还没更新前，新模型停在「未实测」：有开关，照发，抽屉里注明。这一段时间正是这条规则要覆盖的。

### 8.8 删掉 `supportsThinkingLevel`（2026-09-19）

C1 之后它已经没有调用方了：四族都有思考参数的拼法，它对当时的三族恒为 true，对 Responses 反而答 false，留着只会被误用。
思考档位该不该显示，看的是解析出的思考类目（`resolveThinkingCategory`）有没有档位，不看协议族。
`anthropic-plan.md` §4.4、`gemini-plan.md` 里提到它的是当时的实施记录，不改。

### 8.9 严格 JSON 档成为线路能力 `jsonSchema`（模型端点审查，2026-09-19）

`jsonMode.ts` 的自动抬升原来按**协议族**判：① / ② / ③ 族上，模型 id 在 `KNOWN_JSON_SCHEMA` 名单里就发 `json_schema`。
注释写的是「中转站要靠声明才给严格档」，代码却对任何 `openai_compat` 地址都抬升，因为 compat 和官方同属一族。
智谱是反例：它收下 `json_schema` 回 200 然后静默无视，吐出代码块包着的中文字段名（landscape.md §7 第十四个样本）。
可同样是 GLM，在百炼上 `json_schema` 是生效的（qianwen-compat-plan.md P7）。所以「收不收严格档」是**线路**的事，
不是模型 id 的事，理应进能力表。

- 新增能力 `jsonSchema`：`native`，`assumed: "unknown"`，依赖 `structuredOutput`。平台格：OpenAI 两族、Google ③、
  百炼 ①、xAI ② 记 `true`（都有实测或官方明列）；智谱记 `false`；其余平台和中转停在「未实测」。
- **自动档只在格子为 `yes` 时抬升**。「未实测」照发作者的声明，但不替作者抬升，这正是原注释的本意。
- **作者声明了 `json_schema`、格子是 `no`**：降一档发 `json_object`。那个 200 回来的是散文，不是作者要的 schema。
  模型抽屉在这种线路上不再给严格档选项，已经存了的声明仍显示，免得选中项凭空消失。
- 代价：百炼 ② 上的 Qwen 原来被自动抬升，现在停在 `json_object`，因为 ② 面没人测过。这是少一次升级，
  不是一次失败。实测之后补格子即可。

### 8.10 中转站上按模型 id 挑出不支持的：只写 `refuses` 的模型格（2026-09-23）

> 本节写于「上游」一词确定之前：文中「上游渠道」「Kiro 渠道」的「渠道」指中转站背后的后端，即 §8.11 的「上游」；界面上「渠道」只指 provider 行。

**问题。** 中转站（`newapi` / `custom`）没有可识别的主机，同一台背后挂着许多上游渠道，渠道只在模型 id 里看得出来
（`[特价kiro量]claude-opus-5`）。第十五个样本实测了 Kiro 渠道的 Claude：Chat 面的 `file` 片段被丢、`response_format`
被无视，两面的强制 `tool_choice` 在流式下被无视，Anth 面单独挂着的 `web_search_*` 会被中转站劫持成一页搜索结果
（landscape.md §7 第十五个样本）。这些都是 200 不报错，学习型的降级（`toolChoice.ts`、`jsonMode` 的备忘）学不到。

§8.7 的模型格有 `runs` 就有「名单外 = 未实测」这一档。放到中转站上，会把同一台上**别的所有模型**从 `protocol` 拉成
`model-unlisted`，而它们既没测过、也不该因为 Kiro 被连累。

**决定。** `runs` 改成可选。**只写 `refuses` 的格子只负责点名**：名单里的 id 判 `no / model`，名单外的 id（和空 id）
照规则走，跟这个格子不存在一样。矩阵文档里这种格子也标「按模型」。

- 格子写在 `newapi` 和 `custom` 两个平台上：New API 中转站不手选平台时落在 `custom`，渠道又都写在 id 里。
- 一起修了几个查表时不带模型 id 的调用点，否则矩阵说「不发」，适配器照发，一致性测试会抓出来：
  `openai.ts` 的强制工具、`anthropic.ts` 新增的强制工具判断（④ 族以前没问过这一格）、`anthropicServerTools`、
  `readsPdf`、`jsonMode.resolveStructuredOutput`。`structuredOutput` 判 `no` 时 JSON 模式降到 `off`，只发提示语，
  和 ④ 族一样。一致性测试的模型 id 加了一个 Kiro 的。
- **Sonnet 按推断收进 `refuses`（作者决定，2026-09-23）**。这是 §8.7「`refuses` 只收实测」的例外，理由是：
  这些缺口都在中转站的翻译层，不在模型；两款 Opus 在每一项上表现都一样。所以正则按渠道 × 家族写，
  规则是同时带 `kiro` 和 `claude`，不按具体型号。别的渠道（`[anti]` 等）没测，不在里面。
- **后续（2026-09-23）**：同一台中转站又测了 CC / anti / AWSb 三个渠道（landscape.md §7 第十六个样本）。① 面「`response_format` 被丢」
  其实是这台 New API 的转换，所有渠道都一样，不是 Kiro 特有；anti / AWSb 也各有该点名的格子。这些还没进表，原因和做法见
  [`issues/relay-claude-channel-gating.md`](../issues/relay-claude-channel-gating.md)。
- **再后续（同日）**：按渠道点名改成了上游画像，`KIRO_CLAUDE` 迁成按 id 推断出的 Kiro 上游，见 §8.11。

### 8.11 中转站上游画像：上游由作者声明，能力由内置画像决定（2026-09-23）

**问题。** §8.10 的 `KIRO_CLAUDE` 按 id 正则点名，只点得了 Kiro：第十六个样本在同一台中转站上又测了 CC、anti、AWSb，
同一个 `claude-opus-4-6` 在四个上游下 PDF、强制工具、联网搜索各不相同（CC 真搜、anti 丢、Bedrock 发了就 400、Kiro 劫持）。
可这些上游只写在站主自定的前缀里（`[CC量]`、`[anti量]`、`[正向AWSb量1]`），写进正则就是为一台中转站硬编码
（[`issues/relay-claude-channel-gating.md`](../issues/relay-claude-channel-gating.md)）。

**决定。** 把「这个模型背后是哪个上游」做成独立的一轴，由**作者的数据**给出，能力由**代码里的内置画像**给出：

- **解析**（`src/lib/ai/relayUpstream.ts`）：模型手选（`models.relay_upstream`，含 `"none"`）→ 渠道的「前缀 → 上游」表
  （`providers.upstream_prefixes`，取最长的匹配前缀，不分大小写）→ id 里的**上游产品名**（`kiro`、`bedrock`）→ 无。
  只在中转站平台（`newapi` / `custom`）上有意义。`connOptions()` 解析成某个上游或 `"none"`，恒有值——适配器不会再按 id
  推断盖过作者的表；手搭请求（live 探测、端点探测）缺省时才按 id 推断，行为与 §8.10 相同。
- **画像**（`capabilities.ts` 的 `UPSTREAM_CAPABILITIES`）：kiro / cc / anti / bedrock / official 五种，每格只写
  `true` / `false`、只写样本里测过的；作用域只有 Claude（`/claude/`，别的模型没测过）。`familyVerdict` 在 thinking 之后、
  平台格之前查它，原因码 `upstream`。official 没有格子（当天 502 没测到），选它只表示「这个前缀分过类」。
- **`KIRO_CLAUDE` 迁移**成「按 id 推断出 Kiro」：五格逐格保持原状态（测试锁住），原因码从 `model` 变成 `upstream`。
  推断 `bedrock` 是唯一的新行为（作者决定）：id 同时含 `bedrock` 与 `claude` 的模型 ④ 面不再发 `web_search`（Bedrock 没有
  服务端工具，发了整条请求 400），④ PDF 可发。
- **界面**：渠道抽屉的「上游」前缀表（列出这个渠道的模型里还没配的 `[…]` 前缀）；模型抽屉的「上游」分节（跟随渠道 /
  手选 / 不按上游，说明来源，并写一句该上游实测到而能力格表达不了的事——anti 不思考、Kiro 不看输出上限等，只告知不改发送）；
  可用性矩阵里原因为 `upstream` 的格子带「上游」小标。界面上「渠道」指 provider 行，中转站背后的叫「上游」
  （[`terminology.md`](../reference/terminology.md)）。

**为什么不是别的做法。**

| 做法 | 为什么没选 |
| --- | --- |
| 按站主缩写写正则（§8.10 的推广） | 缩写是一台中转站的私事；换一台就漏点名，也可能误中别家的同名缩写 |
| 只在模型行上选上游 | 同一上游的模型多时要逐个选；保留为覆盖 |
| 作者自定义画像、逐格开关 | 作者填的格子没有实测依据，矩阵却会说「实测」；UI 与数据也大得多（作者决定不做） |
| 把上游做成合成平台（`relay-kiro`） | 平台是渠道级的，上游是模型级的；`PlatformId` 会按上游数翻倍 |

**有意留下的。**

- **New API 的 ①→④ 转换层**（① 面 `response_format` 被丢、`reasoning_effort: "max"` = 不想，四个上游都一样）不进画像：
  它属于平台，不属于上游，但只有一台 New API 的样本。唯一的例外是 Kiro 画像保留 ① `structuredOutput: false`——那是
  `KIRO_CLAUDE` 原来就判的，注释写明了真实归属，等转换层那一步落地时挪走。
- **CC 的强制工具**两面都不写：不带思考时全调用，带 adaptive 思考时 3/8、4/8。判「不发」会丢掉能调用的那部分，
  结构化任务的回退链本来就兜得住「没调」。
- **合并渠道**（`channelMerge.ts`）时两张前缀表取并集，同一前缀以保留的一行为准；同 id 模型折叠时保留被吸收行手选的上游。
