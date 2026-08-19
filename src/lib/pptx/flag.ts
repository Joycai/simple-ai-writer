/**
 * The Beta switch for PPTX export (Settings → 通用 → 实验功能).
 *
 * Its own module rather than a field on a store because it is read from three
 * unrelated places — the settings pane, the HTML preview toolbar, and the
 * agent's tool routing — and two of those are outside React. Same shape as
 * `lib/ai/apiLog`'s switch, for the same reason.
 *
 * What the switch actually gates: whether `export_pptx` exists in the model's
 * toolset at all (lib/agent/routing.ts) and whether the preview offers the
 * button. Off is the default, and off means the tool is not merely refused —
 * it is absent, so the model never proposes something the author has not
 * turned on.
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:pptxExportBeta";

export function isPptxExportEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setPptxExportEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
