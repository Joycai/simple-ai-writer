import { useEffect, useRef, useState } from "react";
import "./styles/global.css";
import { SideTabBar } from "./components/layout/SideTabBar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { RightPanel } from "./components/layout/RightPanel";
import { ResizeHandle } from "./components/layout/ResizeHandle";
import { StatusBar } from "./components/layout/StatusBar";
import { SettingsModal } from "./components/settings/SettingsModal";
import { useAppStore } from "./stores/appStore";
import { useAiStore } from "./stores/aiStore";

// Auto-collapse panels when viewport is too narrow to show the editor
const COLLAPSE_SIDEBAR_BELOW = 900;
const COLLAPSE_RIGHT_BELOW = 700;

export default function App() {
  const {
    setSidebarCollapsed, setRightPanelCollapsed,
    sidebarWidth, rightPanelWidth,
    sidebarCollapsed, rightPanelCollapsed,
    setSidebarWidth, setRightPanelWidth,
  } = useAppStore();
  const { loadConfig } = useAiStore();
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    loadConfig();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevWidthRef = useRef(window.innerWidth);
  useEffect(() => {
    // Apply the responsive default once on mount…
    setSidebarCollapsed(window.innerWidth < COLLAPSE_SIDEBAR_BELOW);
    setRightPanelCollapsed(window.innerWidth < COLLAPSE_RIGHT_BELOW);

    // …then only force collapse/expand when the width *crosses* a breakpoint, so a
    // manual toggle isn't clobbered on every resize tick.
    const onResize = () => {
      const w = window.innerWidth;
      const prev = prevWidthRef.current;
      if (prev >= COLLAPSE_SIDEBAR_BELOW && w < COLLAPSE_SIDEBAR_BELOW) setSidebarCollapsed(true);
      else if (prev < COLLAPSE_SIDEBAR_BELOW && w >= COLLAPSE_SIDEBAR_BELOW) setSidebarCollapsed(false);
      if (prev >= COLLAPSE_RIGHT_BELOW && w < COLLAPSE_RIGHT_BELOW) setRightPanelCollapsed(true);
      else if (prev < COLLAPSE_RIGHT_BELOW && w >= COLLAPSE_RIGHT_BELOW) setRightPanelCollapsed(false);
      prevWidthRef.current = w;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        background: "var(--color-bg-base)",
      }}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
          "--sidebar-width": `${sidebarWidth}px`,
          "--right-panel-width": `${rightPanelWidth}px`,
        } as React.CSSProperties}
      >
        <SideTabBar />
        <Sidebar />
        {!sidebarCollapsed && (
          <ResizeHandle onDelta={(d) => setSidebarWidth((prev) => prev + d)} />
        )}
        <EditorArea />
        {!rightPanelCollapsed && (
          <ResizeHandle onDelta={(d) => setRightPanelWidth((prev) => prev - d)} />
        )}
        <RightPanel />
      </div>
      <StatusBar onOpenSettings={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
