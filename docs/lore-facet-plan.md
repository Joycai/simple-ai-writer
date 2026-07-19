# Lore 特征（Facet）系统落地方案

> 目标：把 lore 的注入粒度从"实体"降到"特征（facet）"，配合分层预算注入（调研方向 1+3），并用 AI 自动拆解已有条目降低作者负担。涵盖数据模型、注入引擎、AI 拆解流程、UI 更新、迁移兼容与分期计划。
>
> 日期：2026-07-18 · 基于当前 main 分支代码阅读（rag.ts / entity.ts / model.ts / loreStore / LoreDetail / LoreImproveModal / AiPanel / generator.ts）

---

## 0. 设计总览

```
写作正文 "爱丽丝披上战甲，走向北境城墙…"
                │
                ▼  关键词匹配（实体级，现有 matchEntities）
        ┌───────────────┐
        │ 实体: 爱丽丝    │  命中 name/aliases
        └───────┬───────┘
                │  facet 二级匹配（新增）
     ┌──────────┼─────────────┬──────────────┐
     ▼          ▼             ▼              ▼
 index.md   outfit-armor.md  outfit-casual.md  backstory.md
 核心卡      keys:[战甲,战斗]  keys:[便装,日常]   keys:[童年,回忆]
 (必注入)    ✅ 命中           ❌ 未命中          ❌ 未命中
                │
                ▼  同 group=outfit 互斥，只保留 1 个
        ┌──────────────────────────────┐
        │ 注入 = summary + 核心卡 + 战甲 │ ≈ 250 token（原来 600 token 截断）
        └──────────────────────────────┘
```

核心决策（与现有代码的咬合点）：

1. **facet = 实体目录里的普通 `.md` 文件**。`readEntity` 已经在收集 `mdFiles`，LoreDetail 已把非 index 的 md 显示为"附件"——只需给这些文件加 frontmatter 就升级为可激活特征，**目录结构零改动，老项目零迁移**。
2. **index.md 保持为唯一必注入的"核心卡"**，frontmatter `summary` 作为 L0 层。
3. 注入逻辑抽出独立模块 `src/lib/context/loreSelect.ts`，`rag.ts` 只调用它——现有 `loadEntitySummary()` 整体废弃替换，`assembleContext` 其余层不动。
4. AI 拆解复用 `LoreImproveModal` 的三阶段交互（input → generating → review）和 `generator.ts` 的 JSON-mode 解析套路，新增 `LoreSplitModal`。

---

## 1. 数据模型

### 1.1 Facet 文件格式

实体目录下除 `index.md`、`images.md` 之外的 `.md` 文件，**带有 `facet` frontmatter 的**被识别为特征：

```markdown
---
facet: 战甲形象            # 特征显示名（必填，作为识别标志）
keys: [战甲, 板甲, 出征, 北境, 战斗]   # 二级关键词；空数组 = 永不自动激活（仅手动 pin）
group: outfit             # 互斥组，可选；同组同时命中只注入一个
priority: 2               # 组内/预算内排序，数字大者优先，默认 0
mode: auto                # auto(默认) | always(实体命中即注入) | manual(仅手动 pin)
---
银白色全身板甲，肩甲刻有霜狼家纹，行动时有轻微的金属摩擦声……
```

没有 `facet` 字段的 md 文件维持现状（惰性附件，不参与注入）——这就是向后兼容的全部代价。

### 1.2 类型扩展（`src/lib/lore/model.ts`）

```ts
export interface LoreFacet {
  file: string;            // 文件名，如 "outfit-armor.md"
  title: string;           // frontmatter.facet
  keys: string[];
  group: string | null;
  priority: number;
  mode: "auto" | "always" | "manual";
  charCount: number;       // 正文长度，供 UI 显示 token 估算
}

export interface LoreEntity {
  // …现有字段不变…
  coreBody: string;        // index.md 正文（去 frontmatter），扫描时缓存
  facets: LoreFacet[];     // 新增
}
```

### 1.3 扫描（`src/lib/lore/entity.ts` `readEntity`）

- 对每个非保留 md 读取并 `parseFrontmatter`，有 `facet` 字段则解析为 `LoreFacet`；
- **frontmatter 在扫描期解析，正文注入时按需读取**——避免大项目扫描时把所有特征正文常驻内存（`charCount` 在扫描时顺带记录）；
- `index.md` 正文剥离 frontmatter 后存入 `coreBody`（核心卡本来就该短，常驻无压力）。

> 扫描成本评估：每实体多 N 次小文件读取。现有 `scanLore` 本来就逐目录 readDir + 读 index.md + fileExists 探测 avatar，量级不变。若后续项目出现数百实体，再在 loreStore 加 mtime 缓存，本期不做。

---

## 2. 注入引擎（`src/lib/context/loreSelect.ts`，新文件）

### 2.1 接口

```ts
export interface LoreSelection {
  text: string;                 // 拼好的【设定资料】内容
  report: LoreActivationReport; // 给 UI 的透明度报告
}

export interface LoreActivationReport {
  entities: {
    name: string; dirPath: string;
    reason: "auto" | "pinned";
    layers: { kind: "summary" | "core" | "facet"; title?: string; file?: string;
              chars: number; matchedKeys?: string[]; groupWinner?: boolean }[];
    droppedFacets: { file: string; title: string;
                     reason: "no-key" | "group-lost" | "budget" | "manual-only" }[];
  }[];
  budgetChars: number;
  usedChars: number;
}

export async function selectLore(
  matchTarget: string,          // selection + 文末 500 字（沿用现有逻辑）
  loreIndex: LoreIndex,
  pins: LorePin[],              // 见 §4.3，兼容旧 string dirPath
  budgetChars: number,          // 来自设置，默认 600 token × 3 chars
): Promise<LoreSelection>
```

### 2.2 选择算法（分层填充）

1. **实体匹配**：沿用 `matchEntities` 的 name/aliases 子串匹配（对 CJK 天然友好），上限从 3 提到 **5**——facet 化后单实体成本大幅下降，容得下更多实体（上限与预算双重约束，先到为准）。手动 pin 的实体排最前。
2. **逐实体分层**：
   - L0 `summary`（frontmatter，一句话）——所有命中实体必得；
   - L1 `coreBody`——按实体顺序注入，超预算则段落边界截断（替换现有 600 token 硬截断；截断时在报告里标注）；
   - L2 facets——对每个 `mode:auto` 的 facet 做二级匹配：`keys` 任一出现在 matchTarget 中（不区分大小写子串，与实体匹配同规则）；`mode:always` 直接视为命中；`mode:manual` 只认 pin。
3. **互斥组裁决**：同实体同 `group` 的命中 facet，只保留 `priority` 最高者（同分取文件名字典序，保证确定性）；被 pin 的 facet 无条件赢得其组。落选者进 `droppedFacets(group-lost)`。
4. **预算填充**：按 `实体顺序 × priority` 将命中 facet 依次装入剩余预算；装不下的进 `droppedFacets(budget)`，**绝不截断 facet 正文**（facet 本身就短，截断只会产生半句话；装不下就整个不装，报告说明）。
5. **输出格式**（`bundleToMessages` 的【设定资料】块内）：

```
◆ 爱丽丝（人物）
摘要：北境骑士团副团长，寡言，重誓约。
[核心] ……index.md 正文……
[战甲形象] 银白色全身板甲，肩甲刻有霜狼家纹……
```

### 2.3 rag.ts 接线

- `assembleContext` 中 `loadEntitySummary`/`matchEntities` 相关段替换为一次 `selectLore` 调用；
- `ContextBundle` 增加 `loreReport: LoreActivationReport`，随 bundle 返回给 `aiTaskStore`，供 UI 展示（§4.4）；
- 常量 `MAX_LORE_CHARS` 改为从 appStore 设置读取（默认仍 600 token 等效值）。

### 2.4 单元测试（vitest，放 `src/lib/__tests__/loreSelect.test.ts`）

覆盖：二级 AND 匹配命中/未命中；`always/manual` 模式；同组互斥按 priority、同分稳定性、pin 压倒 priority；预算耗尽时 facet 整体丢弃且报告正确；无 facet 实体行为与现状等价（回归保护）；CJK 关键词子串匹配。

---

## 3. AI 自动拆解（LoreSplitModal）

### 3.1 交互流程（复用 LoreImproveModal 的骨架与样式）

```
入口：LoreDetail 顶栏 "拆分特征" 按钮（Scissors/Sparkles 图标，与"AI 改进"并列）
      仅当 index.md 正文超过 ~400 字 或 无任何 facet 时高亮提示

Phase 1 input     显示当前 index.md 全文 + 可选拆解指令输入框
                  （如"服装单独拆组、背景故事合成一条"）
Phase 2 generating 流式输出（沿用 streamCompletion + onProgress）
Phase 3 review    结构化审阅界面（本功能的核心，见 3.3）
Apply             写文件 + 备份 + rescan
```

### 3.2 模型调用（`src/lib/lore/splitter.ts`，新文件，套 generator.ts 模式）

JSON mode 输出 schema：

```json
{
  "core": "保留在核心卡的正文（人设一句话展开、不变特征）",
  "facets": [
    {
      "filename": "outfit-armor.md",
      "title": "战甲形象",
      "group": "outfit",
      "priority": 2,
      "keys": ["战甲", "板甲", "出征", "战斗"],
      "content": "原文中关于战甲的段落，逐字保留"
    }
  ],
  "notes": "拆解说明，给作者看的一句话"
}
```

系统提示词要点（新增 `ai.instructions.loreSplit` 到 i18n 两语言 + prompts 默认模板）：

- **逐字搬运，禁止改写**——拆解是重组不是润色，作者的措辞就是设定本身；
- 核心卡保留：身份、外貌不变项、性格内核、说话方式，目标 ≤300 字；
- 互斥识别：服装/形态/阶段性状态等"同一时刻只有一个为真"的内容 → 同 `group`；
- keys 生成规则：包含正文中的指称词 + 场景触发词 + 常见同义词（如"战甲"补"铠甲、披挂"），4–8 个；避免过泛词（"她""走"）——每个 key 要过"出现即几乎必相关"测试；
- 无法归类的内容一律留在 core，宁可不拆不可拆丢。

### 3.3 Review 界面（作者可编辑，这是"降低负担但保留控制"的关键）

- 左列：原 index.md（只读，已被抽走的段落淡色标出——按 facet.content 在原文中定位）；
- 右列：核心卡预览 + facet 卡片列表。每张卡片可编辑：标题、keys（chip 输入）、group（下拉，已有组 + 新建）、priority、正文（MarkdownTextarea）；
- 每张卡片可"取消拆分"（内容退回核心卡）；keys 为空时卡片标黄警告；
- 底部显示拆分前后对比：`原条目 ~620 token 全量注入 → 拆分后典型场景 ~180 token`（用 charCount/3 估算），让收益可见；
- Apply 执行：原 `index.md` 快照到 `.ai-writer/backups/<entity>-<timestamp>.md` → 写 facet 文件 → 重写 index.md（新 core，frontmatter 原样保留）→ `scanProject()` 刷新。任何一步失败即中止且不动 index.md（先写 facet 后写 index，保证最坏情况只是多出未引用文件）。

### 3.4 批量拆解（延后）

LoreWall 可加"检测可拆分条目"入口（正文超长且无 facet 的实体列表，逐个走单实体流程）。不做全自动批量 Apply——review 是质量底线。

---

## 4. UI 更新清单

### 4.1 LoreDetail（实体详情页）

- "概要" tab 中现有"附件文件"区改造为 **特征卡片区**：每个 facet 一张卡（标题、group 徽章、keys chips、~token 数、mode 图标）；无 frontmatter 的 md 显示为灰色"附件"，卡片上给"转为特征"按钮（弹出 frontmatter 表单预填）；
- "新建特征" 按钮：表单（标题/keys/group/mode）→ `createFacetFile()`；
- facet 卡点击 → 复用 loreStore `selectFile` 编辑路径，编辑器上方加 frontmatter 字段的表单化编辑条（避免作者手写 yaml）；
- 顶栏新增"拆分特征"入口（§3.1）。

### 4.2 组（group）的轻量呈现

不做独立的组管理页。组是 facet 上的一个字符串字段，UI 层面：同组卡片同色徽章；实体内已有组名作为下拉候选。够用即止。

### 4.3 AiPanel 的 pin 粒度升级

- `LorePicker` 从平铺复选列表升级为两级树：实体行（复选=pin 整实体，行为不变）+ 展开箭头 → facet 子行（复选=pin 单个 facet）；
- pin 存储格式：`dirPath`（整实体，兼容现有 localStorage 数据）与 `dirPath#facetFile`（新增）。`PINNED_LORE_KEY` 数据无需迁移；
- pin 单个 facet 隐含 pin 其实体核心卡（summary+core 必带，否则 facet 无主语）。

### 4.4 注入透明度（新增，分层机制的信任基础）

- AiPanel 任务卡片顶部增加可折叠的 **"本次注入设定"** 条：`selectLore` 的 report 渲染为 chips——`爱丽丝 ▸ 核心 + 战甲形象 (180tk)`；被丢弃项灰色显示原因（组内落选/超预算/未命中）；
- chips 点击跳转对应 lore 文件；
- 报告在任务开始时即可显示（assembleContext 先于请求完成），作者发现"注错了"可以立即 abort、调 pin 重跑。这个反馈回路是作者调 keys 的主要工具，优先级不低于拆解本身。

### 4.5 设置项（SettingsModal → AI）

- "设定资料 token 预算"（默认 600，滑条 200–2000）；
- "自动匹配实体上限"（默认 5）。

### 4.6 i18n

全部新 UI 文案进 `en.json` / `zh-CN.json`（facet 术语建议：中文"特征"，英文 "Facet"）。

---

## 5. 迁移与兼容

| 场景 | 行为 |
|---|---|
| 老实体（只有 index.md） | 与现状完全一致，仅截断策略从硬截断改为段落边界截断 |
| 目录里已有的无 frontmatter md | 惰性附件，不注入；UI 提供一键"转为特征" |
| 旧版 app 打开新项目 | facet 文件被当普通附件忽略，index.md 照常工作（核心卡自足性由拆解提示词保证：core 必须独立成立） |
| 旧 pin 数据（纯 dirPath） | 原样有效 = pin 整实体 |

无 schema 迁移、无一次性脚本。`docs/architecture.md`（RAG 节）与 `docs/workflows.md`（新增"添加/拆分特征"recipe）随 PR 更新。

---

## 6. 分期计划

**PR-1 引擎层（无 UI 变化，可独立合并）**
model.ts/entity.ts 类型与扫描扩展 → loreSelect.ts + 单测 → rag.ts 接线 + ContextBundle.loreReport。验收：现有项目行为不回归（无 facet 时输出与旧逻辑等价的内容）；手工构造 facet 项目验证 AND 匹配/互斥/预算。

**PR-2 Facet 管理 UI**
LoreDetail 特征卡片区、新建/编辑/转为特征、frontmatter 表单条。验收：不写一行 yaml 能完成 facet 全生命周期管理。

**PR-3 AI 拆解**
splitter.ts + LoreSplitModal（三阶段）+ 提示词 i18n + 备份机制。验收：600+ 字角色条目一次拆解 → review 微调 → Apply 后写作场景实测 token 下降且不串装。

**PR-4 Pin 粒度 + 透明度 + 设置**
LorePicker 两级树、注入报告 chips、预算设置。验收：pin 单个 facet 生效；报告与实际注入一致。

依赖链：PR-1 → {PR-2, PR-3, PR-4} 可并行。建议顺序 1→2→3→4：PR-2 先让手动路径闭环，PR-3 的 review 界面能复用 PR-2 的 facet 卡片组件。

---

## 7. 风险与对策

- **keys 质量决定体验**：facet 没命中（漏）比多注入（浪费）更伤——对策：拆解提示词强制补同义词；透明度报告让漏召回可见；`mode:always` 作为作者兜底。
- **拆解改写原文**：JSON mode 下模型有改写倾向——对策：提示词逐字要求 + review 左列淡色定位帮助作者肉眼比对 + 备份兜底。
- **互斥组误伤**（两套服装同场景都该出现，如换装描写）：对策：pin 可压倒互斥（pin 两个同组 facet 则都注入，报告标注）；
- **扫描性能**：见 §1.3，本期接受，预留 mtime 缓存位。
- **同名 group 跨实体**：group 作用域限定在实体内部，跨实体同名互不影响（实现上以 `dirPath+group` 为键）。

---

## 附：与调研报告的对应关系

本方案落实调研中的方向 1（子条目 + secondary keys + 互斥组，对标 SillyTavern selective/inclusion group）与方向 3（summary→core→facet 分层 + token 预算，对标 NovelAI category/budget），AI 拆解属于降低作者负担的配套（调研中"作者负担：中"的短板补偿）。方向 2（状态跟踪）的接口已预留：`mode` 字段与 pin 机制未来可由状态表驱动（状态指向的 facet 等价于程序化 pin），无需返工。
