import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { readPref, writePref } from "../../lib/prefs";
import { IS_MAC, IS_TAURI } from "../../lib/platform";
import {
  CAPS_NOTICE_PREF,
  capsNoticeKey,
  engineName,
  missingCaps,
  parseEngine,
  shouldShowCapsNotice,
  type Cap,
  type EngineInfo,
} from "../../lib/webviewCaps";
import styles from "./WebviewCapsNotice.module.css";

/**
 * The engine as the author should name it in a bug report: the UA says
 * Chromium, but in a Tauri window on Windows that Chromium *is* WebView2, and
 * "update WebView2" is the actionable half of the message.
 */
export function hostEngineLabel(info: EngineInfo): string {
  const name = engineName(info);
  return info.kind === "chromium" && IS_TAURI && !IS_MAC ? `WebView2 (${name})` : name;
}

/** "a, b, c" in the UI language; ids are identifiers, only the commas vary. */
export function capList(caps: readonly Cap[], lang: string): string {
  return caps.map((c) => c.id).join(lang.startsWith("zh") ? "、" : ", ");
}

/**
 * Shown once per distinct set of missing built-ins — a machine whose webview
 * later falls short of something *else* is told again. Probed at mount and
 * never again: the engine does not change while the window is open.
 */
export function WebviewCapsNotice() {
  const { t, i18n } = useTranslation();
  const openSettings = useAppStore((s) => s.openSettings);
  const [missing] = useState(() => missingCaps());
  const [shown, setShown] = useState(() => shouldShowCapsNotice(missing, readPref(CAPS_NOTICE_PREF)));
  if (!shown) return null;

  const engine = parseEngine(navigator.userAgent);
  const dismiss = () => {
    writePref(CAPS_NOTICE_PREF, capsNoticeKey(missing));
    setShown(false);
  };

  return (
    <div className={styles.strip} role="status">
      <span className={styles.text}>
        {t(`webviewCaps.notice.${engine.kind}`, {
          engine: hostEngineLabel(engine),
          caps: capList(missing, i18n.language),
        })}
      </span>
      <button type="button" className={styles.action} onClick={() => openSettings("about")}>
        {t("webviewCaps.details")}
      </button>
      <button type="button" className={styles.action} onClick={dismiss}>
        {t("webviewCaps.dismiss")}
      </button>
    </div>
  );
}
