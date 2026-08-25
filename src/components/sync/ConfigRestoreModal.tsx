/**
 * 从服务器恢复配置 —— 密码 → 预览 → 合并。
 *
 * The same convention the knowledge-base preview enforces, applied to the other
 * resource: **the button that downloads is not the button that merges.** A
 * restore replaces providers by id, overwrites keyring entries, and changes the
 * theme and panel widths the moment it lands. An author who pressed "restore"
 * expecting to look at something first would find all of that already done.
 *
 * The numbers on screen come from the **decrypted, re-validated** bundle, never
 * from the envelope's own `counts`: that field is self-reported and, once
 * encrypted, unverifiable by anyone. Rendering it here would put a number the
 * author trusts in front of a number nothing checked.
 */

import { useTranslation } from "react-i18next";
import { ModalShell } from "../common/ModalShell";
import { useConfigSyncStore } from "../../stores/configSyncStore";
import s from "./sync.module.css";

const ERROR_KEYS: Record<string, string> = {
  "bad-password": "sync.cfgErrBadPassword",
  "password-required": "sync.cfgErrPasswordRequired",
  "not-an-envelope": "sync.cfgErrNotEnvelope",
  "unsupported-version": "sync.cfgErrUnsupportedVersion",
  "unsupported-crypto": "sync.cfgErrUnsupportedCrypto",
  "no-webcrypto": "sync.cfgErrNoWebcrypto",
  conflict: "sync.cfgErrConflict",
};

export function ConfigRestoreModal() {
  const { t } = useTranslation();
  const phase = useConfigSyncStore((p) => p.phase);
  const target = useConfigSyncStore((p) => p.target);
  const prepared = useConfigSyncStore((p) => p.prepared);
  const password = useConfigSyncStore((p) => p.restorePassword);
  const error = useConfigSyncStore((p) => p.error);
  const store = useConfigSyncStore();

  if (phase === "idle") return null;

  const errorText = error ? (ERROR_KEYS[error] ? t(ERROR_KEYS[error]) : error) : null;

  return (
    <ModalShell
      overlayClassName={s.overlay}
      onClose={store.closeRestore}
      closeOnBackdrop={phase !== "applying"}
      closeOnEscape={phase !== "applying"}
    >
      <div className={`${s.panel} ${s.slim}`}>
        <div className={s.head}>
          <span className={s.headTitle}>{t("sync.cfgRestoreTitle")}</span>
          <span className={s.spacer} />
          <button className={s.close} onClick={store.closeRestore} aria-label="close">
            ✕
          </button>
        </div>

        {phase === "downloading" && (
          <div className={s.centered}>
            <div className={s.centeredTitle}>{t("sync.cfgRestoreDownloading")}</div>
          </div>
        )}

        {phase === "password" && (
          <>
            <div className={s.centered} style={{ paddingBottom: 8 }}>
              <div className={s.centeredTitle}>{t("sync.cfgRestorePasswordTitle")}</div>
              <div className={s.footNote} style={{ marginTop: 10 }}>
                {t("sync.cfgRestorePasswordHint")}
              </div>
              <input
                autoFocus
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => store.setRestorePassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && password) void store.submitRestorePassword();
                }}
                style={{
                  marginTop: 18,
                  width: "100%",
                  padding: "10px 12px",
                  font: "400 14px var(--font-sans)",
                  background: "var(--stg-bg-input)",
                  color: "var(--stg-text)",
                  border: "1px solid var(--stg-border-menu)",
                }}
              />
              {errorText && (
                <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--sync-risk-text)" }}>
                  {errorText}
                </div>
              )}
            </div>
            <div className={s.foot}>
              <span className={s.footNote} />
              <button className={s.btnGhost} onClick={store.closeRestore}>
                {t("common.cancel")}
              </button>
              <button
                className={s.btnPrimary}
                disabled={!password}
                onClick={() => void store.submitRestorePassword()}
              >
                {t("sync.cfgRestoreUnlock")}
              </button>
            </div>
          </>
        )}

        {(phase === "preview" || phase === "applying") && prepared && (
          <>
            <div className={s.centered} style={{ textAlign: "left", paddingBottom: 10 }}>
              <div className={s.centeredTitle}>
                {t("sync.cfgRestoreSummary", {
                  providers: prepared.bundle.providers.length,
                  models: prepared.bundle.models.length,
                  prompts: prepared.bundle.prompts.length,
                })}
              </div>
              {target?.header.device && target.version && (
                <div className={s.footNote} style={{ marginTop: 10 }}>
                  {t("sync.cfgRestoreVersionNote", {
                    device: target.header.device,
                    when: new Date(target.version.atMs).toLocaleString(),
                  })}
                </div>
              )}
              {prepared.bundle.keyCount > 0 && (
                <div className={s.footNote} style={{ marginTop: 10, color: "var(--sync-risk-text)" }}>
                  {t("sync.cfgRestoreKeysNote", { count: prepared.bundle.keyCount })}
                </div>
              )}
              {prepared.bundle.docFormats.length > 0 && (
                <div className={s.footNote} style={{ marginTop: 10 }}>
                  {t("sync.cfgRestoreFormatsNote", { count: prepared.bundle.docFormats.length })}
                </div>
              )}
              {prepared.bundle.prefs.length > 0 && (
                <div className={s.footNote} style={{ marginTop: 10 }}>
                  {t("sync.cfgRestorePrefsNote", { count: prepared.bundle.prefs.length })}
                </div>
              )}
              <div className={s.footNote} style={{ marginTop: 10 }}>
                {t("sync.cfgRestoreMergeNote")}
              </div>
              {errorText && (
                <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--sync-risk-text)" }}>
                  {errorText}
                </div>
              )}
            </div>
            <div className={s.foot}>
              <span className={s.footNote} />
              <button
                className={s.btnGhost}
                onClick={store.closeRestore}
                disabled={phase === "applying"}
              >
                {t("common.cancel")}
              </button>
              <button
                className={s.btnPrimary}
                disabled={phase === "applying"}
                onClick={() => void store.confirmRestore()}
              >
                {t(phase === "applying" ? "sync.cfgRestoreApplying" : "sync.cfgRestoreConfirm")}
              </button>
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <div className={s.centered}>
              <div className={s.centeredTitle}>{t("sync.cfgRestoreDone")}</div>
              <div className={s.footNote} style={{ marginTop: 10 }}>
                {t("sync.cfgRestoreDoneNote")}
              </div>
            </div>
            <div className={s.foot}>
              <span className={s.footNote} />
              <button className={s.btnPrimary} onClick={store.closeRestore}>
                {t("sync.cfgRestoreClose")}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}
