import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { privacyControl, setPrivacyPaused } from "../../../lib/privacy/settings";
import { Section, Row } from "./bits";
import ui from "../settingsUi.module.css";

const PRIVACY_POLICY_URL = "https://github.com/Joycai/simple-ai-writer/blob/main/PRIVACY.md";

/** Store-only. The local summary remains readable without network access. */
export function PrivacySection() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let live = true;
    const refresh = () => void privacyControl().then((value) => {
      if (live) setStatus(t(value.paused ? "privacy.paused" : "privacy.ready"));
    }).catch(() => { if (live) setStatus(t("privacy.failed")); });
    refresh();
    window.addEventListener("focus", refresh);
    return () => { live = false; window.removeEventListener("focus", refresh); };
  }, [t]);
  async function change(paused: boolean) {
    setBusy(true);
    try {
      await setPrivacyPaused(paused);
      setStatus(t(paused ? "privacy.paused" : "privacy.resumed"));
    } catch { setStatus(t("privacy.failed")); }
    finally { setBusy(false); }
  }
  return <Section label={t("privacy.title")}>
    <Row title={t("privacy.publicPolicyTitle")} desc={t("privacy.publicPolicyBody")}>
      <a className={ui.aboutLink} href={PRIVACY_POLICY_URL} onClick={(event) => {
        event.preventDefault();
        void openUrl(PRIVACY_POLICY_URL).catch(() => {
          setStatus(t("privacy.openPolicyFailed", { url: PRIVACY_POLICY_URL }));
        });
      }}>{t("privacy.openPolicy")} ↗</a>
    </Row>
    <Row title={t("privacy.policyTitle")} desc={t("privacy.summary")}>
      <button className={ui.rowBtn} onClick={() => void message(t("privacy.policyBody"), { title: t("privacy.policyTitle") })}>
        {t("privacy.readPolicy")}
      </button>
    </Row>
    <Row title={t("privacy.revokeTitle")} desc={t("privacy.revokeBody")}>
      <button className={ui.rowBtn} disabled={busy} onClick={() => void change(true)}>{t("privacy.revoke")}</button>
    </Row>
    <Row desc={t("privacy.resumeBody")} last>
      <button className={ui.rowBtn} disabled={busy} onClick={() => void change(false)}>{t("privacy.resume")}</button>
    </Row>
    <p role="status">{status}</p>
  </Section>;
}
