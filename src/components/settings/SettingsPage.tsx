import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { X, SlidersHorizontal, Layers, MessageSquare, Info, BookOpen, Keyboard, BarChart3, Tags, Users,
  RefreshCw, FileType, FlaskConical, Scroll, Palette,
} from "lucide-react";
import { type SettingsTab } from "../../stores/appStore";
import { ModalErrorBoundary } from "../common/ErrorBoundary";
import { panelFade, overlayFadeTransition, useMotionPreset } from "../../lib/motion";
import { GeneralPane } from "./panes/GeneralPane";
import { AppearancePane } from "./panes/AppearancePane";
import { WorkspacePane } from "./panes/WorkspacePane";
import { SyncPane } from "./panes/SyncPane";
import { UsagePane } from "./panes/UsagePane";
import { FeeGroupsPane } from "./panes/FeeGroupsPane";
import { PromptsPane } from "./panes/PromptsPane";
import { ShortcutsPane } from "./panes/ShortcutsPane";
import { AboutPane } from "./panes/AboutPane";
import { ProvidersModelsPane } from "./panes/ProvidersModelsPane";
import { SubAgentsPane } from "./panes/SubAgentsPane";
import { DocFormatPane } from "./panes/DocFormatPane";
import { LabPane } from "./panes/LabPane";
import { ContextMemoryPane } from "./panes/ContextMemoryPane";
import { isDocxExportEnabled } from "../../lib/docx/flag";
import { readPref, writePref } from "../../lib/prefs";
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
  // Beta off means the item is *absent*, not disabled — the nav below it moves
  // up, nothing greys out. State rather than a one-off read: the switch is on
  // the 实验室 pane, and the author flipping it should see this item arrive
  // (or leave) at once, not on the next open.
  const [docxOn, setDocxOn] = useState(isDocxExportEnabled());
  // 设计稿 05b: the frame the Word switch goes on, the item expands from zero
  // height and its background is dyed accent-tint, fading out within ~500ms —
  // "highlight for one beat" so the author sees *where* the switch acted.
  // Off collapses in reverse with no flash.
  const [docxFlash, setDocxFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleDocxToggled = useCallback((on: boolean) => {
    setDocxOn(on);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (!on) { setDocxFlash(false); return; }
    setDocxFlash(true);
    flashTimer.current = setTimeout(() => setDocxFlash(false), 240);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // 外观 moved out of 通用 (设计稿 05m). Until the author opens it once, the
  // nav item carries a 「新」 and 通用 says where it went; the first visit
  // retires both, for good — a pointer that stays is noise.
  const [appearanceSeen, setAppearanceSeen] = useState(() => readPref("app:appearanceSeen") === "1");
  useEffect(() => {
    if (activeTab !== "appearance" || appearanceSeen) return;
    writePref("app:appearanceSeen", "1");
    setAppearanceSeen(true);
  }, [activeTab, appearanceSeen]);

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

  const navBtn = (
    id: SettingsTab,
    icon: React.ReactNode,
    labelKey: string,
    extra = "",
    // 行尾的成色小标。排版格式挂着 BETA（设计稿 05e 屏 1a / 05f 屏 1n）——
    // 那一项本身就是一个开关开出来的，导航里不说，作者只能在页内标题上才看见；
    // 外观挂着「新」，到作者第一次打开它为止（05m）。
    badge?: string,
  ) => (
    <button
      key={id}
      className={`${styles.navItem} ${activeTab === id ? styles.navItemActive : ""} ${extra}`}
      onClick={() => setActiveTab(id)}
    >
      <span className={styles.navIcon}>{icon}</span>
      {t(labelKey)}
      {badge && <span className={styles.navBadge}>{badge}</span>}
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
          {/* Palette（设计稿 05m）：颜色与样子，和「通用」的滑杆分得开。紧跟通用——
              作者照老习惯点通用找主题时，它就在下一格。 */}
          {navBtn("appearance", <Palette size={15} />, "systemSettings.tabs.appearance", "",
            appearanceSeen ? undefined : t("systemSettings.appearance.newBadge"))}
          {navBtn("workspace", <BookOpen size={15} />, "systemSettings.tabs.workspace")}
          {/* Always mounted so it can animate in and out; `inert` keeps the
              collapsed button out of the tab order. */}
          <div
            className={`${styles.navCollapse} ${docxOn ? styles.navCollapseOpen : ""}`}
            inert={!docxOn}
          >
            {navBtn("docx-format", <FileType size={15} />, "systemSettings.tabs.docxFormat",
              docxFlash ? styles.navItemFlash : "", "BETA")}
          </div>
          <div className={styles.navGroupLabel}>{t("systemSettings.tabs.aiGroup")}</div>
          {navBtn("providers-models", <Layers size={15} />, "systemSettings.tabs.providersModels")}
          {/* Tags（设计稿 05l）：一张价签挂在多个东西上，正是计费组在说的事。
              紧跟「渠道与模型」——它是那一页的价格那一半；中间隔着子代理，
              作者会以为它属于「用量」。 */}
          {navBtn("fees", <Tags size={15} />, "systemSettings.tabs.fees")}
          {navBtn("subagents", <Users size={15} />, "systemSettings.tabs.subagents")}
          {navBtn("prompts", <MessageSquare size={15} />, "systemSettings.tabs.prompts")}
          {/* Scroll (设计稿 05b): what a conversation reads into the model is
              "one roll" — both the text being read and the thing remembered. */}
          {navBtn("context-memory", <Scroll size={15} />, "systemSettings.tabs.contextMemory")}
          {navBtn("usage", <BarChart3 size={15} />, "systemSettings.tabs.usage")}
          {navBtn("lab", <FlaskConical size={15} />, "systemSettings.tabs.lab")}
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
            {activeTab === "general" && (
              <GeneralPane
                onEscapeInterceptChange={setEscIntercept}
                showMovedHint={!appearanceSeen}
                onOpenAppearance={() => setActiveTab("appearance")}
              />
            )}
            {activeTab === "appearance" && <AppearancePane />}
            {activeTab === "workspace" && <WorkspacePane />}
            {activeTab === "docx-format" && docxOn && <DocFormatPane onEscapeInterceptChange={setEscIntercept} />}
            {activeTab === "providers-models" && <ProvidersModelsPane onEscapeInterceptChange={setEscIntercept} />}
            {activeTab === "subagents" && <SubAgentsPane />}
            {activeTab === "prompts" && <PromptsPane onEscapeInterceptChange={setEscIntercept} />}
            {activeTab === "fees" && <FeeGroupsPane />}
            {activeTab === "usage" && <UsagePane onOpenFees={() => setActiveTab("fees")} />}
            {activeTab === "context-memory" && <ContextMemoryPane />}
            {activeTab === "lab" && <LabPane onDocxToggled={handleDocxToggled} onNavigate={setActiveTab} />}
            {activeTab === "sync" && <SyncPane />}
            {activeTab === "shortcuts" && <ShortcutsPane />}
            {activeTab === "about" && <AboutPane />}
          </div>
        </ModalErrorBoundary>
      </div>
    </motion.div>
  );
}
