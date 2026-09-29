# 取材范围多选（Multi-collection scope）

> 状态：**`shipped`——已实施**（数据层 + store + 接线 + 切换器多选 UI，切换器视觉按 Claude Design 设计稿
> 03 屏 26 重绘；见 PR #443）。这是 [`lore-collection-plan.md`](./lore-collection-plan.md) 的一个增量：把
> 「取材范围」从单选一个集合，改成**同时激活多个集合的并集**，且**「未归集」也成为一个
> 可勾选的范围成员**。视觉口径见 [`design-system.md`](../../reference/design-system.md)
> → 集合 · 装订语汇。UI 任务书（给 Claude Design）见本文 §7。
>
> 已落地：`lib/lore/collections.ts` 的类型与纯 helper（`inScope` 并集 + `UNGROUPED` 成员、
> `normalizeScope` / `parseScopePref` / `serializeScope` / `scopeWith` / `scopeWithout` /
> `toggleScope` / `renameScope` / `scopeHas` / `concreteScopeCollections`）、`loreStore` 的
> JSON 序列化与旧格式 shim、`projectStore` 的改名/删除跟随、六处 AI 落点的类型放宽、
> `formatLoreIndex` / `search_text` 的多集合围栏说明、以及 `ScopeMenu`（多选勾选、未归集可勾）
> / `ScopeButton` / `ScopeBand` / `CollectionRail` / `BindingEdge` 的功能接线。纯层单测在
> `loreCollections.test.ts`。切换器视觉（勾选框 / 头部并集候选数 / 并集算式行 / 折起「含 N 个已勾」/
脚部自动行为说明）按设计稿 03b 屏 26 落地。

## 1. 问题

集合已经能把知识库切成几摊活，但取材范围（scope，那道只挡自动发现的围栏）**一次只能立在
一个集合上**（`LoreScope = string | null`）。作者的诉求：

> 我只能激活一个集合。我想要能同时激活多个集合（未分类也算一个集合）来作为范围。

真实场景就是 collection 设计里那句「他们有时候需要互相引用来写作」的另一面：写小说 A 的
某一章时，要让 AI 同时看得见 **小说A** 和 **共享设定**，但仍挡住 **小说B**；或者「**小说A**
＋ 那些还没归好类的散条目」。单选范围表达不了「A 和 B，但不含 C」——除非把共享材料复制进
每个集合，那正是多归属当初要消灭的东西。

## 2. 改动的一句话

`scope` 从「一个集合名或 null」变成「**一组集合名的并集**，或 null ＝全部」，其中并集里可以
含一个特殊成员 **未归集**。`inScope` 从「属于这一个」变成「属于其中任意一个」。围栏的语义
（只挡自动发现、不挡显式指定）、落点（六处作用面）、以及「分类用颜色 / 集合用装订 /
`3px double` 骑缝带是围栏唯一记号」的视觉纪律**全部不变**——变的只是「围栏立在几摊上」。

## 3. 不变量（沿用 + 新增）

沿用 [`lore-collection-plan.md`](./lore-collection-plan.md) §3 的四条（字段非目录、围栏只挡
自动发现、未声明集合照样算数、取材方式不变），另加三条：

5. **空选＝全部。** 一个都不勾，围栏就是放下的（`scope === null`）。取消勾选到最后一个也
   自动退回「全部」，而不是掉进「一条都看不见」——那是脚枪，作者会在不知情时把 AI 写瞎。
   「只看某集合」始终是**主动勾选**的结果，从来不是「取消到零」的副产品。
6. **未归集是并集的合法成员，不再是被排除项。** 这条**推翻**了旧计划 §9 的「未归集不能当
   范围」。旧理由是「没人想让 AI 只用没分好类的条目写作」；多选之后，「**小说A** ＋ 未归集」
   是常态需求（一摊活加上还没来得及归档的散条目），而「只勾未归集」也是一个正当意图
   （只跟还没分拣的那一堆打交道）。刻意的缺席被刻意地取消。
7. **范围的并集只放大候选池，绝不叠加注入量。** 勾三个集合不等于「把三集都塞进上下文」，
   仍然是名称/别名在正文里出现才注入。多选改的是围栏圈住的范围，不是取材策略（§4 沿用
   collection §4.5：整集注入是另一条路，不在这里）。

## 4. 数据模型

### 4.1 类型

```ts
// lib/lore/collections.ts
/** 生效中的取材范围：一组集合名的并集，或 null ＝不设围栏。空数组归一化为 null。 */
export type LoreScope = string[] | null;
```

并集里可含 `UNGROUPED` 这个既有哨兵（`"\u0000ungrouped"`，作者打不出来、不可能与真集合
重名）。它此前只是墙上**筛选**（`CollectionFilter`）的一档；现在它同时成为 scope 的合法成员。
把两处共用同一个哨兵、而不是给 scope 造第二个，是因为「未归集」在两处是同一个概念——一条
`collections` 为空的条目。

### 4.2 判定与派生（collections.ts 里改这几个）

```ts
export function inScope(entity: LoreEntity, scope: LoreScope): boolean {
  if (!scope || scope.length === 0) return true;      // 全部
  const cols = entityCollections(entity);
  return scope.some((s) =>
    s === UNGROUPED ? cols.length === 0 : cols.some((c) => sameCollection(c, s)));
}
```

- `scopeLoreIndex` / `outOfScopeCount`：主体不变，`inScope` 现在吃并集，逻辑自动跟着走。
- `collectionBreakdown`：它现在按**单个** name（含 `UNGROUPED`、含 null）算分布；多选范围的
  「候选 N 条」直接用 `loreEntityCount(scopeLoreIndex(index, scope))`，不需要它改签名。
- 新增 `normalizeScope(raw: unknown): LoreScope`：吃数组 / 旧的单字符串 / null，去空白、大小写
  去重、空归 null、超 `MAX_COLLECTIONS` 截断。**三处共用它**：pref 读取、UI 保存、scan 装载
  ——同 `normalizeCollections`，同一把尺才能保证存进去和读出来是同一份。

### 4.3 持久化与迁移

`lore:scope:<projectPath>` 从「一个裸集合名」改存 **JSON 数组**。读取侧一层 back-compat shim：

```ts
function parseScopePref(raw: string | null): LoreScope {
  if (!raw?.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return normalizeScope(v);          // 新格式：["小说A","共享设定"] 或含哨兵
  } catch {
    return normalizeScope([raw]);      // 旧格式：裸字符串 → 单集合范围
  }
}
```

**不走「丢弃旧数据 + 修复按钮」那条路**：scope 不是可重建状态，静默把旧的单集合范围读丢
会让围栏悄悄放大到「全部」——AI 突然看见作者本来挡掉的材料，且**没有任何提示**。一层
读取 shim 几行就够，且非破坏性，所以留 shim。「全部」仍写成**删除这一行**（`deletePref`），
不存 `[]` 也不存空串——缺席即默认。

### 4.4 新建条目归进当前范围

`createNewEntity`（作者手建）与 agent 的 `create_lore_entity` 现在读的是一组范围。规则：
**把新条目归进当前范围里所有的「实集合」**（跳过 `UNGROUPED` 哨兵）。

- 范围 = null → 不归任何集合（未归集，且它本来就在「全部」里）。
- 范围 = `{小说A}` → 归入小说A（与单选时一致）。
- 范围 = `{小说A, 共享设定}` → 两个都归（否则它只落在其中一摊，另一摊的墙上立刻看不见它）。
- 范围 = `{UNGROUPED}` 或 `{小说A, UNGROUPED}` → 只归实集合（前者归零 → 未归集 → 仍在范围内）。

一句话：新条目落进当前这面**围起来的墙**必须仍看得见它——这条保证从单选原样继承过来，
只是「当前范围」现在可能是好几摊。

## 5. 落点（六处作用面，全部只是把 scope 从标量换成并集）

围栏的六个接线点一个不增一个不减（见 collection §6）：AI 面板全部任务、对话（种子＋逐轮＋
`ToolContext`）、一致性检查、扮演（种子＋逐轮）、子代理（继承父运行）、知识库两个 AI 模态。
它们**全部**只是把 `scope` 值透传给 `inScope` / `scopeLoreIndex`，所以类型放宽后大多原样编译。
需要动手的只有**操作这个值本身**的地方：

| 位置 | 现在 | 改成 |
|---|---|---|
| `loreStore.setScope` | `scope?.trim()` | `normalizeScope`，序列化 JSON / 删键 |
| `loreStore` scan 装载 | `readPref()?.trim() \|\| null` | `parseScopePref(readPref())` |
| `loreStore.createNewEntity` | `scope ? [scope] : []` | 当前范围里的实集合数组（§4.4） |
| `LoreWall` `key={scope ?? "all"}` | React key | `scope ? scope.join("│") : "all"` |
| `formatLoreIndex` 的范围说明 | 「范围：小说A，挡掉 N 条」 | 「范围：小说A ＋共享设定（＋未归集），挡掉 N 条」 |
| `ScopeBand`/`ScopeButton` 的 `scope` prop | `string` | 多集合摘要（§7） |

`scope !== null` 这类真值判断（null vs 数组）在放宽后仍成立，透传点无需改；但**每个**都要过
一眼回归，因为个别地方把 scope 当字符串插值（如 `scope.fence` 的 `{name}`）——那些要换成
「多集合摘要」文案。

## 6. 取舍

- **墙上的浏览筛选（装订栏点集合）保持单选，不在本轮动。** 作者要的是**取材范围**（围栏）多选；
  浏览筛选（`CollectionFilter`，只影响眼睛）是另一回事。两者语义不同、控件不同，混在一轮里
  改会把「围栏 ≠ 筛选」这条刚立稳的分界搅浑。浏览筛选要不要也多选，留作独立问题。
- **不引入「全部」以外的第二种空态。** 空选归一到 null，全项目只有一种「没围栏」的表示。
- **不给范围加持久命名（「保存这组范围为预设」）。** 那是另一个功能（范围预设/书签），有它自己
  的存储和管理面。本轮先把并集做对；预设要加时，它存的就是一个 `string[]`，格式不变。

## 7. UI 任务书（给 Claude Design）

设计项目：`17a6a5ce-f60e-4996-8f94-5948958206d0`（设计稿 03b 屏 24–31 已有取材范围切换器 /
骑缝带 / 装订栏）。**本轮只改「取材范围」这一族控件，从单选变多选**，其余屏不动。完整 prompt
见随附文本；要点：

1. **切换器（屏 26 那个弹层）从单选变多选勾选。** 每行一个 checkbox：全部 / 各集合（带条目数、
   分类分布）/ **未归集（本轮从只读数字变成可勾选的一行）**。「全部」＝清空所有勾选的复位项，
   勾任意集合即取消「全部」；取消到零自动回到「全部」。
2. **头部按钮 / 骑缝带要能概括「立在几摊上」**：一摊时照旧显示集合名；多摊时显示
   `小说A ＋2` 一类的摘要 + 合计候选数，悬停列全名。骑缝带那条 `3px double` 骑缝线**不变**
   ——它仍是「AI 视野变了」的唯一记号，多摊只是把带子里的名字变成一串。
3. **视觉纪律照旧**：集合不引第二套色（分类用颜色、集合用装订）；「围栏生效中」是陈述不是
   错误（不红不黄）；计数 mono；中英双语。
4. **数据边界**：范围是一个 `string[]`（可含「未归集」这个成员）+ 每个集合的条目数/分类分布
   + 合计候选数。**没有**的别画：范围预设的命名/收藏、集合封面、活跃度。

---

*实施顺序（作者的 plan-then-slices 流程）：先落数据层 + store（§4，可单测 `inScope`/
`normalizeScope`/`parseScopePref`），再落切换器多选 UI（§7），每片一个 PR，之间停下来让作者
在真机上验一遍围栏手感。*
