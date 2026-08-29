# Agent 建重复分类的修复：让模型看见分类全貌 + create_lore_category 查重

> **状态：`shipped`** —— 2026-08-29 定案（同日两次对照 main 更新，最终对照 56f374e——
> 分类管理面三片全部落地，含 agent 方案卡的 category-target 轴），当日两片实现完毕：
> PR-A（读侧对照 + 预算放宽）、PR-B（查重 + 文案纠偏），实现出入已回写各节。
> 起因是一次真实事故：作者让 agent「整理并归类小说类的知识库
> 条目」，它没有用小说包的 characters/world/… 分类，而是新建了一批中文标签、id 为 `kb-N`
> 的自定义分类。分析结论：结构性问题，对**所有**能力包和自定义分类成立。
> 相关：[`lore-category-manage-plan.md`](../lore/lore-category-manage-plan.md) —— 同一根轴的
> 管理面，已全部实施。分工：那边修的是「批量搬家在方案卡上是 N 行」（category 步骤 +
> `moveGate`），这里修「模型认不出现有分类 / 建重复」——搬家的门修好了，恰恰让「认对
> 要搬去的分类」更要紧。

## 1. 根因链（四条缝隙叠加，全部在共享层，与具体包无关）

1. **模型只见过分类的英文文件夹 id，从未见过作者所见的标签。**
   `{{categories}}` 占位替换（`registry.ts` `withProfileCategories`）、`category`/`new_category`
   参数的 enum、`formatLoreIndex` 的分组标题 `[characters]`——三处给的全是 id。`labelZh`
   （人物/世界观/势力……）没有任何一条路到达模型。作者用中文提要求，模型对不上
   「characters ↔ 人物」，于是「新建作者看得懂的分类」成了它眼里的正解。
   - 一 id 多义加重此症：四个内置包都声明 `style`，标签却是文风/基调/调性/风格四个词。
   - 自定义分类最糟：纯中文标签派生出 `kb`、`kb-2` 这类 id（`suggestCategoryId` 把非
     ASCII 清空后落到 `kb` 基底），模型看到 `kb-2` 连猜的余地都没有。
2. **声明了但为空的分类在 `list_lore_entities` 结果里是隐形的。**
   `scanLore` 会把每个已声明分类放进索引（空数组也放），但 `formatLoreIndex` 对空分类
   `continue` 跳过。条目还没归进包分类的项目里，模型看到的清单中根本没有那六个分类——
   「这个项目没有小说分类」在它看来就是事实。
3. **`create_lore_category` 没有任何查重。**
   同文件的 `manage_collection` 对已存在的集合返回幂等成功（「already exists — nothing to
   do」），但 `createLoreCategoryTool` 对 label 不查现有分类的 id 也不查标签；方案门只核对
   「这一步在不在批准的方案上」，不判断重复。作者在方案卡上看到「新建分类 人物」，
   也想不到这会和 `characters`（labelZh 人物）并存成两套。
4. **陈旧文案自相矛盾。**
   `ai.instructions.agent` 仍写着「分类本身没有增删工具」，`create_lore_entity` /
   `move_lore_entity` 的参数描述仍说 "No tool creates categories"——这是 `organizeTools`
   落地前的老规矩，没随之更新。方案批准、`lore_organize` 组装载后模型手里明明有
   `create_lore_category`，指引它复用现有分类的唯一线索却还是那串认不出的英文 id。

## 2. 预算约束：工具预算棘轮（`agentToolBudget.test.ts`）

- **常驻半区上限放宽到 12,000**（作者 2026-08-29 拍板；现值 9,500、实测 9,453——
  category-target 那片的措辞改写净省了 4）。按该测试文件自己的规矩，改数随 PR-A 的
  description 改动**同一个 commit** 落地并在注释里记下实测值和理由。放宽买到的是：
  id↔标签对照可以进**常驻 description**（`{{categories}}` 替换），模型从第一轮就有
  对照表，不必先调一次 `list_lore_entities`。
- **真正咬人的变成全集上限**：15,000 未放宽。PR-A 落地后实测：常驻 9,472（对照 +19，
  zh 最坏情形——预算测试的 i18n mock 因此钉在 zh-CN 量贵的那侧）、全集 14,870，头寸
  130。常驻加的每一个 token 同样计入全集，所以 PR-B 改的两处 deferred 参数描述仍须
  **不长于**原句。若复测撞线，优先砍替换文案，而不是顺手把 15,000 也抬高——那个数字
  的规矩写在测试文件头上。
- 两片 PR 落地时都复测并把数字按惯例记进该文件的注释。

## 3. PR-A —— 读侧：让模型拿到 id↔标签对照

两处，一处吃常驻预算（预算已放宽），一处零成本：

**3.0 `{{categories}}` 替换带上标签**（`registry.ts` `withProfileCategories`）：description
里的 id 列表从 `characters, world, …` 变成 `characters(人物), world(世界观), …`。格式收在
`categoryRef(cat, isZh)`（`lib/profile/model.ts`，standing beside `categoryLabel`）——标签
与 id 大小写不敏感相同（英文标签多半如此）时输出裸 id，所以 en 侧几乎不涨。**enum 保持
纯 id 不变**——enum 值就是落盘的文件夹名，混入标签会让模型把标签当 id 传（有测试锁）。
实测这一步只 +19 token（zh），是常驻放宽买的正主：对照表从第一轮就在。

改 `src/lib/agent/tools.ts` 的 `formatLoreIndex`（新加 `isZh` 参数，registry 调用处传
`i18n.language === "zh-CN"`）：

1. **分组标题带作者所见标签**：`[characters(人物)]`——与 3.0 同一个 `categoryRef`，
   一种格式贯穿 description 和结果文本（实施时放弃了原计划的 `[id · label]` 第二种写法，
   两种格式并存只会让「这是同一对事实」更难读出来）。孤儿分类维持现状——裸文件夹名 +
   现有的「no enabled capability pack declares this category」说明（借用停用包的标签会把
   schema 假装还生效，见 `lib/lore/categories.ts` 的注释）。
2. **列出声明了但为空的分类**：收成**一行**（`Categories with no entries yet (valid
   targets for …): world(世界观), …`）而不是原计划的逐个标题——七个空分类七个标题会把
   真正有货的部分挤下去。**取材范围生效时整行抑制**：被围栏挡空 ≠ 空，围栏那句说明
   已经在场（有测试锁）。
3. **空项目的空态分支同步**：无围栏的空项目消息后接同一行空分类清单；有围栏的维持原句。
4. **id-vs-label 提示**：结果尾部一句 `Categories read id(author-facing label) — category
   parameters take the id, never the label.`，仅在真的渲染了至少一对 id(label) 时出现
   （en 全等时一句都不加）。

测试：`agentReadTools.test.ts` 扩展——标签渲染、空分类出现且带「暂无条目」标注、孤儿
仍为裸 id、空项目消息含分类清单、`isZh` 两侧各走一条；`agentToolSchema` 侧补一条
「description 含 `id(标签)` 对照、enum 仍是纯 id」；`agentToolBudget` 的常驻上限改
12,000 并记实测（同 commit）。

## 4. PR-B —— 写侧：`create_lore_category` 查重 + 文案纠偏

1. **查重**（`src/lib/agent/organizeTools.ts` `createLoreCategoryTool`）：过方案门**之前**
   （与 `manage_collection` 的 create 同序）把 label 与现有 `loreCategories()` 逐个比对——
   id、labelZh、labelEn 三路，trim + 忽略大小写。命中即幂等成功：
   `Category already exists as "characters" (人物) — file entries into it with
   create_lore_entity / move_lore_entity; nothing to create.`
   幂等而非报错，理由同 `manage_collection`：报错只会让模型换个名字重试，而换名字
   恰恰是最坏结果。只查已声明分类；label 撞上孤儿文件夹 id 的场景不拦——同名自定义
   分类会「收养」那个文件夹，这正是停用包降级设计里期望的迁出路径。
2. **两处参数描述纠偏**（deferred 组，替换后净缩 9 token——全集 14,870 → 14,861）：
   - `create_lore_entity.category` → "must be one that already exists
     (create_lore_category, plan-gated, adds one only when none fits)."
   - `move_lore_entity.new_category` → "must exist (create_lore_category adds one only
     when none fits)."
3. **`ai.instructions.agent`**（zh-CN + en 两份）：「分类本身没有增删工具：需要新分类时，
   请作者在 设置 → 工作台 或{{kb}}墙上创建，不要往不存在的分类里写。」→
   「分类优先复用现有的——工具描述和 list_lore_entities 都给出分类 id 与作者所见名称的
   对照，作者说的中文名多半就是某个现有 id 的标签；确实没有能容纳的分类才用
   create_lore_category 新建（同样要过方案）。分类的改名/删除请作者在 app 里操作
   （{{kb}}墙上分类右键，或 设置 → 工作台）。」——末句与 main 已落地的分类管理面
   （`lore-category-manage-plan.md` 分片 2 的两扇门）对齐，不再只指设置页。
4. 测试（`src/lib/__tests__/agentOrganizeTools.test.ts` 扩展）：id 命中 / labelZh 命中 /
   大小写与空白容错 / 未命中时照常建；两处描述与指令的陈旧句子加反向断言（不再含
   "No tool creates categories" / 「分类本身没有增删工具」）。复测 `agentToolBudget` 并记数。

## 5. 明确不做的

- **`suggestCategoryId` 的 CJK 转写**（拼音 id 等）：标签可见之后 `kb-N` 只剩观感问题，
  不值得引入转写依赖；留作观察。
- **方案卡上的重复预警**（PlanCard 对 create category 步骤标注「与现有分类疑似重复」）：
  PR-B 的工具侧查重已经把这条路堵死，卡上再标是第二道同样的闸，先不花这个 UI。
- **enum 里放标签**：enum 值就是落盘的文件夹 id，放标签会让模型把标签当 id 传；
  对照关系由 PR-A 的 description 替换和结果文本承担。
- ~~`move_lore_entity` 的 category-target 方案步骤~~：已随
  [`lore-category-manage-plan.md`](../lore/lore-category-manage-plan.md) 分片 3 在 main
  落地（cc83639），本计划两片直接建立在它之上。它顺手改掉了 `createLoreCategoryTool`
  结果文本的末句（指向墙上分类右键），与 PR-B 的指令改法同向，无需再动。
