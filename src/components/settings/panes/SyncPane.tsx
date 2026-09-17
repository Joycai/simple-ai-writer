import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../../stores/projectStore";
import { useSyncStore } from "../../../stores/syncStore";
import type { RemoteSyncRecord } from "../../../lib/sync/client";
import type { FreshnessVerdict } from "../../../lib/sync/status";
import { ConfigBackupSection } from "./ConfigBackupSection";
import { KbPicker } from "./KbPicker";
import { useConfigSyncStore, slotHeader } from "../../../stores/configSyncStore";
import { Pane, PaneHeader } from "./bits";
import ui from "../settingsUi.module.css";
import sp from "./syncPane.module.css";
import { baseName } from "../../../lib/paths";

/**
 * 同步与备份 —— 设计稿 03d「同步在场感」的设置页半边。三个决定:
 *
 * **连接收进锚点卡本身。** 服务器不再是一个区块,而是锚点卡最上面那一条;
 * 断线时那一条就地展开成表单。全页只有这一个连接入口——原来页底那个
 * 重复的重连区就是这个文件此前最大的毛病。
 *
 * **作用域靠纸分。** 装机级的东西(应用配置、备份档)直接落在设置页这张
 * 底纸上,只带一条「这台机器」标题线;项目级的东西(绑定、同步选项、记录)
 * 落在一张 `--stg-hint` 色的暖纸上,纸头写着项目名。
 *
 * **项目在前,机器在后。** 绑定与推拉是这一页被打开的理由,所以暖纸紧跟
 * 锚点卡;「这台机器」挪到页底并默认收成一行摘要(没开项目时展开——那时
 * 它就是全部)。未绑定时选库走 `KbPicker`:推荐卡 + 搜索 + 定高列表,库再多
 * 绑定按钮也不会被挤到页底。见 `sync-lore-ui-brief.md` §绑定选择器。
 *
 * **推拉只有一个家。** 两个按钮长在锚点卡里,都带省略号,都先出预览
 * (`startPreview` → `SyncPreviewModal`,与墙上的状态件共用同一条路)。
 */
export function SyncPane() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((p) => p.projectPath);
  const sync = useSyncStore();
  // 这台机器 folds by default once a project is open — the project's binding is
  // what this page is visited for. Without a project it is all there is.
  const [machineOpen, setMachineOpen] = useState(() => !projectPath);
  const [editConn, setEditConn] = useState(false);
  const [showAllRecords, setShowAllRecords] = useState(false);

  useEffect(() => {
    // Without a project this still has to run: it is what loads the saved
    // address and its token, which the anchor card needs from a cold start.
    void sync.hydrate(projectPath ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // A cold start opens the form itself — with nothing saved there is no strip
  // worth showing alone. Keyed off `hydratedFor` rather than the url value so
  // *typing* an address never collapses the form mid-keystroke: only a
  // successful connect (or toggling 管理连接) closes it.
  useEffect(() => {
    if (sync.hydratedFor !== null && !sync.serverUrl.trim()) setEditConn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.hydratedFor]);

  const bound = projectPath ? sync.binding : null;
  const connected = sync.connection === "connected";
  const connecting = sync.connection === "connecting";
  const hasServer = sync.serverUrl.trim().length > 0;
  // The form is part of the strip, not a second place: it opens on a cold
  // start (the effect above), when the author asked (管理连接 / 改地址), or
  // when a connect failed and the fields are the thing to fix.
  const showForm = !connecting && (editConn || sync.connection === "error");

  const verdict: FreshnessVerdict | "offline" | "loading" = !connected
    ? "offline"
    : (sync.freshness?.verdict ?? "loading");

  const connect = async () => {
    await sync.connect();
    if (useSyncStore.getState().connection === "connected") setEditConn(false);
  };

  return (
    <Pane>
      <PaneHeader
        title={t("sync.paneTitle")}
        sub={bound ? t("sync.subBound") : connected ? t("sync.subConnected") : t("sync.subIntro")}
      />

      {/* ── 锚点卡 ─────────────────────────────────────────────────────── */}
      <div className={sp.anchor}>
        <div className={sp.strip}>
          {connecting ? (
            <>
              <span className={`${sp.dot} ${sp.dotSpin}`} />
              <span className={sp.stripHost}>{hostOf(sync.serverUrl)}</span>
              <span className={sp.stripNote}>{t("sync.aConnecting")}</span>
            </>
          ) : connected ? (
            <>
              <span className={`${sp.dot} ${sp.dotOn}`} />
              <span className={sp.stripHost}>{hostOf(sync.serverUrl)}</span>
              <span className={sp.stripNote}>{t("sync.aConnected")}</span>
              <span className={sp.stripSpacer} />
              <button className={ui.rowBtn} onClick={() => setEditConn((v) => !v)}>
                {t("sync.aManage")}
              </button>
            </>
          ) : hasServer ? (
            <>
              <span className={`${sp.dot} ${sp.dotFail}`} />
              <span className={sp.stripHost}>{hostOf(sync.serverUrl)}</span>
              <span className={sp.stripNote}>
                {t(sync.connection === "error" ? "sync.aFailTitle" : "sync.aOffline")}
                {/* 设计稿 03d 屏 1g: 「连不上 · 上次连通 今天 09:12」— when it last worked
                    is the one fact that tells a dead server from a wrong address. */}
                {sync.lastConnectedAt
                  ? ` · ${t("sync.aLastOnline", { when: new Date(sync.lastConnectedAt).toLocaleString() })}`
                  : ""}
              </span>
              <span className={sp.stripSpacer} />
              {/* While the form is open its own button is the action; a second
                  connect in the strip would be the two-entrances mistake again. */}
              {!showForm && (
                <>
                  <button className={ui.primaryBtn} onClick={() => void connect()}>
                    {t("sync.aReconnect")}
                  </button>
                  <button className={ui.rowBtn} onClick={() => setEditConn(true)}>
                    {t("sync.aEditConn")}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <span className={`${sp.dot} ${sp.dotOff}`} />
              <span className={sp.stripTitle}>{t("sync.aNoServer")}</span>
              <span className={sp.stripNote}>{t("sync.aNoServerNote")}</span>
            </>
          )}
        </div>

        {(showForm || (connected && editConn)) && (
          <div className={sp.connForm}>
            <div className={sp.connRow}>
              <span className={sp.connLabel}>{t("sync.serverAddress")}</span>
              <input
                className={`${sp.connInput} ${sp.connMono}`}
                placeholder="https://lore.example.local:8443"
                value={sync.serverUrl}
                onChange={(e) => sync.setServerUrlDraft(e.target.value)}
              />
            </div>
            <div className={sp.connRow}>
              <span className={sp.connLabel}>{t("sync.token")}</span>
              <input
                className={sp.connInput}
                type="password"
                placeholder={t("sync.aTokenPlaceholder")}
                value={sync.token}
                onChange={(e) => sync.setTokenDraft(e.target.value)}
              />
              <button className={ui.primaryBtn} onClick={() => void connect()} disabled={connecting}>
                {t(sync.connection === "error" ? "sync.aRetry" : "sync.connect")}
              </button>
              {connected && (
                <button
                  className={ui.rowBtn}
                  onClick={() => {
                    sync.disconnect();
                    setEditConn(false);
                  }}
                >
                  {t("sync.aDisconnect")}
                </button>
              )}
            </div>
            {sync.error ? (
              <div className={sp.connError}>
                <span className={sp.connErrorBar} />
                <div className={sp.connErrorText}>{sync.error}</div>
              </div>
            ) : (
              !connected && <div className={sp.connHint}>{t("sync.aTokenHint")}</div>
            )}
          </div>
        )}

        {connected && projectPath && !bound && (
          <div className={sp.strip} style={{ borderBottom: "none", padding: "15px 20px" }}>
            <span className={`${sp.dot} ${sp.dotOff}`} />
            <span className={sp.stripTitle}>
              {t("sync.aUnboundTitle", { name: baseName(projectPath) })}
            </span>
            <span className={sp.stripNote}>{t("sync.aUnboundDesc")}</span>
          </div>
        )}

        {bound && projectPath && (
          <>
            <div className={`${sp.band} ${verdict === "offline" ? sp.bandDim : ""}`}>
              <div className={`${sp.side} ${verdict === "diverged" ? sp.sideRisk : ""}`}>
                <div className={sp.sideLabel}>{t("sync.localProject")}</div>
                <div className={sp.sideName}>{baseName(projectPath)}</div>
                <div className={sp.sideMeta}>
                  {sync.localCount >= 0 ? t("sync.entryCount", { n: sync.localCount }) : "—"}
                  {verdict === "diverged" && sync.freshness
                    ? ` · ${t("sync.aChangedSuffix", { n: sync.freshness.localAhead + sync.freshness.diverged })}`
                    : ""}
                </div>
              </div>
              <Connector verdict={verdict} />
              <div className={`${sp.side} ${verdict === "diverged" ? sp.sideRisk : ""}`}>
                <div className={sp.sideLabel}>{t("sync.aServerSide")}</div>
                <div className={`${sp.sideName} ${verdict === "offline" ? sp.sideNameDim : ""}`}>
                  {bound.kbName}
                </div>
                <div className={sp.sideMeta}>
                  {verdict === "offline"
                    ? t("sync.aUnreadable")
                    : sync.remoteCount >= 0
                      ? `${t("sync.entryCount", { n: sync.remoteCount })}${
                          verdict === "diverged" && sync.freshness
                            ? ` · ${t("sync.aChangedSuffix", { n: sync.freshness.remoteAhead + sync.freshness.diverged })}`
                            : ""
                        }`
                      : "—"}
                </div>
              </div>
            </div>

            {verdict === "diverged" && sync.freshness && (
              <div className={sp.riskNote}>
                <div className={sp.verdictHead}>
                  <span className={`${sp.dot} ${sp.dotRisk}`} />
                  <span className={`${sp.verdictName} ${sp.verdictNameRisk}`}>
                    {t("sync.vDiverged")}
                  </span>
                  <span className={sp.verdictDesc}>
                    {t("sync.vDivergedDesc", {
                      local: sync.freshness.localAhead + sync.freshness.diverged,
                      remote: sync.freshness.remoteAhead + sync.freshness.diverged,
                    })}
                  </span>
                </div>
                <div className={sp.riskNoteBody}>
                  {t("sync.aRiskBody")}
                  <em> {t("sync.aRiskAdvice")}</em>
                </div>
              </div>
            )}

            <div className={sp.verdict}>
              <div className={sp.verdictMain}>
                {verdict !== "diverged" && <VerdictHead verdict={verdict} />}
                <LastSyncLine records={sync.records} lastSyncAt={bound.lastSyncAt} />
              </div>
              <div className={sp.actions}>
                <div className={sp.actionRow}>
                  <button
                    className={verdict === "remote-ahead" ? ui.primaryBtn : ui.rowBtn}
                    disabled={!connected}
                    onClick={() => void sync.startPreview(projectPath, "pull")}
                  >
                    {t("sync.aPull")}
                  </button>
                  <button
                    className={verdict === "remote-ahead" ? ui.rowBtn : ui.primaryBtn}
                    disabled={!connected}
                    onClick={() => void sync.startPreview(projectPath, "push")}
                  >
                    {t("sync.aPush")}
                  </button>
                </div>
                <div className={sp.actionNote}>
                  {t(verdict === "offline" ? "sync.aActionsOffline" : "sync.aActionsNote")}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── 暖纸:当前项目(项目级) ───────────────────────────────────── */}
      <div className={sp.paper}>
        <div className={sp.paperHead}>
          <span className={sp.paperEyebrow}>{t("sync.aProject")}</span>
          {projectPath ? (
            <>
              <span className={sp.paperName}>{baseName(projectPath)}</span>
              <span className={sp.paperMeta}>
                {sync.localCount >= 0 ? t("sync.entryCount", { n: sync.localCount }) : ""}
                {bound ? ` · ${t("sync.boundLabel")}` : ""}
              </span>
            </>
          ) : (
            <span className={`${sp.paperName} ${sp.paperNameDim}`}>{t("sync.aProjectNone")}</span>
          )}
          <span className={sp.stripSpacer} />
          <span className={sp.machineNote}>{t("sync.aProjectNote")}</span>
        </div>
        <div className={sp.paperRule} />

        {!projectPath ? (
          <div className={sp.paperBody}>
            {t("sync.aNoProjectBody")} <span>{t("sync.aNoProjectHint")}</span>
          </div>
        ) : !connected ? (
          bound ? (
            <RecordsBlock
              records={sync.records}
              device={sync.device}
              connected={false}
              showAll={showAllRecords}
              onShowAll={() => setShowAllRecords(true)}
            />
          ) : (
            <div className={sp.paperBody}>
              {t("sync.aNeedServerBody", { name: baseName(projectPath) })}
            </div>
          )
        ) : !bound ? (
          <KbPicker
            key={projectPath}
            projectPath={projectPath}
            projectName={baseName(projectPath)}
          />
        ) : (
          <>
            <div className={sp.paperRow}>
              <div className={sp.paperRowMain}>
                <div className={sp.paperRowTitle}>{t("sync.autoBackup")}</div>
                <div className={sp.paperRowDesc}>{t("sync.autoBackupDesc")}</div>
              </div>
              {/* Not a switch. The executor always backs up before a pull (lib/sync/run
                  rule 2) and nothing reads a preference here, so a toggle would be
                  the 「能力静默消失」 shape from docs/reference/tool-presence.md — the
                  author flips it and nothing changes. The row states the fact. */}
              <span className={sp.alwaysTag}>{t("sync.autoBackupAlways")}</span>
            </div>
            <div className={`${sp.paperRow} ${sp.paperRowLast}`}>
              <div className={sp.paperRowMain}>
                <div className={sp.paperRowDesc}>{t("sync.unbindHint")}</div>
              </div>
              <button
                className={ui.rowBtn}
                onClick={() => {
                  if (
                    window.confirm(
                      t("sync.aUnbindConfirm", {
                        project: baseName(projectPath),
                        kb: bound.kbName,
                      }),
                    )
                  ) {
                    void sync.unbind(projectPath);
                  }
                }}
              >
                {t("sync.aUnbindBtn")}
              </button>
            </div>

            <RecordsBlock
              records={sync.records}
              device={sync.device}
              connected={connected}
              showAll={showAllRecords}
              onShowAll={() => setShowAllRecords(true)}
            />
          </>
        )}
      </div>

      {/* ── 底纸:这台机器(装机级) ───────────────────────────────────── */}
      <div className={sp.machineHead}>
        <span className={sp.machineEyebrow}>{t("sync.aMachine")}</span>
        {sync.device && <span className={sp.machineName}>{sync.device}</span>}
        <span className={sp.stripSpacer} />
        <span className={sp.machineNote}>{t("sync.aMachineNote")}</span>
      </div>
      <div className={sp.machineRule} />
      <button
        className={sp.machineSummary}
        aria-expanded={machineOpen}
        aria-controls="sync-machine-body"
        onClick={() => setMachineOpen((v) => !v)}
      >
        <span className={sp.machineSummaryMain}>
          <span className={sp.machineSummaryTitle}>{t("sync.cfgSumTitle")}</span>
          <span className={sp.machineSummaryDesc}>
            <ConfigSummary connected={connected} />
          </span>
        </span>
        <span className={sp.machineSummaryToggle}>
          {t(machineOpen ? "sync.cfgSumCollapse" : "sync.cfgSumExpand")}
          <span className={`${sp.chevron} ${machineOpen ? sp.chevronOpen : ""}`} aria-hidden />
        </span>
      </button>
      {/* Hidden, not unmounted: the section refreshes the slot list the summary
          line reads, and keeps a half-typed slot name across a fold. */}
      <div id="sync-machine-body" hidden={!machineOpen}>
        <ConfigBackupSection connected={connected} />
      </div>
    </Pane>
  );
}

/**
 * 「本地文件导入 / 导出 · 服务器上 2 个备份档 · 最近 studio · 2026/9/12 · 已加密」——
 * what the folded 这台机器 section holds, so nobody has to unfold it to learn
 * there is nothing new there.
 */
function ConfigSummary({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  const slots = useConfigSyncStore((s) => s.slots);
  const loading = useConfigSyncStore((s) => s.loading);
  const failed = useConfigSyncStore((s) => s.error !== null && s.slots.length === 0);
  const parts = [t("sync.cfgSumLocal")];
  if (!connected) {
    parts.push(t("sync.cfgSumOffline"));
  } else if (failed) {
    // A failed read also empties the list; "no backups yet" would be a lie.
    parts.push(t("sync.cfgSumFailed"));
  } else if (loading && slots.length === 0) {
    parts.push(t("sync.cfgLoading"));
  } else if (slots.length === 0) {
    parts.push(t("sync.cfgSumNoSlots"));
  } else {
    parts.push(t("sync.cfgSumSlots", { n: slots.length }));
    const latest = slots
      .filter((s) => s.current)
      .sort((a, b) => b.current!.atMs - a.current!.atMs)[0];
    if (latest?.current) {
      parts.push(
        t("sync.cfgSumLatest", {
          name: latest.name,
          when: new Date(latest.current.atMs).toLocaleDateString(),
        }),
      );
      const header = slotHeader(latest);
      if (header) parts.push(t(header.encrypted ? "sync.cfgEncrypted" : "sync.cfgPlain"));
    }
  }
  return <>{parts.join(" · ")}</>;
}

type AnchorVerdict = FreshnessVerdict | "offline" | "loading";

/** 双卡带中间那根线:五档判定各有一个形。 */
function Connector({ verdict }: { verdict: AnchorVerdict }) {
  const { t } = useTranslation();
  const risk = verdict === "diverged";
  return (
    <div className={sp.linkCol}>
      <div className={sp.linkLine}>
        {(verdict === "remote-ahead" || risk) && (
          <span className={`${sp.linkHeadLeft} ${risk ? sp.linkHeadRisk : ""}`} />
        )}
        {verdict === "first-sync" || verdict === "offline" || verdict === "loading" ? (
          <span className={sp.linkDashed} />
        ) : (
          <span
            className={`${sp.linkBar} ${risk ? sp.linkBarRisk : verdict === "in-sync" ? "" : sp.linkBarSoft}`}
          />
        )}
        {(verdict === "local-ahead" || risk) && (
          <span className={`${sp.linkHeadRight} ${risk ? sp.linkHeadRisk : ""}`} />
        )}
      </div>
      <div className={`${sp.linkTag} ${risk ? sp.linkTagRisk : ""}`}>{t("sync.boundLabel")}</div>
    </div>
  );
}

function VerdictHead({ verdict }: { verdict: AnchorVerdict }) {
  const { t } = useTranslation();
  const f = useSyncStore((s) => s.freshness);
  const checking = useSyncStore((s) => s.checking);
  switch (verdict) {
    case "in-sync":
      return (
        <div className={sp.verdictHead}>
          <span className={`${sp.dot} ${sp.dotOff}`} />
          <span className={sp.verdictName}>{t("sync.vInSync")}</span>
          <span className={sp.verdictDesc}>{t("sync.vInSyncDesc")}</span>
        </div>
      );
    case "local-ahead":
      return (
        <div className={sp.verdictHead}>
          <span className={`${sp.dot} ${sp.dotChanged}`} />
          <span className={sp.verdictName}>{t("sync.vLocalAhead")}</span>
          <span className={sp.verdictDesc}>
            <b>{f?.localAhead ?? 0}</b> {t("sync.vLocalAheadDesc")}
          </span>
        </div>
      );
    case "remote-ahead":
      return (
        <div className={sp.verdictHead}>
          <span className={`${sp.dot} ${sp.dotChanged}`} />
          <span className={sp.verdictName}>{t("sync.vRemoteAhead")}</span>
          <span className={sp.verdictDesc}>
            <b>{f?.remoteAhead ?? 0}</b> {t("sync.vRemoteAheadDesc")}
          </span>
        </div>
      );
    case "first-sync":
      return (
        <div className={sp.verdictHead}>
          <span className={`${sp.dot} ${sp.dotUnknown}`} />
          <span className={`${sp.verdictName} ${sp.verdictNameDim}`}>{t("sync.vFirstSync")}</span>
          <span className={sp.verdictDesc}>{t("sync.vFirstSyncDesc")}</span>
        </div>
      );
    case "offline":
      return (
        <div className={sp.verdictHead}>
          <span className={`${sp.dot} ${sp.dotUnknown}`} />
          <span className={`${sp.verdictName} ${sp.verdictNameDim}`}>{t("sync.vOffline")}</span>
        </div>
      );
    default:
      // 比对中。哈希会读知识库里每一张配图的每一个字节,大库要跑上几秒——
      // 逐条进度是它和「挂了」之间的全部区别。
      return (
        <div className={sp.verdictHead}>
          <span className={`${sp.dot} ${sp.dotSpin}`} />
          <span className={`${sp.verdictName} ${sp.verdictNameDim}`}>{t("sync.vLoading")}</span>
          {checking && checking.total > 0 && (
            <span className={sp.verdictDesc}>
              {checking.done} / {checking.total} · {checking.path}
            </span>
          )}
        </div>
      );
  }
}

/**
 * 「上次同步:拉取 · 今天 09:12 · 来自 studio-imac」。服务器的记录在,就用它
 * (它有方向和机器名);不在(断线、旧服务端),退回绑定里的本地时间戳。
 */
function LastSyncLine({
  records,
  lastSyncAt,
}: {
  records: RemoteSyncRecord[];
  lastSyncAt: string | null;
}) {
  const { t } = useTranslation();
  const top = records[0];
  if (top) {
    return (
      <div className={sp.lastSync}>
        {t("sync.aLastSync")}
        <b>{t(top.direction === "push" ? "sync.push" : "sync.pull")}</b>
        {" · "}
        <span>{new Date(top.atMs).toLocaleString()}</span>
        {top.device ? (
          <>
            {" · "}
            {t("sync.kbFrom", { device: top.device })}
          </>
        ) : null}
      </div>
    );
  }
  return (
    <div className={sp.lastSync}>
      {lastSyncAt
        ? t("sync.lastSync", { when: new Date(lastSyncAt).toLocaleString() })
        : t("sync.neverSynced")}
    </div>
  );
}

/** 最近同步记录:表头 + 前 4 条(可展开),别的机器的行带 2px 左竖线。 */
function RecordsBlock({
  records,
  device,
  connected,
  showAll,
  onShowAll,
}: {
  records: RemoteSyncRecord[];
  device: string;
  connected: boolean;
  showAll: boolean;
  onShowAll: () => void;
}) {
  const { t } = useTranslation();
  const shown = showAll ? records : records.slice(0, 4);
  const hasOther = records.some((r) => r.device && r.device !== device);
  return (
    <>
      <div className={sp.recHead}>
        <span className={sp.recTitle}>{t("sync.sectionHistory")}</span>
        <span className={sp.recNote}>{t("sync.aRecNote")}</span>
      </div>
      <div className={sp.paperRule} />
      {records.length === 0 ? (
        <div className={sp.recEmpty}>
          {connected ? (
            <>
              {t("sync.aRecEmpty")} <span>{t("sync.aRecEmptyHint")}</span>
            </>
          ) : (
            t("sync.historyOffline")
          )}
        </div>
      ) : (
        <>
          <div className={`${sp.recGrid} ${sp.recThead}`}>
            <span>{t("sync.aRecDir")}</span>
            <span>{t("sync.aRecWhen")}</span>
            <span>{t("sync.aRecFrom")}</span>
            <span>{t("sync.aRecCounts")}</span>
          </div>
          {shown.map((r, i) => {
            const other = !!r.device && r.device !== device;
            return (
              <div
                key={`${r.atMs}-${i}`}
                className={`${sp.recGrid} ${sp.recRow} ${other ? sp.recRowOther : ""}`}
              >
                <span className={sp.recDir}>
                  {t(r.direction === "push" ? "sync.aRecPush" : "sync.aRecPull")}
                </span>
                <span className={sp.recWhen}>{new Date(r.atMs).toLocaleString()}</span>
                <span className={`${sp.recDevice} ${other ? sp.recDeviceOther : ""}`}>
                  {r.device ?? "—"}
                  {r.device && r.device === device && (
                    <span className={sp.recSelf}>{t("sync.aRecSelf")}</span>
                  )}
                </span>
                <span className={sp.recCounts}>
                  +{r.created} · ⟳{r.replaced} · −{r.deleted}
                </span>
              </div>
            );
          })}
          {(records.length > shown.length || hasOther) && (
            <div className={sp.recFoot}>
              {records.length > shown.length && (
                <button className={sp.recMore} onClick={onShowAll}>
                  {t("sync.aRecMore", { n: records.length - shown.length })}
                </button>
              )}
              {hasOther && <span className={sp.recLegend}>{t("sync.aRecLegend")}</span>}
            </div>
          )}
        </>
      )}
    </>
  );
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
