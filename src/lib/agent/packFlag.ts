/**
 * 工具包（`run_pack`）的 dev 开关 —— tool-pack-plan.md 分片 2。
 *
 * 默认关，且这一片**不带任何设置 UI**：分片 3 才把 orchestrator 档接进 chat 并
 * 挂上 设置 → 通用 → 实验功能 的 Beta 开关。现在翻开它的唯一途径是代码里调
 * `setToolPackEnabled(true)`（或直接写偏好键），这正是「dev 开关」的意思——
 * 台架过了闸，但真应用里的分发行为还没有实测记录，不该让作者先撞上。
 *
 * 开着时的效果只有一个：`routeTools` 给声明了 `packs: true` 的 surface（今天
 * 只有 chat）追加 `run_pack` 工具。工具面其余不变——chat 仍是全量工具，模型
 * 可以用也可以不用，这让分发行为可以和直接持有工具的行为并排对照。
 *
 * 独立小模块而不是 packs.ts 里的两个函数，理由同 `lib/pptx/flag`：routing 在
 * 每次路由时读它，测试要能把它 mock 掉而不连带 mock 掉 pack 定义。
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:toolPackDev";

export function isToolPackEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setToolPackEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
