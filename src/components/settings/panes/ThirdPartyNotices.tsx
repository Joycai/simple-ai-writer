import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Section, Row } from "./bits";
import ui from "../settingsUi.module.css";
import styles from "./ThirdPartyNotices.module.css";

type Notices = typeof import("../../../assets/legal/third-party-notices.json");

/** Mounted only in the store channel; all text is bundled, never fetched remotely. */
export function ThirdPartyNotices() {
  const { t } = useTranslation();
  const [notices, setNotices] = useState<Notices | null>(null);
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  async function toggle() {
    if (opened) { setOpened(false); return; }
    if (notices) { setOpened(true); return; }
    setLoading(true);
    setFailed(false);
    try {
      setNotices((await import("../../../assets/legal/third-party-notices.json")).default);
      setOpened(true);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }
  const entries = notices?.entries.filter(entry => `${entry.name} ${entry.license}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <Section label={t("thirdParty.title")}>
    <Row desc={t("thirdParty.description")}>
      <button className={ui.rowBtn} disabled={loading} aria-expanded={opened} aria-controls="third-party-notices" onClick={() => void toggle()}>
        {t(loading ? "thirdParty.loading" : opened ? "thirdParty.hide" : "thirdParty.show")}
      </button>
    </Row>
    {failed && <p role="alert">{t("thirdParty.failed")}</p>}
    <div id="third-party-notices" hidden={!opened}>
      {opened && <>
        <label className={styles.search}>
          {t("thirdParty.search")}
          <input value={query} onChange={event => setQuery(event.target.value)} type="search" />
        </label>
        <p role="status">{t("thirdParty.count", { count: entries.length })}</p>
        {entries.map(entry => <details className={styles.entry} key={`${entry.name}@${entry.version}`}>
          <summary>{entry.name} · {entry.version} · {entry.license}</summary>
          {entry.files.map(file => <div key={file.name}>
            <p>{file.name}</p>
            <pre className={styles.text}>{file.text}</pre>
          </div>)}
        </details>)}
      </>}
    </div>
  </Section>;
}
