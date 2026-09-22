/**
 * The store side of `ToolContext.appState`: what an agent tool may read of the
 * app's live state, wired to the stores that own it.
 *
 * Tools live in `lib/`, and `lib/` never imports `stores/`
 * (docs/feature/code-structure-plan.md P3). Every surface that starts a run
 * passes this one object, so "which settings does a tool see" has a single
 * answer rather than one per surface. Getters read the store at the moment the
 * tool asks — the same moment the `await import` of the store used to.
 */

import type { ToolAppState } from "../lib/agent/registry";
import { useAiStore } from "./aiStore";
import { currentFormats, useDocFormatStore } from "./docFormatStore";
import { useLoreStore } from "./loreStore";

export const toolAppState: ToolAppState = {
  aiSettings: () => {
    const { models, providers, subAgents } = useAiStore.getState();
    return { models, providers, subAgents };
  },
  docFormats: currentFormats,
  addImitatedFormat: (preset) => useDocFormatStore.getState().addImitated(preset),
  categoryNoteWritten: (categoryId) => useLoreStore.getState().categoryNoteWritten(categoryId),
};
