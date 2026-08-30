import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore, type ThemeMode, type Language, type FontScheme } from "../../../stores/appStore";
import { useProjectStore } from "../../../stores/projectStore";
import { MARKDOWN_THEMES } from "../../../lib/theme/markdownThemes";
import { isApiLogEnabled, setApiLogEnabled, getApiLogRevealTarget } from "../../../lib/ai/apiLog";
import { isPptxExportEnabled, setPptxExportEnabled } from "../../../lib/pptx/flag";
import { isDocxExportEnabled, setDocxExportEnabled } from "../../../lib/docx/flag";
import { isXlsxExportEnabled, setXlsxExportEnabled } from "../../../lib/xlsx/flag";
import { isRoleplayEnabled, setRoleplayEnabled } from "../../../lib/roleplay/flag";
import { isTranslateEnabled, setTranslateEnabled } from "../../../lib/translate/flag";
import { isComfyUiEnabled, setComfyUiEnabled } from "../../../lib/comfy/flag";
import { isOrchestratorEnabled, setOrchestratorEnabled } from "../../../lib/agent/packFlag";
import {
  isNotifyEnabled, isNotifyKindEnabled, requestNotifyPermission,
  sendTestNotification, setNotifyEnabled, setNotifyKindEnabled,
} from "../../../lib/notify";
import {
  IMAGE_LONG_EDGE_MAX, IMAGE_LONG_EDGE_MIN,
} from "../../../lib/image/downscalePlan";
import { ResetAppDialog } from "../ResetAppDialog";
import { Pane, PaneHeader, Section, Row, Chip, ChipRow, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";

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

interface Props {
  /** Lets this pane claim Escape while the reset dialog is up — see below. */
  onEscapeInterceptChange: (handler: (() => void) | null) => void;
}

export function GeneralPane({ onEscapeInterceptChange }: Props) {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const { theme, setTheme, language, setLanguage, fontScheme, setFontScheme } = useAppStore();
  const markdownTheme = useAppStore((s) => s.markdownTheme);
  const setMarkdownTheme = useAppStore((s) => s.setMarkdownTheme);
  const [apiLogOn, setApiLogOn] = useState(isApiLogEnabled());
  const imageMaxLongEdge = useAppStore((s) => s.imageMaxLongEdge);
  const setImageMaxLongEdge = useAppStore((s) => s.setImageMaxLongEdge);
  const [edgeDraft, setEdgeDraft] = useState(imageMaxLongEdge ? String(imageMaxLongEdge) : "");
  const commitEdge = () => {
    const n = parseInt(edgeDraft, 10);
    const next = Number.isFinite(n) && n > 0
      ? Math.min(Math.max(n, IMAGE_LONG_EDGE_MIN), IMAGE_LONG_EDGE_MAX)
      : 0;
    setImageMaxLongEdge(next);
    setEdgeDraft(next ? String(next) : "");
  };

  const [notifyOn, setNotifyOn] = useState(isNotifyEnabled());
  const [notifyApproval, setNotifyApprovalOn] = useState(isNotifyKindEnabled("approval"));
  const [notifyDone, setNotifyDoneOn] = useState(isNotifyKindEnabled("done"));
  const [notifyStatus, setNotifyStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pptxOn, setPptxOn] = useState(isPptxExportEnabled());
  const [docxOn, setDocxOn] = useState(isDocxExportEnabled());
  const [xlsxOn, setXlsxOn] = useState(isXlsxExportEnabled());
  const [roleplayOn, setRoleplayOn] = useState(isRoleplayEnabled());
  const [translateOn, setTranslateOn] = useState(isTranslateEnabled());
  const [comfyOn, setComfyOn] = useState(isComfyUiEnabled());
  const [orchestratorOn, setOrchestratorOn] = useState(isOrchestratorEnabled());
  const [sweeping, setSweeping] = useState(false);
  const [sweepStatus, setSweepStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    // While the reset dialog is up, ModalShell's own Escape listener closes it.
    // Both listeners sit on `window`, so the settings page's would otherwise
    // fire too and take the whole page down with the dialog — claiming the key
    // with a no-op is what keeps one press to one layer (same as 供应商与模型).
    onEscapeInterceptChange(resetting ? () => {} : null);
    return () => onEscapeInterceptChange(null);
  }, [resetting, onEscapeInterceptChange]);

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

  const toggleComfy = (enabled: boolean) => {
    setComfyUiEnabled(enabled);
    setComfyOn(enabled);
  };

  const toggleOrchestrator = (enabled: boolean) => {
    setOrchestratorEnabled(enabled);
    setOrchestratorOn(enabled);
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

      {/* Sits before 通知 rather than in 实验功能: downscaling is not a feature
          to switch on, it is what the app now does with every picture — this
          field only moves where the line is. */}
      <Section label={t("systemSettings.general.imageSection", { defaultValue: "图片" })}>
        <Row
          title={t("systemSettings.general.imageLongEdgeLabel", { defaultValue: "发送给模型的最大长边" })}
          desc={t("systemSettings.general.imageLongEdgeHint", {
            defaultValue:
              "超过这个尺寸的图片会在发送前等比缩小，原文件不受影响。留空 / 0 = 原样发送。",
          })}
          last
        >
          <input
            className={`${common.input} ${common.rowNumber}`}
            type="number"
            min={IMAGE_LONG_EDGE_MIN}
            max={IMAGE_LONG_EDGE_MAX}
            step={256}
            placeholder={t("systemSettings.general.imageLongEdgeOff", { defaultValue: "不缩" })}
            value={edgeDraft}
            onChange={(e) => setEdgeDraft(e.target.value)}
            // Committed on blur, not per keystroke: clamping as the author
            // types means the first digit of "4096" becomes 256 and the rest
            // has nowhere to go.
            onBlur={commitEdge}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
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
          title={t("systemSettings.general.docxLabel")}
          desc={t("systemSettings.general.docxHint")}
          warn={docxOn ? undefined : t("systemSettings.general.docxOffHint")}
        >
          <Toggle
            on={docxOn}
            onChange={(next) => { setDocxExportEnabled(next); setDocxOn(next); }}
            label={t("systemSettings.general.docxLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.general.xlsxLabel")}
          desc={t("systemSettings.general.xlsxHint")}
        >
          <Toggle
            on={xlsxOn}
            onChange={(next) => { setXlsxExportEnabled(next); setXlsxOn(next); }}
            label={t("systemSettings.general.xlsxLabel")}
          />
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
        >
          <Toggle
            on={translateOn}
            onChange={toggleTranslate}
            label={t("systemSettings.general.translateLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.general.comfyuiLabel")}
          desc={t("systemSettings.general.comfyuiHint")}
        >
          <Toggle
            on={comfyOn}
            onChange={toggleComfy}
            label={t("systemSettings.general.comfyuiLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.general.toolPackLabel")}
          desc={t("systemSettings.general.toolPackHint")}
          last
        >
          <Toggle
            on={orchestratorOn}
            onChange={toggleOrchestrator}
            label={t("systemSettings.general.toolPackLabel")}
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

      <Section label={t("systemSettings.maintenance.section", { defaultValue: "数据维护" })}>
        <Row
          title={t("systemSettings.maintenance.staleLabel", { defaultValue: "清理失效数据" })}
          desc={t("systemSettings.maintenance.staleHint", {
            defaultValue:
              "少数记录存的是绝对路径：钉住的知识库条目、扮演花名册里的人物绑定、对话记录里的注入账本和配图。移动、重命名或从备份恢复项目后，它们会指向不存在的位置——失效的表现是安静的（钉住的条目不再注入、角色显示「条目已删除」、旧对话里的图不显示）。这里只清掉指不到东西的那些，仍然有效的一条不动；文档、知识库和设置都在文件系统上，完全不受影响。",
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

      {/* 最后一节，也是唯一不可撤销的一节。放在「导出配置」之后是有意的：
          作者先走过留一份副本的门，才会走到这一扇。 */}
      <Section label={t("systemSettings.reset.section")}>
        <Row
          title={t("systemSettings.reset.label")}
          desc={t("systemSettings.reset.hint")}
          last
        >
          <button className={ui.rowBtn} onClick={() => setResetting(true)}>
            {t("systemSettings.reset.button")}
          </button>
        </Row>
      </Section>

      {resetting && <ResetAppDialog onClose={() => setResetting(false)} />}
    </Pane>
  );
}
