/**
 * 花名册（设计稿 08 屏 1a / 1d）。
 *
 * 两类如何区分：**形状 + 分组，不是颜色**。角色是圆头像（取人物条目的配图，
 * 无图时用名字最后一个字），旁白是直角方框套一个小方块并单独成组置顶。
 * 花名册里永远只有一个赭石——它属于「选中」，不属于分类。
 *
 * 选中＝赭石淡染 + 赭石左规；悬停＝中性灰、无左规。两者永不混淆，这是
 * design-system.md 的硬规矩，把悬停也染成赭石会读成一个并不存在的选中。
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { useLoreStore } from "../../stores/loreStore";
import { useImageDataUrl } from "../lore/useImageDataUrl";
import { avatarGlyph, MAX_CONCURRENT_RUNS, ROSTER_PREVIEW_CHARS, type RoleplayAgent } from "../../lib/roleplay/model";
import { scriptPreview } from "../../lib/roleplay/markup";
import styles from "./RoleplayRoster.module.css";
import { isSamePath } from "../../lib/paths";

function Avatar({ agent, active }: { agent: RoleplayAgent; active: boolean }) {
  const loreIndex = useLoreStore((s) => s.index);
  const avatarPath = useMemo(() => {
    if (!agent.primaryDirPath) return null;
    for (const entities of Object.values(loreIndex)) {
      const hit = entities.find((e) => isSamePath(e.dirPath, agent.primaryDirPath));
      if (hit) return hit.avatarPath;
    }
    return null;
  }, [loreIndex, agent.primaryDirPath]);
  const url = useImageDataUrl(avatarPath);

  if (agent.kind === "narrator") {
    return (
      <div className={styles.narratorMark} aria-hidden>
        <span />
      </div>
    );
  }
  if (url) return <img className={styles.avatar} src={url} alt="" />;
  return (
    <div className={`${styles.avatar} ${active ? styles.avatarActive : ""}`} aria-hidden>
      {avatarGlyph(agent.name)}
    </div>
  );
}

function Row({ agent }: { agent: RoleplayAgent }) {
  const { t } = useTranslation();
  const {
    activeAgentId, running, queue, unread, stale, sessions, select,
  } = useRoleplayStore();
  const removeAgent = useRoleplayStore((s) => s.removeAgent);
  const loreIndex = useLoreStore((s) => s.index);

  const selected = activeAgentId === agent.id;
  const isRunning = running.includes(agent.id);
  const queuePos = queue.findIndex((j) => j.agentId === agent.id);
  const session = sessions[agent.id];
  const last = session?.turns[session.turns.length - 1];

  // 主角条目被删了：这个 agent 还能读、不能发，摘要行让位给一句说明。
  const primaryGone = agent.kind === "character" && agent.primaryDirPath !== null
    && !Object.values(loreIndex).some((es) => es.some((e) => isSamePath(e.dirPath, agent.primaryDirPath)));

  // 状态存在时摘要让位给状态（设计稿 1d）。
  let statusRow: React.ReactNode = null;
  if (primaryGone) {
    statusRow = <div className={styles.gone}>{t("roleplay.roster.primaryGone", { defaultValue: "人物条目已删除" })}</div>;
  } else if (isRunning) {
    statusRow = (
      <div className={styles.status}>
        <span className={styles.dotLive} />
        <span className={styles.statusLive}>{t("roleplay.roster.generating", { defaultValue: "正在生成" })}</span>
      </div>
    );
  } else if (queuePos >= 0) {
    statusRow = (
      <div className={styles.status}>
        <span className={styles.dotHollow} />
        <span className={styles.statusQueued}>
          {t("roleplay.roster.queuedAt", { n: queuePos + 1, defaultValue: `队列 · 第 ${queuePos + 1} 位` })}
        </span>
      </div>
    );
  } else if (stale[agent.id]) {
    statusRow = (
      <div className={styles.status}>
        <span className={styles.dotAccentHollow} />
        <span className={styles.statusDim}>{t("roleplay.roster.stale", { defaultValue: "设定已更新" })}</span>
      </div>
    );
  } else if (last) {
    statusRow = <div className={styles.preview}>{scriptPreview(last.text, ROSTER_PREVIEW_CHARS)}</div>;
  }

  return (
    <button
      type="button"
      className={`${styles.row} ${selected ? styles.rowSelected : ""}`}
      onClick={() => void select(agent.id)}
      // 窄面板收成头像轨时名字整个消失，只剩这一个悬停能认人的地方。
      title={agent.name}
    >
      <Avatar agent={agent} active={selected} />
      <div className={styles.rowBody}>
        <div className={styles.rowHead}>
          <span className={`${styles.name} ${primaryGone ? styles.nameGone : ""}`}>{agent.name}</span>
          {agent.kind === "narrator"
            ? <span className={styles.kindTag}>NARRATOR</span>
            : agent.turnCount > 0 && (
                <span className={styles.turns}>
                  {t("roleplay.roster.turns", { n: agent.turnCount, defaultValue: `${agent.turnCount} 轮` })}
                </span>
              )}
        </div>
        {statusRow}
      </div>
      {unread[agent.id] && !selected && <span className={styles.unread} aria-hidden />}
      {primaryGone && (
        <span
          className={styles.removeBtn}
          role="button"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); void removeAgent(agent.id); }}
        >
          {t("roleplay.roster.remove", { defaultValue: "移除" })}
        </span>
      )}
    </button>
  );
}

export function RoleplayRoster({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  const { order, agents, running, queue } = useRoleplayStore();
  const [query, setQuery] = useState("");

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return order
      .flatMap((id) => agents[id] ?? [])
      .filter((a) => !q || a.name.toLowerCase().includes(q));
  }, [order, agents, query]);

  const narrators = list.filter((a) => a.kind === "narrator");
  const characters = list.filter((a) => a.kind === "character");

  return (
    <div className={styles.rail}>
      <div className={styles.railHead}>
        <label className={styles.search}>
          <Search size={12} strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("roleplay.roster.search", { defaultValue: "搜索 agent" })}
          />
        </label>
        <button
          type="button"
          className={styles.newBtn}
          onClick={onNew}
          title={t("roleplay.newAgent", { defaultValue: "新建 agent" })}
        >
          <Plus size={13} strokeWidth={1.6} />
        </button>
      </div>

      <div className={styles.scroll}>
        {narrators.length > 0 && (
          <>
            <div className={styles.groupLabel}>{t("roleplay.kind.narrator", { defaultValue: "旁白" })}</div>
            {narrators.map((a) => <Row key={a.id} agent={a} />)}
          </>
        )}
        {characters.length > 0 && (
          <>
            <div className={styles.groupLabel}>
              {t("roleplay.kind.character", { defaultValue: "角色" })}
              <span className={styles.groupCount}>{characters.length}</span>
            </div>
            {characters.map((a) => <Row key={a.id} agent={a} />)}
          </>
        )}
      </div>

      <div className={styles.railFoot}>
        <span className={styles.footLabel}>{t("roleplay.concurrency", { defaultValue: "并发" })}</span>
        <span className={styles.slots}>
          {Array.from({ length: MAX_CONCURRENT_RUNS }, (_, i) => (
            <span key={i} className={i < running.length ? styles.slotOn : styles.slotOff} />
          ))}
        </span>
        <span className={styles.footValue}>{running.length} / {MAX_CONCURRENT_RUNS}</span>
        <div className={styles.spacer} />
        {queue.length > 0 && (
          <span className={styles.footLabel}>
            {t("roleplay.queuedCount", { n: queue.length, defaultValue: `排队 ${queue.length}` })}
          </span>
        )}
      </div>
    </div>
  );
}
