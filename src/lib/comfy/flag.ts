/**
 * 本地 ComfyUI 生图的 Beta 开关（设置 → AI 配置 → 实验室）。
 *
 * 独立模块而不是 store 上的一个字段，理由和 `lib/translate/flag` 一样：
 * 设置面板和 ModelDrawer 两个互不相干的地方读它。
 *
 * 它管的事：ModelDrawer 的出图接口下拉里 **"ComfyUI（本地）"这一项存不存在**。
 * 已配好的 comfyui 模型在开关关掉后仍然能用、编辑时仍显示该选项——开关管的
 * 是入口不是既有配置（一个作者辛苦导入的工作流不该因为关了实验开关就变成
 * 无法查看的死数据）。见 docs/feature/comfyui-plan.md §3。
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:comfyuiBeta";

export function isComfyUiEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setComfyUiEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
