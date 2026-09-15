/**
 * What has to be re-read after a configuration lands — from a file or from the
 * sync server. One function for both routes: they used to each keep a list, and
 * the server route's list was one line long, so a restore reported 「完成」 over
 * a provider list, model picks and 排版格式 that stayed as they were until the
 * next launch.
 *
 * The order is the point:
 *
 *   1. selections from prefs first — the restore wrote them there, and the
 *      store only reads them at startup;
 *   2. then `loadConfig`, whose stale-id sweep must check *those* ids against
 *      the merged tables (running it first would sweep, and persist, the old ones);
 *   3. then the appearance prefs and the 排版格式 presets, which have no
 *      dependency on either.
 */

import { useAiStore } from "./aiStore";
import { useAppStore } from "./appStore";
import { useDocFormatStore } from "./docFormatStore";

export async function refreshAfterConfigImport(): Promise<void> {
  const ai = useAiStore.getState();
  ai.reloadSelections();
  await ai.loadConfig();
  useAppStore.getState().reloadFromPrefs();
  await useDocFormatStore.getState().reload();
}
