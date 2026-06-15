import { useEffect, useState } from "react";
import "./styles/global.css";
import { SideTabBar } from "./components/layout/SideTabBar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { RightPanel } from "./components/layout/RightPanel";
import { StatusBar } from "./components/layout/StatusBar";
import { SettingsModal } from "./components/settings/SettingsModal";
import { useAppStore } from "./stores/appStore";

// Auto-collapse panels when viewport is too narrow to show the editor
const COLLAPSE_SIDEBAR_BELOW = 900;
const COLLAPSE_RIGHT_BELOW = 700;

export default function App() {
  const { setSidebarCollapsed, setRightPanelCollapsed } = useAppStore();
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      setSidebarCollapsed(w < COLLAPSE_SIDEBAR_BELOW);
      setRightPanelCollapsed(w < COLLAPSE_RIGHT_BELOW);
    };
    onResize();
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
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <SideTabBar />
        <Sidebar />
        <EditorArea />
        <RightPanel />
      </div>
      <StatusBar onOpenSettings={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
