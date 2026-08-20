/**
 * 一个 agent 的对话区（设计稿 08 屏 1a / 1b / 1e / 1h）。
 *
 * 稿面而不是聊天：一栏 640px 居中、与编辑器正文同宽，作者的回合只用一条 2px
 * 赭石左规 + 一个小号名标区分，角色的回合直接落在纸上。没有气泡、没有左右
 * 分栏、没有小尾巴——理由写在设计稿 1c：气泡把每条消息切成独立单元，而剧本
 * 要的是连续的稿面。
 *
 * 输入框的实时着色只改**颜色**，不改字号、字重、字形。设计稿给四种标记各配了
 * 字号（16/18/15/12）和斜体，那是**稿面**的排版；输入框是一个 textarea 上面
 * 盖一层镜像 div，任何度量差异都会让光标和字错位。所以这里只换色——「边打边
 * 变」要传达的是「标记生效了」，而颜色足以传达它。中文输入法组字期间镜像层
 * 让位给原生文本，否则作者会对着一片透明打字。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore } from "../../stores/projectStore";
import { ModelSelector } from "../ai/ModelSelector";
import { AgentLog } from "../ai/AgentLog";
import { ScriptText } from "./ScriptText";
import {
  MentionPicker, filterMentions, mentionKey, mentionLabel,
  useMentionState, type MentionItem,
} from "../common/MentionPicker";
import { classifySegment } from "../../lib/roleplay/markup";
import { projectFilesFromTree } from "../../lib/fs/images";
import { readFile } from "../../lib/fs/fileio";
import type { AttachedItem } from "../../lib/lore/aiTask";
import type { RoleplayAgent, SceneTurn } from "../../lib/roleplay/model";
import styles from "./RoleplayChat.module.css";

const MIRROR_CLASS: Record<string, string> = {
  action: styles.mirrorAction,
  speech: styles.mirrorSpeech,
  scene: styles.mirrorScene,
  meta: styles.mirrorMeta,
};

/**
 * 输入框镜像层。**逐行**着色，空行原样保留——丢一行光标就往上跳一行。
 * 只换颜色：字号、字重、字形一律与 textarea 相同，任何度量差异都会让光标
 * 和字错开。
 */
function ComposerMirror({ text }: { text: string }) {
  return (
    <div className={styles.mirror} aria-hidden>
      {text.split(/\r?\n/).map((line, i) => {
        const seg = classifySegment(line, { requireClosed: true });
        return (
          <div key={i} className={seg ? MIRROR_CLASS[seg.kind] : styles.mirrorScene}>
            {line || "\u200b"}
          </div>
        );
      })}
    </div>
  );
}

function TurnBlock({ turn, log }: { turn: SceneTurn; log?: React.ReactNode }) {
  const { t } = useTranslation();
  if (turn.speaker === "author") {
    return (
      <div className={styles.authorTurn}>
        <div className={styles.authorLabel}>
          {t("roleplay.me", { defaultValue: "我" })}
          {turn.speakerName && <span className={styles.personaName}>{turn.speakerName}</span>}
        </div>
        <ScriptText text={turn.text} />
      </div>
    );
  }
  return (
    <>
      <div className={styles.agentTurn}>
        <div className={styles.agentLabel}>{turn.speakerName}</div>
        <ScriptText text={turn.text} />
      </div>
      {log}
    </>
  );
}

export function RoleplayChat({ agent, onEdit }: { agent: RoleplayAgent; onEdit: () => void }) {
  const { t } = useTranslation();
  const {
    sessions, running, queue, stale, send, stop, dequeue, promote,
    refreshBinding, setAgentModel,
  } = useRoleplayStore();
  const session = sessions[agent.id];
  const isRunning = running.includes(agent.id);
  const queuePos = queue.findIndex((j) => j.agentId === agent.id);

  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [showSyntax, setShowSyntax] = useState(false);
  const [showBindings, setShowBindings] = useState(false);
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [refs, setRefs] = useState<AttachedItem[]>([]);
  const [seconds, setSeconds] = useState(0);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loreIndex = useLoreStore((s) => s.index);
  const fileTree = useProjectStore((s) => s.fileTree);
  const projectPath = useProjectStore((s) => s.projectPath);
  const mention = useMentionState();

  const candidates: MentionItem[] = useMemo(() => [
    ...Object.values(loreIndex).flat().map((entity): MentionItem => ({ type: "lore", entity })),
    ...projectFilesFromTree(fileTree)
      .filter((f) => f.kind === "text")
      .map((file): MentionItem => ({ type: "file", file })),
  ], [loreIndex, fileTree]);

  // 生成中的计时，设计稿在名标旁边显示「生成中 · 4.2s」。
  useEffect(() => {
    if (!isRunning) { setSeconds(0); return; }
    const started = Date.now();
    const id = window.setInterval(() => setSeconds((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(id);
  }, [isRunning]);

  // 新内容到达就滚到底。用 layout effect，否则会看到一帧的旧位置。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.turns.length, session?.streaming]);

  const boundCount = agent.boundPaths.length;
  const canSend = draft.trim().length > 0;

  const doSend = () => {
    if (!canSend) return;
    void send(agent.id, draft, refs);
    setDraft("");
    setRefs([]);
  };

  const mentionItems = useMemo(
    () => filterMentions(candidates, mention.query),
    [candidates, mention.query],
  );
  const refKeys = useMemo(
    () => new Set(refs.map((r) => (r.kind === "lore" ? `lore:${r.entity.dirPath}` : `file:${r.file.path}`))),
    [refs],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && mentionItems.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); mention.move(1, mentionItems.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mention.move(-1, mentionItems.length); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        void handlePickMention(mentionItems[mention.active]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); mention.close(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      doSend();
    }
  };

  const handlePickMention = async (item: MentionItem) => {
    if (refKeys.has(mentionKey(item))) { mention.close(); return; }
    setDraft((prev) => mention.accept(prev, mentionLabel(item)));
    mention.close();
    if (item.type === "lore") {
      setRefs((r) => [...r, { kind: "lore", entity: item.entity }]);
    } else if (projectPath) {
      try {
        const content = await readFile(item.file.path);
        setRefs((r) => [...r, { kind: "text", file: item.file, content }]);
      } catch {
        // 读不到就只留字面上的 @——角色仍然知道作者提到了它。
      }
    }
  };

  const boundEntries = useMemo(() => {
    const byDir = new Map<string, { name: string; facets: { file: string; title: string }[] }>();
    for (const entities of Object.values(loreIndex)) {
      for (const e of entities) {
        byDir.set(e.dirPath, {
          name: e.name,
          facets: (e.facets ?? []).map((f) => ({ file: f.file, title: f.title })),
        });
      }
    }
    return agent.boundPaths.map((raw) => {
      const hash = raw.lastIndexOf("#");
      const dir = byDir.has(raw) || hash < 0 ? raw : raw.slice(0, hash);
      const facetFile = byDir.has(raw) || hash < 0 ? null : raw.slice(hash + 1);
      const entity = byDir.get(dir);
      const facet = facetFile ? entity?.facets.find((f) => f.file === facetFile) : null;
      const gone = !entity || (facetFile !== null && !facet);
      return {
        raw,
        label: entity
          ? `${entity.name}${facet ? ` · ${facet.title}` : ""}`
          : dir.split(/[/\\]/).pop() ?? raw,
        gone,
      };
    });
  }, [agent.boundPaths, loreIndex]);

  return (
    <div className={styles.pane}>
      {/* ── 顶部信息带 ── 一行小字，需要时才展开 ── */}
      <div className={styles.band}>
        <span className={styles.bandName}>{agent.name}</span>
        {agent.kind === "narrator" && <span className={styles.kindTag}>NARRATOR</span>}
        <span className={styles.sep} />
        <button
          type="button"
          className={styles.bandBtn}
          onClick={() => setShowBindings((v) => !v)}
        >
          {t("roleplay.band.bound", { n: boundCount, defaultValue: `绑定 ${boundCount} 项设定` })}
          <ChevronDown size={9} strokeWidth={2.4} />
        </button>
        <span className={styles.sep} />
        <div className={styles.modelSlot}>
          <ModelSelector
            value={agent.modelId ?? undefined}
            onChange={(id) => void setAgentModel(agent.id, id)}
          />
        </div>
        <div className={styles.spacer} />
        <span className={styles.isolation}>
          {agent.kind === "narrator"
            ? t("roleplay.band.narratorScope", { defaultValue: "可读全部角色记录" })
            : t("roleplay.band.isolated", { defaultValue: "记忆独立 · 仅此角色可见" })}
        </span>
        <button type="button" className={styles.bandBtn} onClick={onEdit}>
          {t("roleplay.editAgent", { defaultValue: "编辑" })}
        </button>
      </div>

      {showBindings && (
        <div className={styles.bindPopover}>
          <div className={styles.bindHead}>
            {t("roleplay.band.boundList", { n: boundCount, defaultValue: `本次对话注入的设定 · ${boundCount}` })}
          </div>
          {boundEntries.length === 0 && (
            <div className={styles.bindEmpty}>{t("roleplay.band.boundNone", { defaultValue: "没有绑定任何设定" })}</div>
          )}
          {boundEntries.map((b) => (
            <div key={b.raw} className={`${styles.bindRow} ${b.gone ? styles.bindRowGone : ""}`}>
              <span className={b.gone ? styles.bindDotGone : styles.bindDot} />
              <span className={styles.bindLabel}>{b.label}</span>
              {b.gone && <span className={styles.bindGoneTag}>{t("roleplay.band.deleted", { defaultValue: "已删除" })}</span>}
            </div>
          ))}
        </div>
      )}

      {stale[agent.id] && (
        <div className={styles.staleBar}>
          <span className={styles.staleDot} />
          <span className={styles.staleText}>
            {t("roleplay.stale.body", { defaultValue: "绑定的设定被改过，本次对话用的还是旧版本。" })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.staleBtn} onClick={() => void refreshBinding(agent.id)}>
            {t("roleplay.stale.refresh", { defaultValue: "刷新设定" })}
          </button>
        </div>
      )}

      {/* ── 稿面 ── */}
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.column}>
          {(session?.turns.length ?? 0) === 0 && !isRunning && (
            <div className={styles.chatEmpty}>
              <div className={styles.chatEmptyTitle}>
                {t("roleplay.chatEmpty.title", { name: agent.name, defaultValue: `${agent.name}在这里，还没有人开口。` })}
              </div>
              <div className={styles.chatEmptyBody}>
                {t("roleplay.chatEmpty.body", {
                  n: boundCount,
                  defaultValue: `用一个动作或一句台词起头。TA 只知道你绑给 TA 的 ${boundCount} 项设定，不知道别的角色说过什么。`,
                })}
              </div>
              <div className={styles.starters}>
                {["*我推开门。*", "「你还在等？」", "[从头开始]"].map((s) => (
                  <button key={s} type="button" className={styles.starter} onClick={() => setDraft(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {session?.turns.map((turn) => (
            <TurnBlock
              key={turn.index}
              turn={turn}
              log={
                session.log[turn.index]?.length ? (
                  <div className={styles.logLine}>
                    <button
                      type="button"
                      className={styles.logToggle}
                      onClick={() => setOpenLog(openLog === turn.index ? null : turn.index)}
                    >
                      <ChevronRight
                        size={8}
                        strokeWidth={2.6}
                        style={{ transform: openLog === turn.index ? "rotate(90deg)" : undefined }}
                      />
                      {t("roleplay.log.line", {
                        n: session.log[turn.index].filter((e) => e.kind === "tool-step").length,
                        defaultValue: `执行日志 · ${session.log[turn.index].filter((e) => e.kind === "tool-step").length} 步`,
                      })}
                    </button>
                    {openLog === turn.index && (
                      <div className={styles.logBody}><AgentLog log={session.log[turn.index]} isRunning={false} compact /></div>
                    )}
                  </div>
                ) : undefined
              }
            />
          ))}

          {isRunning && (
            <div className={styles.agentTurn}>
              <div className={styles.streamHead}>
                <span className={styles.agentLabel}>{agent.name}</span>
                <span className={styles.streamDot} />
                <span className={styles.streamTime}>
                  {t("roleplay.generating", { s: seconds.toFixed(1), defaultValue: `生成中 · ${seconds.toFixed(1)}s` })}
                </span>
              </div>
              <ScriptText text={session?.streaming ?? ""} caret />
            </div>
          )}

          {queuePos >= 0 && (
            <div className={styles.queueCard}>
              <span className={styles.spinner} />
              <span className={styles.queueText}>
                {t("roleplay.queue.waiting", { n: queuePos, defaultValue: `排队中 · 前面还有 ${queuePos} 个` })}
              </span>
              <span className={styles.queueHint}>
                {t("roleplay.queue.hint", { defaultValue: "同时最多 3 个 agent 生成" })}
              </span>
              <div className={styles.spacer} />
              <button type="button" className={styles.queueBtn} onClick={() => dequeue(agent.id)}>
                {t("roleplay.queue.cancel", { defaultValue: "取消排队" })}
              </button>
              <button type="button" className={styles.queueBtnAccent} onClick={() => promote(agent.id)}>
                {t("roleplay.queue.promote", { defaultValue: "插到最前" })}
              </button>
            </div>
          )}

          {session?.error && <div className={styles.errorBar}>{session.error}</div>}
        </div>
      </div>

      {/* ── 输入区 ── */}
      <div className={styles.composer}>
        <div className={styles.composerHead}>
          {agent.kind === "narrator" ? (
            <span className={styles.personaHint}>
              {t("roleplay.persona.narratorNote", { defaultValue: "旁白不扮演任何人 · 无身份设定" })}
            </span>
          ) : (
            <PersonaChip />
          )}
          <div className={styles.spacer} />
          {showSyntax ? (
            <button type="button" className={styles.syntaxToggle} onClick={() => setShowSyntax(false)}>
              {t("roleplay.syntax.collapse", { defaultValue: "收起，只留一行" })}
            </button>
          ) : (
            <>
              <span className={styles.syntaxRow}>
                <span className={styles.syntaxAction}>*{t("roleplay.syntax.action", { defaultValue: "动作" })}*</span>
                <span className={styles.syntaxSpeech}>「{t("roleplay.syntax.speech", { defaultValue: "台词" })}」</span>
                <span className={styles.syntaxScene}>{t("roleplay.syntax.scene", { defaultValue: "裸文本＝场景" })}</span>
                <span className={styles.syntaxMeta}>[{t("roleplay.syntax.meta", { defaultValue: "元指令" })}]</span>
              </span>
              <button type="button" className={styles.syntaxToggle} onClick={() => setShowSyntax(true)}>
                {t("roleplay.syntax.expand", { defaultValue: "展开" })}
              </button>
            </>
          )}
        </div>

        {showSyntax && (
          <div className={styles.syntaxCard}>
            <div className={styles.syntaxGrid}>
              {[
                ["*…*", t("roleplay.syntax.action", { defaultValue: "动作" }), "*他没有回头。*"],
                ["「…」", t("roleplay.syntax.speech", { defaultValue: "台词" }), "「你还在等？」"],
                [t("roleplay.syntax.bare", { defaultValue: "裸文本" }), t("roleplay.syntax.scene", { defaultValue: "场景" }), "屋里没有点灯。"],
                ["[…]", t("roleplay.syntax.meta", { defaultValue: "出戏指令" }), "[让他更冷一点]"],
              ].map(([mark, name, example]) => (
                <div key={mark} className={styles.syntaxItem}>
                  <span className={styles.syntaxMark}>{mark}</span>
                  <span className={styles.syntaxName}>{name}</span>
                  <span className={styles.syntaxExample}>{example}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.inputBox}>
          <div className={styles.inputStack}>
            {!composing && <div ref={mirrorRef}><ComposerMirror text={draft} /></div>}
            <textarea
              ref={taRef}
              className={`${styles.textarea} ${composing ? styles.textareaVisible : ""}`}
              value={draft}
              rows={3}
              placeholder={
                agent.kind === "narrator"
                  ? t("roleplay.composer.narratorPlaceholder", { defaultValue: "和旁白讨论情节，或让它把某段互动整理进正文…" })
                  : t("roleplay.composer.placeholder", { defaultValue: "说一句台词，或写一个动作…" })
              }
              onChange={(e) => {
                setDraft(e.target.value);
                mention.sync(e.target.value, e.target.selectionStart);
              }}
              onKeyDown={onKeyDown}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onScroll={(e) => {
                if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
            />
          </div>

          {mention.open && (
            <MentionPicker
              anchorRef={taRef}
              items={mentionItems}
              usedKeys={refKeys}
              activeIndex={mention.active}
              preferAbove
              onPick={(item) => void handlePickMention(item)}
              onDismiss={mention.close}
            />
          )}

          <div className={styles.inputFoot}>
            {refs.length > 0 && (
              <span className={styles.refCount}>
                {t("roleplay.composer.refs", { n: refs.length, defaultValue: `${refs.length} 项引用` })}
              </span>
            )}
            <span className={styles.kbd}>{t("roleplay.composer.newline", { defaultValue: "⇧↵ 换行" })}</span>
            <div className={styles.spacer} />
            {isRunning && (
              <button type="button" className={styles.stopBtn} onClick={() => stop(agent.id)}>
                {t("roleplay.composer.stop", { defaultValue: "停止生成" })}
              </button>
            )}
            <button
              type="button"
              className={styles.sendBtn}
              onClick={doSend}
              disabled={!canSend}
            >
              {t("roleplay.composer.send", { defaultValue: "发送" })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 「我此刻是」——作者的身份，全局设置，每个 agent 都看得到。 */
function PersonaChip() {
  const { t } = useTranslation();
  const { authorPersona, setAuthorPersona } = useRoleplayStore();
  const loreIndex = useLoreStore((s) => s.index);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const characters = Object.values(loreIndex).flat();
  const current = authorPersona.mode === "lore" && authorPersona.dirPath
    ? characters.find((e) => e.dirPath === authorPersona.dirPath)
    : null;

  const label = authorPersona.mode === "none"
    ? t("roleplay.persona.none", { defaultValue: "不设定" })
    : authorPersona.mode === "prompt"
      ? t("roleplay.persona.custom", { defaultValue: "自定义身份" })
      : current?.name ?? t("roleplay.persona.none", { defaultValue: "不设定" });

  return (
    <div className={styles.personaWrap} ref={ref}>
      <span className={styles.personaLabel}>{t("roleplay.persona.iam", { defaultValue: "我此刻是" })}</span>
      <button type="button" className={styles.personaChip} onClick={() => setOpen((v) => !v)}>
        {label}
        <ChevronDown size={8} strokeWidth={2.6} />
      </button>
      {open && (
        <div className={styles.personaMenu}>
          <button
            type="button"
            className={`${styles.personaItem} ${authorPersona.mode === "none" ? styles.personaItemActive : ""}`}
            onClick={() => { void setAuthorPersona({ mode: "none", dirPath: null, prompt: "" }); setOpen(false); }}
          >
            <span className={styles.radio} />
            {t("roleplay.persona.none", { defaultValue: "不设定" })}
            <span className={styles.personaNote}>{t("roleplay.persona.noneHint", { defaultValue: "以旁观者身份说话" })}</span>
          </button>
          {characters.map((e) => (
            <button
              key={e.dirPath}
              type="button"
              className={`${styles.personaItem} ${authorPersona.dirPath === e.dirPath ? styles.personaItemActive : ""}`}
              onClick={() => { void setAuthorPersona({ mode: "lore", dirPath: e.dirPath, prompt: "" }); setOpen(false); }}
            >
              <span className={styles.radio} />
              {e.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
