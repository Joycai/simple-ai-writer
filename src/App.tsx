import { useEffect } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import "./styles/global.css";
import { TitleBar } from "./components/layout/TitleBar";
import { IconRail } from "./components/layout/IconRail";
import { AiRail } from "./components/layout/AiRail";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { ResizeHandle } from "./components/layout/ResizeHandle";
import { SettingsPage } from "./components/settings/SettingsPage";
import { AiDrawer } from "./components/ai/AiDrawer";
import { InlineAiBubble } from "./components/ai/InlineAiBubble";
import { LoreWall } from "./components/lore/LoreWall";
import { LibraryView } from "./components/library/LibraryView";
import { CommandPalette } from "./components/command/CommandPalette";
import { Onboarding } from "./components/onboarding/Onboarding";
import { useAppStore } from "./stores/appStore";
import { useAiStore } from "./stores/aiStore";
import { useMainView } from "./stores/projectStore";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useWindowCloseFlush } from "./useWindowCloseFlush";
import { useExternalFileRefresh } from "./useExternalFileRefresh";
import { installCitationNavigation } from "./lib/lore/citations";
import { installNavigationHistory } from "./stores/navStore";
import { fillLayer, springScreen, viewSlide } from "./lib/motion";

export default function App() {
  const {
    sidebarWidth, setSidebarWidth,
    sidebarCollapsed,
    showSettings, settingsTab, openSettings, closeSettings,
  } = useAppStore();
  const { loadConfig } = useAiStore();
  // Not `mainView` from the store — see useMainView: a persisted view the active
  // profile has no UI for falls back to the editor.
  const view = useMainView();

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

  useGlobalShortcuts();
  useWindowCloseFlush();
  // Files added to the project folder from outside the app appear on return.
  useExternalFileRefresh();

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

      {/* `position: relative` so the settings page can fill exactly this band —
          everything below the TitleBar, which stays put as the drag region. */}
      <div
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
          <ResizeHandle onDelta={(d) => setSidebarWidth((prev) => prev + d)} />
        )}

        <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>
          <AnimatePresence initial={false}>
            <motion.div
              key={view}
              variants={viewSlide}
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
      <InlineAiBubble />
      <CommandPalette />
      <Onboarding />
    </div>
    </MotionConfig>
  );
}

