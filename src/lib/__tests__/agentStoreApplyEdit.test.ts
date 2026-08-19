/**
 * agentStore's approve() -> applyEdit: a propose_edit's `find` text is
 * documented as needing to occur exactly once in the file (see
 * EditProposal.find in agent/registry.ts), but the code never enforced it —
 * it applied at the first match regardless. Phase 5 fix: mirrors
 * rag.ts's resolveEditRange, which already refuses a non-unique match for
 * exactly this reason (repeated lines are ordinary in a draft).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditProposal } from "../agent/registry";

const h = vi.hoisted(() => ({
  content: "",
  writeFile: vi.fn(async (_path: string, _content: string) => {}),
}));

vi.mock("../agent/backup", () => ({ backupFile: vi.fn(async () => null) }));
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async () => h.content),
  writeFile: h.writeFile,
}));
vi.mock("../../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projectPath: "/proj", activeFilePath: null }) },
}));
vi.mock("../../stores/editorStore", () => ({
  useEditorStore: { getState: () => ({ content: "", setContent: vi.fn() }) },
}));

import { useAgentStore } from "../../stores/agentStore";

function proposal(
  find: string,
  replace: string,
  occurrences = 1,
  target?: number | "all",
): EditProposal {
  return { kind: "edit", id: "e1", path: "/proj/writing/a.md", find, replace, occurrences, target };
}

describe("agentStore.approve — applyEdit uniqueness", () => {
  beforeEach(() => {
    h.writeFile.mockClear();
  });

  it("refuses to apply when the find text matches more than once", async () => {
    h.content = "The door creaked. The door creaked. The room was silent.";
    const decision = useAgentStore.getState().requestApproval(
      proposal("The door creaked.", "The door groaned."),
      {},
    );
    await useAgentStore.getState().approve("e1");

    const result = await decision;
    expect(result.approved).toBe(false);
    expect((result as { reason?: string }).reason).toContain("more than once");
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it("applies a targeted edit at the occurrence the card named", async () => {
    h.content = "红色的门。红色的窗。红色的墙。";
    const decision = useAgentStore.getState().requestApproval(
      proposal("红色", "蓝色", 3, 2),
      {},
    );
    await useAgentStore.getState().approve("e1");

    expect((await decision).approved).toBe(true);
    expect(h.writeFile).toHaveBeenCalledWith(
      "/proj/writing/a.md",
      "红色的门。蓝色的窗。红色的墙。",
    );
  });

  it("applies every occurrence for a replace_all edit", async () => {
    h.content = "红色的门。红色的窗。红色的墙。";
    const decision = useAgentStore.getState().requestApproval(
      proposal("红色", "蓝色", 3, "all"),
      {},
    );
    await useAgentStore.getState().approve("e1");

    expect((await decision).approved).toBe(true);
    expect(h.writeFile).toHaveBeenCalledWith(
      "/proj/writing/a.md",
      "蓝色的门。蓝色的窗。蓝色的墙。",
    );
  });

  it("refuses a targeted edit when the author changed the count meanwhile", async () => {
    // The card said 3; by the time they pressed approve there are 2. Applying
    // "the second one" now would land somewhere they never saw.
    h.content = "红色的门。红色的窗。";
    const decision = useAgentStore.getState().requestApproval(
      proposal("红色", "蓝色", 3, 2),
      {},
    );
    await useAgentStore.getState().approve("e1");

    const result = await decision;
    expect(result.approved).toBe(false);
    expect((result as { reason?: string }).reason).toContain("not the 3 shown on the card");
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it("applies normally when the find text is unique", async () => {
    h.content = "The door creaked. The room was silent.";
    const decision = useAgentStore.getState().requestApproval(
      proposal("The door creaked.", "The door groaned."),
      {},
    );
    await useAgentStore.getState().approve("e1");

    const result = await decision;
    expect(result.approved).toBe(true);
    expect(h.writeFile).toHaveBeenCalledWith(
      "/proj/writing/a.md",
      "The door groaned. The room was silent.",
    );
  });
});
