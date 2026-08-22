import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { X, SlidersHorizontal, Layers, MessageSquare, Info, BookOpen, Keyboard, BarChart3, Users,
  RefreshCw,
} from "lucide-react";
import { type SettingsTab } from "../../stores/appStore";
import { ModalErrorBoundary } from "../common/ErrorBoundary";
import { panelFade, overlayFadeTransition, useMotionPreset } from "../../lib/motion";
import { GeneralPane } from "./panes/GeneralPane";
import { WorkspacePane } from "./panes/WorkspacePane";
import { SyncPane } from "./panes/SyncPane";
import { UsagePane } from "./panes/UsagePane";
import { PromptsPane } from "./panes/PromptsPane";
import { ShortcutsPane } from "./panes/ShortcutsPane";
import { AboutPane } from "./panes/AboutPane";
import { ProvidersModelsPane } from "./panes/ProvidersModelsPane";
import { SubAgentsPane } from "./panes/SubAgentsPane";
import styles from "./SettingsPage.module.css";

interface Props {
  onClose: () => void;
  /** Pane to open on. Callers that mean a specific setting (e.g. the model
   *  picker's 管理供应商) pass it so the author lands where they were headed. */
  initialTab?: SettingsTab;
}

/**
 * Settings as a full-window page rather than a dialog.
 *
 * It fills everything below the TitleBar — the bar stays put because it is this
 * app's only window-drag region — and covers the icon rail, sidebar, editor and
 * AI rail. Visibility still lives in `appStore.showSettings` rather than
 * `MainView`, so `navStore.navigationBlocked()` keeps settings out of the
 * back/forward history exactly as before.
 */
export function SettingsPage({ onClose, initialTab = "general" }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // A pane with its own dismissable layer (the provider/model drawer) claims
  // Escape while it is up, so one press peels off one layer.
  const escIntercept = useRef<(() => void) | null>(null);
  const setEscIntercept = useCallback((handler: (() => void) | null) => {
    escIntercept.current = handler;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (escIntercept.current) escIntercept.current();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pageVariants = useMotionPreset(panelFade);

  const navBtn = (id: SettingsTab, icon: React.ReactNode, labelKey: string) => (
    <button
      key={id}
      className={`${styles.navItem} ${activeTab === id ? styles.navItemActive : ""}`}
      onClick={() => setActiveTab(id)}
    >
      <span className={styles.navIcon}>{icon}</span>
      {t(labelKey)}
    </button>
  );

  return (
    <motion.div
      className={styles.page}
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      // An overlay surface, not a peer view: the design system's 200ms fade,
      // not the screen-switch spring.
      transition={overlayFadeTransition}
    >
      <div className={styles.header}>
        <span className={styles.title}>{t("systemSettings.title")}</span>
        <button className={styles.closeBtn} onClick={onClose} title={t("aiConfig.hub.escToClose")}>
          <X size={16} />
        </button>
      </div>

      <div className={styles.body}>
        <nav className={styles.nav}>
          {navBtn("general", <SlidersHorizontal size={15} />, "systemSettings.tabs.general")}
          {navBtn("workspace", <BookOpen size={15} />, "systemSettings.tabs.workspace")}
          <div className={styles.navGroupLabel}>{t("systemSettings.tabs.aiGroup")}</div>
          {navBtn("providers-models", <Layers size={15} />, "systemSettings.tabs.providersModels")}
          {navBtn("subagents", <Users size={15} />, "systemSettings.tabs.subagents")}
          {navBtn("prompts", <MessageSquare size={15} />, "systemSettings.tabs.prompts")}
          {navBtn("usage", <BarChart3 size={15} />, "systemSettings.tabs.usage")}
          <div className={styles.navGroupLabel}>{t("systemSettings.tabs.dataGroup")}</div>
          {navBtn("sync", <RefreshCw size={15} />, "systemSettings.tabs.sync")}
          <div className={styles.navDivider} />
          {navBtn("shortcuts", <Keyboard size={15} />, "systemSettings.tabs.shortcuts")}
          {navBtn("about", <Info size={15} />, "systemSettings.tabs.about")}
        </nav>

        {/* Narrow boundary: a crashed pane replaces only the pane, leaving the
            nav and the close button alive so the author can get out. */}
        <ModalErrorBoundary onClose={onClose}>
          <div className={styles.paneHost}>
            {activeTab === "general" && <GeneralPane />}
            {activeTab === "workspace" && <WorkspacePane />}
            {activeTab === "providers-models" && <ProvidersModelsPane onEscapeInterceptChange={setEscIntercept} />}
            {activeTab === "subagents" && <SubAgentsPane />}
            {activeTab === "prompts" && <PromptsPane onEscapeInterceptChange={setEscIntercept} />}
            {activeTab === "usage" && <UsagePane />}
            {activeTab === "sync" && <SyncPane />}
            {activeTab === "shortcuts" && <ShortcutsPane />}
            {activeTab === "about" && <AboutPane />}
          </div>
        </ModalErrorBoundary>
      </div>
    </motion.div>
  );
}
