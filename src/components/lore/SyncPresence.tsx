import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/projectStore";
import { useSyncStore } from "../../stores/syncStore";
import { useAppStore } from "../../stores/appStore";
import type { FreshnessVerdict } from "../../lib/sync/status";
import { baseName } from "../../lib/paths";
import s from "./SyncPresence.module.css";

/**
 * 墙上的同步状态件 —— 设置页锚点卡的缩写(设计稿 14)。
 *
 * 同一枚判定圆点、同样带省略号的两个动作,压到一行,坐在头部工具带最右侧。
 * **它不做任何执行**:推送…/拉取… 都是「带方向打开既有的同步预览模态」,
 * 与设置页走同一条 `startPreview` 路 —— 没有预览就没有同步,在这里也一样。
 *
 * 未绑定的项目它整个不存在(绑定入口只在 ⋯ 菜单里留一项);断线时两个动作
 * 灰掉但不消失,补一枚「重连」,它调用与设置页同一个连接动作,不跳页。
 */
export function SyncPresence() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((p) => p.projectPath);
  const sync = useSyncStore();
  const openSettings = useAppStore((st) => st.openSettings);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 一次静默准备:补水、必要时连一次、刷新对比。失败落在 connection:"error",
  // 界面上就是「连不上」+ 手动重连 —— 不重试、不打扰。
  useEffect(() => {
    if (projectPath) void sync.ensureReady(projectPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const binding = projectPath ? sync.binding : null;
  if (!projectPath || !binding) return null;

  const connected = sync.connection === "connected";
  const running = sync.phase === "running";
  const verdict: FreshnessVerdict | "offline" | "loading" = !connected
    ? "offline"
    : (sync.freshness?.verdict ?? "loading");
  const risk = verdict === "diverged";
  const f = sync.freshness;

  const startPreview = (direction: "push" | "pull") => {
    setOpen(false);
    void sync.startPreview(projectPath, direction);
  };
  const reconnect = async () => {
    await sync.connect();
    if (useSyncStore.getState().connection === "connected") {
      await sync.refreshCounts(projectPath);
    }
  };

  if (running) {
    const p = sync.progress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    return (
      <div className={s.chip} style={{ cursor: "default" }}>
        <span className={`${s.dot} ${s.dotSpin}`} />
        <span className={s.label}>
          {t(sync.direction === "push" ? "sync.wRunningPush" : "sync.wRunningPull")}
        </span>
        {p && p.total > 0 && (
          <span className={s.count}>
            {p.done} / {p.total}
          </span>
        )}
        <div className={s.progress}>
          <div className={s.progressFill} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  const dotClass =
    verdict === "in-sync"
      ? s.dotOutline
      : verdict === "local-ahead" || verdict === "remote-ahead"
        ? s.dotFilled
        : risk
          ? s.dotRisk
          : verdict === "loading"
            ? s.dotSpin
            : s.dotDashed;
  const label =
    verdict === "offline"
      ? t("sync.wOffline")
      : verdict === "loading"
        ? t("sync.vLoading")
        : t(VERDICT_KEY[verdict]);
  const count =
    verdict === "loading"
      ? // 比对进度:大库的本地哈希要跑上几秒,数字是它和「挂了」之间的区别。
        sync.checking && sync.checking.total > 0
        ? `${sync.checking.done}/${sync.checking.total}`
        : null
      : !f
        ? null
        : verdict === "local-ahead"
          ? String(f.localAhead)
          : verdict === "remote-ahead"
            ? String(f.remoteAhead)
            : risk
              ? `${f.localAhead + f.diverged} · ${f.remoteAhead + f.diverged}`
              : null;

  // 待办的那一侧动作着赭石,另一侧留中性灰;两边都改过时两个都着色。
  const pushHot = risk || verdict === "local-ahead" || verdict === "in-sync" || verdict === "first-sync";
  const pullHot = risk || verdict === "remote-ahead";

  return (
    <div
      ref={rootRef}
      className={`${s.chip} ${risk ? s.chipRisk : ""} ${verdict === "offline" ? s.chipOffline : ""}`}
      onClick={() => setOpen((v) => !v)}
    >
      <span className={`${s.dot} ${dotClass}`} />
      <span className={`${s.label} ${risk ? s.labelRisk : verdict === "offline" || verdict === "first-sync" ? s.labelDim : ""}`}>
        {label}
      </span>
      {count && <span className={`${s.count} ${risk ? s.countRisk : ""}`}>{count}</span>}
      <span className={`${s.sep} ${risk ? s.sepRisk : ""}`} />
      <button
        className={`${s.action} ${risk ? s.actionRisk : pushHot ? s.actionOn : ""}`}
        disabled={!connected}
        onClick={(ev) => {
          ev.stopPropagation();
          startPreview("push");
        }}
      >
        {t("sync.wPush")}
      </button>
      <button
        className={`${s.action} ${risk ? s.actionRisk : pullHot ? s.actionOn : ""}`}
        disabled={!connected}
        onClick={(ev) => {
          ev.stopPropagation();
          startPreview("pull");
        }}
      >
        {t("sync.wPull")}
      </button>
      {!connected && (
        <>
          <span className={s.sep} />
          <button
            className={`${s.action} ${s.actionOn}`}
            onClick={(ev) => {
              ev.stopPropagation();
              void reconnect();
            }}
          >
            {t("sync.wReconnect")}
          </button>
        </>
      )}

      {open && (
        <div className={s.pop} onClick={(ev) => ev.stopPropagation()}>
          <div className={s.popHead}>
            <div className={s.popVerdict}>
              <span className={`${s.dot} ${dotClass}`} />
              <span className={s.popVerdictText}>
                {label}
                {count ? ` · ${count}` : ""}
              </span>
            </div>
            <div className={s.popBand}>
              <div className={s.popSide}>
                {baseName(projectPath)}
                <br />
                <span className={s.popSideMeta}>
                  {sync.localCount >= 0 ? t("sync.entryCount", { n: sync.localCount }) : "—"}
                </span>
              </div>
              <div className={s.popLine}>
                {(verdict === "remote-ahead" || risk) && <span className={s.popHeadLeft} />}
                {verdict === "offline" || verdict === "first-sync" || verdict === "loading" ? (
                  <span className={s.popBarDashed} />
                ) : (
                  <span className={s.popBar} />
                )}
                {(verdict === "local-ahead" || risk) && <span className={s.popHeadRight} />}
              </div>
              <div className={`${s.popSide} ${s.popSideEnd}`}>
                {binding.kbName}
                <br />
                <span className={s.popSideMeta}>
                  {connected && sync.remoteCount >= 0
                    ? t("sync.entryCount", { n: sync.remoteCount })
                    : t("sync.aUnreadable")}
                </span>
              </div>
            </div>
          </div>
          {sync.records.length > 0 && (
            <div className={s.popRecent}>
              <div className={s.popRecentLabel}>{t("sync.wRecent")}</div>
              <div className={s.popRecentRows}>
                {sync.records.slice(0, 3).map((r, i) => (
                  <div key={`${r.atMs}-${i}`}>
                    <span className={s.popRecentDir}>
                      {t(r.direction === "push" ? "sync.aRecPush" : "sync.aRecPull")}
                    </span>{" "}
                    {new Date(r.atMs).toLocaleString()}{" "}
                    {r.device ? (
                      r.device === sync.device ? (
                        <span className={s.popRecentSelf}>{t("sync.aRecSelf")}</span>
                      ) : (
                        <span className={s.popRecentDevice}>{r.device}</span>
                      )
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className={s.popActions}>
            <button className={s.popBtnPrimary} disabled={!connected} onClick={() => startPreview("push")}>
              {t("sync.wPush")}
            </button>
            <button className={s.popBtnGhost} disabled={!connected} onClick={() => startPreview("pull")}>
              {t("sync.wPull")}
            </button>
            <button
              className={s.popSettings}
              onClick={() => {
                setOpen(false);
                openSettings("sync");
              }}
            >
              {t("sync.wSettings")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const VERDICT_KEY: Record<FreshnessVerdict, string> = {
  "in-sync": "sync.vInSync",
  "local-ahead": "sync.vLocalAhead",
  "remote-ahead": "sync.vRemoteAhead",
  diverged: "sync.vDiverged",
  "first-sync": "sync.vFirstSync",
};
