/**
 * 阅读模式（条目的浏览版式）的纯数据层。
 *
 * 设计与任务书：docs/feature/lore/lore-browse-mode-ui-brief.md。UI 等设计稿，
 * 这里先落不随设计稿变的数据侧：模式偏好、激活标签、落款统计。分组**不在**这里
 * ——阅读模式复用 `slots.ts` 的 facetSections/imageSections 与 `facetBlocks.ts`
 * 的互斥组盒，只换渲染；词典正文用 `translate/glossary` 的 `parseDictBody`，
 * 由组件直接引（lore → translate 的反向依赖不值得为一个转发函数背上）。
 */

import type { LoreEntity } from "./model";
import { parseDictBody, type GlossaryEntry } from "../translate/glossary";

/**
 * 详情页的两种看法：阅读（单栏书页）/ 管理（屏 15 的三栏台）。
 *
 * 全局偏好而不是按项目——它是「我习惯怎么看条目」，不是某个知识库的属性。
 */
export type LoreDetailMode = "read" | "manage";

/** `PREF_KEYS` 里对应的那一行；测试钉着两边不脱钩。 */
export const LORE_DETAIL_MODE_PREF = "app:loreDetailMode";

/**
 * 从偏好行解析模式。**缺席即阅读**——点开一张卡片的默认意图是「把这条看一遍」，
 * 管理台一步之遥（任务书 §3e）；老用户第一次升级到这个版本也走这条默认。
 */
export function parseDetailMode(raw: string | null | undefined): LoreDetailMode {
  return raw === "manage" ? "manage" : "read";
}

/**
 * 条目的**激活标签**：名称 + 全部别名，命中任一即把这条注入上下文（匹配靶的
 * 构成见 `match.ts` / `context/loreSelect.ts`）。
 *
 * 阅读模式的档案头把这层语义第一次写明白——别名在管理台里只被当成「又名」展示
 * 过。名称永远排第一；去掉空白项，大小写不同的重复只留先出现的写法（匹配本就
 * 不分大小写，展示两遍是复读）。
 */
export function activationTags(entity: Pick<LoreEntity, "name" | "aliases">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [entity.name, ...(entity.aliases ?? [])]) {
    const tag = raw?.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 档案头元数据行 / 页底落款要念的三个数（任务书 §3b）。 */
export interface EntityReadStats {
  facetCount: number;
  imageCount: number;
  /** 主条目正文 + 全部特征正文的字数（frontmatter 不计——`charCount` 本就不含）。 */
  totalChars: number;
}

/**
 * `indexBodyChars` 由调用方传入（主条目正文是详情页已经读进来的内容，这里不做
 * IO）；特征那份用扫描时量好的 `charCount`，所以统计不必等特征正文加载完。
 */
export function entityReadStats(entity: LoreEntity, indexBodyChars: number): EntityReadStats {
  const facets = entity.facets ?? [];
  return {
    facetCount: facets.length,
    imageCount: (entity.images ?? []).length,
    totalChars: Math.max(0, indexBodyChars) + facets.reduce((n, f) => n + (f.charCount || 0), 0),
  };
}

/** 词典正文拆成「词表 + 其余行」（设计稿 16 屏 1e）。 */
export interface DictSplit {
  entries: GlossaryEntry[];
  /** 解析不成词对的非空行，按原样 markdown 落在词表下方——不吞掉内容。 */
  rest: string;
}

/**
 * 阅读模式把 `dict` 条目的正文渲染成双栏词表；这里按行分拣。
 *
 * 每行的判定**就是** `parseDictBody` 对单行的判定（逐行喂给它，而不是抄一份
 * 正则）——词表页显示的行集必须和翻译真正用到的行集一字不差，两份实现迟早在
 * `=` 分隔符或列表前缀这类宽容规则上分道扬镳。空行不进 `rest`：它们在原文里
 * 只是词对之间的呼吸，攒成 markdown 段落反而生出空段。
 */
export function splitDictBody(body: string): DictSplit {
  const entries: GlossaryEntry[] = [];
  const restLines: string[] = [];
  for (const line of body.split("\n")) {
    const parsed = parseDictBody(line);
    if (parsed.length > 0) entries.push(...parsed);
    else if (line.trim()) restLines.push(line);
  }
  return { entries, rest: restLines.join("\n") };
}
