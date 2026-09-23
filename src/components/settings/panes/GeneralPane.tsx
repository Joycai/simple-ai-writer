import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore, type Language } from "../../../stores/appStore";
import { useProjectStore } from "../../../stores/projectStore";
import { isApiLogEnabled, setApiLogEnabled, getApiLogRevealTarget } from "../../../lib/ai/apiLog";
import {
  isNotifyEnabled, isNotifyKindEnabled, requestNotifyPermission,
  sendTestNotification, setNotifyEnabled, setNotifyKindEnabled,
} from "../../../lib/notify";
import { ResetAppDialog } from "../ResetAppDialog";
import { Pane, PaneHeader, Section, Row, Chip, ChipRow, Toggle } from "./bits";
import ui from "../settingsUi.module.css";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "English" },
];

interface Props {
  /** Lets this pane claim Escape while the reset dialog is up — see below. */
  onEscapeInterceptChange: (handler: (() => void) | null) => void;
  /** 外观 moved out of this page (设计稿 05m). Until the author has opened
   *  外观 once, the top of this page says where it went. */
  showMovedHint: boolean;
  onOpenAppearance: () => void;
}

export function GeneralPane({ onEscapeInterceptChange, showMovedHint, onOpenAppearance }: Props) {
  const { t } = useTranslation();
  const { language, setLanguage } = useAppStore();
  const [apiLogOn, setApiLogOn] = useState(isApiLogEnabled());

  const [notifyOn, setNotifyOn] = useState(isNotifyEnabled());
  const [notifyApproval, setNotifyApprovalOn] = useState(isNotifyKindEnabled("approval"));
  const [notifyDone, setNotifyDoneOn] = useState(isNotifyKindEnabled("done"));
  const [notifyError, setNotifyErrorOn] = useState(isNotifyKindEnabled("error"));
  const [notifyStatus, setNotifyStatus] = useState<{ ok: boolean; text: string } | null>(null);
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

      {/* 路标只活到作者第一次打开外观页：老习惯来这里找主题的人一眼看见去向，
          之后它就是噪音。 */}
      {showMovedHint && (
        <div className={ui.signpost}>
          {t("systemSettings.appearance.movedHint")}{" "}
          <button type="button" className={ui.signpostLink} onClick={onOpenAppearance}>
            {t("systemSettings.tabs.appearance")} →
          </button>
        </div>
      )}

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
            <Row
              title={t("systemSettings.general.notifyErrorLabel")}
              desc={t("systemSettings.general.notifyErrorHint")}
            >
              <Toggle
                on={notifyError}
                onChange={(next) => { setNotifyKindEnabled("error", next); setNotifyErrorOn(next); }}
                label={t("systemSettings.general.notifyErrorLabel")}
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
