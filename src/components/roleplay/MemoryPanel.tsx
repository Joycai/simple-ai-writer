/**
 * 记事本 —— 一个 agent 记下的约定 / 待办 / 事件 / 关系。
 *
 * 设计稿 08 TURN 1 没有画这一屏，所以这里的判断是我做的，理由如下：
 *
 * **可收起的第三栏，默认收起。** 对话稿面固定 640px（与编辑器正文同宽，那是
 * 整个面板不肯让步的一条），抽屉 1180px 减去 272 的花名册只剩 908——一栏常驻的
 * 记事本会把稿面压到 640 以下，等于为一个「需要时才看」的东西破坏那条一直在
 * 看的东西。所以它从顶部信息带按需拉开。
 *
 * **但入口带计数。** 面板里其余控件都压成一行小字，记事本是唯一的例外：它不是
 * 配置，是作品的一部分。作者应当一眼看到「这个角色还欠着三件事」，所以那个
 * 数字常驻在信息带上。
 *
 * **不做成待办清单 app。** 没有复选框方阵、没有进度条、没有优先级星标——它是
 * 故事的账本，不是效率工具。「已兑现」和「已作废」不靠颜色区分（整个应用只有
 * 一个赭石），靠的是把它们整组折起来。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { useProjectStore } from "../../stores/projectStore";
import { areaEntities, scanArea } from "../../lib/roleplay/area";
import type { LoreEntity } from "../../lib/lore/model";
import { MEMORY_KINDS, hasDoneState, kindLabel } from "../../lib/roleplay/memory";
import type { MemoryKind, MemoryRecord } from "../../lib/roleplay/model";
import styles from "./MemoryPanel.module.css";

function Record({
  agentId, record, onJump,
}: {
  agentId: string;
  record: MemoryRecord;
  onJump: (turn: number) => void;
}) {
  const { t } = useTranslation();
  const reviseMemory = useRoleplayStore((s) => s.reviseMemory);
  const closed = record.status !== "open";

  return (
    <div className={`${styles.record} ${closed ? styles.recordClosed : ""}`}>
      <div className={styles.recordHead}>
        <span className={styles.recordTitle}>{record.title}</span>
        {record.turn > 0 && (
          <button type="button" className={styles.turnLink} onClick={() => onJump(record.turn)}>
            {t("roleplay.memory.jumpToTurn", { n: record.turn, defaultValue: `第 ${record.turn} 轮` })}
          </button>
        )}
      </div>
      {record.subject && <div className={styles.subject}>{record.subject}</div>}
      {record.body && <div className={styles.body}>{record.body}</div>}
      <div className={styles.actions}>
        {closed ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => void reviseMemory(agentId, record.id, { status: "open" })}
          >
            {t("roleplay.memory.reopen", { defaultValue: "重新生效" })}
          </button>
        ) : (
          <>
            {hasDoneState(record.kind) && (
              <button
                type="button"
                className={styles.action}
                onClick={() => void reviseMemory(agentId, record.id, { status: "done" })}
              >
                {t("roleplay.memory.markDone", { defaultValue: "已兑现" })}
              </button>
            )}
            <button
              type="button"
              className={styles.action}
              onClick={() => void reviseMemory(agentId, record.id, { status: "void" })}
            >
              {t("roleplay.memory.markVoid", { defaultValue: "已作废" })}
            </button>
          </>
        )}
        <div className={styles.spacer} />
        <span className={styles.id}>{record.id}</span>
      </div>
    </div>
  );
}

function AddForm({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const addMemory = useRoleplayStore((s) => s.addMemory);
  const [kind, setKind] = useState<MemoryKind>("pact");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    void addMemory(agentId, { kind, title: title.trim(), body: body.trim(), subject: null });
    onDone();
  };

  return (
    <div className={styles.form}>
      <div className={styles.kindRow}>
        {MEMORY_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`${styles.kindChip} ${kind === k ? styles.kindChipOn : ""}`}
            onClick={() => setKind(k)}
          >
            {kindLabel(k)}
          </button>
        ))}
      </div>
      <input
        className={styles.input}
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("roleplay.memory.titlePlaceholder", { defaultValue: "一行话" })}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <textarea
        className={styles.textarea}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("roleplay.memory.bodyPlaceholder", { defaultValue: "细节" })}
      />
      <div className={styles.formFoot}>
        <button type="button" className={styles.ghost} onClick={onDone}>
          {t("roleplay.memory.cancel", { defaultValue: "取消" })}
        </button>
        <button type="button" className={styles.primary} onClick={submit} disabled={!title.trim()}>
          {t("roleplay.memory.save", { defaultValue: "记下" })}
        </button>
      </div>
    </div>
  );
}

export function MemoryPanel({
  agentId, onClose, onJump,
}: {
  agentId: string;
  onClose: () => void;
  onJump: (turn: number) => void;
}) {
  const { t } = useTranslation();
  const session = useRoleplayStore((s) => s.sessions[agentId]);
  const refreshMemory = useRoleplayStore((s) => s.refreshMemory);
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const records = session?.memory ?? [];
  const open = useMemo(() => records.filter((r) => r.status === "open"), [records]);
  const closed = useMemo(() => records.filter((r) => r.status !== "open"), [records]);

  // 记忆区那一层。读盘而不是进 store：它只在这个面板打开着的时候有人看，而每次
  // 转场都会改它——让 store 背一份就得再维护一条同步路径。
  const projectPath = useProjectStore((s) => s.projectPath);
  const areaId = useRoleplayStore((s) => s.agents[agentId]?.areaId ?? null);
  const [areaItems, setAreaItems] = useState<LoreEntity[]>([]);
  useEffect(() => {
    if (!projectPath || !areaId) { setAreaItems([]); return; }
    let alive = true;
    void scanArea(projectPath, areaId)
      .then((idx) => { if (alive) setAreaItems(areaEntities(idx)); })
      .catch(() => { if (alive) setAreaItems([]); });
    return () => { alive = false; };
    // 转场之后条目会多出来一批——`turnCount` 归零正是那一刻。
  }, [projectPath, areaId, session?.turns.length]);

  return (
    <aside className={styles.panel}>
      <header className={styles.head}>
        <span className={styles.title}>{t("roleplay.memory.title", { defaultValue: "记事本" })}</span>
        <span className={styles.count}>
          {t("roleplay.memory.count", { n: open.length, defaultValue: `${open.length} 条在生效` })}
        </span>
        <div className={styles.spacer} />
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setAdding((v) => !v)}
          title={t("roleplay.memory.add", { defaultValue: "手动记一条" })}
        >
          <Plus size={13} strokeWidth={1.8} />
        </button>
        <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
          <X size={13} strokeWidth={1.8} />
        </button>
      </header>

      {session?.memoryStale && (
        <div className={styles.staleBar}>
          <span className={styles.staleText}>
            {t("roleplay.memory.stale", { defaultValue: "记事本改过了，本次对话用的还是旧的。" })}
          </span>
          <button type="button" className={styles.staleBtn} onClick={() => void refreshMemory(agentId)}>
            {t("roleplay.memory.refresh", { defaultValue: "刷新记忆" })}
          </button>
        </div>
      )}

      <div className={styles.scroll}>
        {adding && <AddForm agentId={agentId} onDone={() => setAdding(false)} />}

        {records.length === 0 && !adding && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>
              {t("roleplay.memory.empty", { defaultValue: "还没有记下任何东西。" })}
            </div>
            <div className={styles.emptyHint}>
              {t("roleplay.memory.emptyHint", {
                defaultValue: "角色会在你们说定一件事、或它对你的看法变化时自己记下来。你也可以手动加。",
              })}
            </div>
          </div>
        )}

        {/* ── 常驻层 ── 每轮都在，不需要被提起。 */}
        {(open.length > 0 || areaItems.length > 0) && (
          <div className={styles.tierLabel}>
            <span className={styles.tierName}>
              {t("roleplay.memory.tierStanding", { defaultValue: "常驻" })}
            </span>
            <span className={styles.tierNote}>
              {t("roleplay.memory.tierStandingNote", {
                n: open.length, defaultValue: `${open.length} · 每轮都在`,
              })}
            </span>
          </div>
        )}

        {MEMORY_KINDS.map((kind) => {
          const group = open.filter((r) => r.kind === kind);
          if (!group.length) return null;
          return (
            <section key={kind} className={styles.group}>
              <div className={styles.groupLabel}>{kindLabel(kind)}</div>
              {group.map((r) => (
                <Record key={r.id} agentId={agentId} record={r} onJump={onJump} />
              ))}
            </section>
          );
        })}

        {closed.length > 0 && (
          <section className={styles.group}>
            <button
              type="button"
              className={styles.closedToggle}
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed
                ? t("roleplay.memory.hideClosed", { defaultValue: "收起已了结的" })
                : t("roleplay.memory.showClosed", { n: closed.length, defaultValue: `看已了结的（${closed.length}）` })}
            </button>
            {showClosed && closed.map((r) => (
              <Record key={r.id} agentId={agentId} record={r} onJump={onJump} />
            ))}
          </section>
        )}

        {/* ── 降级分隔 ── 两层之间的关系是**上下**，不是并列：转场时常驻的东西
            往下沉一层。所以这里画的是一支向下的箭头，不是一道普通的分节线。 */}
        {areaId && (
          <div className={styles.sinkRow}>
            <span className={styles.sinkLine} />
            <span className={styles.sinkArrow} aria-hidden />
            <span className={styles.sinkText}>
              {t("roleplay.memory.sink", { defaultValue: "转场时沉下去" })}
            </span>
            <span className={styles.sinkLine} />
          </div>
        )}

        {/* ── 记忆区层 ── 相关时才出现。 */}
        {areaId && (
          <>
            <div className={styles.tierLabel}>
              <span className={styles.tierName}>
                {t("roleplay.area.label", { defaultValue: "记忆区" })}
              </span>
              <span className={styles.tierNote}>
                {t("roleplay.memory.tierAreaNote", {
                  n: areaItems.length, defaultValue: `${areaItems.length} · 相关时才出现`,
                })}
              </span>
            </div>
            {areaItems.length === 0 && (
              <div className={styles.areaEmpty}>
                {t("roleplay.memory.areaEmpty", {
                  defaultValue: "还是空的。这一场转场时，上面那些不再欠着的东西会沉到这里。",
                })}
              </div>
            )}
            {areaItems.map((e) => (
              <div key={e.dirPath} className={styles.areaItem}>
                <div className={styles.areaTitle}>{e.name}</div>
                {e.summary && <div className={styles.areaSummary}>{e.summary}</div>}
                {e.aliases.length > 0 && (
                  <div className={styles.areaKeys}>
                    {e.aliases.map((k) => (
                      <span key={k} className={styles.areaKey}>{k}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
