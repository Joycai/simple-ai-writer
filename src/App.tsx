import { useEffect, useState } from "react";
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
import { fillLayer, springScreen, viewSlide } from "./lib/motion";

export default function App() {
  const {
    sidebarWidth, setSidebarWidth,
    sidebarCollapsed,
    mainView,
    showCommandPalette, setShowCommandPalette,
    setShowAiDrawer,
  } = useAppStore();
  const { loadConfig } = useAiStore();
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    loadConfig();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global ⌘K / Ctrl+K to open command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowCommandPalette(!showCommandPalette);
      } else if (e.key === "Escape") {
        setShowCommandPalette(false);
        setShowAiDrawer(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCommandPalette, setShowCommandPalette, setShowAiDrawer]);

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
        <IconRail onOpenSettings={() => setShowSettings(true)} />
        {!sidebarCollapsed && mainView === "editor" && <Sidebar />}
        {!sidebarCollapsed && mainView === "editor" && (
          <ResizeHandle onDelta={(d) => setSidebarWidth((prev) => prev + d)} />
        )}

        <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>
          <AnimatePresence initial={false}>
            <motion.div
              key={mainView}
              variants={viewSlide}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={springScreen}
              style={fillLayer}
            >
              {mainView === "editor" && <EditorArea />}
              {mainView === "lore-wall" && <LoreWall />}
              {mainView === "outline-full" && <OutlineFullView />}
            </motion.div>
          </AnimatePresence>
        </div>

        <AiRail />
      </div>

      <AnimatePresence>
        {showSettings && <SettingsModal key="settings" onClose={() => setShowSettings(false)} />}
      </AnimatePresence>
      <AiDrawer />
      <InlineAiBubble />
      <CommandPalette />
      <Onboarding />
    </div>
    </MotionConfig>
  );
}

