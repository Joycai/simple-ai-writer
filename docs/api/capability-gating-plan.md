# 模型能力判定：一张登记表、一个裁决函数

> **状态：`partial`——C0 已实现（能力表 + 裁决函数 + 矩阵文档，行为逐格不变）；C1–C3 待做；C4（视频按平台）搁置。**
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

`serverTools` **不并入**：它带拼法（同一个 id 在不同平台是不同的 body），不只是有无。但它的裁决走同一个出口（§2.3），
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
| **C4** | **第一次行为变化**：`videoInput` 标为 `private`-like 的实测能力——点名千问 ×2 与智谱（均已实测）；中继 `unknown`；其余平台在实测前 `no`。需要先跑的样本：OpenAI 官方、DeepSeek、xAI、火山方舟的 ① 线路各一条 `video_url`，结果记入 `landscape.md` 新样本。已声明视频的旧行不受伤：落在 `no` 上的按 §2.4 显示「已声明，不发送」。 | 有，需实测 |
| **C5**（可选） | 服务端工具的裁决出口并到 `capabilityVerdict` 之下（拼法表留在原处）。只有当 C0–C4 证明这个形状顺手时才做。 | 无 |

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

- 调用点没动（C1）：`wireReadsPdf` 等旧名字还在，只是不再自己算；`canReadVideo` 仍是自己的族判断（它的签名里没有平台，改它就是改调用点）。
- `CapabilityReason` 的句子还没进语言文件（C2）；四个类型暂未导出，因为 `exportReach.test.ts` 不许没有第二个使用者的导出，C1 的调用点会用到它们。
- 表目前只到「平台 × 族 × 模型 id → 有无」。按模型 id 给**能力**（而不只是预填）下结论——比如智谱只有 glm-5.3-flash / flashx 读 PDF——
  形状上已经能写（一个正则组），但那是行为变化，且对没见过的新 id 该判 `no` 还是 `unknown` 需要先定，留到 C1 之后单独提。
