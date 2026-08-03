import { useEffect } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import "./styles/global.css";
import { TitleBar } from "./components/layout/TitleBar";
import { IconRail } from "./components/layout/IconRail";
import { AiRail } from "./components/layout/AiRail";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { ResizeHandle } from "./components/layout/ResizeHandle";
import { SettingsModal } from "./components/settings/SettingsModal";
import { AiDrawer } from "./components/ai/AiDrawer";
import { InlineAiBubble } from "./components/ai/InlineAiBubble";
import { LoreWall } from "./components/lore/LoreWall";
import { OutlineFullView } from "./components/outline/OutlineFullView";
import { CommandPalette } from "./components/command/CommandPalette";
import { Onboarding } from "./components/onboarding/Onboarding";
import { useAppStore } from "./stores/appStore";
import { useAiStore } from "./stores/aiStore";
import { useMainView } from "./stores/projectStore";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useWindowCloseFlush } from "./useWindowCloseFlush";
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

  useGlobalShortcuts();
  useWindowCloseFlush();

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

      <div
        style={{
          display: "flex",
          flex: 1,
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
              {view === "outline-full" && <OutlineFullView />}
            </motion.div>
          </AnimatePresence>
        </div>

        <AiRail />
      </div>

      <AnimatePresence>
        {showSettings && (
          <SettingsModal key="settings" initialTab={settingsTab} onClose={closeSettings} />
        )}
      </AnimatePresence>
      <AiDrawer />
      <InlineAiBubble />
      <CommandPalette />
      <Onboarding />
    </div>
    </MotionConfig>
  );
}

