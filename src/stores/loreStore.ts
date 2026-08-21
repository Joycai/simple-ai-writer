import { create } from "zustand";
import {
  scanLore,
  createEntity,
  readEntityFile,
  writeEntityFile,
  type LoreIndex,
  type LoreEntity,
  type CategoryId,
} from "../lib/lore";
import { makeDir, renamePath } from "../lib/fs/fileio";

interface LoreState {
  index: LoreIndex;
  selectedEntity: LoreEntity | null;
  selectedFile: string | null;   // filename within entity dir
  fileContent: string;
  isDirty: boolean;
  isLoading: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /**
   * dirPath of the entity open in the wall's detail view; null = the grid.
   * Store-owned rather than local to LoreWall for two reasons: other surfaces
   * open a detail directly (citation clicks), and navigation history has to be
   * able to read *and* restore it (see stores/navStore). An unresolvable path
   * simply renders the grid, so a request made while a scan is still in flight
   * resolves itself when the index lands.
   */
  detailPath: string | null;
  /** Whether that detail view opens straight into edit mode. */
  detailEditing: boolean;
  /**
   * A passage handed to the wall's AI-extract modal, waiting for it to mount.
   *
   * 提取为设定 is invoked from the editor's floating toolbar, which is a
   * different screen from the one that owns the modal — so the text travels
   * through the store rather than through props. Consumed (and cleared) by
   * LoreWall the moment it opens the generator; null the rest of the time.
   */
  pendingExtract: string | null;

  scanProject: (projectPath: string) => Promise<void>;
  /** Ask the lore wall to open AI-extract seeded with this passage. */
  requestExtract: (text: string) => void;
  /** Read the staged passage exactly once. */
  takePendingExtract: () => string | null;
  openDetail: (dirPath: string | null, editing?: boolean) => void;
  selectEntity: (entity: LoreEntity) => Promise<void>;
  selectFile: (filename: string) => Promise<void>;
  setFileContent: (content: string) => void;
  saveNow: () => Promise<void>;
  createNewEntity: (projectPath: string, category: CategoryId, id: string, name: string) => Promise<void>;
  deleteEntity: (projectPath: string, entity: LoreEntity) => Promise<void>;
}

/**
 * Scan scheduling — module-level because it is about the disk, not the view.
 *
 * Scans used to run fire-and-parallel: several lore writes in one agent round
 * started overlapping full walks, and whichever *resolved* last installed its
 * index — not the one that started last. Serializing fixes the ordering and,
 * more importantly, makes `await scanProject()` mean what every caller assumes:
 * the index is at least as fresh as the moment they asked. `syncLore` in the
 * agent's write tools depends on exactly that guarantee.
 *
 * `queued` is shared with any caller that arrives while it is still *waiting*,
 * because a scan that has not begun will read disk strictly after their write.
 * A caller arriving once it has begun queues a fresh one instead. That is what
 * keeps a burst of writes to one extra walk rather than one walk each — and it
 * holds only because the queued scan has genuinely not called `scanLore` yet.
 * Anything that pre-starts it breaks the guarantee silently.
 */
let chain: Promise<void> = Promise.resolve();
/** The scan scheduled but not yet reading disk, if any, and what identifies it. */
let queued: Promise<void> | null = null;
let queuedToken: object | null = null;
/** Which project `queued` will scan — a project switch must not be served the old one. */
let queuedPath: string | null = null;
/** Scans scheduled and not yet finished, so `isLoading` doesn't flicker between them. */
let activeScans = 0;

export const useLoreStore = create<LoreState>((set, get) => ({
  index: {},
  selectedEntity: null,
  selectedFile: null,
  fileContent: "",
  isDirty: false,
  isLoading: false,
  saveTimer: null,
  detailPath: null,
  detailEditing: false,
  pendingExtract: null,

  requestExtract: (text) => set({ pendingExtract: text }),
  takePendingExtract: () => {
    const text = get().pendingExtract;
    if (text !== null) set({ pendingExtract: null });
    return text;
  },

  openDetail: (dirPath, editing = false) => set({ detailPath: dirPath, detailEditing: editing }),

  scanProject: (projectPath) => {
    // Share a scan that is queued but not yet reading disk — see the note above.
    if (queued && queuedPath === projectPath) return queued;

    const token = {};
    activeScans++;
    set({ isLoading: true });

    const walk = async () => {
      // Claimed here, not when scheduled: this scan's view of disk is fixed
      // from now on, so a caller arriving later must schedule its own.
      if (queuedToken === token) { queued = null; queuedToken = null; queuedPath = null; }
      try {
        set({ index: await scanLore(projectPath) });
      } finally {
        if (--activeScans === 0) set({ isLoading: false });
      }
    };

    // `.then(walk, walk)` rather than `.then(walk)`: a scan that failed must not
    // wedge every scan behind it. The rejection still reaches its own caller,
    // while `chain` swallows it so the queue keeps moving.
    const promise = chain.then(walk, walk);
    chain = promise.catch(() => {});
    queued = promise;
    queuedToken = token;
    queuedPath = projectPath;
    return promise;
  },

  selectEntity: async (entity) => {
    // Flush any pending edit on the previously selected file before
    // switching away — otherwise it's silently discarded, the way
    // selectFile and editorStore.loadFile both already guard against.
    const { saveTimer } = get();
    if (saveTimer) {
      clearTimeout(saveTimer);
      await get().saveNow();
    }
    set({ selectedEntity: entity, selectedFile: null, fileContent: "", isDirty: false });
    // Auto-open index.md if it exists
    if (entity.mdFiles.includes("index.md")) {
      await get().selectFile("index.md");
    }
  },

  selectFile: async (filename) => {
    const { selectedEntity, saveTimer } = get();
    if (!selectedEntity) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      await get().saveNow();
    }
    try {
      const content = await readEntityFile(selectedEntity.dirPath, filename);
      set({ selectedFile: filename, fileContent: content, isDirty: false });
    } catch {
      // selectedFile stays null (not `filename`) — setFileContent's autosave
      // gate is `selectedEntity && selectedFile`, so leaving it null prevents
      // a later edit from autosaving near-empty content over a file that
      // actually failed to read. Mirrors editorStore.loadFile's fix.
      set({ selectedFile: null, fileContent: "", isDirty: false });
    }
  },

  setFileContent: (content) => {
    const { saveTimer, selectedEntity, selectedFile } = get();
    if (saveTimer) clearTimeout(saveTimer);

    const timer = selectedEntity && selectedFile
      ? setTimeout(() => void get().saveNow().catch(() => {}), 2000) // saveNow logs; retried on next edit/flush
      : null;

    set({ fileContent: content, isDirty: true, saveTimer: timer });
  },

  saveNow: async () => {
    const { selectedEntity, selectedFile, fileContent, saveTimer } = get();
    // Cancel the real timer, not just the state field — see editorStore's
    // saveNow for why a caller that flushes without pre-clearing it matters.
    if (saveTimer) clearTimeout(saveTimer);
    if (!selectedEntity || !selectedFile) { set({ saveTimer: null }); return; }
    try {
      await writeEntityFile(selectedEntity.dirPath, selectedFile, fileContent);
      // TODO: refresh `index` for this entity. Editing index.md here changes
      // name/aliases/summary on disk but not in the index. A blanket
      // scanProject() is the wrong shape — this runs on a 2s autosave debounce
      // while the author types, so it would walk the whole lore tree every
      // couple of seconds. The right fix is a targeted `rescanEntity(dirPath)`
      // in lib/lore/entity.ts (readEntity is module-private today) spliced into
      // `index`. Not urgent: no component reads this editor path today.
      set({ isDirty: false, saveTimer: null });
    } catch (e) {
      // Keep isDirty true so the unsaved indicator stays truthful and the next
      // edit/flush retries the write — clearing it would silently drop the draft.
      console.error("[loreStore] save failed:", selectedEntity.dirPath, selectedFile, e);
      set({ saveTimer: null });
      throw e;
    }
  },

  createNewEntity: async (projectPath, category, id, name) => {
    await createEntity(projectPath, category, id, name);
    await get().scanProject(projectPath);
    const entity = get().index[category]?.find((e) => e.id === id);
    if (entity) get().selectEntity(entity);
  },

  deleteEntity: async (projectPath, entity) => {
    // 目录移进 `.ai-writer/backups/`，不真删——和删 agent、删记忆区、删文档同一个
    // 规矩。条目正文是作者写的字，而它最可能被删的时刻，恰恰是作者以为自己不再
    // 需要它的时刻。这里曾经是整个删除纪律里唯一的硬删除。
    const backups = `${projectPath}/.ai-writer/backups`;
    await makeDir(backups);
    await renamePath(entity.dirPath, `${backups}/lore-${Date.now()}-${entity.category}-${entity.id}`);
    await get().scanProject(projectPath);
    if (get().selectedEntity?.id === entity.id) {
      set({ selectedEntity: null, selectedFile: null, fileContent: "" });
    }
  },
}));
