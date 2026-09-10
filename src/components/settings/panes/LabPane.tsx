import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsTab } from "../../../stores/appStore";
import { isPptxExportEnabled, setPptxExportEnabled } from "../../../lib/pptx/flag";
import { isDocxExportEnabled, setDocxExportEnabled } from "../../../lib/docx/flag";
import { isXlsxExportEnabled, setXlsxExportEnabled } from "../../../lib/xlsx/flag";
import { isRoleplayEnabled, setRoleplayEnabled } from "../../../lib/roleplay/flag";
import { isTranslateEnabled, setTranslateEnabled } from "../../../lib/translate/flag";
import { isComfyUiEnabled, setComfyUiEnabled } from "../../../lib/comfy/flag";
import { isAsrEnabled, setAsrEnabled } from "../../../lib/asr/flag";
import { isOrchestratorEnabled, setOrchestratorEnabled } from "../../../lib/agent/packFlag";
import { isSkillStateEnabled, setSkillStateEnabled } from "../../../lib/agent/stateFlag";
import { isCliEnabled, setCliEnabled } from "../../../lib/cli/flag";
import { cachedShellInfo, shellInfo, shellLabel, type ShellInfo } from "../../../lib/cli/shell";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import styles from "./Lab.module.css";

interface Props {
  /**
   * The Word switch is the one Beta that changes the settings page itself
   * (排版格式 appears in / leaves the nav). SettingsPage owns that item, so it
   * hears about the flip from here instead of re-reading the pref next open.
   */
  onDocxToggled?: (on: boolean) => void;
  /** Where a signpost goes: the pane is already open, so this switches the
   *  active tab in place rather than round-tripping through `openSettings`. */
  onNavigate: (tab: SettingsTab) => void;
}

/**
 * 设置 → AI 配置 → 实验室: every Beta switch in one place.
 *
 * Each of these gates an *assistant* capability — an export format, a way of
 * working, a local service — which is why they live under the AI group next
 * to the panes an author goes to right after flipping one. Off is the default
 * for all of them, and off means absent: the tool is not in the model's
 * toolset, the entry point is not drawn. Nothing on disk is deleted.
 *
 * 设计稿 05b groups them by what switching one on costs the author — 导出格式
 * (nothing: one more file type) · 工作方式 (changes how the assistant and the
 * author interact) · 本地服务 (another program has to be running first) — and
 * gives the three with a next step a signpost that appears only once the
 * switch is on. See docs/feature/settings-ai-tabs-ui-brief.md.
 */
export function LabPane({ onDocxToggled, onNavigate }: Props) {
  const { t } = useTranslation();
  const [pptxOn, setPptxOn] = useState(isPptxExportEnabled());
  const [docxOn, setDocxOn] = useState(isDocxExportEnabled());
  const [xlsxOn, setXlsxOn] = useState(isXlsxExportEnabled());
  const [roleplayOn, setRoleplayOn] = useState(isRoleplayEnabled());
  const [orchestratorOn, setOrchestratorOn] = useState(isOrchestratorEnabled());
  const [skillStateOn, setSkillStateOn] = useState(isSkillStateEnabled());
  const [translateOn, setTranslateOn] = useState(isTranslateEnabled());
  const [comfyOn, setComfyOn] = useState(isComfyUiEnabled());
  const [asrOn, setAsrOn] = useState(isAsrEnabled());
  const [cliOn, setCliOn] = useState(isCliEnabled());
  // The shell is probed once per process (Rust side); this row only asks once
  // the switch is on, so an author who never opens the Beta never pays the
  // probe — and the browser dev server, which has no shell, answers null.
  const [shell, setShell] = useState<ShellInfo | null>(cachedShellInfo());
  useEffect(() => {
    if (!cliOn || shell) return;
    let live = true;
    void shellInfo().then((info) => { if (live) setShell(info); });
    return () => { live = false; };
  }, [cliOn, shell]);

  const toggleDocx = (enabled: boolean) => {
    setDocxExportEnabled(enabled);
    setDocxOn(enabled);
    onDocxToggled?.(enabled);
  };

  /** 「接着去 ＋ 页面名 →」— text with a hairline, never a button. */
  const goNext = (tab: SettingsTab, labelKey: string, hintKey: string) => (
    <div className={styles.go}>
      <span className={styles.goLead}>{t("systemSettings.lab.goLead")}</span>
      <button type="button" className={styles.goLink} onClick={() => onNavigate(tab)}>
        {t(labelKey)} →
      </button>
      <span className={styles.goHint}>{t(hintKey)}</span>
    </div>
  );

  return (
    <Pane>
      <PaneHeader title={t("systemSettings.tabs.lab")} sub={t("systemSettings.lab.paneSub")} />

      <Section label={t("systemSettings.lab.groupExport")}>
        <Row top title={t("systemSettings.lab.pptxLabel")} desc={t("systemSettings.lab.pptxHint")}>
          <Toggle
            on={pptxOn}
            onChange={(next) => { setPptxExportEnabled(next); setPptxOn(next); }}
            label={t("systemSettings.lab.pptxLabel")}
          />
        </Row>
        <Row
          top
          title={t("systemSettings.lab.docxLabel")}
          desc={t("systemSettings.lab.docxHint")}
          // Off: the consequence, as a second line of the description. On:
          // that line gives way to the signpost — the item it points at has
          // just appeared in the nav.
          foot={docxOn
            ? goNext("docx-format", "systemSettings.tabs.docxFormat", "systemSettings.lab.goDocxHint")
            : <div className={ui.rowDesc}>{t("systemSettings.lab.docxOffHint")}</div>}
        >
          <Toggle on={docxOn} onChange={toggleDocx} label={t("systemSettings.lab.docxLabel")} />
        </Row>
        <Row top title={t("systemSettings.lab.xlsxLabel")} desc={t("systemSettings.lab.xlsxHint")} last>
          <Toggle
            on={xlsxOn}
            onChange={(next) => { setXlsxExportEnabled(next); setXlsxOn(next); }}
            label={t("systemSettings.lab.xlsxLabel")}
          />
        </Row>
      </Section>

      <Section label={t("systemSettings.lab.groupWays")}>
        <Row top title={t("systemSettings.lab.roleplayLabel")} desc={t("systemSettings.lab.roleplayHint")}>
          <Toggle
            on={roleplayOn}
            onChange={(next) => { setRoleplayEnabled(next); setRoleplayOn(next); }}
            label={t("systemSettings.lab.roleplayLabel")}
          />
        </Row>
        <Row top title={t("systemSettings.lab.toolPackLabel")} desc={t("systemSettings.lab.toolPackHint")}>
          <Toggle
            on={orchestratorOn}
            onChange={(next) => { setOrchestratorEnabled(next); setOrchestratorOn(next); }}
            label={t("systemSettings.lab.toolPackLabel")}
          />
        </Row>
        <Row top title={t("systemSettings.lab.skillStateLabel")} desc={t("systemSettings.lab.skillStateHint")}>
          <Toggle
            on={skillStateOn}
            onChange={(next) => { setSkillStateEnabled(next); setSkillStateOn(next); }}
            label={t("systemSettings.lab.skillStateLabel")}
          />
        </Row>
        {/* 命令行（docs/feature/agent/shell-command-plan.md §3.6）：住在工作方式里，
            因为它改变的是助手能提议什么，不是多一种文件。开着时的脚注报这台电脑
            检测到的 shell——作者据此知道助手会用哪种语法；关着时的补充句说的是
            入口**不存在**（不是禁用），句式同音频转写。 */}
        <Row
          top
          title={t("systemSettings.lab.cliLabel")}
          desc={t("systemSettings.lab.cliHint")}
          foot={
            <div className={ui.rowDesc}>
              {cliOn
                ? shell
                  ? t("systemSettings.lab.cliShell", { shell: shellLabel(shell) })
                  : t("systemSettings.lab.cliShellUnknown")
                : t("systemSettings.lab.cliOffHint")}
            </div>
          }
          last
        >
          <Toggle
            on={cliOn}
            onChange={(next) => { setCliEnabled(next); setCliOn(next); }}
            label={t("systemSettings.lab.cliLabel")}
          />
        </Row>
      </Section>

      <Section label={t("systemSettings.lab.groupLocal")}>
        <Row
          top
          title={t("systemSettings.lab.translateLabel")}
          desc={t("systemSettings.lab.translateHint")}
          foot={translateOn
            ? goNext("subagents", "systemSettings.tabs.subagents", "systemSettings.lab.goTranslateHint")
            : undefined}
        >
          <Toggle
            on={translateOn}
            onChange={(next) => { setTranslateEnabled(next); setTranslateOn(next); }}
            label={t("systemSettings.lab.translateLabel")}
          />
        </Row>
        <Row
          top
          title={t("systemSettings.lab.comfyuiLabel")}
          desc={t("systemSettings.lab.comfyuiHint")}
          foot={comfyOn
            ? goNext("providers-models", "systemSettings.tabs.providersModels", "systemSettings.lab.goComfyHint")
            : undefined}
        >
          <Toggle
            on={comfyOn}
            onChange={(next) => { setComfyUiEnabled(next); setComfyOn(next); }}
            label={t("systemSettings.lab.comfyuiLabel")}
          />
        </Row>
        {/* 音频转写（设计稿 02f 屏 1a）：住在日中翻译旁边——同样是一个 Beta 开关
            + 一个只会干一件事的专用模型 + 子代理里的绑定。区别是它不在本机跑、
            不免费，所以说明里把「上传到阿里云临时存储 · 按秒计费」写成陈述句。
            关着时的补充句说的是入口**不存在**（不是禁用）。 */}
        <Row
          top
          title={t("systemSettings.lab.asrLabel")}
          desc={t("systemSettings.lab.asrHint")}
          foot={asrOn
            ? goNext("subagents", "systemSettings.tabs.subagents", "systemSettings.lab.goAsrHint")
            : <div className={ui.rowDesc}>{t("systemSettings.lab.asrOffHint")}</div>}
          last
        >
          <Toggle
            on={asrOn}
            onChange={(next) => { setAsrEnabled(next); setAsrOn(next); }}
            label={t("systemSettings.lab.asrLabel")}
          />
        </Row>
      </Section>
    </Pane>
  );
}
