import { create } from "zustand";
import {
  scanLore,
  scanEntity,
  createEntity,
  loadPinnedLore,
  moveEntitiesToCategory,
  readEntityFile,
  repointPins,
  savePinnedLore,
  writeEntityFile,
  parseDetailMode,
  LORE_DETAIL_MODE_PREF,
  type CategoryMove,
  type LoreIndex,
  type LoreEntity,
  type LoreEntityAddress,
  type CategoryId,
  type LoreDetailMode,
} from "../lib/lore";
import {
  concreteScopeCollections,
  parseScopePref,
  serializeScope,
  type LoreScope,
} from "../lib/lore";
import { makeDir, renamePath } from "../lib/fs/fileio";
import { deletePref, LORE_SCOPE_PREFIX, readPref, writePref } from "../lib/prefs";

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
   * 详情页此刻的看法：阅读（书页）或管理（三栏台）。全局偏好
   * `app:loreDetailMode`，缺席＝阅读（见 lib/lore/readView）。
   *
   * 不挂在 appStore 的 `reloadFromPrefs` 上：`openDetail` 每次打开都从偏好重读，
   * 配置导入或另一个实例写下的值最迟在下一次点开卡片时生效——模式只在详情开着时
   * 才被消费，比让三处导入点各记一笔便宜。`detailEditing` 与它正交：编辑表单在
   * 两种看法之上（右键「编辑」直达表单，不改这里）。
   */
  detailMode: LoreDetailMode;
  /**
   * A passage handed to the wall's AI-extract modal, waiting for it to mount.
   *
   * 提取为设定 is invoked from the editor's floating toolbar, which is a
   * different screen from the one that owns the modal — so the text travels
   * through the store rather than through props. Consumed (and cleared) by
   * LoreWall the moment it opens the generator; null the rest of the time.
   */
  pendingExtract: string | null;
  /**
   * 生效中的**取材范围**：一组集合名的并集，或 null ＝ 全部（见 lib/lore/collections）。
   *
   * 按项目持久化（`lore:scope:<projectPath>`，存 JSON 数组）。住在 loreStore 而不是
   * appStore，因为它说的是知识库的一个子集是哪些；每个 AI 入口在组装上下文时读它，
   * 而不是各自记一份。
   */
  scope: LoreScope;

  scanProject: (projectPath: string) => Promise<void>;
  /**
   * 只重读**一个条目**的文件夹并换进索引——代理的写工具在一次改动没离开条目
   * 文件夹时走这条（`ToolContext.onLoreChanged` 带着条目地址来）。全量
   * `scanProject` 对几百个条目是上千次串行 IPC，而它跟在**每一次**写工具调用
   * 后面；改一句话不该付整个知识库的账。
   *
   * 与全量扫描排在同一条队列里，所以 `await` 到的保证不变：索引至少和调用那一刻
   * 的磁盘一样新。排队中尚未开始的全量扫描顺带就读到这次写入，直接共用；索引不是
   * 这个项目的、或条目不在快照说的位置（快照与磁盘对不上），退回全量扫描——多走
   * 一遍总好过拼错。
   */
  refreshEntity: (projectPath: string, target: LoreEntityAddress) => Promise<void>;
  /**
   * 同一件事的批量版：一次归集、一次集合改名/删除会改到 N 条，而它们仍然全在自己
   * 的文件夹里。逐条调 `refreshEntity` 会排 N 次队（每次一个 `set`，界面重渲染
   * N 次）；这里一次读完、一次换进去。N 为 0 时什么都不做。
   */
  refreshEntities: (projectPath: string, targets: readonly LoreEntityAddress[]) => Promise<void>;
  /** 切换取材范围并记住（null 或空 ＝ 全部）。 */
  setScope: (projectPath: string | null, scope: LoreScope) => void;
  /** Ask the lore wall to open AI-extract seeded with this passage. */
  requestExtract: (text: string) => void;
  /** Read the staged passage exactly once. */
  takePendingExtract: () => string | null;
  openDetail: (dirPath: string | null, editing?: boolean) => void;
  /** 切换阅读/管理并记住（全局，不分项目）。 */
  setDetailMode: (mode: LoreDetailMode) => void;
  selectEntity: (entity: LoreEntity) => Promise<void>;
  selectFile: (filename: string) => Promise<void>;
  setFileContent: (content: string) => void;
  saveNow: () => Promise<void>;
  createNewEntity: (projectPath: string, category: CategoryId, id: string, name: string) => Promise<void>;
  deleteEntity: (projectPath: string, entity: LoreEntity) => Promise<void>;
  /**
   * 把一批条目搬进另一个分类（知识库墙多选之后的那一下）。返回真搬了哪些（旧 → 新
   * dirPath）、跳过多少（本来就在那儿）、哪几条没搬成——三样界面要分开说。
   *
   * `moves` 而不是一个计数：调用方的选中态也是按 dirPath 存的，搬完不跟着改就会整批
   * 落空，而作者刚搬错了一批时最想要的正是「原样选中、再搬回去」。
   */
  moveToCategory: (
    projectPath: string,
    entities: readonly LoreEntity[],
    category: CategoryId,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<{ moves: CategoryMove[]; skipped: number; failed: string[] }>;
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
/** Which project the installed index describes — `refreshEntity` must not patch another's. */
let scannedPath: string | null = null;

/**
 * The full walk, under the loading flag. Only ever run from inside the queue
 * (`scanProject`'s walk, or `refreshEntity` falling back to it).
 */
async function walkProject(projectPath: string): Promise<void> {
  activeScans++;
  useLoreStore.setState({ isLoading: true });
  try {
    // 范围随索引一起装载：扫描是「换项目了」唯一必经的地方，而范围是按项目存的。
    // 反复扫描同一个项目读到的是同一个值（setScope 同时写盘与写 state），所以
    // 这里不会把会话中途的切换覆盖掉。`parseScopePref` 兼容旧的单集合裸字符串。
    const scope = parseScopePref(readPref(`${LORE_SCOPE_PREFIX}${projectPath}`));
    const index = await scanLore(projectPath);
    scannedPath = projectPath;
    useLoreStore.setState({ index, scope });
  } finally {
    if (--activeScans === 0) useLoreStore.setState({ isLoading: false });
  }
}

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
  detailMode: parseDetailMode(readPref(LORE_DETAIL_MODE_PREF)),
  pendingExtract: null,
  scope: null,

  requestExtract: (text) => set({ pendingExtract: text }),
  takePendingExtract: () => {
    const text = get().pendingExtract;
    if (text !== null) set({ pendingExtract: null });
    return text;
  },

  openDetail: (dirPath, editing = false) =>
    set({
      detailPath: dirPath,
      detailEditing: editing,
      // 打开时重读，不只信内存值 —— 见 detailMode 的注释。
      detailMode: parseDetailMode(readPref(LORE_DETAIL_MODE_PREF)),
    }),

  setDetailMode: (mode) => {
    set({ detailMode: mode });
    writePref(LORE_DETAIL_MODE_PREF, mode);
  },

  scanProject: (projectPath) => {
    // Share a scan that is queued but not yet reading disk — see the note above.
    if (queued && queuedPath === projectPath) return queued;

    const token = {};
    const walk = () => {
      // Claimed here, not when scheduled: this scan's view of disk is fixed
      // from now on, so a caller arriving later must schedule its own.
      if (queuedToken === token) { queued = null; queuedToken = null; queuedPath = null; }
      return walkProject(projectPath);
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

  refreshEntity: (projectPath, target) => get().refreshEntities(projectPath, [target]),

  refreshEntities: (projectPath, targets) => {
    // 同一条目被列两次（归入 A 又移出 B 这种）只读一遍。
    const wanted = new Map<string, LoreEntityAddress>();
    for (const t of targets) wanted.set(t.dirPath, t);
    if (wanted.size === 0) return Promise.resolve();

    // A full scan that is queued but not yet reading disk will see this write
    // too — same sharing rule as scanProject, same reason it is safe.
    if (queued && queuedPath === projectPath) return queued;

    const patch = async () => {
      // Decided here, inside the queue, not when scheduled: a project switch
      // ahead of us in the chain would otherwise be patched with the previous
      // project's entity. And `walkProject` directly rather than `scanProject`
      // — scheduling behind `chain` from inside it would wait on itself.
      if (scannedPath !== projectPath) return walkProject(projectPath);
      // 全部读完再动索引，`get().index` 才只在 await 之后读一次——和单条版本
      // 一样的理由，只是这里有 N 个 await 要跨过去。
      const fresh: { target: LoreEntityAddress; entity: LoreEntity }[] = [];
      for (const target of wanted.values()) {
        fresh.push({ target, entity: await scanEntity(target.category, target.id, target.dirPath) });
      }
      const index = get().index;
      const patched: LoreIndex = {};
      for (const { target, entity } of fresh) {
        const list = patched[target.category] ?? index[target.category];
        // The run's snapshot and the index disagree on where this entity is:
        // one more walk is cheaper than being wrong about a folder.
        if (!list) return walkProject(projectPath);
        const at = list.findIndex((e) => e.dirPath === target.dirPath);
        if (at < 0) return walkProject(projectPath);
        const next = patched[target.category] ?? list.slice();
        next[at] = entity;
        patched[target.category] = next;
      }
      set({ index: { ...index, ...patched } });
    };

    const promise = chain.then(patch, patch);
    chain = promise.catch(() => {});
    return promise;
  },

  setScope: (projectPath, scope) => {
    const serialized = serializeScope(scope); // 归一化 + JSON；空/无效 → null
    const next = serialized ? parseScopePref(serialized) : null;
    set({ scope: next });
    if (!projectPath) return;
    const key = `${LORE_SCOPE_PREFIX}${projectPath}`;
    // 「全部」写成删除这一行，而不是存一个空串：缺席本来就是默认值，留一行空的只会
    // 让项目被删掉之后的清理工作多认一种形态。
    if (serialized) writePref(key, serialized);
    else deletePref(key);
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
    // 归进当前取材范围里的所有**实集合**：范围生效时新建的条目若落成「未归集」，
    // 它会立刻从作者刚刚建它的那面墙上消失（agent 侧同理，见 writeTools 的
    // create_lore_entity）。范围只含「未归集」或为 null 时归零 —— 那本来就在范围内。
    const { scope } = get();
    await createEntity(projectPath, category, id, name, concreteScopeCollections(scope));
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

  moveToCategory: async (projectPath, entities, category, onProgress) => {
    const { moves, skipped, failed } = await moveEntitiesToCategory(projectPath, entities, category, onProgress);
    // 置顶跟着搬。顺序是「先重指、再重扫」：墙上的置顶记号是按 `index` 重算的
    // （LoreWall 的 pinnedDirs），扫描在后，作者就不会看见中间那一帧「置顶没了」。
    if (moves.length > 0) {
      savePinnedLore(projectPath, repointPins(loadPinnedLore(projectPath), moves));
    }
    await get().scanProject(projectPath);
    // 详情页握的是 dirPath，被搬走的那一条得跟过去而不是被关掉——作者看的还是同一条
    // 条目，关掉它等于说「你刚才那下把它弄丢了」。编辑区的 selectedEntity 同理。
    const relocate = (dir: string | null | undefined) =>
      dir ? (moves.find((m) => m.from === dir)?.to ?? dir) : dir;
    const { detailPath, selectedEntity } = get();
    const nextDetail = relocate(detailPath);
    if (nextDetail !== detailPath) set({ detailPath: nextDetail ?? null });
    if (selectedEntity && moves.some((m) => m.from === selectedEntity.dirPath)) {
      const moved = get().index[category]?.find((e) => e.dirPath === relocate(selectedEntity.dirPath));
      set({ selectedEntity: moved ?? null, ...(moved ? {} : { selectedFile: null, fileContent: "" }) });
    }
    return { moves, skipped, failed };
  },
}));
