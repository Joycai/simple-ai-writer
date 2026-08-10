import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import styles from "../settingsCommon.module.css";

const GITHUB_URL = "https://github.com/Joycai/simple-ai-writer";

export function AboutPane() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
  }, []);

  const openLink = (url: string) => {
    openUrl(url).catch(() => { /* best-effort */ });
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.aboutHero}>
          <div className={styles.aboutName}>{t("systemSettings.about.appName")}</div>
          <div className={styles.aboutVersion}>v{version || "…"}</div>
          <div className={styles.aboutTagline}>{t("systemSettings.about.tagline")}</div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.itemList}>
          <div className={styles.item}>
            <div className={styles.itemInfo}>
              <div className={styles.itemName}>{t("systemSettings.about.versionLabel")}</div>
              <div className={styles.itemMeta}>{version || "…"}</div>
            </div>
          </div>
          <button className={styles.item} onClick={() => openLink(GITHUB_URL)} style={{ textAlign: "left", cursor: "pointer" }}>
            <GitBranch size={16} />
            <div className={styles.itemInfo}>
              <div className={styles.itemName}>{t("systemSettings.about.githubLabel")}</div>
              <div className={styles.itemMeta}>{GITHUB_URL}</div>
            </div>
            <ExternalLink size={14} />
          </button>
        </div>
      </div>

      <div className={styles.aboutCopyright}>{t("systemSettings.about.copyright")}</div>
    </div>
  );
}
