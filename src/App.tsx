import { useEffect, useRef } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import "./styles/global.css";
import { TitleBar } from "./components/layout/TitleBar";
import { WebviewCapsNotice } from "./components/common/WebviewCapsNotice";
import { IconRail } from "./components/layout/IconRail";
import { AiRail } from "./components/layout/AiRail";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { ResizeHandle } from "./components/layout/ResizeHandle";
import { SettingsPage } from "./components/settings/SettingsPage";
import { AiDrawer } from "./components/ai/AiDrawer";
import { ChatSwitchGuard } from "./components/ai/ChatSwitchGuard";
import { InlineAiBubble } from "./components/ai/InlineAiBubble";
import { LoreWall } from "./components/lore/LoreWall";
import { LibraryView } from "./components/library/LibraryView";
import { CommandPalette } from "./components/command/CommandPalette";
import { SyncPreviewModal } from "./components/sync/SyncPreviewModal";
import { ConfigRestoreModal } from "./components/sync/ConfigRestoreModal";
import { Onboarding } from "./components/onboarding/Onboarding";
import { clampSidebarWidth, useAppStore } from "./stores/appStore";
import { useAiStore } from "./stores/aiStore";
import { useMainView, useProjectStore } from "./stores/projectStore";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useWindowCloseFlush } from "./useWindowCloseFlush";
import { useExternalFileRefresh } from "./useExternalFileRefresh";
import { usePrefsFocusSync } from "./usePrefsFocusSync";
import { useWindowTitle } from "./useWindowTitle";
import { launchProjectPath } from "./lib/instance";
import { installCitationNavigation } from "./lib/lore/citations";
import { installNavigationHistory } from "./stores/navStore";
import { fillLayer, springScreen, useMotionPreset, viewSlide } from "./lib/motion";

export default function App() {
  const {
    sidebarWidth, setSidebarWidth,
    sidebarCollapsed,
    mainView: storedView, setMainView,
    showSettings, settingsTab, openSettings, closeSettings,
  } = useAppStore();

  // Sidebar drag: the width is consumed only as a CSS variable, so the drag
  // writes that variable directly and commits to the store (one set + one
  // preference write) on release. Routing every mousemove through the store
  // re-rendered the whole app tree ~120×/s and queued a SQLite write each time.
  const layoutRef = useRef<HTMLDivElement>(null);
  const dragWidth = useRef<number | null>(null);
  // And the write itself is coalesced to one per frame: `mousemove` is dispatched
  // at the mouse's sampling rate, not the display's, while every write of
  // `--sidebar-width` invalidates style for the whole layout subtree and forces
  // the editor column (CodeMirror included) to relayout. Only one of those per
  // frame can ever be seen, so the rest are pure waste.
  const rafId = useRef<number | null>(null);
  const flushWidth = () => {
    rafId.current = null;
    if (dragWidth.current === null) return;
    layoutRef.current?.style.setProperty("--sidebar-width", `${dragWidth.current}px`);
  };
  const onResizeStart = () => {
    layoutRef.current?.setAttribute("data-resizing", "");
  };
  const onResizeDelta = (d: number) => {
    const cur = dragWidth.current ?? useAppStore.getState().sidebarWidth;
    dragWidth.current = clampSidebarWidth(cur + d);
    if (rafId.current === null) rafId.current = requestAnimationFrame(flushWidth);
  };
  const onResizeEnd = () => {
    // The last move's frame may not have run yet, and the next line puts the
    // 320ms collapse transition back — leaving the gap unwritten would let the
    // sidebar drift on for a third of a second after the button came up.
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    flushWidth();
    layoutRef.current?.removeAttribute("data-resizing");
    if (dragWidth.current !== null) setSidebarWidth(dragWidth.current);
    dragWidth.current = null;
  };
  const { loadConfig } = useAiStore();
  // Not `mainView` from the store — see useMainView: a view whose precondition
  // isn't met (no folder open, for the knowledge base and the library) falls
  // back to the editor.
  const view = useMainView();

  // ...and the store follows that fallback rather than keeping the view it was
  // bounced off. Otherwise a view set while it was gated would still be sitting
  // there when a folder opens, and the author would land somewhere they never
  // asked to go. The rail and ⌘3/⌘4 already refuse; this catches the paths with
  // no button behind them — a citation click, a step Back into a project that
  // has since been closed.
  useEffect(() => {
    if (storedView !== view) setMainView(view);
  }, [storedView, view, setMainView]);

  useEffect(() => {
    loadConfig();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lore-citation clicks navigate from any markdown surface (preview, chat,
  // cards) — one document-level delegate instead of per-component wiring.
  useEffect(() => installCitationNavigation(), []);

  // Back / forward: records where the author has been (whatever moved them
  // there) and binds the mouse's side buttons. Keys live in useGlobalShortcuts.
  useEffect(() => installNavigationHistory(), []);

  // A workspace named on the command line — how a second instance ("open in
  // new window") lands on its project. Consumed once on the Rust side, so
  // StrictMode's doubled run gets null and opens nothing twice.
  useEffect(() => {
    void (async () => {
      const path = await launchProjectPath();
      if (!path) return;
      try {
        const outcome = await useProjectStore.getState().openProject(path);
        // `code <folder>` behaviour: the folder was already open in another
        // window, that window has just been brought forward, and this fresh
        // process was launched *for* that folder — it has nothing to show,
        // so it hands off and leaves rather than lingering as a blank picker.
        if (outcome === "focused-existing") {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().destroy();
        }
      } catch (e) {
        console.warn("[launch] could not open the workspace from the command line:", e);
      }
    })();
  }, []);

  useGlobalShortcuts();
  useWindowCloseFlush();
  // Files added to the project folder from outside the app appear on return.
  useExternalFileRefresh();
  // Preferences another app instance changed appear on return, the same way.
  usePrefsFocusSync();
  // …and this window names itself, so the other instances can list it.
  useWindowTitle();

  const viewVariants = useMotionPreset(viewSlide);

  return (
    <MotionConfig reducedMotion="user">
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        background: "var(--color-bg-base)",
      }}
    >
      <TitleBar />
      {/* Under the TitleBar, above every view: the webview is older than the
          build was made for, so some feature will break when reached. */}
      <WebviewCapsNotice />

      {/* `position: relative` so the settings page can fill exactly this band —
          everything below the TitleBar, which stays put as the drag region. */}
      <div
        ref={layoutRef}
        style={{
          display: "flex",
          flex: 1,
          position: "relative",
          overflow: "hidden",
          ["--sidebar-width" as any]: `${sidebarWidth}px`,
        }}
      >
        <IconRail onOpenSettings={() => openSettings()} />
        {view === "editor" && <Sidebar />}
        {!sidebarCollapsed && view === "editor" && (
          <ResizeHandle onDelta={onResizeDelta} onStart={onResizeStart} onEnd={onResizeEnd} />
        )}

        <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>
          <AnimatePresence initial={false}>
            <motion.div
              key={view}
              variants={viewVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={springScreen}
              style={fillLayer}
            >
              {view === "editor" && <EditorArea />}
              {view === "lore-wall" && <LoreWall />}
              {view === "library" && <LibraryView />}
            </motion.div>
          </AnimatePresence>
        </div>

        <AiRail />

        <AnimatePresence>
          {showSettings && (
            <SettingsPage key="settings" initialTab={settingsTab} onClose={closeSettings} />
          )}
        </AnimatePresence>
      </div>

      <AiDrawer />
      <ChatSwitchGuard />
      <InlineAiBubble />
      <CommandPalette />
      {/* Outside the settings shell on purpose: a sync survives the settings
          page being closed, and the run must keep its progress and its backup
          location on screen until the author dismisses the result. */}
      <SyncPreviewModal />
      <ConfigRestoreModal />
      <Onboarding />
    </div>
    </MotionConfig>
  );
}

