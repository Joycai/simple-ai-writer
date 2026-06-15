import "./styles/global.css";
import { SideTabBar } from "./components/layout/SideTabBar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { RightPanel } from "./components/layout/RightPanel";
import { StatusBar } from "./components/layout/StatusBar";

export default function App() {
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
      <StatusBar />
    </div>
  );
}
