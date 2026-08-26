/**
 * 集合（collections）—— 知识库条目的**第二根轴**。
 *
 * 分类（category）回答「这条是什么」（人物 / 世界观 / 势力），是磁盘上的文件夹，
 * 带类型 schema，一条只能属于一个。集合回答「这条属于哪一摊活」（小说A / 小说B /
 * 项目甲报告），**一条可以属于任意多个，也可以一个都不属于**。
 *
 * ## 为什么不是文件夹
 *
 * 一层目录看起来更直观，但 `dirPath` 这个字符串已经被四样东西持久化了：AI 面板的
 * 置顶、`[[lore:…]]` 引用、扮演角色的绑定条目、知识库同步的逐条哈希。加一层目录
 * 等于同时作废这四样并做一次有丢失风险的迁移——而多归属根本没法用目录表达（一条
 * 共享世界观要同时在两本小说下面）。所以集合是 `index.md` frontmatter 上的一个
 * 字段，纯追加：老项目缺这个字段就是「未归集」，同步和导出白搭车。
 *
 * ## 集合的 id 就是它的名字
 *
 * 分类的 id 是文件夹名，所以必须是 ASCII slug，显示名另存。集合没有文件夹这个
 * 约束，于是 id 直接用名字本身——因为这个值会落到作者每天要读的 frontmatter 里，
 * `collections: ["小说A", "共享设定"]` 是能读的，`collections: ["kb-2"]` 不是
 * （`suggestCategoryId` 对纯中文标签正是产出 kb / kb-2 / kb-3）。代价是重命名要
 * 改写所有成员条目的 frontmatter，而那是个罕见操作，且改的东西作者看得见。
 *
 * 大小写不敏感地视为同一个集合（`sameCollection`），显示时用声明里的那份写法：
 * 「Draft」和「draft」是同一摊活，不是两摊。
 *
 * ## 取材范围（scope）只挡自动发现
 *
 * `scope` 是一个集合名或 null（＝全部）。它缩小的是**自动匹配的候选池**和 agent
 * 的条目清单，绝不拦截作者的显式指定——置顶、`@` 引用、`[[lore:…]]`、点开的条目
 * 照常生效。显式指定＝作者坚持，这条规则和 `selectLore` 里 pin 豁免 `excludeDirs`
 * 是同一条。
 */

import type { LoreEntity, LoreIndex } from "./model";

/**
 * 生效中的取材范围：一个集合名，或 null 表示不设围栏。
 *
 * 刻意没有「只看未归集」这一档：那是浏览时的筛选（墙自己的 state），不是一种取材
 * 意图——没有人会想让 AI 只用那些还没分好类的条目写作。
 */
export type LoreScope = string | null;

/** 一个集合在当前项目里的样子，供墙面与切换器渲染。 */
export interface CollectionView {
  /** 名字，同时也是 id。显示用这份写法。 */
  name: string;
  /** 归入这个集合的条目数。 */
  count: number;
  /**
   * false = 只在条目的 frontmatter 里出现过，profile.json 没有声明它。
   *
   * 和孤儿分类同一套降级哲学（见 lib/lore/categories）：作者手写进 frontmatter 的
   * 集合、或者别人项目里带来的集合，都要能看见、能筛、能进围栏，只是不占声明列表
   * 的顺序。扫描绝不「清理」这种值。
   */
  declared: boolean;
}

/** 一个集合名最长多少字符——挡住把整段正文粘进去的手滑，不是什么正确性约束。 */
export const MAX_COLLECTION_NAME = 40;

/** 一个项目最多声明多少个集合。同 MAX_CATEGORIES 的量级，纯粹是防失控。 */
export const MAX_COLLECTIONS = 60;

/** 两个集合名是不是同一个集合（大小写不敏感）。 */
export function sameCollection(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 把任意来源的集合名清成一份干净列表：去空白、去空项、超长截断、大小写不敏感去重，
 * 保留首次出现的顺序与写法。
 *
 * 三个调用方共用它：frontmatter 解析、profile.json 解析、UI 的多选保存——同一把尺
 * 才能保证「存进去的」和「读出来的」是同一份。
 */
export function normalizeCollections(raw: unknown): string[] {
  const items = coerceList(raw);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const name = item.trim().slice(0, MAX_COLLECTION_NAME).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_COLLECTIONS) break;
  }
  return out;
}

/**
 * frontmatter / JSON 里的值 → 字符串数组。
 *
 * 既要吃真正的数组，也要吃手写的行内形式 `collections: [小说A, 共享设定]`——轻量
 * frontmatter 解析器对没引号的 CJK 行内数组是原样交回一个字符串的（`coerceStringList`
 * 在 entity.ts 里为 `keys` 做的是同一件事，这里不复用是因为那个是模块私有，且这里
 * 还要吃单个裸字符串 `collections: 小说A`）。
 */
function coerceList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return [];
    const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
    return inner
      .split(/[,，]/)
      .map((s) => s.trim().replace(/^["']|["']$/g, "").trim());
  }
  return [];
}

/** 一个条目的集合列表，永远是数组（老条目没有这个字段）。 */
export function entityCollections(entity: LoreEntity): string[] {
  return entity.collections ?? [];
}

/** 这个条目在当前取材范围内吗？范围为 null（全部）时恒为真。 */
export function inScope(entity: LoreEntity, scope: LoreScope): boolean {
  if (!scope) return true;
  return entityCollections(entity).some((c) => sameCollection(c, scope));
}

/**
 * 按取材范围过滤出一份新的索引。
 *
 * 分类键**全部保留**（哪怕过滤后为空），因为下游把键当作分类清单在用——只把每个
 * 分类的条目数组换成过滤后的新数组。返回的是新对象与新数组，条目本身仍是共享引用：
 * 这里只做筛选，谁都不该就地改条目（要改的人用 `cloneLoreIndex`）。
 */
export function scopeLoreIndex(index: LoreIndex, scope: LoreScope): LoreIndex {
  if (!scope) return index;
  const out: LoreIndex = {};
  for (const [category, entities] of Object.entries(index)) {
    out[category] = (entities ?? []).filter((e) => inScope(e, scope));
  }
  return out;
}

/** 索引里在取材范围**之外**的条目数——用来诚实地报告围栏挡掉了多少。 */
export function outOfScopeCount(index: LoreIndex, scope: LoreScope): number {
  if (!scope) return 0;
  let n = 0;
  for (const entities of Object.values(index)) {
    for (const e of entities ?? []) if (!inScope(e, scope)) n++;
  }
  return n;
}

/** 一条都没归集的条目数。 */
export function ungroupedCount(index: LoreIndex): number {
  let n = 0;
  for (const entities of Object.values(index)) {
    for (const e of entities ?? []) if (entityCollections(e).length === 0) n++;
  }
  return n;
}

/**
 * 这个项目当前有哪些集合：先是 profile.json 声明的那些（**按声明顺序，含空集合**），
 * 再是只在条目里出现过的（按名字排序）。
 *
 * 和 `indexCategories` 是同一个形状、同一个理由：声明列表回答「可以往哪儿放」，
 * 这个函数回答「实际有什么」。空集合要在——先建集合再往里装是正常用法；未声明的
 * 要在——否则作者手写进 frontmatter 的集合会在墙上和切换器里消失，而围栏那边却认，
 * 于是「看得见的」比「模型看得见的」还少，正是孤儿分类那个 bug 的翻版。
 *
 * 未声明的排在后面并按名字排序，而不是按索引顺序：索引顺序是 readDir 顺序，跨机器
 * 会抖。
 */
export function collectionViews(index: LoreIndex, declared: string[]): CollectionView[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const entities of Object.values(index)) {
    for (const e of entities ?? []) {
      for (const name of entityCollections(e)) {
        const key = name.trim().toLowerCase();
        if (!key) continue;
        const hit = counts.get(key);
        if (hit) hit.count++;
        else counts.set(key, { name: name.trim(), count: 1 });
      }
    }
  }

  const out: CollectionView[] = [];
  const used = new Set<string>();
  for (const name of normalizeCollections(declared)) {
    const key = name.toLowerCase();
    used.add(key);
    out.push({ name, count: counts.get(key)?.count ?? 0, declared: true });
  }
  const extras = [...counts.entries()].filter(([key]) => !used.has(key));
  extras.sort((a, b) => a[1].name.localeCompare(b[1].name));
  for (const [, { name, count }] of extras) out.push({ name, count, declared: false });
  return out;
}

/** 往一条的集合列表里加一个（已在其中则原样返回同一个数组）。 */
export function addCollection(current: string[], name: string): string[] {
  if (current.some((c) => sameCollection(c, name))) return current;
  return normalizeCollections([...current, name]);
}

/** 从一条的集合列表里去掉一个。 */
export function removeCollection(current: string[], name: string): string[] {
  return current.filter((c) => !sameCollection(c, name));
}

/**
 * 重命名：把列表里叫 `from` 的那个换成 `to`，**位置不变**。
 *
 * 位置不变是有意的——集合在墙上的顺序是作者排的，重命名不该让它跳到末尾。改完仍
 * 过一次 `normalizeCollections`，这样「把 A 改成已存在的 B」自然合并成一个而不是
 * 留下两条同名。
 */
export function renameCollection(current: string[], from: string, to: string): string[] {
  return normalizeCollections(current.map((c) => (sameCollection(c, from) ? to : c)));
}

/**
 * 装订边上的竖排短名——设计稿 03 屏 24 的那条 22px 竖带。
 *
 * 竖排一个字一行，四个字就是一条装订标的高度上限。作者的集合名常常带书名号
 * （《漕运纪·前传》），而书名号在竖排里既占一行又不表意，先剥掉再取前四字。
 *
 * 刻意**不为此加一个 `shortName` 字段**：这纯粹是显示层的截断，全名一个悬停就
 * 能看见，而给声明格式加一层结构就会让 profile.json 从一个字符串数组变成一串
 * 对象，手改成本立刻上去。真需要时再加是加宽，不是迁移。
 */
export function bindingLabel(name: string, max = 4): string {
  const bare = name.replace(/[《》「」『』【】〈〉〔〕\[\]]/g, "").trim();
  const base = bare || name.trim();
  return [...base].slice(0, max).join("");
}

/**
 * 一个集合内部按分类的分布 —— 切换器和管理面板都要显示的
 * 「人物 2 · 势力 1 · 地点 1」那一行。
 *
 * 分类顺序照索引给的顺序（也就是工作台的顺序），空分类不出现。
 */
export function collectionBreakdown(
  index: LoreIndex,
  name: LoreScope,
): { category: string; count: number }[] {
  const out: { category: string; count: number }[] = [];
  for (const [category, entities] of Object.entries(index)) {
    const n = (entities ?? []).filter((e) =>
      name === null
        ? true
        : name === UNGROUPED
          ? entityCollections(e).length === 0
          : inScope(e, name),
    ).length;
    if (n > 0) out.push({ category, count: n });
  }
  return out;
}

/**
 * 墙上的**筛选**（只影响眼睛）比取材范围多一档：只看未归集的那些。
 *
 * 用一个不可能与集合重名的哨兵，而不是给 `LoreScope` 加一个变体——取材范围**刻意**
 * 没有「只看未归集」这一档（没人会想让 AI 只用还没分好类的条目写作），把它并进同一个
 * 类型就会让那条刻意的缺席变成一个到处都要记得处理的分支。
 */
export const UNGROUPED = "\u0000ungrouped";

/** 墙上的筛选：全部 / 某个集合 / 未归集。 */
export type CollectionFilter = string | null;

/** 这个条目通过当前筛选吗？ */
export function passesFilter(entity: LoreEntity, filter: CollectionFilter): boolean {
  if (filter === null) return true;
  if (filter === UNGROUPED) return entityCollections(entity).length === 0;
  return inScope(entity, filter);
}
