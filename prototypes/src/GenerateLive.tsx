/** Isolated entry: production layout with in-memory fixtures; no project or provider connection. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../src/i18n";
import "../../src/styles/global.css";
import { applyThemeId } from "../../src/lib/theme/scheme";
import { AiPanel } from "../../src/components/ai/AiPanel";
import { useAiStore } from "../../src/stores/aiStore";
import { useAiTaskStore } from "../../src/stores/aiTaskStore";
import { panelDocumentOf, useComposerStore } from "../../src/stores/composerStore";
import { useAppStore } from "../../src/stores/appStore";
import { useProjectStore } from "../../src/stores/projectStore";
import { useEditorStore } from "../../src/stores/editorStore";
import { useLoreStore } from "../../src/stores/loreStore";
import { resolveWorkspace, setActiveWorkspace, BID_PROFILE, WEEKLY_PROFILE, FEEDBACK_PROFILE } from "../../src/lib/profile";

const workspace = resolveWorkspace([BID_PROFILE, WEEKLY_PROFILE, FEEDBACK_PROFILE]);
setActiveWorkspace(workspace);
useProjectStore.setState({ workspace, projectPath: null, activeFilePath: "/fixture/实施方案.md" });
useEditorStore.setState({ filePath: "/fixture/实施方案.md", content: "项目实施以客户需求为基础，分阶段交付成果。" });
useAiStore.setState({
  activeModelId: "fixture", models: [{ id: "fixture", providerId: "fixture", modelId: "gpt-5", name: "Review model", type: "text", enabled: true, priceIn: 0, priceOut: 0, priceCachedIn: 0, contextSize: 1048576, maxOutput: 2000 }],
  providers: [{ id: "fixture", name: "Review", baseUrl: "https://invalid.invalid", apiStandard: "openai", createdAt: 0 }],
  updateModel: async model => { useAiStore.setState({ models: [model] }); },
});
useAiTaskStore.setState({ runTask: async () => {} });
useComposerStore.setState({
  panelTask: "continue",
  setPanelTask: panelTask => useComposerStore.setState({ panelTask }),
  setPanelSettings: patch => useComposerStore.setState(s => ({ panelSettings: { ...s.panelSettings, ...patch } })),
  setPanelDocument: (path, patch) => { if (path) useComposerStore.setState(s => ({ panelDocuments: { ...s.panelDocuments, [path]: { ...panelDocumentOf(s, path), ...patch } } })); },
});
useAppStore.setState({ setDraftCount: draftCount => useAppStore.setState({ draftCount }), setLoreBudgetTokens: loreBudgetTokens => useAppStore.setState({ loreBudgetTokens }) });
useLoreStore.setState({ index: { custom: ["产品介绍", "服务承诺", "客户案例"].map((name, n) => ({ id: String(n), name, category: "custom", dirPath: `/fixture/lore/${n}`, aliases: [], summary: "验收用资料", avatarPath: null, collections: [], mdFiles: ["index.md"], images: [], facets: [{ file: "index.md", title: "概要", charCount: 300, slot: null, keys: [], group: null, priority: 0, mode: "auto" as const }] })) } });
applyThemeId("paper", "light");
function Review() {
  const [narrow, setNarrow] = useState(false);
  return <I18nextProvider i18n={i18n}><div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <nav style={{ padding: 12, display: "flex", gap: 16 }}>
      <span>正式生成页 · 示例数据 · 不调用模型</span>
      <button onClick={() => setNarrow(!narrow)}>宽窄切换</button>
      <button onClick={() => applyThemeId("night", "dark")}>深色</button>
      <button onClick={() => applyThemeId("paper", "light")}>浅色</button>
      <button onClick={() => useAiStore.setState(s => ({ models: s.models.map(m => ({ ...m, contextSize: m.contextSize === 512 ? 1048576 : 512 })) }))}>切换超限示例</button>
    </nav>
    <div style={{ flex: 1, minHeight: 0, width: narrow ? 360 : "100%", maxWidth: "100%", margin: "auto" }}><AiPanel /></div>
  </div></I18nextProvider>;
}
createRoot(document.getElementById("root")!).render(<Review />);
