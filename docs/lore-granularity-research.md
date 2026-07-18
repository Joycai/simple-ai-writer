# Lore 条目细粒度激活优化调研

> 问题：写作时引用 lore 条目只能整条加载。以"角色"条目为例，角色有多套服装/形象，但当前场景只穿一套，激活整条 lore 会浪费大量上下文。有哪些优化方向？
>
> 调研日期：2026-07-18 · 针对项目：simple-ai-writer

---

## 一、问题本质

这个问题在业界有明确的名字：**条目粒度问题（entry granularity）/ context bloat**。根源是把"实体（entity）"当作了"注入单位（injection unit）"——但实体是按*认知*组织的（一个角色一个条目），而上下文应该按*当前场景相关性*组织。两者天然错位：

- 角色的 5 套服装、3 段背景故事、10 条人际关系，任何一个时刻只有 1~2 项与正文相关；
- 整条注入时，无关部分不仅浪费 token，还会**干扰模型**——模型可能让角色穿错衣服（因为 5 套服装都在上下文里，权重相近）。

所以这不只是省 token 的问题，也是**生成质量**问题：注入越精准，模型越不容易"串戏"。

### simple-ai-writer 当前实现的对照

看了当前代码（`src/lib/context/rag.ts`、`src/lib/lore/entity.ts`）：

- 激活：name/aliases 关键词匹配，最多 3 个实体（`MAX_AUTO_LORE_CARDS`）；
- 注入：读整个 `index.md`，**硬截断到约 600 token**（`MAX_LORE_CHARS`）；
- 实体目录下已支持多个 `.md` 文件（`mdFiles`），但注入时只用 `index.md`。

当前的硬截断比"整条加载"更危险：如果"冬装"写在文件后半部分，截断后模型根本看不到，而作者以为它在上下文里。**好消息是：实体=目录、目录内多 md 文件的结构，天然为下面的"子条目"方案铺好了路。**

---

## 二、业界的六个优化方向

### 方向 1：子条目拆分（Sub-entries / Facets）——最主流、性价比最高

把一个实体拆成"**核心卡 + 多个侧面（facet）**"，激活单位从实体降到侧面：

```
lore/characters/alice/
├── index.md          # 核心卡：一句话人设 + 不变的关键特征（始终随实体激活）
├── outfit-casual.md  # facet: 便装   keys: [便装, 日常, 咖啡馆]
├── outfit-armor.md   # facet: 战甲   keys: [战斗, 战甲, 出征]
├── backstory.md      # facet: 背景   keys: [童年, 过去, 回忆]
└── relations.md      # facet: 关系   keys: [鲍勃, 妹妹]
```

facet 的激活条件是 **AND 逻辑**：`实体名匹配 AND facet 关键词匹配`。这正是 SillyTavern World Info 的 **selective + secondary keys** 机制——主键（角色名）命中后，还要求辅助键（"战斗/战甲"）也出现才注入该条目，支持 AND ANY / AND ALL / NOT ANY / NOT ALL 四种逻辑。Character Card V3 规范也把它标准化成了 `selective + secondary_keys` 字段，另有 `@@additional_keys` / `@@exclude_keys` 装饰器做增补和排除。

针对"同一时间只穿一套服装"，SillyTavern 还有一个精确对口的机制：**互斥组（Inclusion Group）**——同组的多个条目即使同时触发，也只按优先级/权重选**一个**注入。把所有服装 facet 放进 `outfit` 互斥组，就从机制上保证了上下文里永远只有一套服装。

社区最佳实践（Evernever 的 lorebook 指南）也印证这个方向："**One entry, one topic**"，单条目建议 50–150 词，并假设任意时刻只有 2–4 个条目活跃。

**落地成本：低。** 对 simple-ai-writer 来说只需：facet 文件加 frontmatter（`keys`, `priority`, `group`），注入逻辑从"读 index.md 截断"改为"index.md 的核心段 + 命中的 facet 文件"。目录结构不用动。

### 方向 2：状态跟踪（State Tracking）——对"当前穿哪套"最根治

服装本质上不是静态设定，而是**随剧情演进的可变状态**。关键词匹配永远有失灵的时候（正文里没提"战甲"两个字，但角色确实穿着战甲）。根治方案是给故事维护一个显式的状态层：

```yaml
# story-state.yaml（随写作进度更新）
alice:
  current_outfit: outfit-armor   # 指向 facet
  location: 北境要塞
  injuries: [左臂轻伤]
```

注入时：核心卡 + `current_outfit` 指向的那一个 facet，其余服装 facet 一律不载入。状态由作者在 UI 上手动切换（一个下拉框），或在每章结束时让 LLM 从正文中抽取更新（成本低，可离线做）。

业界的弱化版对应物：SillyTavern 的 **timed effects**（sticky：激活后持续 N 条消息；cooldown：冷却期内不再触发），以及 CCv3 的 `@@keep_activate_after_match` / `@@dont_activate_after_match`——都是在用"时间持续性"近似"状态"。写作软件比聊天软件更适合做显式状态，因为章节/场景边界是天然的状态切换点。

**落地成本：中。** 需要新增状态数据结构 + UI；但它与 simple-ai-writer 已有的 `memory.ts`（故事记忆压缩）方向一致，可以合并设计成"故事状态 = 记忆摘要 + 实体状态表"。

### 方向 3：分层注入（Summary → Detail 递进）

默认只注入轻量层，需要时才升级到重量层：

- **L0 一句话 summary**（frontmatter 里已有！）：所有被提及的实体都注入，成本几乎为零；
- **L1 核心卡**：主关键词强命中的实体注入；
- **L2 facet 细节**：secondary keys 命中才注入。

NovelAI Lorebook 的 **category/subcontext + token budget + reserved tokens** 就是这个思路的预算化版本：每个条目/分类有 token 预算上限和优先级，预算紧张时先砍低优先级细节、保高优先级核心。SillyTavern 同样有全局 WI 预算（上下文百分比）+ 条目排序，超预算时按顺序丢弃。

**落地成本：低。** simple-ai-writer 的 `summary` 字段已存在，只是没被分层利用——现在是"3 个实体各塞 600 token"，可以改成"命中的实体先各给 summary（约 30 token），剩余预算按匹配强度分给核心卡和 facet"。

### 方向 4：语义检索 / 段落级向量化（RAG chunking)

把实体的所有 md 按段落 chunk 化做 embedding，写作时用光标前文本检索 top-k **段落**（而非文件）。SillyTavern 的 Vector Storage / Data Bank 走的就是这条路：向量化后"条目通过语义相似度激活，绕过关键词匹配"，能解决"正文没出现关键词但语义相关"的召回问题。

优缺点都很明显：召回好、无需作者写关键词；但**非确定性**（作者不能精确预测哪段会进上下文）、需要 embedding 依赖（本地模型或 API）、对"服装互斥"这类逻辑约束无能为力（语义上"便装"和"战甲"都与"爱丽丝换衣服"相关）。业界共识是把它作为关键词机制的**补充**而非替代。

**落地成本：中高。** rag.ts 的注释表明 V1 刻意选择了"无 embeddings"，这个方向适合放后期。

### 方向 5：LLM 即时蒸馏(Just-in-time Distillation）

激活实体后，不直接注入原文，而是让一个便宜快模型带着当前场景做一次抽取："给定接下来要写的场景 X，从爱丽丝的完整档案中抽出相关信息，≤150 字"。结果可按 `(实体, 场景摘要)` 缓存。

这是效果上限最高的方案（真正做到"场景定制的条目视图"），但每次生成多一跳调用，有延迟和成本；且蒸馏可能丢掉作者认为必须逐字保留的措辞。适合作为高级选项而不是默认路径。

### 方向 6：激活条件工程（时机/位置控制）——锦上添花

CCv3 装饰器体系展示了大量"何时/何处注入"的控制原语：`@@activate_only_after`（N 条消息后才可激活）、`@@scan_depth`（只扫描最近 N 条）、`@@depth` / `@@position`（注入位置）、`@@ignore_on_max_context`（上下文吃紧时先丢弃）、概率触发等。NovelAI 则有 key-relative insertion（条目插在关键词出现的位置附近）和 cascading activation（条目内容可再触发其他条目，即递归激活——对应"核心卡里提到'战甲'从而带出战甲 facet"的联动）。

这些不解决粒度问题本身，但拆分成子条目后，这套控制原语决定了体验上限。**递归激活尤其值得做**：作者只需在核心卡里自然提及"她常穿的战甲"，战甲 facet 就能被级联带出，无需正文命中。

---

## 三、方案对比

| 方向 | 省 token 效果 | 确定性 | 作者负担 | 实现成本 | 建议 |
|---|---|---|---|---|---|
| 1 子条目 + 互斥组 | ★★★★ | 高（可预测） | 中（要拆条目、写 keys） | 低 | **首选，先做** |
| 2 状态跟踪 | ★★★★★ | 最高 | 低（一个下拉框） | 中 | 第二步，与 memory 合并设计 |
| 3 分层注入 + 预算 | ★★★ | 高 | 低（summary 已有） | 低 | 与方向 1 同批做 |
| 4 向量段落检索 | ★★★★ | 低 | 最低 | 中高 | 后期补充召回 |
| 5 LLM 即时蒸馏 | ★★★★★ | 中 | 最低 | 中（延迟/费用） | 高级选项 |
| 6 激活条件工程 | ★★ | 高 | 高（配置多） | 低~中 | 按需渐进加 |

## 四、对 simple-ai-writer 的落地路线建议

**第一阶段（改动最小、收益最大）：facet 文件约定 + 分层预算**

实体目录里的每个非 index 的 `.md` 变成一个可独立激活的 facet，用 frontmatter 声明激活条件：

```markdown
---
facet: 战甲形象
keys: [战甲, 战斗, 出征, 北境]
group: outfit        # 同组互斥，只注入一个
priority: 2
---
银白色全身板甲，肩甲刻有家纹……
```

注入规则改为：`实体命中 → 注入 index.md 核心段（≤200 token）→ 对每个 facet 做 secondary-key 匹配 → 同 group 只取 priority 最高的一个 → 总预算内按优先级填充`。`readEntity` 已经在收集 `mdFiles`，改动集中在 rag.ts 的 `loadEntitySummary` 一处。同时把 600 token 硬截断换成"核心段落边界截断"，避免截出半句话。

**第二阶段：实体状态表。** 在项目级维护 `state.md`（角色当前服装/位置/伤势），编辑器侧栏给每个 group 一个当前值选择器；"继续写作"时状态指向的 facet 无条件注入并跳过关键词匹配。可选：章节完成后用 LLM 自动更新状态。

**第三阶段：递归激活 + 向量补充召回。** 核心卡内容命中其他 facet 的 keys 时级联激活（限一层，防爆炸）；再视需求引入段落级 embedding 作为关键词未命中时的兜底。

一句话总结：**先把"注入单位"从实体降到 facet（方向 1+3，改动小、确定性高），再把"选哪个 facet"从关键词猜测升级为显式状态（方向 2），最后用向量检索和递归激活补召回长尾（方向 4+6）。**

---

## 参考来源

- [SillyTavern World Info 官方文档](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)（selective/secondary keys、inclusion group、timed effects、token budget、向量化条目）
- [World Info Encyclopedia（社区百科）](https://rentry.co/world-info-encyclopedia)
- [Character Card V3 规范](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)（decorators：@@activate_only_after、@@scan_depth、@@exclude_keys 等）
- [NovelAI Lorebook 文档](https://docs.novelai.net/en/text/lorebook/)（token budget、reserved tokens、cascading activation、category/subcontext）
- [Evernever: AI Lorebook Guide — Organize Worldbuilding Without Context Bloat](https://evernever.org/playbook/lorebooks)（one entry one topic、50–150 词、2–4 活跃条目假设）
- [SillyTavern Vector Storage / RAG 系统（DeepWiki）](https://deepwiki.com/SillyTavern/SillyTavern/6.3-vector-storage-and-rag-system)
- [SillyTavern Data Bank (RAG)](https://docs.sillytavern.app/usage/core-concepts/data-bank/)
- [Sillycard: character_book 字段解析](https://sillycard-web.pages.dev/blog/st-fields-04-character-book)
