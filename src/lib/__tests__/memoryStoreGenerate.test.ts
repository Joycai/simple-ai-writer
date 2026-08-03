/**
 * memoryStore.generate() — the guard against racing generateForFile (Phase 3
 * fix: it used to check only isGenerating, not chapterGen, so an outline-
 * triggered chapter generation and the active-document "创建摘要" button could
 * both run at once, saving the same memory file twice from stale snapshots).
 */
import { describe, expect, it, vi } from "vitest";

// memoryStore -> projectStore -> appStore, which reads localStorage and
// writes `document` at module load; the test environment is node. Only a
// bare-minimum shape is needed since this test never actually resolves a model.
vi.mock("../../stores/appStore", () => ({
  useAppStore: { getState: () => ({}) },
}));

import { useMemoryStore } from "../../stores/memoryStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { useAiStore } from "../../stores/aiStore";

describe("memoryStore.generate — chapterGen guard", () => {
  it("is a no-op while a chapter generation (generateForFile) is already running", async () => {
    // Wire up enough real state that, WITHOUT the chapterGen guard, execution
    // would proceed past the "no project/file open" checks and reach
    // resolveModel() — which, with no model configured, sets a real error.
    // That's what proves the guard itself is what stops this, not an
    // incidental early exit.
    useProjectStore.setState({ projectPath: "/proj", activeFilePath: "/proj/writing/a.md" });
    useEditorStore.setState({ filePath: "/proj/writing/a.md", content: "irrelevant" });
    useAiStore.setState({ activeModelId: null, memoryModelId: null, models: [], providers: [] });

    useMemoryStore.setState({
      isGenerating: false,
      chapterGen: { path: "/proj/writing/b.md", done: 0, total: 3 },
      error: null,
      notice: null,
    });

    await useMemoryStore.getState().generate();

    expect(useMemoryStore.getState().isGenerating).toBe(false);
    expect(useMemoryStore.getState().error).toBeNull();

    // Clean up so this test's global-store mutations don't leak elsewhere.
    useMemoryStore.setState({ chapterGen: null });
    useProjectStore.setState({ projectPath: null, activeFilePath: null });
    useEditorStore.setState({ filePath: null, content: "" });
  });

  it("sanity check: without a chapterGen guard this setup would set an error", async () => {
    // Same wiring as above, but with chapterGen cleared — proves the state
    // above genuinely reaches resolveModel() when nothing stops it early,
    // so the first test's null error is meaningful rather than incidental.
    useProjectStore.setState({ projectPath: "/proj", activeFilePath: "/proj/writing/a.md" });
    useEditorStore.setState({ filePath: "/proj/writing/a.md", content: "irrelevant" });
    useAiStore.setState({ activeModelId: null, memoryModelId: null, models: [], providers: [] });
    useMemoryStore.setState({ isGenerating: false, chapterGen: null, error: null, notice: null });

    await useMemoryStore.getState().generate();

    expect(useMemoryStore.getState().error).not.toBeNull();

    useProjectStore.setState({ projectPath: null, activeFilePath: null });
    useEditorStore.setState({ filePath: null, content: "" });
    useMemoryStore.setState({ error: null });
  });
});
