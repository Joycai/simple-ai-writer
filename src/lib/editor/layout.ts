/** At least 360 CSS pixels per pane, plus the preview's dividing border. */
const EDITOR_SPLIT_MIN_WIDTH = 721;

export type ViewMode = "split" | "editor" | "preview";

export function canSplitEditor(width: number): boolean {
  return width >= EDITOR_SPLIT_MIN_WIDTH;
}

/** The requested mode survives a temporary shortage of room. */
export function effectiveViewMode(state: { viewMode: ViewMode; canSplit: boolean }): ViewMode {
  return state.viewMode === "split" && !state.canSplit ? "editor" : state.viewMode;
}
