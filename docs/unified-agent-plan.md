# 统一 AI Agent 系统方案（v0.3.0 · feat/unified-agent）

> 目标：把目前分散在编辑器侧与 lore 侧的所有 AI 功能，统一到**一套 agent runtime**
> 上运行 —— 该 runtime 提供 tool loop，模型可以按需发现 lore、阅读章节文本、
> 更新记忆/设定，或依据文本与用户输入修改、新增 lore。
>
> 交互形态采用**两阶段演进**：第一阶段统一底层 runtime（现有 UI 入口全部改为
> 调用它，行为对用户基本无感）；第二阶段把 AiRail 长成对话式统一助手。

## 1. 现状盘点：分散的 AI 入口

当前共约 9 处各自组装 prompt、各自管理流式状态的 AI 调用点：

| 入口 | 位置 | 形态 | 上下文来源 |
| --- | --- | --- | --- |
| 续写 continue | `stores/aiTaskStore.ts` | **agent loop**（唯一） | 预算化 RAG 注入 + 4 个只读工具 |
| 润色/改写/总结/自定义 | `stores/aiTaskStore.ts` | 单次流式 | 预算化 RAG 注入 |
| 前情记忆摘要 | `stores/memoryStore.ts` | 单次流式 | 分段正文切片 |
| Lore 新建实体提取 | `lib/lore/generator.ts` | 单次流式（JSON 结构化） | 描述 + @附件 |
| Lore 特征拆解 | `lib/lore/splitter.ts` | 单次流式 | 实体全文 |
| 图集 AI 描述 | `lib/lore/vision.ts` | 单次流式（多模态） | 单张图片 |
| LoreImproveModal / LoreMetaImproveModal / FacetAiAssistantModal | `components/lore/` | 单次流式（共用 `lib/lore/aiTask.ts` 引擎） | 实体文件 + @附件 |

问题不在功能而在结构：每个入口都要重复解决模型解析、apiKey、流式累积、
错误/中止、写回等同一批事，且互相看不见 —— lore 改进器不知道章节正文，
续写 agent 只读不能写，记忆更新只能被动整段重算。

## 2. 可行性判断

**可行，且已有一半地基。** `lib/agent/loop.ts` 已经是一个与 provider 无关的
tool loop：OpenAI/Gemini 双协议、多模态工具结果、`trimHistory` 上下文裁剪、
最后一轮强制成文、Gemini thought-signature 保留。`lib/agent/tools.ts` 已有
工具定义/执行器模式与路径包含校验（`isPathWithin`）。缺的是：

1. loop 与「续写」语义解耦（多轮会话、任务无关的收尾策略）；
2. **写类工具**及其安全机制（备份 / diff 审批）；
3. 工具注册表 + 按任务裁剪的 toolset；
4. 一个统一的会话状态层（替代各入口自管的流式状态）。

主要风险与对策见 §6。

## 3. 目标架构

```
components/（各入口 UI，第一阶段保持外观不变）
      │  以 TaskPreset 启动
      ▼
stores/agentStore.ts        ← 会话历史、工具时间线、待审批队列、usage
      │
      ▼
lib/agent/runtime.ts        ← 泛化自 loop.ts：多轮 tool loop、流式、裁剪
lib/agent/registry.ts       ← 工具注册表（定义 + 执行器 + 权限级别）
lib/agent/presets.ts        ← TaskPreset：每个旧入口 = 一份预设
lib/agent/approval.ts       ← 写操作分级：自动+备份 / diff 审批
      │
      ▼
lib/ai/*（streamCompletion 等，不动） · lib/context/*（预算化注入，保留作 seed）
```

### 3.1 AgentRuntime（`runtime.ts`，从 `loop.ts` 泛化）

- 输入从「systemPrompt + initialUserMessage」泛化为**会话消息数组**，
  支持追加用户轮次（第二阶段聊天 UI 的基础）；
- `MAX_ROUNDS`、收尾策略（强制成文 / 允许以工具调用结束）由 preset 决定；
- 工具执行改为查 registry，不再 switch 硬编码；
- 保留：`trimHistory`、`inputCeilingTokens`、多模态图片回传、abort 语义。

### 3.2 工具注册表（`registry.ts`）

| 工具 | 读/写 | 说明 |
| --- | --- | --- |
| `list_lore_entities` / `read_lore_entity` / `list_files` / `read_file` | 读 | 现有四件套，原样迁入 |
| `search_text` | 读 | 在 writing/ 内全文检索（lore 提取、一致性检查都需要） |
| `read_memory` | 读 | 读当前文档的前情记忆 |
| `create_lore_entity` | 写·L1 | 新建实体（name/category/summary/content），落盘前校验 frontmatter |
| `update_lore_file` | 写·L1 | 改写实体的 index.md 或特征 md（整文件替换，沿用 splitter 的逐字校验思路） |
| `update_memory` | 写·L1 | 更新前情记忆段落（走 memory.ts 的分段协议，不允许破坏元数据注释） |
| `propose_edit` | 写·L2 | 对 writing/ 正文提出修改（range + 新文本），**只产生提案不落盘** |

**安全分级（已定）：**

- **L1（lore / 记忆）：自动应用 + 自动备份。** 每次写入前把原文件备份到
  `.ai-writer/backups/<时间戳>/…`（复用 LoreSplitModal 的备份模式），
  写入后触发 loreStore 重扫 / memoryStore 刷新。
- **L2（正文）：必须审批。** `propose_edit` 只把 diff 放进 agentStore 的
  待审批队列，UI 渲染 diff，用户确认后才写入 editorStore/磁盘；拒绝则把
  「用户拒绝+理由」作为 tool result 回给模型。
- 所有路径参数一律过 `isPathWithin`，写类工具额外限定在
  `.ai-writer/lore/`、`.ai-writer/memory/`、`writing/` 白名单内。

### 3.3 TaskPreset（`presets.ts`）

每个现有入口收敛为一份预设：

```ts
interface TaskPreset {
  id: string;                    // continue / polish / lore-improve / …
  systemPrompt(ctx): string;
  seedContext(ctx): Promise<string>;  // 预算化 RAG 注入结果（沿用 lib/context）
  tools: ToolId[];               // 按任务裁剪，如 polish 可以为空数组
  finishPolicy: "force-text" | "allow-tool-end";
  output: "stream-to-panel" | "structured-json" | "write-back";
}
```

要点：**预算化注入不废除**。lore 的三层预算注入（loreSelect）继续作为
seed 提供低延迟的第一轮上下文，工具用于按需补读 —— 两者互补而非替代。
`tools: []` 的 preset 就退化为今天的单次流式，弱模型兜底也靠它（§6）。

### 3.4 agentStore

替代 aiTaskStore 中「流式状态」职责（selection 等编辑器耦合状态留在原处）：
会话消息、toolSteps 时间线、pendingApprovals、usage 累计、abortController。
一次只跑一个会话（与现状一致），第二阶段再考虑会话持久化。

## 4. 分阶段 PR 计划

| PR | 内容 | 验收 |
| --- | --- | --- |
| **PR1** | 抽出 runtime + registry（纯搬运，只读工具），`continue` 迁移到 preset 跑通 | 续写行为与 main 完全一致；loop.ts 删除 |
| **PR2** | agentStore + 备份/审批基础设施 + L1 写工具（lore/记忆）；`update_memory` 接入 | 手动触发 agent 改 lore 有备份、UI 即时刷新 |
| **PR3** | lore 侧入口迁移：Improve / MetaImprove / FacetAssistant / Generator / Splitter 全部改为 preset 调 runtime；`lib/lore/aiTask.ts` 流式部分退役 | 各 modal 外观不变，底层单一路径 |
| **PR4** | `propose_edit` + diff 审批 UI；润色/改写/总结获得可选 agent 模式；一致性检查用 `search_text` 重做 | 正文修改全部走审批 |
| **PR5**（第二阶段） | AiRail 对话式统一助手：自由输入 + 预设变快捷指令、会话内多轮追问 | 聊天式交互上线 |

PR1–PR2 合并前不动任何用户可见行为，随时可发版；0.3.0 在 PR4 末尾对外。

## 5. 需要同步调整的现有模块

- `aiTaskStore.runTask`：收缩为「解析 preset → 调 runtime」的薄壳；
  预算规划（planContextBudget）挪进 preset 的 seedContext。
- `lib/lore/aiTask.ts`：附件收集（@-引用）保留，改造成 seedContext 的素材源；
  `streamLoreTask` 删除。
- `memory.ts`：暴露「重写单段」的安全写入 API 供 `update_memory` 调用，
  保持分段哈希协议不被模型输出破坏。
- i18n：新增工具时间线、审批 diff、备份提示文案（中文用「特征」术语）。
- 测试：registry 的路径白名单/参数校验单测；runtime 多轮会话单测
  （mock streamCompletion）；preset 快照测试。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 任意 OpenAI 兼容端点上的弱模型 tool-use 不可靠 | preset 均保留 `tools: []` 单次流式回退；provider 探测（providerProbe）可加 tool-call 能力探测 |
| 工具循环放大 token 成本/延迟 | 沿用 MAX_ROUNDS + inputCeilingTokens；seed 注入减少补读轮数；usage 面板继续按任务记账 |
| 模型写坏 lore 文件（frontmatter / 分段协议） | 写工具走结构化参数 + 落盘前 schema 校验，坏输出直接以错误回给模型重试；L1 自动备份可回滚 |
| 大重构回归 | 分 5 个 PR，PR1/PR3 是行为等价迁移，CI（tsc + vitest + build）逐个把关 |

## 7. 本分支进度

- 基于 main@69e5a13 建分支 `feat/unified-agent`；
- 四份版本清单同步升至 0.3.0（bump-version 脚本）；
- 本方案文档；
- **PR1 完成**：`loop.ts` → `runtime.ts`（按 preset 驱动的通用 tool loop）+
  `registry.ts`（工具注册表，含 access 分级字段）+ `presets.ts`（CONTINUE_PRESET）+
  `events.ts`（结构化执行事件）。`aiTaskStore` 改为薄壳调用 runtime。
- **执行日志（提前自 §4 计划）**：所有任务（含单次流式）发 run-start / round-start /
  tool-step / context-trimmed / run-done / run-error 事件，AiPanel 的
  AgentLogSection 实时渲染为可折叠日志（工具调用、轮次、token 估算、时间戳）。
  注意：preset 的 systemPrompt/seedContext 收拢仍属 PR2/PR3 范围，当前仍在
  aiTaskStore 内组装。
- **PR2 完成**：`backup.ts`（写前自动快照进 `.ai-writer/backups/`，backup 失败即写入
  失败）+ `writeTools.ts` 四个新工具：`read_memory`（读段落索引）与三个 L1 写工具
  `create_lore_entity` / `update_lore_file` / `update_memory`（access: write-auto）。
  结构校验先于落盘：index.md 必须保住 frontmatter 且禁改 category、facet 文件必须
  仍是合法 facet、images.md 拒写、记忆只能走 `rewriteMemorySegment`（memory.ts 新
  API，段范围/哈希协议不可破坏）。ToolContext 增加 onLoreChanged/onMemoryChanged
  刷新钩子（aiTaskStore 已接 loreStore.scanProject / memoryStore.loadForActiveFile）。
  注意：尚无 preset 引用写工具——它们在 PR3 的 lore 入口迁移中获得第一个 UI 触发点；
  独立的 agentStore 推迟到需要审批队列/多轮会话时（PR4/PR5）再立。
- **PR3 完成（范围有两处有意收窄）**：
  - `run.ts` 新增 `runLoreAgentTask`（Model/Provider → runAgent 的 UI 入口），
    `streamLoreTask` 从 aiTask.ts 删除；执行日志抽成共享组件
    `components/ai/AgentLog.tsx`（AiPanel 与 lore modal 共用）。
  - **LoreImproveModal / FacetAiAssistantModal**：迁到 LORE_IMPROVE / FACET_ASSIST
    preset（带 list/read lore 只读工具，maxRounds 4），modal 内嵌执行日志——AI 改设定
    前可以自己查阅其它条目了。审阅后保存的 UX 不变（modal 落盘），未直接用
    update_lore_file 自动写：审阅式 modal 里静默改盘反而降低可控性。
  - **generator.ts / splitter.ts**：等价迁到 runtime 单发 preset（runtime 新增
    extraBody 透传支持 JSON mode）。JSON mode 与 tool 调用在多家 provider 上互斥，
    故这两个暂不带工具；升级路径是 PR4/PR5 的「强制 tool 调用做结构化输出」。
  - **LoreMetaImproveModal 未迁**：它自有「强制 tool_choice + JSON 回退」结构化输出
    流程，等 runtime 原生支持结构化输出（同上）再收编。
  - 写工具（create_lore_entity 等）的 UI 触发点顺延至 PR5 对话式助手——那才是
    「agent 自主改 lore」的自然场景；modal 场景保留人审。
