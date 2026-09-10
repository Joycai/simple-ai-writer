/**
 * 音频转写的 Beta 开关（设置 → AI 配置 → 实验室）和它的两个输出偏好。
 *
 * 独立模块而不是 store 上的一个字段，理由和 `lib/translate/flag` 一样：它被三个
 * 互不相干的地方读（设置面板、文件树的右键菜单、agent 的工具路由），其中两个在
 * React 之外。
 *
 * 开关管的是**入口存不存在**：Beta 关着，右键菜单里没有「转写为文字」这一项、
 * 模型的工具集里没有 `transcribe_audio`——不是渲染成禁用、不是调用被拒。一个
 * 看得见却永远失败的入口，作者读到的是"应用坏了"。默认关：这个功能只对手里有
 * 录音素材的作者有意义，而它带着一次上传和一笔按秒计的费用。
 * 见 docs/feature/asr/01-execution-plan.md §1 不变量 6。
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:asrBeta";

export function isAsrEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setAsrEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}

const TIMESTAMPS_KEY = "ai:asr:timestamps";

/**
 * 文字稿每段前要不要写 `[mm:ss]`（设置 → 子代理 → 音频转写）。
 *
 * 缺席＝**开**：引用一段采访录音时，时间戳是回去核对原声的唯一线索；不要的
 * 作者删一列比要的作者补一列容易得多。
 */
export function isAsrTimestampsEnabled(): boolean {
  return readPref(TIMESTAMPS_KEY) !== "0";
}

export function setAsrTimestampsEnabled(enabled: boolean): void {
  writePref(TIMESTAMPS_KEY, enabled ? "1" : "0");
}

const DIARIZATION_KEY = "ai:asr:diarization";

/**
 * 说话人分离的**默认值**（设置 → 子代理 → 音频转写）。
 *
 * 缺席＝关：它只对多人对话有意义，单人口述开了只会把每句都标成「说话人 1」。
 * 确认卡 / 审批卡上的那个开关是本次的临时值，初始值从这里来。
 */
export function isAsrDiarizationDefault(): boolean {
  return readPref(DIARIZATION_KEY) === "1";
}

export function setAsrDiarizationDefault(enabled: boolean): void {
  writePref(DIARIZATION_KEY, enabled ? "1" : "0");
}
