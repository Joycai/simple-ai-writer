/**
 * 置顶条目的读写——AI 面板勾选的那份「这次一定要带上」的清单。
 *
 * 从 AiPanel 里搬出来，是因为知识库墙也要读它：取材范围生效时，被置顶的条目即使
 * 在围栏外也照常进上下文，墙上必须把这件事画出来（设计稿 03 屏 25 的「◆ 你已置顶 ·
 * 越栏生效」）。两处各存一份就会出现「面板说置顶了、墙上说没有」。
 *
 * 按项目一行（`ai:pinnedLore:<projectPath>`）。键里带绝对路径，作者一挪文件夹就不再
 * 匹配——`lib/prefs` 的 `prunePrefsWithPrefix` 负责收尸。
 */

import { PINNED_LORE_PREFIX, readPref, writePref } from "../prefs";

export function loadPinnedLore(projectPath: string | null): string[] {
  if (!projectPath) return [];
  try {
    const raw = readPref(`${PINNED_LORE_PREFIX}${projectPath}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function savePinnedLore(projectPath: string | null, paths: string[]): void {
  if (!projectPath) return;
  writePref(`${PINNED_LORE_PREFIX}${projectPath}`, JSON.stringify(paths));
}

/**
 * 置顶串里**条目**那一层的 dirPath 集合。
 *
 * 置顶项可能是 `"<dirPath>"` 也可能是 `"<dirPath>#<facet>"`（见 loreSelect 的
 * `parsePins`）。墙上问的是「这个条目越不越栏」，特征级的置顶同样让整条越栏——
 * 摘掉 `#` 后缀是这里唯一要做的事。
 */
export function pinnedEntityDirs(pins: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of pins) out.add(splitPin(raw).dir);
  return out;
}

/**
 * 一条置顶拆成「条目目录」和「特征后缀」。
 *
 * 两个读置顶的地方（问「这条越不越栏」和「搬家之后它指哪」）必须用同一条拆法，否则
 * 一个把 `…/角色/凯尔#外袍` 当条目目录、另一个当特征，结果是重指之后墙上还画着旧的。
 */
function splitPin(raw: string): { dir: string; facet: string } {
  const hash = raw.lastIndexOf("#");
  return hash > 0 && hash < raw.length - 1
    ? { dir: raw.slice(0, hash), facet: raw.slice(hash) }
    : { dir: raw, facet: "" };
}

/**
 * 条目搬家之后把置顶重新指过去。
 *
 * 置顶的键是**绝对路径**，而改分类（或改名）会把整个条目文件夹挪走——不重指的话，
 * 批量移动 20 条就等于静默取消这 20 条的置顶。作者不会收到任何提示，要等到下一次运行
 * 读到一段没带人设的正文才发现，那时已经很难把两件事联系起来。
 *
 * 纯函数：读写 prefs 的那一步留给调用方，这样它可以被单测，也可以在一次搬家里只写一次盘。
 * 特征后缀原样带过去——搬家改的是条目住在哪，不是它有哪些特征。
 */
export function repointPins(
  pins: readonly string[],
  moves: readonly { from: string; to: string }[],
): string[] {
  if (moves.length === 0) return [...pins];
  const byFrom = new Map(moves.map((m) => [m.from, m.to]));
  return pins.map((raw) => {
    const { dir, facet } = splitPin(raw);
    const to = byFrom.get(dir);
    return to ? `${to}${facet}` : raw;
  });
}
