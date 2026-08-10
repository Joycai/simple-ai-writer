import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { Pane } from "./bits";
import ui from "../settingsUi.module.css";

const GITHUB_URL = "https://github.com/Joycai/simple-ai-writer";
const GITHUB_LABEL = "github.com/Joycai/simple-ai-writer";

export function AboutPane() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
  }, []);

  return (
    <Pane width="narrow">
      <div className={ui.aboutHero}>
        <div className={ui.aboutName}>{t("systemSettings.about.appName")}</div>
        <div className={ui.aboutVersion}>
          <span className={ui.badge}>v{version || "…"}</span>
        </div>
        <div className={ui.aboutTagline}>{t("systemSettings.about.tagline")}</div>
      </div>

      <div className={ui.aboutRows}>
        <div className={ui.aboutRow}>
          <span className={ui.aboutKey}>{t("systemSettings.about.versionLabel")}</span>
          <span className={ui.aboutVal}>{version || "…"}</span>
        </div>
        <div className={ui.aboutRow}>
          <span className={ui.aboutKey}>{t("systemSettings.about.githubLabel")}</span>
          {/* Opened through the shell, not the webview — a Tauri window has no
              tabs to come back from. */}
          <a
            className={ui.aboutLink}
            href={GITHUB_URL}
            onClick={(e) => { e.preventDefault(); openUrl(GITHUB_URL).catch(() => { /* best-effort */ }); }}
          >
            {GITHUB_LABEL} ↗
          </a>
        </div>
        <div className={ui.aboutRow}>
          <span className={ui.aboutKey}>{t("systemSettings.about.licenseLabel")}</span>
          <span className={ui.aboutVal}>MIT</span>
        </div>
      </div>

      <div className={ui.aboutCopyright}>{t("systemSettings.about.copyright")}</div>
    </Pane>
  );
}
