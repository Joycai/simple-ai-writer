/**
 * 助手工具包模式（orchestrator 档）的 Beta 开关 —— tool-pack-plan.md 分片 3
 * （设置 → 通用 → 实验功能）。
 *
 * 开着时 chat 换到 **orchestrator 档**：主控只带查/读/笔记/记忆的轻常驻，写入
 * 全部经 `run_pack` 派给执行代理（`ORCHESTRATOR_PRESET`，见 packs.ts）。Beta
 * 开着时 `run_pack` 必须在场——它是这一档唯一的写路径——所以 routing 的追加
 * 条件读的就是这个开关。
 *
 * 独立小模块而不是 packs.ts 里的两个函数，理由同 `lib/pptx/flag`：routing 在
 * 每次路由时读它，测试要能把它 mock 掉而不连带 mock 掉 pack 定义。
 *
 * （分片 2 曾另有一个 `app:toolPackDev` dev 开关——「全量工具的 chat 多出
 * run_pack」的 A/B 形态。分片 3 上线、Beta 开关进了设置之后它再无产品入口，
 * 已删除；旧偏好键即使残留在 config.db 里也没有任何读者。）
 */

import { readPref, writePref } from "../prefs";

const ORCHESTRATOR_KEY = "app:toolPackOrchestratorBeta";

export function isOrchestratorEnabled(): boolean {
  return readPref(ORCHESTRATOR_KEY) === "1";
}

export function setOrchestratorEnabled(enabled: boolean): void {
  writePref(ORCHESTRATOR_KEY, enabled ? "1" : "0");
}
