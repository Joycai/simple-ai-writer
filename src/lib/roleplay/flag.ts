/**
 * The Beta switch for 互动式角色扮演创作 (Settings → AI 配置 → 实验室).
 *
 * Its own module rather than a field on a store, for the same reason
 * `lib/pptx/flag` is: it is read from three unrelated places — the settings
 * pane, the AI drawer's tab strip, and `appStore`'s stored-mode resolver — and
 * one of those runs before React does.
 *
 * Off is the default, and off means the tab is *absent* rather than disabled:
 * a mode the author has not turned on should not occupy a tab slot, and the
 * drawer only has room for four.
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:roleplayBeta";

export function isRoleplayEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setRoleplayEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
