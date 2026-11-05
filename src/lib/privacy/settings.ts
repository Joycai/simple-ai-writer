/** Higher-level boot/settings adapter; never imported by the HTTP gate. */
import { ask } from "@tauri-apps/plugin-dialog";
import i18n from "../../i18n";
import { readPrefConfirmed, writePrefConfirmed, PRIVACY_CONSENT_PREFIX } from "../prefs";
import { setPrivacySessionPaused, installConsentAdapter, type ConsentState, type Decision } from "./consent";

const CONTROL = "app:privacyControl";
export async function privacyControl(): Promise<{ epoch: string; paused: boolean }> {
  const raw = await readPrefConfirmed(CONTROL);
  if (raw === null) return { epoch: "initial", paused: false };
  const value = JSON.parse(raw);
  if (typeof value?.epoch !== "string" || typeof value?.paused !== "boolean") throw new Error("PRIVACY_INVALID_STATE");
  return value;
}
async function read(key: string): Promise<ConsentState> {
  const control = await privacyControl();
  const raw = await readPrefConfirmed(PRIVACY_CONSENT_PREFIX + key);
  let decision: Decision | undefined;
  if (raw !== null) {
    const value = JSON.parse(raw);
    if (typeof value?.version !== "number" || typeof value?.allowed !== "boolean"
      || typeof value?.epoch !== "string" || typeof value?.at !== "string") throw new Error("PRIVACY_INVALID_STATE");
    decision = value;
  }
  return { ...control, decision };
}
/** Pausing persists across processes and relaunch. Resume permits prompts, never sends by itself. */
export async function setPrivacyPaused(paused: boolean): Promise<void> {
  setPrivacySessionPaused(true);
  await writePrefConfirmed(CONTROL, JSON.stringify({ epoch: crypto.randomUUID(), paused }));
  if (!paused) setPrivacySessionPaused(false);
}
export function initializePrivacyConsent(): void {
  // Serialize native dialogs across purposes/targets; each request still makes its own decision.
  let dialogs = Promise.resolve();
  installConsentAdapter({
    read,
    errorText: (code) => i18n.t(code === "PRIVACY_REDIRECT_BLOCKED" ? "privacy.redirectBlocked" : "privacy.blocked"),
    save: (key, decision) => writePrefConfirmed(PRIVACY_CONSENT_PREFIX + key, JSON.stringify(decision)),
    ask: (recipient) => {
      const answer = dialogs.then(() => ask(i18n.t("privacy.consentBody", {
        endpoint: recipient.endpoint,
        scope: recipient.scope,
        purpose: i18n.t(`privacy.purposes.${recipient.purpose}`),
        data: i18n.t(`privacy.data.${recipient.purpose}`),
      }), { title: i18n.t("privacy.title"), kind: "warning",
        okLabel: i18n.t("privacy.allow"), cancelLabel: i18n.t("privacy.deny") }));
      dialogs = answer.then(() => {}, () => {});
      return answer;
    },
  });
}
