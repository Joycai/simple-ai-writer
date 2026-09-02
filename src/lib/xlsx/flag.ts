/**
 * The Beta switch for Excel export (Settings → AI 配置 → 实验室).
 *
 * Its own module for the same reasons `lib/pptx/flag.ts` and `lib/docx/flag.ts`
 * give: it is read from the settings pane and from the agent's tool routing,
 * and one of those is outside React.
 *
 * What the switch gates: whether `export_xlsx` exists in the model's toolset at
 * all (lib/agent/routing.ts). Off is the default, and off means the tool is not
 * merely refused — it is absent, so the model never proposes a feature the
 * author has not turned on.
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:xlsxExportBeta";

export function isXlsxExportEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setXlsxExportEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
