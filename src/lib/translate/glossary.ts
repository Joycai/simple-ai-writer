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

import type { LoreIndex } from "../lore/model";

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
 * 这一块用得上的词条。
 *
 * 方向是**别名（原文写法）→ 条目名（作者的译名）**：作者翻一本日文小说时，
 * 条目名是他定的中文名，别名里放着原文写法。所以只有在原文里真的出现过的别名
 * 才是源词，而这正好就是"命中"。
 */
export function collectGlossary(index: LoreIndex, text: string): GlossaryEntry[] {
  const seen = new Set<string>();
  const entries: GlossaryEntry[] = [];

  for (const list of Object.values(index)) {
    for (const entity of list) {
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
