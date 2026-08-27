# 知识库条目类型系统落地方案

> **状态：第 1~4 期已实现**（槽位骨架 / 孤儿分类 / 创作侧接线 / UI 呈现）；
> 第 5 期 `subtypes` 按计划不做，见 §6。
>
> 目标：让条目在保持「主条目 + 特征 + 配图」三段结构不变的前提下**带上类型**，
> 由能力包声明；类型给出该类条目**应该有哪些面**（外貌 / 组织架构 / 人设图…），
> 用于创作侧的缺口提示与 AI 提示词；能力包下线时条目**降级**为普通条目而不是消失。
>
> 日期：2026-08-19 · 基于当前 main 分支代码阅读（profile/{model,resolve,active,file,store}.ts /
> lore/{model,entity,gallery,transfer}.ts / context/loreSelect.ts / agent/{registry,writeTools}.ts /
> components/lore/*）
>
> 相关：[`lore-facet-plan.md`](lore-facet-plan.md)（特征系统本体）·
> [`lore-granularity-research.md`](lore-granularity-research.md)（粒度调研）·
> [`architecture.md`](../../reference/architecture.md) → Capability packs / Facet-aware lore selection

---

## 0. 设计总览

```
能力包 novel 启用
      │  声明分类 characters，并给它一份 schema
      ▼
分类 characters（= .ai-writer/lore/characters/ 目录）
      │  slots:      外貌* / 装扮(互斥组 outfit) / 人物关系* / 往事 / 能力 / 说话方式(常驻)
      │  imageSlots: 人设图* / 表情 / 服装设定            （* = expected，缺了会提示）
      ▼
条目 爱丽丝/
      ├── index.md          主条目（不变）
      ├── outfit-armor.md   frontmatter 多一行 slot: outfit   ← 第 1 期加的全部字段
      ├── relations.md      slot: relations
      └── images.md         配图（第 4 期加 slot 行）

关掉 novel 包 →  schema 消失，slot 变成不认识的字符串
              →  条目、特征、配图全都照旧工作，注入行为分毫不动
              →  只是没有槽位分组、缺口提示和类型化提示词    ← 这就是「降级」
```

三个关键选择，理由分别在 §2 / §4 / §5：

1. **类型不是新的一根轴，而是「分类的 schema」**——分类本来就是单值、能力包声明的条目分类。
2. **slot 只影响创作、呈现和提示词，绝不参与注入**；槽位的默认值在**创建那一刻物化**进文件 frontmatter。
3. **降级只发生在读取侧，绝不回写磁盘**；能力包下线的分类作为「孤儿分类」继续被扫描出来。

---

## 1. 需求与现状

原始需求（作者提出，三条）：

1. 除通用条目外，启用某些能力包后出现**特定类型**的条目；这与现在的「分类」不同，分类更像 tag / 分组。
2. 条目本身仍是「主条目 + 特征 + 配图」，只是特定类型下某些特征归属于特定的项目（外貌、人物关系……）。
3. 某条目所依赖的能力包被关掉或迁移后，**自动降级**为普通标准条目。

现状里三件事需要先说清：

- **分类不是 tag**。它是 `.ai-writer/lore/<category>/` 的目录名，一个条目有且只有一个分类，
  改分类会真的搬目录（[`entity.ts` `saveEntityMetaAndBody`](../../../src/lib/lore/entity.ts)）。
  也就是说「单值 + 能力包声明」这两条它已经满足了。
- **特征已经足够表达「面」**，缺的只是「这一面是什么」——`LoreFacet` 有 keys/group/priority/mode，
  没有语义归类。
- **关掉能力包，条目现在会从 UI 里整个消失**（`scanLore` 只扫 `loreCategories()`）。
  [`WorkspacePane`](../../../src/components/settings/panes/WorkspacePane.tsx) 已经为此专门算了一个
  parked 计数告诉作者「数据停在那儿了」。需求 3 等于要求它从「停车」变成「还能用」。

---

## 2. 核心决策：类型 = 分类的 schema

分类升级为可带 schema：

```ts
interface ProfileCategory {
  id; labelZh; labelEn;
  slots?: FacetSlot[];       // 该类条目的特征槽位：外貌 / 组织架构 / 人物关系…
  imageSlots?: ImageSlot[];  // 该类条目的配图槽位：人设图 / 建筑图 / 概念图…
}
```

作者的两个例子都落在分类已经占的位置上，这是这个决策的直接依据：

| 例子 | 「类型」 | 「面」 |
|---|---|---|
| 小说：场景 / 人物 / 组织 | novel 包的 `world` / `characters` / `factions` | 外貌、位置、结构、组织架构、人设图、建筑图、概念图 = **槽位** |
| 项目：联系人 / 部门 / 项目 / 系统 | 一个新能力包的四个分类，`resolveWorkspace` 现在就能产出 | 负责人、上下游、接口清单… = **槽位** |

### 被否掉的方案

- **A. 在 frontmatter 里新开一个独立的 `type` 字段（与分类平行）。**
  否掉的理由：两套近乎平行的分类法要靠作者手动保持一致（`characters` 分类下 `type: 系统` 的条目谁说了算？），
  而每个生成 / 拆分 / 改进的 prompt 都得先决定用哪一个；`type` 还得自带一套校验与兜底，
  和 `isKnownCategory` / `fallbackCategoryId` 重复。
  它唯一真正的优势记录在这里，别以后重新发现：**独立字段改类型不用搬目录**，
  而挂在分类上时改类型 = `renamePath` + 重算 id，会让 `dirPath#facetFile` 形式的 pin
  和 `category/id` 形式的 `[[lore:…]]` 引用失效。这是**今天改分类已有的行为**，
  重新归类又是低频操作，不值得为它引入第二根轴。
- **B. 一个类型一个分类目录，并把类型写死在组件里。**
  否掉的理由：这正是能力包重构要消灭的东西——支持一种新写作应该是加数据，不是加分支。
- **C. 让 slot 在读取时参与解析 mode/priority（schema 驱动注入）。**
  否掉的理由见 §4：那样关掉一个能力包会**静默改变模型看到的上下文**，是最难查的一类回归；
  而且需求 3 的「降级」立刻从免费变成要写迁移。
- **D. 让「类型」多值化（真 tag）。** 分类是目录，做不到多值。
  如果以后真需要跨切面的自由归组，那是**第三样东西**（`index.md` frontmatter 里的 `tags`），
  和类型、分类都不要混为一谈；它不动存储布局，什么时候加都便宜。

### 留了口子但本期不做：`subtypes`

一个分类目录里确实要装多种类型时（`custom` 桶尤其），schema 可以再声明
`subtypes: [{ id, label, slots }]`。关键是它**长在分类 schema 内部**，
所以永远不可能和目录矛盾。等真有一个能力包需要它再加，见 §6 第 5 期。

---

## 3. 数据模型

### 3.1 槽位（`src/lib/profile/model.ts`）

```ts
export interface FacetSlot {
  /** 稳定 id，写进特征 frontmatter 的 `slot`，也会进工具 schema 的 enum。 */
  id: string;
  labelZh: string;
  labelEn: string;
  /** 这一面该写什么 —— 第 3 期进 AI 提示词清单。 */
  hintZh?: string;
  hintEn?: string;
  /** 这类条目通常都该有这一面：驱动「缺口」提示，不是硬校验。 */
  expected?: boolean;
  /** 新建这一面时**物化进 frontmatter** 的默认值（见 §4 不变量二）。 */
  defaults?: {
    mode?: "auto" | "always" | "manual";
    priority?: number;
    group?: string;
    keys?: string[];
  };
}

export interface ImageSlot { id; labelZh; labelEn; hintZh?; hintEn?; expected?; }
```

`defaults` 特意做成嵌套而不是平铺：平铺的 `mode` 会让人以为「槽位的注入方式」是运行时解析的，
嵌在 `defaults` 里，手写 profile.json 的人一眼就知道它只在创建时起作用。

校验（`parseCategory`）：slot id 复用 `CATEGORY_ID_RE`（它要作为未加引号的 YAML 标量和 JSON enum 值出现），
每分类 ≤ 12 个 slot / ≤ 8 个 imageSlot，hint ≤ 120 字，建议触发词 ≤ 8 条。
**空槽位列表不写 key**——`profile.test.ts` 里有 `toEqual({id,labelZh,labelEn})` 的精确比较，
更重要的是 profile.json 不该被塞进一堆 `"slots": []`。

profile.json **不升版本**：分类对象上的可选字段是纯增量，老版本的 `parseCategory`
会静默丢掉不认识的键（本来就是白名单构造），于是老版本读新文件 = 自动降级。
自定义包的回写也不用改——`saveProfileFile` 直接 `JSON.stringify` 解析后的包对象。

### 3.2 合并规则（`src/lib/profile/resolve.ts`）

多个包声明同一个分类（`factions` 同时被 novel 和 ttrpg 声明，`items`/`style`/`metrics` 也共享）时：

- **槽位按 id 取并集，首个声明者胜**（label、hint、defaults 全都取首个）——
  与分类标签现有的「首个声明者的 label 胜」同一口径，也符合「能力包是纯增量」。
- 合并时**必须复制数组再追加**：`{...cat}` 带过来的是内置包模块级单例的那个数组，
  直接 push 会把状态泄漏到别的项目里（`resolve.ts` 头注释的老规矩）。

### 3.3 特征的 `slot`（`src/lib/lore/model.ts` + `entity.ts`）

```markdown
---
facet: 战甲形象
slot: outfit          # ← 第 1 期加的全部字段；不认识的值 = 无归属，行为不变
keys: [战甲, 板甲, 出征]
group: outfit
priority: 2
mode: auto
---
```

- `LoreFacet.slot: string | null`——解析总会给出答案，不认识的值原样保留（**不清洗**，
  能力包切回来它就该还在）。
- `FacetMeta.slot?: string | null`——写入侧可选，老调用点一个字都不用改。
- 但**每个改写 meta 的路径都必须把它带过去**，否则「编辑一次特征就丢了归属」：
  第 1 期已经补了 `FacetEditModal` 的保存和 `updateFacetMetaTool` 的 `next`
  （工具本身还没有 `slot` 参数，纯粹是保值）。

配图的 slot 见 §7 坑 5，第 4 期做。

### 3.4 槽位怎么进模型（第 3 期）

一条**没有**照原计划做的：`slot` 参数**不带 enum**。原计划说「enum 从 schema 填，
照 `profileCategoryParams` 的先例」，实现时否掉了，理由是那个先例在这里不成立：

- `getToolDefinitions(ids)` 是**按 preset** 构建的，没有 run 上下文，
  所以它拿不到「这次要改的是哪个分类的条目」。
- 退而求其次填「所有分类槽位的并集」反而更糟：模型会看到一份跨域的 id 表
  （给人物条目挂 `emblem`），而 enum 的作用本该是排除这种事。

改成三件事配合：

1. **`read_lore_entity` 多一段 `=== facet slots ===`**，列出该分类声明了哪些槽位、
   每个槽位现在被哪几条特征覆盖、哪些是 expected 却还空着。模型是从**读条目**学到
   槽位的，而不是从一个大 enum。
2. **`update_facet_meta` / `split_facet` 在执行时按该条目的分类校验**，不认识就报错
   并列出合法的 id——比静默丢掉好：丢掉的话特征会落进「未归类」堆，而任何地方都不会
   说明为什么。空字符串是「清除归类」。
3. **拆分与起草的 prompt 自带清单**（`slotChecklistText`），所以模型多半第一次就写对。

清单用**双语标签**（`appearance (外貌 / Appearance)`）而不是界面语言：这段文字是给
模型看的，它可能在用任一语言写作；而且这样 `lib/lore/slots.ts` 就不用把 i18n 拖进来，
测试可以当纯函数调用。id 放在每行最前面——那是模型唯一必须原样回传的 token。

---

## 4. 三条不变量

**一、slot 只影响创作、呈现和提示词；`selectLore` 读到的东西一个字都不许多。**
今天注入只认 facet frontmatter 的 keys/group/priority/mode。守住这条，
关掉能力包最坏的结果就是少了槽位分组与类型化提示词，**注入行为分毫不动**——
需求 3 的「降级」于是是免费的。破了这条，关掉一个包就会静默改变模型看到的上下文。

**二、槽位的默认值在创建那一刻物化进 frontmatter，绝不在读取时解析。**
`defaults.mode/priority/group/keys` 是「新建这一面时预填什么」，不是「这一面运行时是什么」。
所以 schema 消失后文件依然自带完整的注入语义。

**三、降级只发生在读取侧，绝不回写磁盘。**
房规已经存在：[`scanLore` 的注释](../../../src/lib/lore/entity.ts)明确「切换 profile 只是隐藏，
目录留在磁盘上，切回来就回来」。作者主动「迁移」是显式动作，不是自动的。

三条都要有测试钉住，前两条尤其：它们坏掉时不报错，只是上下文悄悄变了。

---

## 5. 降级与孤儿分类（需求 3）

需求 3 顺手暴露了一个现存缺陷：能力包一关，它独有分类下的条目**从 UI 消失**，
而不是降级。做法是让 `scanLore` 扫**磁盘上真实存在的目录**，把没有任何已启用包声明的目录
作为**孤儿分类**产出（label = 目录名，无 schema，可被作者一键提升为用户自建分类）。
这样条目、特征、配图全都继续工作，只是失去类型化的那层壳。

一个必须小心的分岔：**孤儿分类不能合并进 `loreCategories()`**。那个列表同时在回答两个不同的问题：

| 问题 | 谁在问 | 孤儿分类算不算 |
|---|---|---|
| 这个 id 能不能拿去拼路径 / 作为新建目标 | `isKnownCategory`（守模型与作者的输入）、`create_lore_entity` 的 enum（`profileCategoryParams`）、新建表单 | **不算** |
| 有哪些目录里装着条目 | 知识库墙、命令面板、AI 面板的实体清单、注入 | **算** |

配套的第二个坑见 §7 坑 1——这两件事必须同一个 PR 改完。

**落地口径**（第 2 期，运行时说明记在 [`architecture.md`](../../reference/architecture.md) →
孤儿分类）：

- 两个问题分家到 `src/lib/lore/categories.ts`：`indexCategories(index)` 答「有些什么」，
  `loreCategories()`/`isKnownCategory()` 继续答「能往哪写」。
- **空的孤儿目录不算分类**：谁也不能往里新建，列出来只是碍事。大小写不同的同一目录只进一次
  （大小写不敏感的文件系统会把它报成另一个名字）。
- 孤儿的**标签用目录名**，不借那个被停用的包的标签——借来的标签会让人以为 schema 还在，
  而目录名对手工建的、或跟着别人项目一起来的文件夹也是唯一诚实的答案。
- `assignableCategories(current)` 是唯一例外：条目正待在某个孤儿分类里时，选择器必须列出它，
  否则界面显示一个它不在的分类，下一次保存就把目录搬走了。「搬进」孤儿仍然不可能。
- `list_lore_entities` 在孤儿分类后缀一句说明，免得模型试一次被拒才知道。
- Settings → 工作台 的「N 个分类目录仍有内容」文案同步改掉：它此前说「重新启用即可看到」，
  而现在本来就看得到，重新启用恢复的是分类名与类型。
- **视觉上仍是普通分类**（只多一个 tooltip）：条目是完好的，报警式的处理会谎报状态；
  专门的降级呈现是设计稿屏 23，第 4 期的事。

---

## 6. 分期计划

| 期 | 内容 | 状态 |
|---|---|---|
| **1** | **槽位骨架**：`FacetSlot`/`ImageSlot` 类型与校验、`ResolvedCategory` 并集合并、facet frontmatter `slot` 解析/序列化、写入路径保值、novel 包的槽位表、单测。零 UI、零行为变化。 | ✅ 已实现 |
| **2** | **孤儿分类**（§5）+ §7 坑 1 的那批循环 + `lib/lore/categories.ts` 的两问分家。 | ✅ 已实现 |
| **3** | **创作侧接线**：`lib/lore/slots.ts`（`slotStatuses` / `unslottedFacets` / `slotChecklistText` / `withSlotDefaults`）；拆分整理与「生成新特征」的 prompt 带清单；`split_facet`、`update_facet_meta`、`draft_lore_facet` 加 `slot`（**不带 enum**，改为执行时按分类校验——见 §3.4）；`read_lore_entity` 多一段槽位清单；ttrpg/copy/wechat/bid 的槽位表。 | ✅ 已实现 |
| **4** | **UI 呈现**（设计稿屏 19–23）：详情页特征栏按槽位分段、缺口邀请、类型行与覆盖小结、特征编辑的归属槽位与预填、配图按 imageSlot 分段（含 `images.md` 的 `slot:` 行）、降级条与「启用 <包>」。落地口径记在 [`design-system.md`](../../reference/design-system.md) → 知识库设计语言 → 类型系统。 | ✅ 已实现 |
| 5 | `subtypes`（§2 末）——等真有一个能力包需要再说。 | 不做 |

其余内置包的槽位表放到第 3 期、和消费它的提示词一起给：第 1 期只有 novel 有槽位，
是为了让格式先在一个真实用例上跑通，而不是先摊一堆作者看不见、也没人消费的半成品。

第 3 期落地时**只给了 ttrpg / copy / wechat / bid**，`weekly` 与 `feedback` 保持无 schema，
连同各包里那些单一用途的分类（`rules`/`hooks`/`style`/`competitors`/`implementation`…）。
判据是**条目长到值得拆**才配槽位：周报的「项目」「指标」、反馈报告的「来源」「分群」
都是短事实，整条注入本来就不浪费，硬塞一份清单只会让提示词里多一段没用的话——
而一份弱清单比没有清单更糟。标书的「业务能力」「项目案例」相反，动辄几千字，
一条应答只该带它真正引用的那一面，所以它们有。缺的那些等域的主人自己定义，
无 schema 是完全受支持的状态（§4 不变量一）。

---

## 7. 坑清单

1. ~~**约 8 处 `loreCategories()` + `loreIndex[c.id]` 的循环**~~（第 2 期已改）——
   `LoreWall` 三处 + `LoreDetail` 翻页 + `CommandPalette` + `AiPanel` 清单改走
   `indexCategories(index)`；新建条目的分类选择器**保持** `loreCategories()`，
   两个分类选择器改走 `assignableCategories(entity.category)`。
   原因留档：`selectLore` 走的是 `Object.values(loreIndex)`（`loreSelect.ts:149`），
   `scanLore` 一旦产出孤儿键，**注入立刻覆盖到它们，UI 却看不见**——
   错的方向，作者看不见的条目悄悄进了 prompt。新增循环时照此二分。
2. **槽位默认值必须写进文件**（§4 不变量二）。
3. **跨包共享分类的槽位合并要显式定**（§3.2）。否则「启用第二个包」会静默改掉一个已有分类的 schema；
   合并时忘了复制数组则会污染内置包单例。
4. **改类型 = 搬目录**，会断 `dirPath#facetFile` 形式的 pin（`loreSelect.ts:56`）和
   `category/id` 形式的引用（`citations.ts:16`）。这是今天改分类**已有**的行为，
   写在这里是为了别以后被当成新 bug 重新发现（也是方案 A 唯一有力的论据，见 §2）。
5. ~~**`images.md` 是唯一必须改格式的存储**~~（第 4 期已改，就按这条做的）：描述块首行的
   `slot: portrait` 被 parser 吃掉，**只认第一行**，所以正文里再出现 "slot:" 不受影响；
   无 slot 时**一个字都不写**，老项目的 diff 保持干净。老版本会把 slot 行当描述文字显示，
   纯观感问题，不丢数据。**别用 h1 分组**：现在的 parser 会把 h1 行吞进上一张图的描述里。
   写入侧同样守保值纪律——`updateLoreImageDesc` 只改描述、带着 slot 走，改归类是
   `updateLoreImageSlot` 自己的事。
6. **`FacetMeta` 的写入路径都要保值**（§3.3）。已知三处：`FacetEditModal.handleSave`、
   `updateFacetMetaTool`、`LoreImproveModal` 的 `facetMetaRef`（后者整体透传，天然安全）。
   `LoreSplitModal` 建的是新特征，第 3 期才由 AI 填 slot。

---

## 8. UI 设计稿 prompt（第 4 期用）

设计稿在 claude.ai/design 项目「Simple AI Writer UI redesign」→ 文件 `03 设定集 Lore`
（现有屏号到 18，v2/v3/v4 三轮）。下面这段整段贴给 Claude Design 用来加新屏：

```text
在项目「Simple AI Writer UI redesign」的 `03 设定集 Lore` 文件里，接着现有屏号往后加
19–23 五屏，主题是「条目类型系统」。沿用该文件 v2/v3/v4 已确立的全部语汇，不要另起一套：
条目 = 主条目 + 特征 + 配图（屏 14/15/16）；详情页三栏 `主条目 320 | 特征 flex | 配图 300`，
三栏各自滚动、栏首齐平、落款钉底；互斥组画成虚线盒（组内按优先级降序）；注入语义写在每行上
（常驻 = 3px 赭石左边 / 自动 = 实描边徽标 / 手动 = 灰描边 + 半透明）；纸面 #FBF8F0 面板、
网格纸墙、索引卡硬偏移阴影、全局零圆角（只有状态点/转圈/单选点是圆的）；单一赭石强调色
（浅 #A0522D / 深 #D9925B），AI 新增内容用 diff 绿；字数/id/计数一律等宽字体；
模态 760 宽、footer 是「左：模型选择器 + 斜体说明 ／ 右：取消·次·主 三级按钮」。
术语：特征（不是"分面"）、主条目、配图、概要。

要表达的概念（数据模型已经支持，除了标注「格式待扩展」的那处）：
- 分类现在可以带一份 **schema**：一组**特征槽位**（外貌 / 装扮 / 人物关系 / 往事 / 能力 /
  说话方式）和一组**配图槽位**（人设图 / 表情 / 服装设定）。槽位是**归类与提示**，
  不改变注入规则——设计上必须让人一眼看出槽位不是开关。
- 部分槽位标记为「通常该有」，缺失时给**缺口提示**（不是错误，是邀请）。
- 能力包关掉后条目**降级**：槽位分组消失，条目照旧可读可编辑可注入。

五屏：
19. 详情页 · 特征栏按槽位分组。在现有三栏详情页上，中栏的特征列表按槽位分段
    （段首是槽位名 + 该段特征数），未归类的特征收在末尾「未归类」段；虚线互斥盒
    仍在段内生效。段首右侧留一个「+」新建这一面。
20. 详情页 · 槽位缺口。同一屏的变体：expected 但为空的槽位显示为**虚线空段**
    （槽位名 + 一句 hint + 「+ 补上这一面」），和已填段视觉上明确不同级。
    另给主条目栏底部一条「本类型建议的 6 面已有 4」的等宽小结。
21. 特征编辑弹窗 + 槽位。在现有 640 单列 FacetEditModal 的「名称」下加一行
    **归属槽位**选择（含「不归类」），选中后下方触发词/互斥组/优先级出现**预填提示**
    的形态（示意「默认值只在新建时预填，之后归你」）。
22. 配图栏 · 按配图槽位分组。右栏 300 宽，配图按 人设图 / 表情 / 服装设定 分段，
    每段有槽位名与数量，未归类段在末尾；空的 expected 槽位同样是虚线空段。
    （标注：images.md 格式待扩展）
23. 降级态。同一个条目在其能力包被关掉后的样子：槽位分段消失、退回一条平铺的特征列表，
    顶部一条克制的说明条（「这个条目的类型来自未启用的能力包 · 内容完好 · 启用后恢复分组」
    + 一个「启用 novel」次级按钮）。要传达「数据没丢、功能没坏」，不要用错误色。

每屏按该文件既有的方式标注：屏号、标题、以及标注里点出与既有屏的差异。
```

设计稿落地后，把口径（尤其是"设计稿要求但数据模型没接"的部分）记进
[`design-system.md`](../../reference/design-system.md) → 知识库设计语言，与前四轮 v1~v4 的记法一致——
提交信息和代码注释不算记录。

---

## 9. 验证

- 第 1 期：`pnpm test`（新增 `categorySlots.test.ts` + `loreSelect.test.ts` 的 parseFacetMeta 用例）
  与 `pnpm tsc --noEmit`。行为不变的证据是**现有测试全绿且没被改动语义**：
  slots 没有任何消费者，`parseFacetMeta` 只多一个字段。
- 第 2 期：`orphanCategories.test.ts` —— 扫描认出孤儿目录 / 空目录不认 / 大小写变体不重复；
  `indexCategories` 的顺序与「枚举出的条目数 == 索引里的条目数」（坑 1 的回归钉）；
  `assignableCategories` 的例外只放行条目自己那一个；`isKnownCategory("npcs")` 仍为 false。
  `agentReadTools.test.ts` 补了 `formatLoreIndex` 的孤儿标注。
- 第 3 期：`facetSlots.test.ts`（`slotStatuses` 的覆盖/缺口判定与大小写、未归类两种情形
  同桶、清单文本、`withSlotDefaults` 只填中性字段且不动无 schema 的条目）、
  `splitTools.test.ts` 的 slot 三例（认、拒并列出合法 id、无 schema 时忽略）、
  `agentWriteTools.test.ts` 的 `update_facet_meta` 三例（含「不提 slot 的编辑不得把它抹掉」）。
- 第 4 期：`facetSlots.test.ts` 补 `facetSections`/`imageSections`/`slotCoverage`/
  `categoryTypeName`（分段顺序、未归类兜底、缺口只认 expected、无 schema 时为空）、
  `imagesMdSlots.test.ts`（slot 行只认第一行、无 slot 不写、与老格式互读）、
  `categorySlots.test.ts` 补 `packsDeclaringCategory`。不变量一仍由第 1 期
  `loreSelect.test.ts` 那一例守着——本期没有往注入路径上加任何东西。
  **UI 本身没有自动化验证**，本期也没有手工跑过：详情页要一个真实项目才渲染得出来。
  纯逻辑（分段、缺口、格式读写）都在上面的单测里，样式与交互需要作者在真实项目上过一眼。
