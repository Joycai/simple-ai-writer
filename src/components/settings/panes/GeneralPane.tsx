import { useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAiStore } from "../../../stores/aiStore";
import { useAppStore, type ThemeMode, type Language, type FontScheme } from "../../../stores/appStore";
import { useProjectStore } from "../../../stores/projectStore";
import { MARKDOWN_THEMES } from "../../../lib/theme/markdownThemes";
import { isApiLogEnabled, setApiLogEnabled, getApiLogRevealTarget } from "../../../lib/ai/apiLog";
import { isPptxExportEnabled, setPptxExportEnabled } from "../../../lib/pptx/flag";
import { isRoleplayEnabled, setRoleplayEnabled } from "../../../lib/roleplay/flag";
import { isTranslateEnabled, setTranslateEnabled } from "../../../lib/translate/flag";
import {
  isNotifyEnabled, isNotifyKindEnabled, requestNotifyPermission,
  sendTestNotification, setNotifyEnabled, setNotifyKindEnabled,
} from "../../../lib/notify";
import { applyConfigImport, exportAiConfig, stageConfigImport } from "../../../lib/ai/configTransfer";
import { Pane, PaneHeader, Section, Row, Chip, ChipRow, Toggle } from "./bits";
import ui from "../settingsUi.module.css";

const THEMES: { value: ThemeMode; labelKey: string }[] = [
  { value: "dark", labelKey: "settings.dark" },
  { value: "light", labelKey: "settings.light" },
  { value: "system", labelKey: "settings.system" },
];

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "English" },
];

// Preview stack per scheme mirrors the --font-serif override in tokens.css,
// so each option renders in the body font it selects.
const FONT_SCHEMES: { value: FontScheme; labelKey: string; sample: string; previewFont: string }[] = [
  { value: "manuscript", labelKey: "systemSettings.general.fontManuscript", sample: "文字 Aa", previewFont: '"Spectral", Georgia, "Songti SC", "Noto Serif CJK SC", serif' },
  { value: "song", labelKey: "systemSettings.general.fontSong", sample: "文字 Aa", previewFont: 'Georgia, Cambria, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, serif' },
  { value: "hei", labelKey: "systemSettings.general.fontHei", sample: "文字 Aa", previewFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
  { value: "kai", labelKey: "systemSettings.general.fontKai", sample: "文字 Aa", previewFont: '"Iowan Old Style", Georgia, "Kaiti SC", STKaiti, KaiTi, "Noto Serif CJK SC", serif' },
];

export function GeneralPane() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const { theme, setTheme, language, setLanguage, fontScheme, setFontScheme } = useAppStore();
  const markdownTheme = useAppStore((s) => s.markdownTheme);
  const setMarkdownTheme = useAppStore((s) => s.setMarkdownTheme);
  const [apiLogOn, setApiLogOn] = useState(isApiLogEnabled());
  const [notifyOn, setNotifyOn] = useState(isNotifyEnabled());
  const [notifyApproval, setNotifyApprovalOn] = useState(isNotifyKindEnabled("approval"));
  const [notifyDone, setNotifyDoneOn] = useState(isNotifyKindEnabled("done"));
  const [notifyStatus, setNotifyStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pptxOn, setPptxOn] = useState(isPptxExportEnabled());
  const [roleplayOn, setRoleplayOn] = useState(isRoleplayEnabled());
  const [translateOn, setTranslateOn] = useState(isTranslateEnabled());
  const providers = useAiStore((s) => s.providers);
  const loadConfig = useAiStore((s) => s.loadConfig);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepStatus, setSweepStatus] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * Collect the stored references that no longer point at anything.
   *
   * No confirmation step: every path is checked against disk first, so this
   * cannot remove something that still resolves — there is nothing for the
   * author to weigh. What they need is the *result*, which is why the counts
   * are reported rather than a bare "done".
   */
  const handleSweepStale = async () => {
    if (sweeping) return;
    setSweeping(true);
    setSweepStatus(null);
    try {
      const { sweepStaleRefs, sweepTotal } = await import("../../../lib/staleRefs");
      const swept = await sweepStaleRefs(useProjectStore.getState().projectPath ?? "");
      const total = sweepTotal(swept);
      setSweepStatus({
        ok: true,
        text: total === 0
          ? t("systemSettings.maintenance.sweptNone", {
              defaultValue: "没有发现失效记录。",
            })
          : t("systemSettings.maintenance.sweptSome", {
              defaultValue:
                "清理了 {{total}} 条失效记录：钉住的条目 {{pins}}、扮演绑定 {{roster}}、对话注入 {{injected}}、配图 {{images}}、整项目的钉住记录 {{projects}}。",
              total,
              pins: swept.pinnedEntries,
              roster: swept.rosterRefs,
              injected: swept.sessionInjected,
              images: swept.sessionImages,
              projects: swept.pinnedProjects,
            }),
      });
    } catch (e) {
      setSweepStatus({ ok: false, text: String(e) });
    } finally {
      setSweeping(false);
    }
  };

  const togglePptx = (enabled: boolean) => {
    setPptxExportEnabled(enabled);
    setPptxOn(enabled);
  };

  const toggleRoleplay = (enabled: boolean) => {
    setRoleplayEnabled(enabled);
    setRoleplayOn(enabled);
  };

  const toggleTranslate = (enabled: boolean) => {
    setTranslateEnabled(enabled);
    setTranslateOn(enabled);
  };

  const toggleNotify = (enabled: boolean) => {
    setNotifyEnabled(enabled);
    setNotifyOn(enabled);
    setNotifyStatus(null);
    // Asking here rather than at the first notification: this is the moment
    // the author said yes, so it is the moment an OS prompt belongs to.
    if (enabled) void requestNotifyPermission();
  };

  const testNotify = async () => {
    setNotifyStatus(null);
    try {
      await sendTestNotification(t("notify.testTitle"), t("notify.testBody"));
      setNotifyStatus({ ok: true, text: t("systemSettings.general.notifyTestOk") });
    } catch (e) {
      // The one failure with an actionable fix gets its own wording; anything
      // else is a plumbing error the author can only report.
      const denied = e instanceof Error && e.message === "notification-permission-denied";
      setNotifyStatus({
        ok: false,
        text: denied
          ? t("systemSettings.general.notifyTestDenied")
          : t("systemSettings.general.notifyTestFailed", { error: String(e) }),
      });
    }
  };

  const toggleApiLog = (enabled: boolean) => {
    setApiLogEnabled(enabled);
    setApiLogOn(enabled);
  };

  const openApiLogs = async () => {
    try {
      await revealItemInDir(await getApiLogRevealTarget());
    } catch { /* best-effort */ }
  };

  const handleExportConfig = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const saved = await exportAiConfig(includeKeys);
      if (saved) setBackupStatus({ ok: true, text: t("systemSettings.backup.exported", { path: saved }) });
    } catch (e) {
      setBackupStatus({ ok: false, text: `${t("systemSettings.backup.exportFailed")} ${e}` });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportConfig = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const staged = await stageConfigImport(providers.map((p) => p.id));
      if (!staged) return;
      let confirmMsg = t("systemSettings.backup.importConfirm", {
        providers: staged.providers.length,
        models: staged.models.length,
        prompts: staged.prompts.length,
      });
      if (staged.keyCount > 0) {
        confirmMsg += `\n${t("systemSettings.backup.importKeysNote", { count: staged.keyCount })}`;
      }
      if (staged.prefs.length > 0) {
        confirmMsg += `\n${t("systemSettings.backup.importPrefsNote", { count: staged.prefs.length })}`;
      }
      if (!window.confirm(confirmMsg)) return;
      await applyConfigImport(staged);
      await loadConfig();
      // Imported preferences are in the store but not yet on screen.
      useAppStore.getState().reloadFromPrefs();
      setBackupStatus({ ok: true, text: t("systemSettings.backup.imported") });
    } catch (e) {
      const invalid = e instanceof Error && e.message === "invalid-backup";
      setBackupStatus({
        ok: false,
        text: invalid ? t("systemSettings.backup.invalidFile") : `${t("systemSettings.backup.importFailed")} ${e}`,
      });
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <Pane>
      <PaneHeader title={t("systemSettings.tabs.general")} sub={t("systemSettings.general.paneSub")} />

      <Section label={t("systemSettings.general.appearance")}>
        <Row title={t("systemSettings.general.themeLabel")}>
          <ChipRow>
            {THEMES.map((th) => (
              <Chip key={th.value} label={t(th.labelKey)} active={theme === th.value} onClick={() => setTheme(th.value)} />
            ))}
          </ChipRow>
        </Row>

        <div className={ui.rowStacked}>
          <div className={ui.rowTitle}>{t("systemSettings.general.fontLabel")}</div>
          <div className={ui.rowDesc}>{t("systemSettings.general.fontHint")}</div>
          <div className={`${ui.cardGrid} ${ui.cardGridFont}`}>
            {FONT_SCHEMES.map((f) => (
              <button
                key={f.value}
                className={`${ui.card} ${ui.fontCard} ${fontScheme === f.value ? ui.cardActive : ""}`}
                onClick={() => setFontScheme(f.value)}
              >
                <span className={ui.fontSample} style={{ fontFamily: f.previewFont }}>{f.sample}</span>
                <span className={ui.cardName}>{t(f.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={`${ui.rowStacked} ${ui.rowLast}`}>
          <div className={ui.rowTitle}>{t("systemSettings.general.mdThemeLabel")}</div>
          <div className={ui.rowDesc}>{t("systemSettings.general.mdThemeHint")}</div>
          <div className={`${ui.cardGrid} ${ui.cardGridWide}`}>
            {MARKDOWN_THEMES.map((mt) => (
              <button
                key={mt.id}
                className={`${ui.card} ${markdownTheme === mt.id ? ui.cardActive : ""}`}
                onClick={() => setMarkdownTheme(mt.id)}
              >
                {/* A real md-body sample, pinned by data-md-theme to this card's
                    theme whatever the app-wide setting currently is. */}
                <div className={`${ui.mdSample} md-body`} data-md-theme={mt.id} aria-hidden>
                  <h2>{isZh ? "标题" : "Heading"}</h2>
                  <p>{isZh ? "正文示例，字体与间距如此。" : "Body text, set in this theme."}</p>
                </div>
                <div className={ui.cardName}>{isZh ? mt.label.zh : mt.label.en}</div>
                <div className={ui.cardDesc}>{isZh ? mt.desc.zh : mt.desc.en}</div>
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section label={t("systemSettings.general.languageSection")}>
        <Row title={t("systemSettings.general.languageLabel")} last>
          <ChipRow>
            {LANGUAGES.map((lang) => (
              <Chip key={lang.value} label={lang.label} active={language === lang.value} onClick={() => setLanguage(lang.value)} />
            ))}
          </ChipRow>
        </Row>
      </Section>

      <Section label={t("systemSettings.general.notifySection")}>
        <Row
          title={t("systemSettings.general.notifyLabel")}
          desc={t("systemSettings.general.notifyHint")}
          last={!notifyOn}
        >
          <Toggle on={notifyOn} onChange={toggleNotify} label={t("systemSettings.general.notifyLabel")} />
        </Row>
        {/* The per-kind switches and the test button only mean anything once
            the master switch is on — off, they would read as dead controls. */}
        {notifyOn && (
          <>
            <Row
              title={t("systemSettings.general.notifyApprovalLabel")}
              desc={t("systemSettings.general.notifyApprovalHint")}
            >
              <Toggle
                on={notifyApproval}
                onChange={(next) => { setNotifyKindEnabled("approval", next); setNotifyApprovalOn(next); }}
                label={t("systemSettings.general.notifyApprovalLabel")}
              />
            </Row>
            <Row
              title={t("systemSettings.general.notifyDoneLabel")}
              desc={t("systemSettings.general.notifyDoneHint")}
            >
              <Toggle
                on={notifyDone}
                onChange={(next) => { setNotifyKindEnabled("done", next); setNotifyDoneOn(next); }}
                label={t("systemSettings.general.notifyDoneLabel")}
              />
            </Row>
            <Row desc={t("systemSettings.general.notifyPlatformHint")} last>
              <button className={ui.rowBtn} onClick={testNotify}>
                {t("systemSettings.general.notifyTest")}
              </button>
            </Row>
            {notifyStatus && (
              <div className={notifyStatus.ok ? ui.statusOk : ui.statusError}>{notifyStatus.text}</div>
            )}
          </>
        )}
      </Section>

      <Section label={t("systemSettings.general.betaSection")}>
        <Row
          title={t("systemSettings.general.pptxLabel")}
          desc={t("systemSettings.general.pptxHint")}
        >
          <Toggle on={pptxOn} onChange={togglePptx} label={t("systemSettings.general.pptxLabel")} />
        </Row>
        <Row
          title={t("systemSettings.general.roleplayLabel", { defaultValue: "互动式角色扮演创作" })}
          desc={t("systemSettings.general.roleplayHint", {
            defaultValue: "在 AI 助手里多出「扮演」一栏：绑定知识库人物，以第一人称和他们对话；旁白 agent 能读到全部对话并把互动整理进正文。对话记录存在项目的 .ai-writer/roleplay/ 下。",
          })}
        >
          <Toggle
            on={roleplayOn}
            onChange={toggleRoleplay}
            label={t("systemSettings.general.roleplayLabel", { defaultValue: "互动式角色扮演创作" })}
          />
        </Row>
        <Row
          title={t("systemSettings.general.translateLabel")}
          desc={t("systemSettings.general.translateHint")}
          last
        >
          <Toggle
            on={translateOn}
            onChange={toggleTranslate}
            label={t("systemSettings.general.translateLabel")}
          />
        </Row>
      </Section>

      <Section label={t("systemSettings.general.debugSection")}>
        <Row
          title={t("systemSettings.general.apiLogLabel")}
          desc={t("systemSettings.general.apiLogHint")}
          last={!apiLogOn}
        >
          <Toggle on={apiLogOn} onChange={toggleApiLog} label={t("systemSettings.general.apiLogLabel")} />
        </Row>
        {/* Only worth offering once there is something in that folder. */}
        {apiLogOn && (
          <Row desc={t("systemSettings.general.apiLogLocation")} last>
            <button className={ui.rowBtn} onClick={openApiLogs}>
              {t("systemSettings.general.openApiLogs")}
            </button>
          </Row>
        )}
      </Section>

      <Section label={t("systemSettings.backup.section")}>
        <Row title={t("systemSettings.backup.transferLabel")} desc={t("systemSettings.backup.hint")}>
          <button className={ui.rowBtn} onClick={handleExportConfig} disabled={backupBusy}>
            {t("systemSettings.backup.export")}
          </button>
          <button className={ui.rowBtn} onClick={handleImportConfig} disabled={backupBusy}>
            {t("systemSettings.backup.import")}
          </button>
        </Row>
        <Row
          title={t("systemSettings.backup.keysLabel")}
          desc={t("systemSettings.backup.keysHint")}
          warn={includeKeys ? t("systemSettings.backup.keysWarn") : undefined}
          last
        >
          <ChipRow>
            <Chip label={t("systemSettings.backup.keysOff")} active={!includeKeys} onClick={() => setIncludeKeys(false)} />
            <Chip label={t("systemSettings.backup.keysOn")} active={includeKeys} onClick={() => setIncludeKeys(true)} />
          </ChipRow>
        </Row>
        {backupStatus && (
          <div className={backupStatus.ok ? ui.statusOk : ui.statusError}>{backupStatus.text}</div>
        )}
      </Section>

      <Section label={t("systemSettings.maintenance.section", { defaultValue: "数据维护" })}>
        <Row
          title={t("systemSettings.maintenance.staleLabel", { defaultValue: "清理失效数据" })}
          desc={t("systemSettings.maintenance.staleHint", {
            defaultValue:
              "少数记录存的是绝对路径：钉住的知识库条目、扮演花名册里的人物绑定、对话记录里的注入账本和配图。移动、重命名或从备份恢复项目后，它们会指向不存在的位置——失效的表现是安静的（钉住的条目不再注入、角色显示「条目已删除」、旧对话里的图不显示）。这里只清掉指不到东西的那些，仍然有效的一条不动；文档、知识库和设定都在文件系统上，完全不受影响。",
          })}
          last
        >
          <button className={ui.rowBtn} onClick={handleSweepStale} disabled={sweeping}>
            {sweeping
              ? t("systemSettings.maintenance.sweeping", { defaultValue: "清理中…" })
              : t("systemSettings.maintenance.sweep", { defaultValue: "扫描并清理" })}
          </button>
        </Row>
        {sweepStatus && (
          <div className={sweepStatus.ok ? ui.statusOk : ui.statusError}>{sweepStatus.text}</div>
        )}
      </Section>
    </Pane>
  );
}
