/**
 * 计费组列表怎么排、怎么过滤——**纯函数**，不碰库也不碰 store。
 *
 * 价格搬进组之后组开始变多，一屏十几行只能靠自己起的名字认。整理的手段有
 * 两样：厂商（把列表分段）和搜索。两样都不参与算钱，所以它们在这里，而不在
 * `feeGroup.ts`（那份是模式、档位匹配与唯一的一份 `costOf`）。
 *
 * 抽出来而不是留在组件的 `useMemo` 里，是因为「搜不到」和「分错段」都是**静默
 * 错法**：界面照常渲染，只是少了几行。这个仓库里容器组件不写测试，留在组件里
 * 就等于没有测试点。
 *
 * 四条规则，各自的理由记在它们各自的函数上；取舍的全文在
 * docs/feature/billing/01-fee-groups.md → 厂商与搜索。
 */

import type { FeeGroup } from "./feeGroup";

/**
 * 一个模型在这里只需要三样：绑了哪个组、叫什么、端点认的 id。
 *
 * 结构类型而不是 `import type { Model }`：这个模块只读这三个字段，声明成它
 * 真正要的形状，测试里就不必造一个完整的模型行。
 */
export interface BoundModelRef {
  feeGroupId?: string | null;
  name?: string;
  modelId?: string;
}

/*
 * 下面三个形状**不导出**：调用方从函数的返回类型推断就够了，而 exportReach
 * 那条守卫要求每个 export 都有第二个文件在用——为一个没人按名字引用的类型
 * 开一个 export，只会让下一个人以为有谁在用它。
 */

/** 列表里的一行：命中的组，加上它凭什么出现在结果里。 */
interface FeeGroupHit {
  group: FeeGroup;
  /**
   * 命中的模型名字。**只有当查询没有命中组名和厂商时才非空**——它是写给那
   * 一行看的「凭什么出现」；组名自己就命中了的时候再挂一串模型名只是噪音。
   */
  matchedModels: string[];
}

/** 一段。`vendor` 为空串的那一段是「没填厂商」的组，恒排最后。 */
interface VendorSection {
  /** 显示用的写法（第一次出现的那个）。空串 ＝ 未填厂商。 */
  vendor: string;
  hits: FeeGroupHit[];
}

/**
 * 给 `<select>` 的一项。
 *
 * 形状照着 `components/common/Select` 的 `SelectOption`，但**不从那里 import**：
 * `lib/` 不依赖 `components/`（layering.test.ts 盯着这条）。两边结构一致，所以
 * 直接传得过去。
 */
interface FeeGroupOption {
  value: string;
  label: string;
  /** 连续同组的选项共用一个段首——这就是 `<optgroup>` 的平铺写法。 */
  group?: string;
}

/**
 * 归段用的键：大小写不该把一个厂商裂成两段。
 *
 * 显示的时候用第一次出现的那个写法。补全会让多数人写一致，但手打一次
 * `openai` 不该和 `OpenAI` 各占一段。挡得住大小写，挡不住「Open AI」——那种
 * 只有补全能防，这里不做合并。
 */
export function vendorKey(vendor: string | undefined): string {
  return (vendor ?? "").trim().toLowerCase();
}

/** 已经用过的厂商，去重、按出现顺序。抽屉的补全候选就是它。 */
export function knownVendors(groups: FeeGroup[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    const v = (g.vendor ?? "").trim();
    const key = vendorKey(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** 这个组绑着的模型。 */
function boundTo(groupId: string, models: BoundModelRef[]): BoundModelRef[] {
  return models.filter((m) => m.feeGroupId === groupId);
}

/** 一个字段里有没有这个词。空字段永远不命中（空串的 includes 恒为真）。 */
function hasText(v: string | undefined, q: string): boolean {
  return !!v && v.toLowerCase().includes(q);
}

/** 一个模型在搜索里能被什么词找到：显示名和端点认的 id。 */
function modelLabel(m: BoundModelRef): string {
  return (m.name ?? "").trim() || (m.modelId ?? "").trim();
}

/**
 * 过滤：大小写无关的子串，三个维度——组名、厂商、**这个组绑着的每个模型的
 * 名字与 id**。
 *
 * 模型也算进来，是因为作者记得住 `qwen3.8-flash`，不一定记得住自己给那组价
 * 起的中文名。代价是结果里会出现「组名里根本没有这个词」的行，所以那一行要
 * 说出命中了哪个模型。
 *
 * 空查询 ＝ 不过滤（全部返回，`matchedModels` 都为空），而不是全部落选。
 */
export function matchFeeGroups(
  groups: FeeGroup[],
  models: BoundModelRef[],
  query: string,
): FeeGroupHit[] {
  const q = query.trim().toLowerCase();
  const out: FeeGroupHit[] = [];
  for (const g of groups) {
    if (!q) {
      out.push({ group: g, matchedModels: [] });
      continue;
    }
    const own = g.name.toLowerCase().includes(q) || vendorKey(g.vendor).includes(q);
    // 两个字段**分别**比，不拼成一个字符串再整体比：拼接会在接缝上造出
    // 一个原文里不存在的词，`name:"foo" modelId:"bar"` 会被 `oo b` 命中。
    const matched = boundTo(g.id, models)
      .filter((m) => hasText(m.name, q) || hasText(m.modelId, q))
      .map(modelLabel)
      .filter(Boolean);
    if (!own && !matched.length) continue;
    out.push({ group: g, matchedModels: own ? [] : matched });
  }
  return out;
}

/**
 * 过滤 + 分段。
 *
 * **段序 ＝ 这一段第一个组在原列表里的位置**，未填厂商的一段恒排最后。
 * 不按名字排：中英混排下「按名字」是拼音还是笔画取决于运行时的 ICU 数据，
 * 同一份配置在两台机器上会排成两样；而原列表的顺序（`sort_order` →
 * `created_at`）是迁移和作者自己留下的，分段不该把它推翻。下面那次 `sort`
 * 只把空厂商那一段挪到末尾——`Array#sort` 是稳定的，别的段保持首现顺序。
 */
export function organizeFeeGroups(
  groups: FeeGroup[],
  models: BoundModelRef[],
  query: string,
): VendorSection[] {
  const byKey = new Map<string, VendorSection>();
  const out: VendorSection[] = [];
  for (const hit of matchFeeGroups(groups, models, query)) {
    const key = vendorKey(hit.group.vendor);
    let section = byKey.get(key);
    if (!section) {
      section = { vendor: (hit.group.vendor ?? "").trim(), hits: [] };
      byKey.set(key, section);
      out.push(section);
    }
    section.hits.push(hit);
  }
  return out.sort((a, b) => (a.vendor === "" ? 1 : 0) - (b.vendor === "" ? 1 : 0));
}

/**
 * 两个选组的下拉（模型抽屉、渠道抽屉）共用的选项表。
 *
 * 厂商就是 `group`。**一个厂商都没填时不产生任何 `group`**：全都是「未填厂商」
 * 等于没分段，凭空多一行段首只会让短列表看起来更长。
 *
 * 「未绑定」不在这里：它是一个 `value: ""` 的真选择（不是 placeholder），由
 * 调用方放在最前面——它不属于任何厂商。
 */
export function feeGroupOptions(
  groups: FeeGroup[],
  label: (g: FeeGroup) => string,
  unsetVendorLabel: string,
): FeeGroupOption[] {
  const sections = organizeFeeGroups(groups, [], "");
  const grouped = sections.some((s) => s.vendor !== "");
  return sections.flatMap((s) =>
    s.hits.map((h) => ({
      value: h.group.id,
      label: label(h.group),
      ...(grouped ? { group: s.vendor || unsetVendorLabel } : {}),
    })),
  );
}
