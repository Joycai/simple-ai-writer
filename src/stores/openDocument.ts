/**
 * The document open in the editor, as the project and the editor see it
 * together: closing it, and the "writing focus" every AI action targets.
 *
 * Both need `projectStore.activeFilePath` (what the author clicked) and
 * `editorStore` (what the buffer holds). They used to live in editorStore,
 * which then imported projectStore while projectStore imported editorStore —
 * an import cycle (docs/feature/code-structure-plan.md P4). Here, above both,
 * neither store imports the other's reader.
 */

import { isImagePath } from "../lib/fs/images";
import { baseName, isSamePath } from "../lib/paths";
import { useEditorStore, type CrumbTraceKind } from "./editorStore";
import { useProjectStore } from "./projectStore";

// ─── Saving and closing the open document ─────────────────────────────────────

/** How long the breadcrumb keeps a trace (a closed dirty document, a failed write). */
const CRUMB_TRACE_MS = 2000;
let crumbTraceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 关掉当前文档：先落盘，再置空，回到空稿页（设计稿 01e 屏 1e）。
 *
 * 三个入口共用它——面包屑末尾的 ×、⌘W、文件树右键的「关闭」——所以留下的痕迹
 * 与写盘时机只有一处定义。**没有模态**：这个应用一直在自动保存，「丢弃」不是它
 * 有的概念，所以脏文档的正确做法是 flush 完再关，而不是问一句。
 *
 * 缓冲区里正好停着要关的那一篇时才动它。作者关掉的如果是一张图片，缓冲区里是
 * 上一篇文档（有意为之，见 {@link WritingFocus}），那次待写的自动保存不能被这
 * 次关闭顺手取消掉。
 */
export async function closeDocument(): Promise<void> {
  const closing = useProjectStore.getState().activeFilePath;
  if (!closing) return;

  const { isDirty, filePath, saveTimer } = useEditorStore.getState();
  const holdsIt = isSamePath(filePath, closing);
  const flushed = holdsIt && isDirty && !!filePath;
  const name = traceName(closing);

  if (holdsIt) {
    if (saveTimer) clearTimeout(saveTimer);
    if (flushed) {
      try {
        await useEditorStore.getState().saveNow();
      } catch {
        // 写盘失败（磁盘满、文件被占用、权限）：**不关**。缓冲区是这几行字唯一
        // 的副本，关掉等于替作者丢稿；saveNow 已经把 isDirty 留成 true，下一次
        // 编辑或 ⌘S 还会重试。
        flashCrumbTrace({ name, kind: "closeFailed" });
        return;
      }
    }
    useEditorStore.setState({
      content: "", filePath: null, headings: [], isDirty: false,
      saveTimer: null, loadError: null,
    });
    useEditorStore.getState().setDocCounts(0, 0);
  }
  useProjectStore.getState().setActiveFilePath(null);

  flashCrumbTrace(flushed ? { name, kind: "closed" } : null);
}

/**
 * ⌘S：立刻把缓冲区写盘。失败时在面包屑尾巴留一道「保存失败 · 名字」——
 * 和关闭时写盘失败同一个位置、同一种琥珀、同一个时长。这个应用没有 toast
 * （`docs/feature/topbar-doc-actions-brief.md`），而没有这一道，作者按下 ⌘S
 * 之后看见的只是保存点照旧琥珀，分不清是没按上还是磁盘拒写。成功不留痕迹：
 * 保存点变回去就是回执，自动保存每两秒都在做同一件事。
 *
 * 名字取**缓冲区**里那一篇，不是 `activeFilePath`：作者看着一张图片按 ⌘S 时，
 * 写的是缓冲区里停着的上一篇（见 {@link WritingFocus}），失败说的也该是它。
 * 原因在 `saveNow` 的 console.error 里；isDirty 由它留成 true，下一次编辑或
 * 再按一次 ⌘S 都会重试。
 */
export async function saveDocument(): Promise<void> {
  const { filePath } = useEditorStore.getState();
  try {
    await useEditorStore.getState().saveNow();
  } catch {
    if (filePath) flashCrumbTrace({ name: traceName(filePath), kind: "saveFailed" });
  }
}

/** 面包屑里的文档名：和面包屑本身一样，`.md` 不显示。 */
function traceName(path: string): string {
  return (baseName(path) || path).replace(/\.md$/i, "");
}

/** 面包屑尾巴上那一道痕迹：写上去，两秒后自己收走。 */
function flashCrumbTrace(trace: { name: string; kind: CrumbTraceKind } | null): void {
  if (crumbTraceTimer) clearTimeout(crumbTraceTimer);
  useEditorStore.setState({ crumbTrace: trace });
  if (!trace) return;
  crumbTraceTimer = setTimeout(
    () => useEditorStore.setState({ crumbTrace: null }),
    CRUMB_TRACE_MS,
  );
}

// ─── Writing focus ────────────────────────────────────────────────────────────

/**
 * The document every AI action targets.
 *
 * `filePath` and `text` are read as a pair from this store on purpose: they are
 * written in a single `set()` inside loadFile, so they can never name two
 * different documents. Composing a focus out of `projectStore.activeFilePath`
 * (set synchronously on click) plus `editorStore.content` (set by an async
 * effect, after flushing the previous file's autosave) *could* — and that window
 * is exactly how a task ends up running the previous chapter's prose against the
 * new chapter's memory and book position.
 */
export interface WritingFocus {
  /** Absolute path of the focused document, or null when none is loaded. */
  filePath: string | null;
  /** That document's current text — always the same document as `filePath`. */
  text: string;
  /**
   * False while the editor has not caught up to the file the author just opened
   * (or is showing something the editor never loads, like an image). AI actions
   * stay disabled until it settles rather than silently using the old document.
   */
  settled: boolean;
  /** The file the author opened, when it differs from the focus. */
  pendingPath: string | null;
}

function deriveFocus(
  filePath: string | null,
  text: string,
  activeFilePath: string | null,
): WritingFocus {
  const settled = isSamePath(activeFilePath, filePath);
  return {
    filePath,
    text,
    settled,
    pendingPath: settled ? null : activeFilePath,
  };
}

/** Non-reactive read, for stores and run-time snapshots. */
export function getWritingFocus(): WritingFocus {
  const { filePath, content } = useEditorStore.getState();
  return deriveFocus(filePath, content, useProjectStore.getState().activeFilePath);
}

/** Reactive read, for components. */
export function useWritingFocus(): WritingFocus {
  const filePath = useEditorStore((s) => s.filePath);
  const text = useEditorStore((s) => s.content);
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  return deriveFocus(filePath, text, activeFilePath);
}

/** True when the author has opened something the editor will never load as text. */
export function focusBlockedByImage(focus: WritingFocus): boolean {
  return !focus.settled && !!focus.pendingPath && isImagePath(focus.pendingPath);
}

/**
 * Resolves `true` once the editor holds `path`, or `false` as soon as it never
 * will: the author opened, closed or deleted something meanwhile (any change
 * of `activeFilePath` away from `path` — `null` included, since every writer
 * of `null` is a real "nothing is focused any more"), the load of `path`
 * failed, or `timeoutMs` passed.
 *
 * For a gesture that opens a file *and* sends a turn about it: `setActiveFilePath`
 * is synchronous, the editor's load is an effect that runs after the commit,
 * and a turn sent between the two snapshots the *previous* document as its
 * focus (the composer has no `settled` gate — the author typing there is
 * already looking at the editor). Waiting here is what keeps 「新建目录说明并
 * 交给助手」 from running on the chapter that was open before the click.
 */
export function whenFocusSettles(path: string, timeoutMs = 5000): Promise<boolean> {
  if (isSamePath(useEditorStore.getState().filePath, path)) return Promise.resolve(true);
  // Call after `setActiveFilePath(path)`: the wait is for the editor to catch
  // up with what the author opened, so a `path` nobody has opened is over
  // before it starts, not something to sit five seconds on.
  if (!isSamePath(useProjectStore.getState().activeFilePath, path)) return Promise.resolve(false);
  // Only an error raised by *this* attempt ends the wait — the previous load
  // of the same file may have failed and left its `loadError` behind.
  const staleError = useEditorStore.getState().loadError;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubEditor();
      unsubProject();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubEditor = useEditorStore.subscribe((s) => {
      if (isSamePath(s.filePath, path)) finish(true);
      else if (s.loadError && s.loadError !== staleError && isSamePath(s.loadError.path, path)) finish(false);
    });
    const unsubProject = useProjectStore.subscribe((s) => {
      if (!isSamePath(s.activeFilePath, path)) finish(false);
    });
  });
}
