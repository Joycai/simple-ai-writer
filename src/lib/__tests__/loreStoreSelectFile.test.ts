/**
 * loreStore.selectFile / selectEntity — same failed-read fix as editorStore:
 * a read failure must not attach the real filename to empty content, or the
 * next edit's autosave would overwrite the file that actually failed to load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEntityFile: vi.fn(async (_dir: string, _name: string) => "content"),
  writeEntityFile: vi.fn(async (_dir: string, _name: string, _content: string) => {}),
}));
vi.mock("../lore", () => ({
  scanLore: vi.fn(async () => ({})),
  createEntity: vi.fn(),
  readEntityFile: h.readEntityFile,
  writeEntityFile: h.writeEntityFile,
  // Called at store creation (detailMode's initial value).
  parseDetailMode: () => "read",
  LORE_DETAIL_MODE_PREF: "app:loreDetailMode",
}));
vi.mock("../fs/fileio", () => ({ removeDir: vi.fn() }));

import { useLoreStore } from "../../stores/loreStore";
import type { LoreEntity } from "../lore";

const ENTITY = { id: "ava", name: "Ava", category: "characters", dirPath: "/p/lore/characters/ava", mdFiles: [] } as unknown as LoreEntity;

describe("loreStore.selectFile — failed read", () => {
  beforeEach(() => {
    useLoreStore.setState({
      selectedEntity: ENTITY, selectedFile: null, fileContent: "", isDirty: false, saveTimer: null,
    });
    h.writeEntityFile.mockClear();
  });

  it("leaves selectedFile null instead of attaching the failed filename to empty content", async () => {
    h.readEntityFile.mockRejectedValueOnce(new Error("broken"));

    await useLoreStore.getState().selectFile("broken.md");

    const state = useLoreStore.getState();
    expect(state.selectedFile).toBeNull();
    expect(state.fileContent).toBe("");
  });

  it("never schedules an autosave after a failed load", async () => {
    h.readEntityFile.mockRejectedValueOnce(new Error("broken"));
    await useLoreStore.getState().selectFile("broken.md");

    useLoreStore.getState().setFileContent("whatever got typed");
    expect(useLoreStore.getState().saveTimer).toBeNull();

    await useLoreStore.getState().saveNow();
    expect(h.writeEntityFile).not.toHaveBeenCalled();
  });
});
