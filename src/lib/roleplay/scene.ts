/**
 * 场次地址 —— `<agentId>#<N>` 的解析与解析。纯函数，不碰盘。
 *
 * ## 场号的定义
 *
 * 场号是**每个 agent 自己的归档序号**，口径就是 `peekNextArchiveNo`（已有文件名
 * 解析出的最大值 + 1，**不是文件个数**）。不存在全局场编号——06 §9 问过「第 3 场
 * 是谁的第 3 场」，答案是「返回 `(agent, 场号)` 二元组就不必回答它」。
 *
 * ## 地址空间是全的
 *
 * `N ≤ 归档数` → `archive/transcript-NN.md`；`N == 当前场号` → 当前这一场；裸
 * `<agentId>` 等价于当前这一场。当前场也有号（＝最大归档号 + 1，和转场稿面上
 * 「当前第 N 场」说的是同一个数），所以模型不需要记「当前场要用另一种写法」这条
 * 特例。
 *
 * ## 按编号匹配，绝不按下标取
 *
 * 作者手删掉中间一场之后归档编号会有洞（`[1, 3]`）。按排序后的下标取，`#2` 会
 * 指到第 3 场——一个看起来完全正常、内容却属于另一场的答案。这和
 * `nextArchiveNo` 不按文件个数数是同一条纪律。
 */

/** `<agentId>#<N>` 拆开之后的样子。`scene: null` = 没写场号（＝当前这一场）。 */
export interface SceneAddress {
  agentId: string;
  scene: number | null;
}

/**
 * 拆一个场次地址。**永不抛**——认不出的后缀当作没写，退回当前这一场，因为
 * 「读到了当前这一场」比「工具报了个错」更接近模型的本意。
 */
export function parseSceneAddress(raw: string): SceneAddress {
  const text = (raw ?? "").trim();
  const hash = text.lastIndexOf("#");
  if (hash < 0) return { agentId: text, scene: null };
  const agentId = text.slice(0, hash).trim();
  const suffix = text.slice(hash + 1).trim();
  if (!/^\d+$/.test(suffix)) return { agentId: agentId || text, scene: null };
  const n = Number(suffix);
  return { agentId, scene: Number.isFinite(n) && n > 0 ? n : null };
}

/** 拼一个场次地址，供工具输出里引用某一场。 */
export function formatSceneAddress(agentId: string, scene: number): string {
  return `${agentId}#${scene}`;
}

/**
 * 当前这一场是第几场。**和 `peekNextArchiveNo` 必须是同一个算法**——两处各算
 * 各的，作者手删过一场归档之后就会错开，而记忆区条目里的「来自第 N 场」是按
 * 转场时那个数写下的。
 */
export function currentSceneNo(archiveNos: readonly number[]): number {
  return archiveNos.reduce((max, n) => Math.max(max, n), 0) + 1;
}

export type ResolvedScene =
  | { kind: "current"; scene: number }
  | { kind: "archived"; scene: number }
  /** 编号不存在（作者手删过，或模型编了一个）。调用方要如实说出来。 */
  | { kind: "unknown"; scene: number };

/**
 * 把一个场号落到具体的一场。
 *
 * `scene` 传 `null`（地址里没写场号）时就是当前这一场。
 */
export function resolveScene(
  archiveNos: readonly number[], scene: number | null,
): ResolvedScene {
  const current = currentSceneNo(archiveNos);
  if (scene === null || scene === current) return { kind: "current", scene: current };
  // 按编号匹配，不按下标——文件名解析出什么就是什么。
  if (archiveNos.includes(scene)) return { kind: "archived", scene };
  return { kind: "unknown", scene };
}
