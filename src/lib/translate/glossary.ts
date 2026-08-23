/**
 * 术语表：从知识库里挑出这一块用得上的词条，再在译文上强制落实。
 *
 * 四条：
 *
 * 1. **只注入本块命中的条目。** 这跟应用里 RAG「尽量多喂」的直觉是反的，但
 *    Sakura 推荐的上下文只有前 3–5 句；几百条术语塞进去既挤掉正文，又会让它
 *    开始照着术语表造句。命中判定顺便解决了另一件事：一个中文别名不会出现在
 *    日文原文里，所以「哪些别名是源词」不需要靠字符集去猜。
 * 2. **术语表是软提示，不是替换。** 实测 15 行里 `文香→芙美香` 只生效了一半，
 *    最后一行仍是「文香」。所以译名一致性由 {@link enforceGlossary} 兜底 ——
 *    没有它，这个功能对"同一个人名前后不一致"这件事毫无帮助。
 * 3. **强制替换按最长词优先。** 否则 `文香→芙美香` 会先把 `文香さん→芙美香小姐`
 *    的前半截吃掉，留下 `芙美香さん`。
 * 4. **不替换 URL、链接目标和行内代码里的文本。** 那里面的字符串是标识符，
 *    改一个字就是坏链接。
 */

import type { LoreEntity, LoreIndex } from "../lore/model";

export interface GlossaryEntry {
  /** 原文里出现的写法（日文）。 */
  src: string;
  /** 作者定的译名。 */
  dst: string;
  /** 一句话备注，进 `#` 后面。可空。 */
  note?: string;
}

/**
 * 一块最多带多少条。
 *
 * 上限存在的理由是第 1 条：术语表要占上下文，而这个模型的窗口本来就不打算塞满。
 * 满了时留下的是**较长的源词**——长词更特指，短词更可能是碰巧命中的常用字。
 */
export const MAX_GLOSSARY_ENTRIES = 30;

/** 备注截断长度。它是给模型的一句提示，不是条目正文。 */
const NOTE_CHARS = 24;

function shortNote(summary: string): string | undefined {
  const one = summary.replace(/\s+/g, " ").trim();
  if (!one) return undefined;
  return one.length > NOTE_CHARS ? one.slice(0, NOTE_CHARS) + "…" : one;
}

/**
 * 「翻译词典」条目的标记名。
 *
 * 别名通道一个条目只能表达一个译名；作者手里现成的对照词表需要一个整批的家。
 * **名字或任一别名**等于这个词的条目（任何分类下，可以有多个）的**正文**按
 * {@link parseDictBody} 解析成词条，和别名通道合并。走别名是让条目名保持
 * 自由——「词典·人名」「词典·地名」各挂一个「翻译词典」别名即可。精确匹配
 * 而不是靠格式嗅探：一段碰巧含 `A->B` 的普通条目正文不该悄悄变成词典。
 */
export const DICT_ENTITY_NAME = "翻译词典";

/** 这个条目是不是一本翻译词典。 */
export function isDictEntity(e: Pick<LoreEntity, "name" | "aliases">): boolean {
  if (e.name.trim() === DICT_ENTITY_NAME) return true;
  return (e.aliases ?? []).some((a) => a.trim() === DICT_ENTITY_NAME);
}

/**
 * 把「翻译词典」条目的正文解析成词条。
 *
 * 一行一条 `原文->译文 #备注`（就是 Sakura 的术语表格式，作者写下的即模型看到
 * 的）。宽容三件事：`→` 当 `->` 用、行首的 markdown 列表符号、`#备注` 可省。
 * 其余行（标题、说明文字、空行）静默跳过——正文允许夹杂说明。
 */
export function parseDictBody(body: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.、])\s+/, "");
    const m = line.match(/^(.+?)\s*(?:->|→)\s*(.+)$/);
    if (!m) continue;
    const src = m[1].trim();
    let rest = m[2];
    let note: string | undefined;
    const hash = rest.indexOf("#");
    if (hash >= 0) {
      note = shortNote(rest.slice(hash + 1));
      rest = rest.slice(0, hash);
    }
    const dst = rest.trim();
    if (!src || !dst || src === dst) continue;
    out.push(note ? { src, dst, note } : { src, dst });
  }
  return out;
}

/**
 * 这一块用得上的词条。
 *
 * 方向是**别名（原文写法）→ 条目名（作者的译名）**：作者翻一本日文小说时，
 * 条目名是他定的中文名，别名里放着原文写法。所以只有在原文里真的出现过的别名
 * 才是源词，而这正好就是"命中"。
 *
 * `dict` 是「翻译词典」条目正文里解析出的词条（调用方在运行开始时读一次，
 * 见 `tool.loadTranslateDict`），命中筛选和别名通道同一条规则。同一个源词
 * 两边都有时**词典赢**——那一行是作者专门为翻译写下的对应关系，别名只是顺带的。
 */
export function collectGlossary(
  index: LoreIndex,
  text: string,
  dict: readonly GlossaryEntry[] = [],
): GlossaryEntry[] {
  const seen = new Set<string>();
  const entries: GlossaryEntry[] = [];

  for (const e of dict) {
    const src = e.src.trim();
    const dst = e.dst.trim();
    if (!src || !dst || src === dst || seen.has(src)) continue;
    if (!text.includes(src)) continue;
    seen.add(src);
    entries.push({ src, dst, note: e.note });
  }

  for (const list of Object.values(index)) {
    for (const entity of list) {
      // 词典条目自身不进别名通道：它的名字和别名是给作者找条目用的，不是译名。
      if (isDictEntity(entity)) continue;
      const dst = entity.name.trim();
      if (!dst) continue;
      for (const raw of entity.aliases ?? []) {
        const src = raw.trim();
        // src === dst 的条目什么都不表达，还会占一行；别名为空同理。
        if (!src || src === dst || seen.has(src)) continue;
        if (!text.includes(src)) continue;
        seen.add(src);
        entries.push({ src, dst, note: shortNote(entity.summary ?? "") });
      }
    }
  }

  // 长词优先：既是取舍时保留谁的依据，也让格式化后的表顺序和强制替换的顺序一致。
  // 同长时按码元比，不用 localeCompare —— 后者的结果取决于运行环境的 locale，
  // 而这是一条数据管线：同一份知识库在两台机器上必须切出同一张表。
  entries.sort((a, b) => b.src.length - a.src.length || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
  return entries.slice(0, MAX_GLOSSARY_ENTRIES);
}

/** Sakura 的术语表格式：一行一条 `src->dst #备注`。 */
export function formatGlossary(entries: readonly GlossaryEntry[]): string {
  return entries
    .map((e) => (e.note ? `${e.src}->${e.dst} #${e.note}` : `${e.src}->${e.dst}`))
    .join("\n");
}

/**
 * 受保护的片段：URL、markdown 链接/图片的目标、行内代码。
 *
 * 捕获组是有意的——`String.split` 会把捕获到的分隔符一并留在结果里，于是奇数位
 * 就是"不许动"的片段，偶数位是正文。
 */
const PROTECTED = /(`[^`]*`|\]\([^)]*\)|https?:\/\/\S+)/g;

function replaceOutside(text: string, apply: (s: string) => string): string {
  return text
    .split(PROTECTED)
    .map((part, i) => (i % 2 === 1 ? part : apply(part)))
    .join("");
}

/**
 * 在译文上落实术语表 —— 模型漏替的地方由这里补上。
 *
 * 词条按源词长度降序处理（`collectGlossary` 已经排好），见文件头第 3 条。
 */
export function enforceGlossary(out: string, entries: readonly GlossaryEntry[]): string {
  if (!entries.length) return out;
  const ordered = [...entries].sort((a, b) => b.src.length - a.src.length);
  return replaceOutside(out, (segment) => {
    let s = segment;
    for (const e of ordered) {
      if (!e.src || e.src === e.dst) continue;
      s = s.split(e.src).join(e.dst);
    }
    return s;
  });
}
