/**
 * 写手的署名、工单与那条线（设计稿 12 · 写手 Writer）。
 *
 * 这个文件回答的是整套功能唯一真正难的问题：**作者在读一段散文，而这段字是第二
 * 个模型写的，面板顶上写的却是助手的模型名。**
 *
 * 不显示，作者分不清「真的走了写手」和「写手没跑起来、你读到的是助手写的」——后者
 * 在某些接口上会真实发生（handoff.fallbackBrief）。显示得太重，每条回复顶一个
 * 徽章，连读四轮就是四个徽章，读者开始读徽章不读字。
 *
 * 采用的答案是几何的，不是颜色的：回复左边那条槽里放一道 1px 竖线，长度**正好
 * 等于**写手写的那段文字——上不越过助手的执行日志，下不越过最后一个字。线在读区
 * 之外，但它可量，它标出的是**作者边界**，这件事任何一个徽章都做不到；而且它能
 * 表达另外两个态：虚顶（工单是推断的）、整条不存在（这段是助手自己写的）。
 *
 * 被否掉的两个做法记在这里，因为它们都很容易被重新提出来：
 *   - 每条回复顶一个「写手」徽章 —— 标不出边界，助手的日志和写手的正文会在同一个
 *     徽章底下；
 *   - 给写手的正文换底色或字色 —— 那是隐形的第二强调色，正文一变色就不再是正文，
 *     读起来像引用。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AgentEvent } from "../../lib/agent/events";
import type { HandoffBrief } from "../../lib/agent/handoff";
import { formatTokenCount } from "../../lib/agent/logFormat";
import { formatUsd } from "../../lib/ai/usage";
import styles from "./WriterTurn.module.css";

type HandoffEvent = Extract<AgentEvent, { kind: "handoff" }>;
type HandoffDoneEvent = Extract<AgentEvent, { kind: "handoff-done" }>;

export interface TurnHandoff {
  open: HandoffEvent;
  done?: HandoffDoneEvent;
}

/**
 * The handoff on one turn's log, if it had one.
 *
 * Top-level only: a `parentStep` event is the writer's own nested log, and one
 * of those would make a turn look like it handed off twice.
 */
export function findHandoff(log: readonly AgentEvent[]): TurnHandoff | null {
  let open: HandoffEvent | undefined;
  let done: HandoffDoneEvent | undefined;
  for (const e of log) {
    if (e.parentStep) continue;
    if (e.kind === "handoff") open = e;
    if (e.kind === "handoff-done") done = e;
  }
  return open ? { open, ...(done ? { done } : {}) } : null;
}

/** Whether this turn ended with the writer unable to run at all. */
export function handoffFailed(h: TurnHandoff): boolean {
  return Boolean(h.done?.error) && (h.done?.chars ?? 0) === 0;
}

// ─── 左槽 ─────────────────────────────────────────────────────────────

export function WriterGutter({ degraded }: { degraded?: boolean }) {
  return (
    <span className={styles.gutter} aria-hidden="true">
      <span className={styles.tick} />
      {degraded && <span className={styles.ruleDashed} />}
      <span className={styles.rule} />
    </span>
  );
}

// ─── 工单 ─────────────────────────────────────────────────────────────

/** The collapsed row's one-line summary — derived, never stored beside the brief. */
function summarize(brief: HandoffBrief, degraded: boolean, t: TFn): string {
  const parts: string[] = [];
  if (degraded) parts.push(t("ai.writer.inferred"));
  parts.push(t(`ai.writer.kind.${brief.kind}`));
  if (brief.notes.length) parts.push(t("ai.writer.refsN", { n: brief.notes.length }));
  if (brief.constraints.length) {
    parts.push(t("ai.writer.constraintsN", { n: brief.constraints.length }));
  }
  if (brief.length) parts.push(brief.length);
  if (brief.deliverTo) parts.push(t("ai.writer.deliverShort", { path: brief.deliverTo.path }));
  return parts.join(" · ");
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * The work order as plain text, for 复制工单.
 *
 * Rebuilt from the brief rather than scraped from the DOM: the author copying
 * this is almost always about to paste it somewhere to ask why the result came
 * out wrong, and a copy that silently lost a section would be the worst
 * possible time for that.
 */
function briefAsText(brief: HandoffBrief, t: TFn): string {
  const out = [`${t("ai.writer.deliverable")}: ${t(`ai.writer.kind.${brief.kind}`)}`, brief.goal];
  if (brief.length) out.push(`${t("ai.writer.lengthLabel")}: ${brief.length}`);
  const section = (label: string, items: readonly string[]) => {
    if (items.length) out.push("", label, ...items.map((x) => `- ${x}`));
  };
  section(t("ai.writer.materials", { n: brief.notes.length }), brief.notes);
  section(t("ai.writer.constraints", { n: brief.constraints.length }), brief.constraints);
  section(t("ai.writer.anchors"), brief.styleAnchors);
  section(t("ai.writer.forbid"), brief.forbid);
  if (brief.deliverTo) {
    out.push("", `${t("ai.writer.willWrite")}: ${brief.deliverTo.path} (${brief.deliverTo.mode})`);
  }
  return out.join("\n");
}

/** A material line: `path rest` splits so the path reads first and the range dims. */
function splitRef(raw: string): { path: string; tail?: string } {
  const at = raw.search(/\s/);
  if (at < 0) return { path: raw };
  return { path: raw.slice(0, at), tail: raw.slice(at + 1).trim() || undefined };
}

export function WorkOrderCard({ brief, degraded }: { brief: HandoffBrief; degraded: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={styles.card}>
      <div className={brief.constraints.length || brief.notes.length ? styles.cardHead : styles.cardHeadTight}>
        <div className={styles.kickerRow}>
          <span className={styles.kicker}>{t("ai.writer.deliverable")}</span>
          <span className={styles.kickerValue}>{t(`ai.writer.kind.${brief.kind}`)}</span>
          {degraded && <span className={styles.inferredBadge}>{t("ai.writer.inferred")}</span>}
          <span className={styles.orderSpacer} />
          <span className={styles.kickerRight}>
            {brief.length || t("ai.writer.noLength")}
          </span>
        </div>
        <div className={styles.goal}>{brief.goal || t("ai.writer.noGoal")}</div>
      </div>

      {/* 空的整节直接不渲染——没有灰字占位，没有「无」。卡片能从 6 节缩到 1 节，
          高度差本身就是信息：一眼看得出这轮工单薄不薄。 */}
      {brief.notes.length > 0 && (
        <>
          <div className={`${styles.hair} ${styles.hairTop}`} />
          <div className={styles.cardSection}>
            <div className={styles.listLabel}>
              {t("ai.writer.materials", { n: brief.notes.length })}
            </div>
            <div className={styles.refs}>
              {brief.notes.map((raw, i) => {
                const { path, tail } = splitRef(raw);
                return (
                  <div className={styles.refRow} key={`${raw}-${i}`}>
                    <span className={styles.refPath}>{path}</span>
                    {tail && <span className={styles.refTail}>{tail}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {brief.constraints.length > 0 && (
        <>
          <div className={styles.hair} />
          <div className={styles.cardSection}>
            <div className={styles.listLabel}>
              {t("ai.writer.constraints", { n: brief.constraints.length })}
            </div>
            <div className={styles.constraints}>
              {brief.constraints.map((c, i) => (
                <div className={styles.constraintRow} key={`${c}-${i}`}>
                  <span className={styles.constraintNo}>{String(i + 1).padStart(2, "0")}</span>
                  <span className={styles.constraintText}>{c}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* 卡上第二处、也是最后一处衬线。锚点是这张工单里唯一的文学内容，其余全是
          清单——衬线一断，读者就知道下面不是文章。 */}
      {brief.styleAnchors.length > 0 && (
        <>
          <div className={styles.hair} />
          <div className={styles.anchors}>
            <div className={styles.listLabel}>{t("ai.writer.anchors")}</div>
            {brief.styleAnchors.map((a, i) => (
              <div className={styles.anchorQuote} key={`${i}-${a.slice(0, 12)}`}>
                <span className={styles.anchorRule} />
                <div className={styles.anchorText}>{a}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {brief.forbid.length > 0 && (
        <>
          <div className={styles.hair} />
          <div className={styles.cardSection}>
            <div className={styles.listLabel}>{t("ai.writer.forbid")}</div>
            <div className={styles.forbid}>
              {brief.forbid.map((f, i) => (
                <span className={styles.forbidChip} key={`${f}-${i}`}>{f}</span>
              ))}
            </div>
          </div>
        </>
      )}

      {degraded && (
        <>
          <div className={styles.hair} />
          <div className={styles.inferredNote}>{t("ai.writer.inferredCard")}</div>
        </>
      )}

      {brief.deliverTo && (
        <div className={styles.deliver}>
          <span className={styles.deliverKicker}>{t("ai.writer.willWrite")}</span>
          <span className={styles.deliverPath}>{brief.deliverTo.path}</span>
          <span className={styles.deliverMode}>
            {t(`ai.writer.mode.${brief.deliverTo.mode}`, {
              from: brief.deliverTo.range?.from ?? 0,
              to: brief.deliverTo.range?.to ?? 0,
            })}
          </span>
          <span className={styles.orderSpacer} />
          <span className={styles.deliverNote}>{t("ai.writer.stillNeedsApproval")}</span>
        </div>
      )}
    </div>
  );
}

/**
 * 交接行：收起时一行，点一下就开。
 *
 * 只有一层。工单不是子代理的产出，它是这一轮的**接缝**——所以它从执行日志里搬了
 * 出来，挂在交接行上，日志里不再有工单卡（logModel.roundRows）。
 */
export function WorkOrder({
  handoff, first, degradedOrdinal, onChangeModel,
}: {
  handoff: TurnHandoff;
  /** Show the writer's model name outright — only on the session's first handoff. */
  first: boolean;
  /** 1-based count of degraded handoffs in this session up to and including this one. */
  degradedOrdinal: number;
  onChangeModel?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { open: ev, done } = handoff;
  const degraded = Boolean(ev.degraded);

  return (
    <>
      <button
        type="button"
        className={`${styles.orderRow} ${open ? styles.orderOpen : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.orderChevron}>
          {open ? <ChevronDown size={9} strokeWidth={2} /> : <ChevronRight size={9} strokeWidth={2} />}
        </span>
        <span className={styles.orderLabel}>{t("ai.writer.workOrder")}</span>
        <span className={styles.orderMeta}>{summarize(ev.brief, degraded, t)}</span>
        <span className={styles.orderSpacer} />
        {ev.model && (
          <span className={`${styles.signature} ${first ? "" : styles.signatureHover}`}>
            {t("ai.writer.signature", { model: ev.model })}
          </span>
        )}
      </button>

      {/* 分寸：不是错误。没有红色、没有图标、没有横幅、不阻断阅读；全套中性灰，
          只有那句「换个助手模型」是赭石——因为它是唯一可点的东西。 */}
      {degraded && (degradedOrdinal < 3 ? (
        <div className={styles.degradedNote}>
          <span>{t("ai.writer.degradedWhy")}</span>
          {onChangeModel && (
            <button type="button" className={styles.degradedAction} onClick={onChangeModel}>
              {t("ai.writer.degradedAction")}
            </button>
          )}
        </div>
      ) : (
        // 第三次起退成一行：这个模型就是这样，不需要每轮解释一遍。
        <div className={styles.degradedTerse}>
          {t("ai.writer.degradedTerse", { n: degradedOrdinal })}
        </div>
      ))}

      {open && (
        <>
          <WorkOrderCard brief={ev.brief} degraded={degraded} />
          <div className={styles.cardFoot}>
            <button
              type="button"
              className={styles.cardFootBtn}
              onClick={() => void navigator.clipboard.writeText(briefAsText(ev.brief, t))}
            >
              {t("ai.writer.copyOrder")}
            </button>
            <button type="button" className={styles.cardFootBtn} onClick={() => setOpen(false)}>
              {t("ai.writer.collapse")}
            </button>
            {/* 这张卡最容易被误读成回复本身——它的语气、编号、标题都不是给读者的。
                一句等宽小字，放在卡外的页脚，说清它是什么。 */}
            <span className={styles.cardFootNote}>{t("ai.writer.notAReply")}</span>
          </div>
        </>
      )}

      {/* 单轮的代价只在悬停时出现；常驻的那句「每轮 2 次请求」在输入框上边。
          三处都是陈述，没有一处需要点掉。 */}
      {done && !done.error && (
        <div className={styles.cost}>
          <span>
            {t("ai.writer.costLine", {
              secs: ((done.elapsedMs ?? 0) / 1000).toFixed(1),
              tokens: formatTokenCount((done.inputTokens ?? 0) + (done.outputTokens ?? 0)),
              cost: formatUsd(done.cost ?? 0),
            })}
          </span>
          <span className={styles.costFaint}>{t("ai.writer.twoRequests")}</span>
        </div>
      )}
    </>
  );
}

// ─── 写手没跑起来 ─────────────────────────────────────────────────────

export function WriterUnavailable({ reason, onOpenSettings, onDisable }: {
  reason: string;
  onOpenSettings?: () => void;
  onDisable?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.unavailable}>
      <div className={styles.unavailHead}>
        <span className={styles.unavailTag}>{t("ai.writer.appTag")}</span>
        <span className={styles.unavailTitle}>{t("ai.writer.unavailableTitle")}</span>
      </div>
      <div className={styles.unavailWhy}>{reason}</div>
      <div className={styles.unavailActions}>
        {onOpenSettings && (
          <button type="button" className={styles.stripActionAccent} onClick={onOpenSettings}>
            {t("ai.writer.goToSettings")}
          </button>
        )}
        {onDisable && (
          <button type="button" className={styles.stripAction} onClick={onDisable}>
            {t("ai.writer.disableForSession")}
          </button>
        )}
      </div>
    </div>
  );
}
