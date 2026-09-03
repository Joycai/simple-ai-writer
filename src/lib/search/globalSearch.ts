/**
 * 全局搜索（⌘K）的纯逻辑层：搜什么、怎么排、高亮哪一段。
 *
 * 面板本身只做接线——把 `projectStore.fileTree` / `loreStore.index` /
 * `editorStore.content` / `navStore.past` 递进来，把命中递给渲染。匹配与排序全在
 * 这里，所以它能在 node 下跑测试，而面板换样子（设计稿 21）时一个字都不用动。
 *
 * 三条决定：
 *
 * - **子串 > 词首 > 子序列。** 文档名和条目名上允许子序列（`ch3 ren` 命中
 *   `第三章/人物小传.md` 是 VS Code ⌘P 的肌肉记忆），正文行上**不允许**——一行
 *   几十个字里几乎任何两个字都能按顺序找到，子序列在那里只是噪音。
 * - **空格分词，每个词各自命中。** 一个词可以落在文档名上、另一个落在分组路径上；
 *   全部命中才算命中。
 * - **回传的是区间，不是布尔。** 高亮由区间画，而不是像旧面板那样在渲染时再
 *   `indexOf` 一次查询串——那只会亮第一个子串，子序列和多词一个都亮不出来。
 *
 * 设计：docs/feature/global-search-ui-brief.md
 */
import { dirName, pathKey, projectRelative } from "../paths";

/**
 * The text buffer is searchable only while it belongs to the file the project
 * says is active. File loading is asynchronous, and images deliberately leave
 * the previous text buffer in place, so either path on its own is insufficient.
 */
export function currentTextDocument(
  activePath: string | null,
  loadedPath: string | null,
  content: string,
): { path: string; content: string } | null {
  return activePath && loadedPath && pathKey(activePath) === pathKey(loadedPath)
    ? { path: loadedPath, content }
    : null;
}

// ─── 作用域与前缀 ────────────────────────────────────────────────────────────

export type SearchScope = "all" | "lore" | "files" | "text" | "ai";

/**
 * 首字符 → 作用域。`/` 与 `?` 是旧面板界面上早已画着的两枚 chip（此前从未真的
 * 解析过）；`#` 文档是**暂定**，等设计稿定字——改这一张表就够了。
 */
export const SCOPE_PREFIXES: Readonly<Record<string, SearchScope>> = {
  "/": "lore",
  "#": "files",
  "?": "ai",
};

export interface ParsedQuery {
  scope: SearchScope;
  /** 去掉前缀与首尾空白之后真正拿去匹配的词。 */
  term: string;
  prefix: string | null;
}

export function parseQuery(raw: string, prefixes: Readonly<Record<string, SearchScope>> = SCOPE_PREFIXES): ParsedQuery {
  const s = raw.trimStart();
  const first = s.charAt(0);
  const scope = first ? prefixes[first] : undefined;
  if (scope) return { scope, term: s.slice(1).trim(), prefix: first };
  return { scope: "all", term: s.trim(), prefix: null };
}

// ─── 文本匹配 ────────────────────────────────────────────────────────────────

/** 半开区间 `[start, end)`，按原文的码元位置。 */
export interface MatchRange {
  start: number;
  end: number;
}

export interface TextMatch {
  score: number;
  /** 已合并、按位置排好。 */
  ranges: MatchRange[];
}

export interface MatchOptions {
  /** 找不到子串时是否退而求其次按子序列匹配。默认 true。 */
  subsequence?: boolean;
}

/** 词首：串首，或前一个字符是分隔符。CJK 没有词界，不在这里猜。 */
const BOUNDARY = new Set([" ", "\t", "/", "\\", "_", "-", ".", "·", "、", ",", "，", "(", ")", "（", "）", "[", "]", "【", "】", "「", "」"]);
function atBoundary(text: string, i: number): boolean {
  return i === 0 || BOUNDARY.has(text.charAt(i - 1));
}

function matchToken(lower: string, tok: string, subsequence: boolean): TextMatch | null {
  const idx = lower.indexOf(tok);
  if (idx >= 0) {
    const bonus = idx === 0 ? 30 : atBoundary(lower, idx) ? 20 : 0;
    return { score: 100 + bonus - Math.min(idx, 20), ranges: [{ start: idx, end: idx + tok.length }] };
  }
  if (!subsequence) return null;
  // 贪心从左到右：每个字符取游标之后的第一次出现。连续命中加分，跳过的距离扣分，
  // 但扣分封顶——一个很长的路径不该因为长就永远输给一个短的错误答案。
  const ranges: MatchRange[] = [];
  let cursor = 0;
  let runs = 0;
  let boundaries = 0;
  let gaps = 0;
  let prevEnd = -1;
  for (const ch of tok) {
    const at = lower.indexOf(ch, cursor);
    if (at < 0) return null;
    if (at === prevEnd) {
      runs++;
      ranges[ranges.length - 1].end = at + ch.length;
    } else {
      if (prevEnd >= 0) gaps += at - prevEnd;
      if (atBoundary(lower, at)) boundaries++;
      ranges.push({ start: at, end: at + ch.length });
    }
    prevEnd = at + ch.length;
    cursor = prevEnd;
  }
  return { score: 40 + runs * 6 + boundaries * 8 - Math.min(gaps, 30), ranges };
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: MatchRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function tokenize(term: string): string[] {
  return term.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * `term` 的每个词都在 `text` 里命中才返回；分数是各词之和，区间已合并。
 * 空词返回 null——「没有查询」不是「命中了一切」。
 */
export function matchText(text: string, term: string, opts: MatchOptions = {}): TextMatch | null {
  const tokens = tokenize(term);
  if (tokens.length === 0) return null;
  const lower = text.toLowerCase();
  let score = 0;
  const ranges: MatchRange[] = [];
  for (const tok of tokens) {
    const m = matchToken(lower, tok, opts.subsequence ?? true);
    if (!m) return null;
    score += m.score;
    ranges.push(...m.ranges);
  }
  return { score, ranges: mergeRanges(ranges) };
}

/**
 * 把一整行裁成能放进结果行的一段：以第一个命中为中心开窗，区间随之平移。
 * 裁掉的两头用省略号标出，所以作者知道自己看的是片段。
 */
export function windowAround(text: string, ranges: MatchRange[], maxLen: number): { text: string; ranges: MatchRange[] } {
  if (text.length <= maxLen) return { text, ranges };
  const first = ranges[0]?.start ?? 0;
  let start = Math.max(0, first - Math.floor(maxLen / 3));
  if (start + maxLen > text.length) start = text.length - maxLen;
  const end = start + maxLen;
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const shift = head.length - start;
  const out = ranges
    .filter((r) => r.end > start && r.start < end)
    .map((r) => ({ start: Math.max(r.start, start) + shift, end: Math.min(r.end, end) + shift }));
  return { text: head + text.slice(start, end) + tail, ranges: out };
}

export interface SearchResult<T> {
  hits: T[];
  /** 命中总数（含没进 `hits` 的），给「更多」用。 */
  total: number;
}

// ─── 文档 ────────────────────────────────────────────────────────────────────

/** 文件树节点的结构形状（与 `lib/project` 的 `FileNode` 同形，这里不依赖它）。 */
export interface FileNodeLike {
  name: string;
  path: string;
  is_dir: boolean;
  children?: readonly FileNodeLike[] | null;
}

export interface FileHit {
  path: string;
  name: string;
  /** 相对项目根的所在分组，posix 分隔；根目录下为空串。 */
  dir: string;
  score: number;
  nameRanges: MatchRange[];
  dirRanges: MatchRange[];
}

const NAME_WEIGHT = 1;
const DIR_WEIGHT = 0.6;
const PATH_WEIGHT = 0.5;

/**
 * 每个词依次试名字、分组路径、整条相对路径（后者接住跨过 `/` 的词）；权重递减，
 * 所以「名字里有」永远排在「只在路径里有」前面。目录不参与——搜索找的是能打开的东西。
 */
export function searchFiles(
  nodes: readonly FileNodeLike[],
  root: string | null,
  term: string,
  limit = 8,
): SearchResult<FileHit> {
  const tokens = tokenize(term);
  if (tokens.length === 0) return { hits: [], total: 0 };
  const all: (FileHit & { rel: string })[] = [];
  const walk = (list: readonly FileNodeLike[]) => {
    for (const n of list) {
      if (n.is_dir) { if (n.children) walk(n.children); continue; }
      const rel = (root ? projectRelative(root, n.path) : null) ?? n.name;
      const dir = dirName(rel);
      const nameL = n.name.toLowerCase();
      const dirL = dir.toLowerCase();
      const relL = rel.toLowerCase();
      let score = 0;
      const nameRanges: MatchRange[] = [];
      const dirRanges: MatchRange[] = [];
      let ok = true;
      for (const tok of tokens) {
        const byName = matchToken(nameL, tok, true);
        if (byName) { score += byName.score * NAME_WEIGHT; nameRanges.push(...byName.ranges); continue; }
        const byDir = dir ? matchToken(dirL, tok, true) : null;
        if (byDir) { score += byDir.score * DIR_WEIGHT; dirRanges.push(...byDir.ranges); continue; }
        const byPath = dir ? matchToken(relL, tok, true) : null;
        if (!byPath) { ok = false; break; }
        score += byPath.score * PATH_WEIGHT;
        // 整条路径上的区间拆回两段：`dir.length` 那一位是分隔符，两边都不要。
        const cut = dir.length + 1;
        for (const r of byPath.ranges) {
          if (r.start < dir.length) dirRanges.push({ start: r.start, end: Math.min(r.end, dir.length) });
          if (r.end > cut) nameRanges.push({ start: Math.max(r.start, cut) - cut, end: r.end - cut });
        }
      }
      if (!ok) continue;
      all.push({ path: n.path, name: n.name, dir, rel, score, nameRanges: mergeRanges(nameRanges), dirRanges: mergeRanges(dirRanges) });
    }
  };
  walk(nodes);
  all.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  return { hits: all.slice(0, limit).map(({ rel: _rel, ...h }) => h), total: all.length };
}

// ─── 条目 ────────────────────────────────────────────────────────────────────

export interface LoreLike {
  name: string;
  aliases: readonly string[];
}

export interface LoreHit<E extends LoreLike> {
  entity: E;
  score: number;
  /** 命中的是名字还是某个别名——界面靠它决定高亮画在哪一行。 */
  via: "name" | "alias";
  alias: string | null;
  ranges: MatchRange[];
}

const ALIAS_WEIGHT = 0.9;

export function searchLore<E extends LoreLike>(entities: readonly E[], term: string, limit = 8): SearchResult<LoreHit<E>> {
  if (tokenize(term).length === 0) return { hits: [], total: 0 };
  const all: LoreHit<E>[] = [];
  for (const e of entities) {
    const byName = matchText(e.name, term);
    if (byName) { all.push({ entity: e, score: byName.score, via: "name", alias: null, ranges: byName.ranges }); continue; }
    let best: LoreHit<E> | null = null;
    for (const a of e.aliases) {
      const m = matchText(a, term);
      if (m && (!best || m.score * ALIAS_WEIGHT > best.score)) {
        best = { entity: e, score: m.score * ALIAS_WEIGHT, via: "alias", alias: a, ranges: m.ranges };
      }
    }
    if (best) all.push(best);
  }
  all.sort((a, b) => b.score - a.score || a.entity.name.length - b.entity.name.length || a.entity.name.localeCompare(b.entity.name));
  return { hits: all.slice(0, limit), total: all.length };
}

// ─── 当前文档正文 ────────────────────────────────────────────────────────────

export interface LineHit {
  /** 1 基行号，和编辑器边栏上印的一样。 */
  line: number;
  text: string;
  ranges: MatchRange[];
}

/** 只认子串（见文件头）；按文档顺序返回前 `limit` 行，`total` 数完整篇。 */
export function searchLines(content: string, term: string, limit = 5): SearchResult<LineHit> {
  if (tokenize(term).length === 0) return { hits: [], total: 0 };
  const hits: LineHit[] = [];
  let total = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = matchText(lines[i], term, { subsequence: false });
    if (!m) continue;
    total++;
    if (hits.length < limit) hits.push({ line: i + 1, text: lines[i], ranges: m.ranges });
  }
  return { hits, total };
}

// ─── 最近去过 ────────────────────────────────────────────────────────────────

export type RecentLocation =
  | { kind: "editor"; filePath: string }
  | { kind: "lore"; entityDir: string };

/** `navStore` 的 `NavLocation` 的结构形状——文库那一类没有地址，进不了这张表。 */
export interface NavLocationLike {
  kind: string;
  filePath?: string | null;
  entityDir?: string | null;
}

function toRecent(loc: NavLocationLike): RecentLocation | null {
  if (loc.kind === "editor" && loc.filePath) return { kind: "editor", filePath: loc.filePath };
  if (loc.kind === "lore" && loc.entityDir) return { kind: "lore", entityDir: loc.entityDir };
  return null;
}

function recentKey(r: RecentLocation): string {
  return `${r.kind}:${pathKey(r.kind === "editor" ? r.filePath : r.entityDir)}`;
}

/**
 * 空查询时的那一组：本会话去过的地方，最近的在前，去重，**不含现在所在的那一个**
 * （列出「你就在这里」没有意义），并剔掉已经不存在的（`exists` 由调用方拿文件树和
 * 知识库索引来答——这里不碰盘）。
 */
export function recentLocations(
  past: readonly NavLocationLike[],
  current: NavLocationLike | null,
  opts: { limit?: number; exists?: (loc: RecentLocation) => boolean } = {},
): RecentLocation[] {
  const limit = opts.limit ?? 8;
  const seen = new Set<string>();
  const here = current ? toRecent(current) : null;
  if (here) seen.add(recentKey(here));
  const out: RecentLocation[] = [];
  for (let i = past.length - 1; i >= 0 && out.length < limit; i--) {
    const r = toRecent(past[i]);
    if (!r) continue;
    const key = recentKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    if (opts.exists && !opts.exists(r)) continue;
    out.push(r);
  }
  return out;
}
