/**
 * The Beta switch for Word export (Settings → AI 配置 → 实验室).
 *
 * Its own module rather than a field on a store, for the same three reasons
 * `lib/pptx/flag.ts` gives: it is read from the settings pane, from the
 * agent's tool routing, and from the briefing builder, and two of those are
 * outside React.
 *
 * What the switch gates: whether `export_docx` exists in the model's toolset
 * at all (lib/agent/routing.ts), and whether the settings page offers the
 * 排版格式 pane. Off is the default, and off means the tool is not merely
 * refused — it is absent, so the model never proposes a feature the author has
 * not turned on.
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:docxExportBeta";

export function isDocxExportEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setDocxExportEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
