/**
 * 一张被阻塞的卡片（审批 / 方案 / 轮数上限 / 截断）该由哪个界面渲染。
 *
 * 在扮演功能出现之前这个问题不存在：对话助手和任务面板各自把 `agentStore` 的
 * 四个队列**整个**渲染出来，而同一时间通常只有一个在跑，重复显示看不出来。
 * 扮演打破了这个假设——它可以同时跑三个 agent，每个都可能提出自己的改稿请求。
 * 不区分的后果不是难看，是**卡片出现在另一个 tab 里**：作者看到的是旁白停住
 * 不动，而唯一能解开它的按钮在他没打开的那一页上。
 *
 * 规则只有一条，故意做成加法：
 *
 * - **没有 `surface` 的卡片**属于默认界面（对话助手 + 任务面板），行为与从前
 *   完全一致——所以不会有任何既有路径因为这次改动而突然把卡片藏起来。
 * - **带 `surface` 的卡片**只由同名的界面渲染。今天唯一会打标的是扮演面板，
 *   它用 agentId 打标，于是三个并发的 agent 各看各的。
 *
 * 「藏起来」在这里等于「运行永久挂起」，所以默认必须是显示，而不是过滤。
 */

/** 任何一种被阻塞的卡片共有的路由字段。 */
export interface SurfaceTagged {
  /** 拥有这张卡片的界面；缺席表示默认界面。 */
  surface?: string;
}

/**
 * @param surface 当前界面的标识；`null` 表示默认界面（对话助手 / 任务面板）。
 */
export function belongsToSurface(item: SurfaceTagged, surface: string | null): boolean {
  return surface === null ? item.surface === undefined : item.surface === surface;
}

/** 过滤一队卡片到当前界面。 */
export function cardsForSurface<T extends SurfaceTagged>(
  items: readonly T[],
  surface: string | null,
): T[] {
  return items.filter((item) => belongsToSurface(item, surface));
}
