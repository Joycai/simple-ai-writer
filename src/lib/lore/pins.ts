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
  for (const raw of pins) {
    const hash = raw.lastIndexOf("#");
    out.add(hash > 0 && hash < raw.length - 1 ? raw.slice(0, hash) : raw);
  }
  return out;
}
