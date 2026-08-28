import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../../stores/projectStore";
import { useSyncStore } from "../../../stores/syncStore";
import type { RemoteKb, RemoteSyncRecord } from "../../../lib/sync/client";
import type { Freshness } from "../../../lib/sync/status";
import { ConfigBackupSection } from "./ConfigBackupSection";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";
import s from "../../sync/sync.module.css";
import { baseName } from "../../../lib/paths";

/**
 * 同步与备份 —— 一台服务器，两件互不相干的东西。
 *
 * 服务器（地址 + token）和**应用配置**都是装机级的：不需要打开任何项目。
 * **知识库同步**是按项目走的。这三节按作者遇到它们的顺序排。
 *
 * The project gate used to be the pane's first statement — no project, no pane.
 * That was right when the pane only did knowledge-base sync and is wrong now:
 * a freshly installed machine with no project yet is exactly when an author
 * wants their providers back. So the gate moved down into the section it
 * actually governs, and the two above it work from a cold start.
 *
 * Neither sync button syncs, and neither restore button restores. Both open a
 * preview (`components/sync/SyncPreviewModal`, `ConfigRestoreModal`), because
 * work overwritten by something the author did not read is the failure both
 * halves of this pane exist to prevent.
 */
export function SyncPane() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((p) => p.projectPath);
  const sync = useSyncStore();
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [autoBackup, setAutoBackup] = useState(true);

  useEffect(() => {
    // Without a project this still has to run: it is what loads the saved
    // address and its token, which the server section needs from a cold start.
    void sync.hydrate(projectPath ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const bound = projectPath ? sync.binding : null;
  const connected = sync.connection === "connected";

  return (
    <Pane>
      <PaneHeader
        title={t("sync.paneTitle")}
        sub={bound ? t("sync.subBound") : connected ? t("sync.subConnected") : t("sync.subIntro")}
      />

      <Section label={t("sync.sectionServer")}>
        {connected ? (
          <Row title={sync.serverUrl.replace(/^https?:\/\//, "")} desc={t("sync.connected")} last>
            <button className={ui.rowBtn} onClick={sync.disconnect}>
              {t("sync.disconnect")}
            </button>
          </Row>
        ) : (
          <>
            <Row title={t("sync.serverAddress")} desc={t("sync.serverAddressDesc")}>
              <input
                className={common.input}
                style={{ width: 320, fontFamily: "var(--font-mono)", fontSize: 13 }}
                value={sync.serverUrl}
                placeholder="https://lore.example.local:8443"
                onChange={(e) => sync.setServerUrlDraft(e.target.value)}
              />
            </Row>
            <Row title={t("sync.token")} desc={t("sync.tokenDesc")}>
              <input
                className={common.input}
                style={{ width: 320, fontSize: 13 }}
                type="password"
                value={sync.token}
                onChange={(e) => sync.setTokenDraft(e.target.value)}
              />
            </Row>
            <Row desc={sync.error ?? t("sync.connectHint")} warn={sync.error ?? undefined} last>
              <button
                className={ui.primaryBtn}
                disabled={sync.connection === "connecting"}
                onClick={() => void sync.connect()}
              >
                {t(sync.connection === "connecting" ? "sync.connecting" : "sync.connect")}
              </button>
            </Row>
          </>
        )}
      </Section>

      <ConfigBackupSection connected={connected} />

      {connected && projectPath && !bound && (
        <Section
          label={t("sync.sectionRemoteKbs")}
          action={
            creating ? undefined : (
              <button className={ui.rowBtn} onClick={() => setCreating(true)}>
                {t("sync.newKb")}
              </button>
            )
          }
        >
          {creating && (
            <Row title={t("sync.newKbName")} last={sync.kbs.length === 0}>
              <input
                className={common.input}
                style={{ width: 220 }}
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                className={ui.primaryBtn}
                disabled={!newName.trim() || sync.busy}
                onClick={async () => {
                  const kb = await sync.createKb(newName.trim());
                  if (kb) {
                    setSelected(kb.id);
                    setNewName("");
                    setCreating(false);
                  }
                }}
              >
                {t("common.create")}
              </button>
            </Row>
          )}
          {sync.kbs.map((kb, i) => (
            <KbRow
              key={kb.id}
              kb={kb}
              selected={selected === kb.id}
              last={i === sync.kbs.length - 1}
              onSelect={() => setSelected(kb.id)}
            />
          ))}
          {sync.kbs.length === 0 && !creating && (
            <Row desc={t("sync.noKbs")} last />
          )}
          <Row desc={t("sync.bindHint")} last>
            <button
              className={ui.primaryBtn}
              disabled={!selected}
              onClick={() => {
                const kb = sync.kbs.find((k) => k.id === selected);
                if (kb) void sync.bind(projectPath, kb);
              }}
            >
              {selected
                ? t("sync.bindTo", { name: sync.kbs.find((k) => k.id === selected)?.name ?? "" })
                : t("sync.bind")}
            </button>
          </Row>
        </Section>
      )}

      {connected && !projectPath && (
        <Section label={t("sync.sectionKb")}>
          <Row desc={t("sync.kbNeedProject")} last />
        </Section>
      )}

      {bound && projectPath && (
        <>
          <Section label={t("sync.sectionBinding")}>
            <div className={s.band} style={{ padding: "18px 0 16px" }}>
              <div className={s.card}>
                <div className={s.sideLabel}>{t("sync.localProject")}</div>
                <div className={s.cardName}>{projectName(projectPath)}</div>
                <div className={s.cardMeta}>
                  {sync.localCount >= 0 ? t("sync.entryCount", { n: sync.localCount }) : "—"}
                </div>
              </div>
              <div className={s.arrowCol}>
                <div className={s.arrowLine}>
                  <span className={s.arrowHeadLeft} style={{ borderRightColor: "var(--sync-arrow)" }} />
                  <span className={s.arrowBar} style={{ background: "var(--sync-arrow)", height: 1.5 }} />
                  <span className={s.arrowHeadRight} style={{ borderLeftColor: "var(--sync-arrow)" }} />
                </div>
                <div className={s.arrowNote}>{t("sync.boundLabel")}</div>
              </div>
              <div className={s.card}>
                <div className={s.sideLabel}>{hostOf(bound.serverUrl)}</div>
                <div className={s.cardName}>{bound.kbName}</div>
                <div className={s.cardMeta}>
                  {sync.remoteCount >= 0 ? t("sync.entryCount", { n: sync.remoteCount }) : "—"}
                </div>
              </div>
            </div>
            <Row
              title={sync.freshness ? freshnessText(sync.freshness, t) : undefined}
              desc={
                bound.lastSyncAt
                  ? t("sync.lastSync", { when: new Date(bound.lastSyncAt).toLocaleString() })
                  : t("sync.neverSynced")
              }
              warn={
                sync.freshness?.verdict === "diverged" ? t("sync.freshDivergedWarn") : undefined
              }
              last
            >
              {connected && (
                <button className={ui.rowBtn} onClick={() => void sync.refreshCounts(projectPath)}>
                  {t("sync.refresh")}
                </button>
              )}
            </Row>
          </Section>

          <Section label={t("sync.sectionSync")}>
            <Row title={t("sync.pushRow")} desc={t("sync.pushRowDesc")}>
              <button
                className={ui.primaryBtn}
                disabled={!connected}
                onClick={() => void sync.startPreview(projectPath, "push")}
              >
                {t("sync.pushBtn")}
              </button>
            </Row>
            <Row title={t("sync.pullRow")} desc={t("sync.pullRowDesc")}>
              <button
                className={ui.rowBtn}
                disabled={!connected}
                onClick={() => void sync.startPreview(projectPath, "pull")}
              >
                {t("sync.pullBtn")}
              </button>
            </Row>
            <Row title={t("sync.autoBackup")} desc={t("sync.autoBackupDesc")}>
              {/* Read-only for now: the executor always backs up before a pull
                  (lib/sync/run rule 2), and a switch that could turn the only
                  safety net off would need its own confirmation to be honest. */}
              <Toggle on={autoBackup} onChange={setAutoBackup} label={t("sync.autoBackup")} />
            </Row>
            <Row desc={t("sync.unbindHint")} last>
              <button className={ui.rowBtn} onClick={() => void sync.unbind(projectPath)}>
                {t("sync.unbind")}
              </button>
            </Row>
          </Section>

          <Section label={t("sync.sectionHistory")}>
            {sync.records.length === 0 ? (
              <Row desc={t(connected ? "sync.historyEmpty" : "sync.historyOffline")} last />
            ) : (
              sync.records.map((r, i) => (
                <Row
                  key={`${r.atMs}-${i}`}
                  title={`${t(r.direction === "push" ? "sync.historyPush" : "sync.historyPull")} · ${new Date(r.atMs).toLocaleString()}`}
                  desc={recordSubtitle(r, t)}
                  last={i === sync.records.length - 1}
                />
              ))
            )}
          </Section>

          {!connected && (
            <Section label={t("sync.sectionServer")}>
              <Row desc={t("sync.reconnectHint")} last>
                <button className={ui.primaryBtn} onClick={() => void sync.connect()}>
                  {t("sync.connect")}
                </button>
              </Row>
            </Section>
          )}
        </>
      )}
    </Pane>
  );
}

/**
 * "128 条 · 最后更新 08-19 22:41 · 来自 MacBook-Pro" — the line that tells the
 * author which of several knowledge bases is the one they have been writing
 * into. Each clause is dropped when the server has nothing to say: an empty
 * base has no update time, and a base written by a client that sent no
 * `X-Source-Device` has no machine name. Rendering "unknown" for those would
 * be noise dressed as information.
 */
function kbSubtitle(kb: RemoteKb, t: (k: string, o?: Record<string, unknown>) => string): string {
  const parts = [t("sync.entryCount", { n: kb.entryCount })];
  if (kb.updatedAtMs > 0) {
    parts.push(t("sync.kbUpdated", { when: new Date(kb.updatedAtMs).toLocaleString() }));
  }
  if (kb.lastDevice) parts.push(t("sync.kbFrom", { device: kb.lastDevice }));
  return parts.join(" · ");
}

/**
 * 谁比较新,一句话。The verdict comes from the three-way hash comparison
 * (`lib/sync/status`), so it can never contradict the preview the author is
 * about to read — both are drawn from the same maps.
 */
function freshnessText(f: Freshness, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (f.verdict) {
    case "in-sync":
      return t("sync.freshInSync");
    case "local-ahead":
      return t("sync.freshLocalAhead", { n: f.localAhead });
    case "remote-ahead":
      return t("sync.freshRemoteAhead", { n: f.remoteAhead });
    case "diverged":
      return t("sync.freshDiverged", {
        local: f.localAhead + f.diverged,
        remote: f.remoteAhead + f.diverged,
      });
    case "first-sync":
      return t("sync.freshFirstSync", { n: f.localAhead + f.remoteAhead + f.diverged });
  }
}

/**
 * "来自 MacBook-Pro · 新增 3 · 覆盖 2" — same rule as `kbSubtitle`: a clause
 * with nothing to say is dropped, and a run whose surviving clauses are all
 * zero (possible only from an older client) still gets a line rather than an
 * empty subtitle.
 */
function recordSubtitle(
  r: RemoteSyncRecord,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (r.device) parts.push(t("sync.kbFrom", { device: r.device }));
  if (r.created > 0) parts.push(t("sync.historyCreated", { n: r.created }));
  if (r.replaced > 0) parts.push(t("sync.historyReplaced", { n: r.replaced }));
  if (r.deleted > 0) parts.push(t("sync.historyDeleted", { n: r.deleted }));
  if (parts.length === 0) parts.push(t("sync.historyNoCounts"));
  return parts.join(" · ");
}

function KbRow({
  kb,
  selected,
  last,
  onSelect,
}: {
  kb: RemoteKb;
  selected: boolean;
  last: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`${ui.row} ${last ? ui.rowLast : ""}`}
      style={{
        cursor: "pointer",
        background: selected ? "var(--sync-target-bg)" : undefined,
        boxShadow: selected ? "inset 0 0 0 1px var(--sync-target-ring)" : undefined,
        paddingLeft: selected ? 12 : undefined,
      }}
      onClick={onSelect}
    >
      <span
        style={{
          width: 15,
          height: 15,
          borderRadius: "50%",
          border: `1.5px solid ${selected ? "var(--stg-accent)" : "var(--stg-border-menu)"}`,
          display: "grid",
          placeItems: "center",
          marginRight: 14,
          flex: "none",
        }}
      >
        {selected && (
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--stg-accent)" }} />
        )}
      </span>
      <div className={ui.rowMain}>
        <div className={ui.rowTitle}>{kb.name}</div>
        <div className={ui.rowDesc}>{kbSubtitle(kb, t)}</div>
      </div>
    </div>
  );
}

function projectName(path: string): string {
  return baseName(path);
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
