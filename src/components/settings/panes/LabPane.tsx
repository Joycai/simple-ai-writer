import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isPptxExportEnabled, setPptxExportEnabled } from "../../../lib/pptx/flag";
import { isDocxExportEnabled, setDocxExportEnabled } from "../../../lib/docx/flag";
import { isXlsxExportEnabled, setXlsxExportEnabled } from "../../../lib/xlsx/flag";
import { isRoleplayEnabled, setRoleplayEnabled } from "../../../lib/roleplay/flag";
import { isTranslateEnabled, setTranslateEnabled } from "../../../lib/translate/flag";
import { isComfyUiEnabled, setComfyUiEnabled } from "../../../lib/comfy/flag";
import { isOrchestratorEnabled, setOrchestratorEnabled } from "../../../lib/agent/packFlag";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";

interface Props {
  /**
   * The Word switch is the one Beta that changes the settings page itself
   * (排版格式 appears in / leaves the nav). SettingsPage owns that item, so it
   * hears about the flip from here instead of re-reading the pref next open.
   */
  onDocxToggled?: (on: boolean) => void;
}

/**
 * 设置 → AI 配置 → 实验室: every Beta switch in one place.
 *
 * Each of these gates an *assistant* capability — an export format, a way of
 * working, a local service — which is why they live under the AI group next
 * to the panes an author goes to right after flipping one (子代理 for the
 * translation model, 供应商与模型 for ComfyUI, 排版格式 for Word). Off is the
 * default for all of them, and off means absent: the tool is not in the
 * model's toolset, the entry point is not drawn. Nothing on disk is deleted.
 *
 * Grouping and the "go configure it next" signposts are waiting on 设计稿 18
 * — see docs/feature/settings-ai-tabs-ui-brief.md §2.2.
 */
export function LabPane({ onDocxToggled }: Props) {
  const { t } = useTranslation();
  const [pptxOn, setPptxOn] = useState(isPptxExportEnabled());
  const [docxOn, setDocxOn] = useState(isDocxExportEnabled());
  const [xlsxOn, setXlsxOn] = useState(isXlsxExportEnabled());
  const [roleplayOn, setRoleplayOn] = useState(isRoleplayEnabled());
  const [translateOn, setTranslateOn] = useState(isTranslateEnabled());
  const [comfyOn, setComfyOn] = useState(isComfyUiEnabled());
  const [orchestratorOn, setOrchestratorOn] = useState(isOrchestratorEnabled());

  const toggleDocx = (enabled: boolean) => {
    setDocxExportEnabled(enabled);
    setDocxOn(enabled);
    onDocxToggled?.(enabled);
  };

  return (
    <Pane>
      <PaneHeader title={t("systemSettings.tabs.lab")} sub={t("systemSettings.lab.paneSub")} />

      <Section label={t("systemSettings.lab.betaSection")}>
        <Row
          title={t("systemSettings.lab.pptxLabel")}
          desc={t("systemSettings.lab.pptxHint")}
        >
          <Toggle
            on={pptxOn}
            onChange={(next) => { setPptxExportEnabled(next); setPptxOn(next); }}
            label={t("systemSettings.lab.pptxLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.lab.docxLabel")}
          desc={t("systemSettings.lab.docxHint")}
          warn={docxOn ? undefined : t("systemSettings.lab.docxOffHint")}
        >
          <Toggle on={docxOn} onChange={toggleDocx} label={t("systemSettings.lab.docxLabel")} />
        </Row>
        <Row
          title={t("systemSettings.lab.xlsxLabel")}
          desc={t("systemSettings.lab.xlsxHint")}
        >
          <Toggle
            on={xlsxOn}
            onChange={(next) => { setXlsxExportEnabled(next); setXlsxOn(next); }}
            label={t("systemSettings.lab.xlsxLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.lab.roleplayLabel")}
          desc={t("systemSettings.lab.roleplayHint")}
        >
          <Toggle
            on={roleplayOn}
            onChange={(next) => { setRoleplayEnabled(next); setRoleplayOn(next); }}
            label={t("systemSettings.lab.roleplayLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.lab.translateLabel")}
          desc={t("systemSettings.lab.translateHint")}
        >
          <Toggle
            on={translateOn}
            onChange={(next) => { setTranslateEnabled(next); setTranslateOn(next); }}
            label={t("systemSettings.lab.translateLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.lab.comfyuiLabel")}
          desc={t("systemSettings.lab.comfyuiHint")}
        >
          <Toggle
            on={comfyOn}
            onChange={(next) => { setComfyUiEnabled(next); setComfyOn(next); }}
            label={t("systemSettings.lab.comfyuiLabel")}
          />
        </Row>
        <Row
          title={t("systemSettings.lab.toolPackLabel")}
          desc={t("systemSettings.lab.toolPackHint")}
          last
        >
          <Toggle
            on={orchestratorOn}
            onChange={(next) => { setOrchestratorEnabled(next); setOrchestratorOn(next); }}
            label={t("systemSettings.lab.toolPackLabel")}
          />
        </Row>
      </Section>
    </Pane>
  );
}
