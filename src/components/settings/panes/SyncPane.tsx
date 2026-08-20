import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../../stores/projectStore";
import { useSyncStore } from "../../../stores/syncStore";
import type { RemoteKb } from "../../../lib/sync/client";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";
import s from "../../sync/sync.module.css";

/**
 * 知识库同步（设计稿 06 · 画板 1a/1b/1c）.
 *
 * Three states in one pane, in the order the author meets them: not connected →
 * connected but unbound → bound. Project-scoped like WorkspacePane, so it shows
 * an explicit "open a project first" state rather than controls with nothing to
 * act on.
 *
 * Neither sync button syncs. Both open the preview
 * (`components/sync/SyncPreviewModal`), because a one-way mirror the author did
 * not read is the failure this whole feature exists to prevent.
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
    if (projectPath) void sync.hydrate(projectPath);
    // Hydration is per project; the store holds the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  if (!projectPath) {
    return (
      <Pane>
        <PaneHeader title={t("sync.paneTitle")} sub={t("sync.needProject")} />
      </Pane>
    );
  }

  const bound = sync.binding;
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

      {connected && !bound && (
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

      {bound && (
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
              desc={
                bound.lastSyncAt
                  ? t("sync.lastSync", { when: new Date(bound.lastSyncAt).toLocaleString() })
                  : t("sync.neverSynced")
              }
              last
            />
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
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
