/**
 * 应用配置 —— 本地文件导出/导入，以及推到服务器上的备份档。
 *
 * Both halves live in one section on purpose. They are two exits from the same
 * thing, and splitting them across two settings pages (which is where the file
 * half used to live) made them look like two features — with the consequence
 * that the rule binding them, *keys may only leave this machine encrypted*,
 * looked like it applied to just one of them.
 *
 * This section is **installation-level**: no project needed. A machine with the
 * app freshly installed and no project yet is exactly when an author most wants
 * their providers back.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAiStore } from "../../../stores/aiStore";
import { useAppStore } from "../../../stores/appStore";
import { useConfigSyncStore, slotHeader } from "../../../stores/configSyncStore";
import {
  applyConfigImport,
  exportAiConfig,
  stageConfigImport,
} from "../../../lib/ai/configTransfer";
import type { RemoteSlot } from "../../../lib/configsync/client";
import { Section, Row, Chip, ChipRow, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";

/**
 * An error from the store, as something to read.
 *
 * `EnvelopeError` codes come through as keys because they are already the
 * vocabulary this pane needs; anything else is a message from a layer with no
 * translation (an HTTP failure, a locked keyring) and is shown as it came.
 */
function useErrorText(): (raw: string | null) => string | null {
  const { t } = useTranslation();
  const KEYS: Record<string, string> = {
    "keys-need-password": "sync.cfgErrKeysNeedPassword",
    "bad-password": "sync.cfgErrBadPassword",
    "password-required": "sync.cfgErrPasswordRequired",
    "not-an-envelope": "sync.cfgErrNotEnvelope",
    "unsupported-version": "sync.cfgErrUnsupportedVersion",
    "unsupported-crypto": "sync.cfgErrUnsupportedCrypto",
    "no-webcrypto": "sync.cfgErrNoWebcrypto",
    conflict: "sync.cfgErrConflict",
  };
  return (raw) => (raw ? (KEYS[raw] ? t(KEYS[raw]) : raw) : null);
}

export function ConfigBackupSection({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  const providers = useAiStore((s) => s.providers);
  const loadConfig = useAiStore((s) => s.loadConfig);
  const cfg = useConfigSyncStore();
  const errorText = useErrorText();

  const [includeKeysFile, setIncludeKeysFile] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileStatus, setFileStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (connected) void cfg.refresh();
    // Refreshing is a connection-level concern; the store holds the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const handleExport = async () => {
    if (fileBusy) return;
    setFileBusy(true);
    setFileStatus(null);
    try {
      const saved = await exportAiConfig(includeKeysFile);
      if (saved) {
        setFileStatus({ ok: true, text: t("systemSettings.backup.exported", { path: saved }) });
      }
    } catch (e) {
      setFileStatus({ ok: false, text: `${t("systemSettings.backup.exportFailed")} ${e}` });
    } finally {
      setFileBusy(false);
    }
  };

  const handleImport = async () => {
    if (fileBusy) return;
    setFileBusy(true);
    setFileStatus(null);
    try {
      const staged = await stageConfigImport(providers.map((p) => p.id));
      if (!staged) return;
      let confirmMsg = t("systemSettings.backup.importConfirm", {
        providers: staged.providers.length,
        models: staged.models.length,
        prompts: staged.prompts.length,
      });
      if (staged.keyCount > 0) {
        confirmMsg += `\n${t("systemSettings.backup.importKeysNote", { count: staged.keyCount })}`;
      }
      if (staged.prefs.length > 0) {
        confirmMsg += `\n${t("systemSettings.backup.importPrefsNote", { count: staged.prefs.length })}`;
      }
      if (!window.confirm(confirmMsg)) return;
      await applyConfigImport(staged);
      await loadConfig();
      // Imported preferences are in the store but not yet on screen.
      useAppStore.getState().reloadFromPrefs();
      setFileStatus({ ok: true, text: t("systemSettings.backup.imported") });
    } catch (e) {
      const invalid = e instanceof Error && e.message === "invalid-backup";
      setFileStatus({
        ok: false,
        text: invalid
          ? t("systemSettings.backup.invalidFile")
          : `${t("systemSettings.backup.importFailed")} ${e}`,
      });
    } finally {
      setFileBusy(false);
    }
  };

  const pushStatus = cfg.status?.text.startsWith("pushed:")
    ? (() => {
        const [providersN, models, prompts] = cfg.status.text.slice(7).split("/");
        return t("sync.cfgPushed", { providers: providersN, models, prompts });
      })()
    : null;

  return (
    <>
      <Section label={t("sync.cfgSection")}>
        <Row title={t("sync.cfgLocalLabel")} desc={t("sync.cfgLocalDesc")}>
          <button className={ui.rowBtn} onClick={handleExport} disabled={fileBusy}>
            {t("systemSettings.backup.export")}
          </button>
          <button className={ui.rowBtn} onClick={handleImport} disabled={fileBusy}>
            {t("systemSettings.backup.import")}
          </button>
        </Row>
        <Row
          title={t("systemSettings.backup.keysLabel")}
          desc={t("systemSettings.backup.keysHint")}
          warn={includeKeysFile ? t("systemSettings.backup.keysWarn") : undefined}
          last={!fileStatus}
        >
          <ChipRow>
            <Chip
              label={t("systemSettings.backup.keysOff")}
              active={!includeKeysFile}
              onClick={() => setIncludeKeysFile(false)}
            />
            <Chip
              label={t("systemSettings.backup.keysOn")}
              active={includeKeysFile}
              onClick={() => setIncludeKeysFile(true)}
            />
          </ChipRow>
        </Row>
        {fileStatus && (
          <Row
            desc={fileStatus.ok ? fileStatus.text : undefined}
            warn={fileStatus.ok ? undefined : fileStatus.text}
            last
          />
        )}
      </Section>

      <Section
        label={t("sync.cfgServerLabel")}
        action={
          connected ? (
            <button className={ui.rowBtn} onClick={() => void cfg.refresh()} disabled={cfg.loading}>
              {t(cfg.loading ? "sync.cfgLoading" : "sync.cfgRefresh")}
            </button>
          ) : undefined
        }
      >
        {!connected ? (
          <Row desc={t("sync.cfgNeedServer")} last />
        ) : (
          <>
            <Row title={t("sync.cfgKeysLabel")} desc={t("sync.cfgKeysDesc")}>
              <Toggle
                on={cfg.includeKeys}
                onChange={cfg.setIncludeKeys}
                label={t("sync.cfgKeysLabel")}
              />
            </Row>
            <Row
              title={t("sync.cfgPasswordLabel")}
              desc={t("sync.cfgPasswordDesc")}
              // The invariant, said in the row rather than only on failure:
              // ticking "include keys" makes the password field mandatory, and
              // the author should see that at the moment they tick it.
              warn={
                cfg.includeKeys && !cfg.password
                  ? t("sync.cfgErrKeysNeedPassword")
                  : undefined
              }
            >
              <input
                className={common.input}
                style={{ width: 240 }}
                type="password"
                autoComplete="new-password"
                placeholder={t("sync.cfgPasswordPlaceholder")}
                value={cfg.password}
                onChange={(e) => cfg.setPassword(e.target.value)}
              />
            </Row>
            <Row
              title={t("sync.cfgRemember")}
              desc={t("sync.cfgRememberDesc")}
              last={cfg.slots.length === 0 && !creating}
            >
              <Toggle
                on={cfg.remember}
                onChange={cfg.setRemember}
                label={t("sync.cfgRemember")}
              />
            </Row>

            {cfg.slots.map((slot, i) => (
              <SlotRow
                key={slot.id}
                slot={slot}
                last={i === cfg.slots.length - 1 && !creating}
              />
            ))}

            {cfg.slots.length === 0 && !creating && !cfg.loading && (
              <Row desc={t("sync.cfgNoSlots")} last />
            )}

            {creating ? (
              <Row title={t("sync.cfgNewSlotName")} desc={t("sync.cfgNewSlotHint")} last>
                <input
                  className={common.input}
                  style={{ width: 200 }}
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <button
                  className={ui.primaryBtn}
                  disabled={!newName.trim() || cfg.busy}
                  onClick={async () => {
                    const slot = await cfg.createSlot(newName.trim());
                    if (slot) {
                      setNewName("");
                      setCreating(false);
                    }
                  }}
                >
                  {t("common.create")}
                </button>
              </Row>
            ) : (
              <Row desc={pushStatus ?? undefined} warn={errorText(cfg.error) ?? undefined} last>
                <button className={ui.rowBtn} onClick={() => setCreating(true)}>
                  {t("sync.cfgNewSlot")}
                </button>
              </Row>
            )}
          </>
        )}
      </Section>
    </>
  );
}

/** One backup slot: what it holds, and the two things to do with it. */
function SlotRow({ slot, last }: { slot: RemoteSlot; last: boolean }) {
  const { t } = useTranslation();
  const cfg = useConfigSyncStore();
  const header = slotHeader(slot);

  const parts: string[] = [];
  if (slot.current) {
    parts.push(
      t("sync.cfgSlotMeta", {
        versions: slot.versionCount,
        when: new Date(slot.current.atMs).toLocaleString(),
      }),
    );
    if (header?.device) parts.push(t("sync.cfgSlotFrom", { device: header.device }));
    if (header) {
      parts.push(t(header.encrypted ? "sync.cfgEncrypted" : "sync.cfgPlain"));
      if (header.hasKeys) parts.push(t("sync.cfgHasKeys"));
    }
  } else {
    parts.push(t("sync.cfgSlotEmpty"));
  }

  return (
    <Row title={slot.name} desc={parts.join(" · ")} last={last}>
      <button
        className={ui.rowBtn}
        disabled={cfg.busy || !slot.current}
        onClick={() => void cfg.startRestore(slot.id)}
      >
        {t("sync.cfgRestore")}
      </button>
      <button
        className={ui.primaryBtn}
        disabled={cfg.busy}
        onClick={() => void cfg.push(slot.id)}
      >
        {t(cfg.busy ? "sync.cfgPushing" : "sync.cfgPush")}
      </button>
      <button
        className={ui.rowBtn}
        disabled={cfg.busy}
        onClick={() => {
          if (
            window.confirm(
              t("sync.cfgDeleteConfirm", { name: slot.name, versions: slot.versionCount }),
            )
          ) {
            void cfg.deleteSlot(slot.id);
          }
        }}
      >
        {t("sync.cfgDelete")}
      </button>
    </Row>
  );
}
