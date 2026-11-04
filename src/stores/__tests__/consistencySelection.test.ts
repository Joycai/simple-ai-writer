import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConsistencyStore } from "../consistencyStore";
import type { ConsistencyReport } from "../../lib/consistency/model";

const editor = vi.hoisted(() => ({ content: "Alpha. Beta.", filePath: "/project/doc.md", setContent: vi.fn() }));
vi.mock("../appStore", () => ({ useAppStore: { getState: () => ({}) } }));
vi.mock("../editorStore", () => ({ useEditorStore: { getState: () => editor } }));
vi.mock("../projectStore", () => ({ useProjectStore: { getState: () => ({ projectPath: "/project" }) } }));
vi.mock("../../lib/notify", () => ({ notify: vi.fn(), notifyApproval: vi.fn(), notifyDone: vi.fn(), notifyError: vi.fn() }));
const original = useConsistencyStore.getState();
const report: ConsistencyReport = {
  issues: [
    { id: "a", title: "First", severity: "conflict", category: "custom", reference: "Source", quote: "Alpha.", suggestion: "One.", line: 1 },
    { id: "b", title: "Second", severity: "warning", category: "custom", reference: "Source", quote: "Beta.", suggestion: "Two.", line: 1 },
  ], passed: [], checkedCount: 2, durationMs: 100, filePath: "/project/doc.md", docChars: 12,
  scope: { kind: "all" }, focus: "", windows: [], uncheckedFrom: null, aborted: false, emptyRun: false,
};
beforeEach(() => {
  editor.content = "Alpha. Beta."; editor.filePath = "/project/doc.md";
  editor.setContent.mockReset(); editor.setContent.mockImplementation((value: string) => { editor.content = value; });
  useConsistencyStore.setState({ report, ignored: new Set(), applied: new Map(), isScanning: false });
});
afterEach(() => useConsistencyStore.setState(original, true));
it("applies only selected suggestions in one editor update and preserves undo", () => {
  expect(useConsistencyStore.getState().applyAll(["b"])).toBe(1);
  expect(editor.content).toBe("Alpha. Two.");
  expect(editor.setContent).toHaveBeenCalledTimes(1);
  expect([...useConsistencyStore.getState().applied.keys()]).toEqual(["b"]);
  expect(useConsistencyStore.getState().undoApply("b")).toBe(true);
  expect(editor.content).toBe("Alpha. Beta.");
});
it("does not write on an empty selection, another document, or during a run", () => {
  expect(useConsistencyStore.getState().applyAll([])).toBe(0);
  editor.filePath = "/project/other.md";
  expect(useConsistencyStore.getState().applyAll(["a"])).toBe(0);
  editor.filePath = "/project/doc.md";
  useConsistencyStore.setState({ isScanning: true });
  expect(useConsistencyStore.getState().applyAll(["a"])).toBe(0);
  expect(editor.setContent).not.toHaveBeenCalled();
});
it("skips ignored and stale quotes even if their IDs were selected earlier", () => {
  editor.content = "Changed. Beta.";
  useConsistencyStore.setState({ ignored: new Set(["b"]) });
  expect(useConsistencyStore.getState().applyAll(["a", "b"])).toBe(0);
  expect(editor.setContent).not.toHaveBeenCalled();
});
