/**
 * 对话助手 — the stage-two conversational surface of the unified agent.
 *
 * One session at a time, backed by agentStore's persistent wire history: the
 * agent's tool calls and results from earlier turns stay in context, so
 * follow-ups like "把刚才那条也改了" work. Each assistant turn embeds its own
 * execution log; manuscript edits surface as approval cards right above the
 * input while the loop waits.
 *
 * The composer carries an attachment row: the editor selection can be pinned to
 * a message so "把这一段重写得更克制一些" has an explicit referent instead of
 * relying on the agent to guess which passage 这一段 means.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, ChevronDown, ChevronRight, Image as ImageIcon, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { SnippetPicker } from "./SnippetPicker";
import {
  MentionPicker,
  filterMentions,
  mentionKey,
  mentionLabel,
  useMentionState,
  type MentionItem,
} from "../common/MentionPicker";
import { renderMarkdown } from "../../lib/fs/markdown";
import {
  MAX_IMAGE_BYTES, imageToDataUrl, readTextFileContent, scanProjectFiles, type ProjectFile,
} from "../../lib/fs/images";
import { attachedKey } from "../../lib/lore/aiTask";
import { chainCanSeeImages, withSessionOverrides } from "../../lib/agent/subagent";
import { useImageThumbnails } from "../lore/useImageDataUrl";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useAgentStore } from "../../stores/agentStore";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { useAiTaskStore } from "../../stores/aiTaskStore";
import { useComposerStore } from "../../stores/composerStore";
import { AgentLog } from "./AgentLog";
import { ApprovalCard } from "./ApprovalCard";
import { PlanCard } from "./PlanCard";
import { RoundLimitCard } from "./RoundLimitCard";
import { TaskPanel } from "./TaskPanel";
import { sumTokens, taskDocRevision } from "../../lib/agent/logModel";
import { useImeGuard } from "../../lib/ime";
import type { AgentEvent } from "../../lib/agent/events";
import { foldBoundary } from "../../lib/agent/transcriptFold";
import { splitMentions } from "../../lib/agent/mentionText";
import {
  CONTEXT_SEGMENT_ORDER,
  computeContextBreakdown,
  type ContextBreakdown,
  type ContextSegmentKey,
} from "../../lib/agent/contextBreakdown";
import { AGENT_ASSIST_PRESET } from "../../lib/agent/presets";
import { getToolDefinitions } from "../../lib/agent/registry";
import { routePlannedTools } from "../../lib/agent/routing";
import { estimateToolsTokens } from "../../lib/ai/tokenEstimate";
import { inputCeilingFor } from "../../lib/context/budget";
import { ReasoningControls } from "./ReasoningControls";
import { SubAgentChips } from "./SubAgentChips";
import { PlanModeChip } from "./PlanModeChip";
import { AutoApproveChip } from "./AutoApproveChip";
import { CHAT_AUTO_APPROVE_KEY } from "../../lib/agent/autoApprove";
import styles from "./AgentChat.module.css";

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Compact token count: 200000 → "200k", 3244 → "3.2k". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
}

/**
 * What a `+ …` chip pre-filters the picker to.
 *
 * Finer than `MentionItem["type"]`, because a document and a picture are both
 * `file` items yet the author asking for one never means the other.
 */
type PickKind = "lore" | "text" | "image";

function matchesKind(item: MentionItem, kind: PickKind): boolean {
  return kind === "lore" ? item.type === "lore" : item.type === "file" && item.file.kind === kind;
}

export function AgentChat() {
  const { t } = useTranslation();
  const {
    turns, chatRunning, chatError, pending, pendingPlans, pendingRoundLimits,
    sendChat, stopChat,
  } = useAgentStore();
  const activeModelId = useAiStore((s) => s.activeModelId);
  const activeModel = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId));
  const subAgents = useAiStore((s) => s.subAgents);
  const disabledSubAgents = useAgentStore((s) => s.disabledSubAgents);
  const models = useAiStore((s) => s.models);
  const effectiveSubs = useMemo(
    () => withSessionOverrides(subAgents, disabledSubAgents),
    [subAgents, disabledSubAgents],
  );
  // Whether the model chain (either the active model directly or via vision subagent)
  // can consume pictures for the live session.
  const canSeeImages = chainCanSeeImages(activeModel, effectiveSubs, models);
  const selection = useAiTaskStore((s) => s.selection);
  const terms = useTerms();

  // Held in composerStore, not useState: closing the drawer unmounts this
  // component, and a half-typed question must survive that.
  const draft = useComposerStore((s) => s.chatDraft);
  const setDraft = useComposerStore((s) => s.setChatDraft);
  // Mirrors `draft` for the handlers that read it after an await — reading a
  // large file takes long enough for the author to have kept typing.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The selection is attached by default when one exists — that is nearly always
  // why the author opened the assistant with text highlighted. Detaching is one
  // click; re-selecting in the editor re-attaches.
  const [detached, setDetached] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);

  // ── @ references ──
  const projectPath = useProjectStore((s) => s.projectPath);
  const loreIndex = useLoreStore((s) => s.index);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const refs = useComposerStore((s) => s.chatRefs);
  const setRefs = useComposerStore((s) => s.setChatRefs);
  const clearComposer = useComposerStore((s) => s.clearChatComposer);
  const mention = useMentionState();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Set only when the picker was opened from a `+ 设定` / `+ 章节` chip: the
  // author has already said which kind they want, so the list shouldn't make
  // them re-narrow it by typing. Cleared the moment the mention closes, so a
  // hand-typed `@` always searches everything.
  const [pickKind, setPickKind] = useState<PickKind | null>(null);
  useEffect(() => { if (!mention.open) setPickKind(null); }, [mention.open]);
  /** Rejected attachment (too large, unreadable) — cleared by the next pick. */
  const [refError, setRefError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) { setProjectFiles([]); return; }
    scanProjectFiles(projectPath).then(setProjectFiles).catch(() => {});
  }, [projectPath]);

  const candidates: MentionItem[] = useMemo(() => [
    ...Object.values(loreIndex).flat().map((entity): MentionItem => ({ type: "lore", entity })),
    // Pictures only for a model that can read them. Offering them to a
    // text-only model would attach something the message physically cannot
    // carry — the author would see a chip and the assistant would answer as if
    // nothing were there.
    ...projectFiles
      .filter((f) => f.kind === "text" || canSeeImages)
      .map((file): MentionItem => ({ type: "file", file })),
  ], [loreIndex, projectFiles, canSeeImages]);

  const mentionItems = filterMentions(
    pickKind ? candidates.filter((c) => matchesKind(c, pickKind)) : candidates,
    mention.query,
  );
  const refKeys = new Set(refs.map(attachedKey));

  /**
   * `@` is the whole mechanism — the chips just type it for you.
   *
   * Routing them through the same splice keeps one code path: the chosen item
   * lands as `@[name]` in the sentence the author is writing, exactly where a
   * typed mention would, instead of becoming a second kind of attachment the
   * message has to carry separately.
   */
  const openMentionFor = (kind: PickKind) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? draftRef.current.length;
    const before = draftRef.current.slice(0, caret);
    // `foo@bar` is an address, not a mention — findMention refuses an `@` that
    // follows an ASCII word character, so give it the boundary it needs rather
    // than dropping a stray `@` that opens nothing. CJK needs no such space.
    const pad = /[\w@]$/.test(before) ? " " : "";
    const at = caret + pad.length;
    const next = `${before}${pad}@${draftRef.current.slice(caret)}`;
    setPickKind(kind);
    setDraft(next);
    draftRef.current = next;
    mention.sync(next, at + 1);
    // After the value lands, or the browser puts the caret back at the end.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + 1, at + 1);
    });
  };

  const handleDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    mention.sync(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const handlePickMention = async (item: MentionItem) => {
    if (refKeys.has(mentionKey(item))) { mention.close(); return; }
    setRefError(null);
    if (item.type === "lore") {
      setRefs((prev) => [...prev, { kind: "lore", entity: item.entity }]);
    } else if (item.file.kind === "image") {
      try {
        const { dataUrl, bytes } = await imageToDataUrl(item.file.path);
        // Refused here rather than at send time: the author is choosing the
        // picture *now*, and a message that quietly loses one of its
        // attachments minutes later is unexplainable from the transcript.
        if (bytes.length > MAX_IMAGE_BYTES) {
          setRefError(t("ai.chat.imageTooLarge", {
            defaultValue: "{{name}} 太大（{{size}}MB，上限 {{max}}MB）",
            name: item.file.name,
            size: (bytes.length / 1024 / 1024).toFixed(1),
            max: MAX_IMAGE_BYTES / 1024 / 1024,
          }));
          return;
        }
        setRefs((prev) => [...prev, { kind: "image", file: item.file, dataUrl }]);
      } catch {
        setRefError(t("ai.chat.refUnreadable", {
          defaultValue: "读不到 {{name}}",
          name: item.file.name,
        }));
        return;
      }
    } else {
      try {
        const content = await readTextFileContent(item.file.path);
        setRefs((prev) => [...prev, { kind: "text", file: item.file, content }]);
      } catch {
        setRefError(t("ai.chat.refUnreadable", {
          defaultValue: "读不到 {{name}}",
          name: item.file.name,
        }));
        return;
      }
    }
    // Not inside a state updater: `accept` calls setState itself, and React
    // runs an updater twice under StrictMode. The ref supplies the live value
    // the updater was being used for.
    setDraft(mention.accept(draftRef.current, mentionLabel(item)));
    inputRef.current?.focus();
  };

  // A fresh selection is a fresh intent — undo any earlier detach.
  useEffect(() => { setDetached(false); }, [selection]);

  // ── Transcript folding (display only — the wire history is untouched) ──
  // Older turns collapse behind a bar once the session is long; the boundary
  // tracks the conversation, so with the fold closed new turns keep pushing
  // old ones behind it. `showAll` is per-mount, like scroll position.
  const [showAll, setShowAll] = useState(false);
  const foldableAt = useMemo(() => foldBoundary(turns.map((t) => t.role)), [turns]);
  const foldAt = showAll ? 0 : foldableAt;
  const hiddenExchanges = useMemo(
    () => turns.slice(0, foldAt).filter((t) => t.role === "user").length,
    [turns, foldAt],
  );
  // Toggling the fold adds or removes content *above* the viewport, which
  // would visually teleport the transcript. Compensate by the height delta —
  // before paint, so the reader never sees the jump.
  const foldAdjust = useRef<{ height: number; top: number } | null>(null);
  const toggleFold = () => {
    const el = messagesRef.current;
    if (el) foldAdjust.current = { height: el.scrollHeight, top: el.scrollTop };
    setShowAll((v) => !v);
  };
  useLayoutEffect(() => {
    const el = messagesRef.current;
    const prev = foldAdjust.current;
    if (!el || !prev) return;
    foldAdjust.current = null;
    el.scrollTop = Math.max(0, prev.top + (el.scrollHeight - prev.height));
  }, [showAll]);

  // Land on the newest turn when the tab is opened. AiDrawer renders one mode
  // at a time, so switching away unmounts this and switching back remounts it
  // at scrollTop 0 — i.e. at the top of the transcript, which for a chat log is
  // the least useful end of it. Layout effect so the jump happens before paint
  // rather than as a visible scroll from the top.
  useLayoutEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, []);

  // Follow the newest content while a turn is streaming.
  useEffect(() => {
    if (chatRunning && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [turns, chatRunning]);

  // ── Task plan (band ④) ──
  // The handle's `taskId` is a getter on a stable object, so it is read through
  // a selector rather than off the object: the store's turns change on every
  // agent event, which is exactly when a workspace comes into being.
  const chatTaskId = useAgentStore((s) => s.chatTaskWorkspace?.taskId ?? null);
  const turnLogs = useMemo(() => turns.map((tn) => tn.log), [turns]);
  const taskRevision = useMemo(() => taskDocRevision(turnLogs), [turnLogs]);
  const taskTokens = useMemo(() => sumTokens(turnLogs), [turnLogs]);

  const attachedQuote = !detached && selection ? selection : undefined;
  const canSend = !!draft.trim() && !chatRunning && !!activeModelId;

  const handleSend = () => {
    if (!canSend) return;
    const text = draft;
    const sending = refs;
    setRefError(null);
    // References are per-message, like the typed text: the next question is
    // rarely about the same files, and the material stays in the conversation
    // history anyway.
    clearComposer();
    void sendChat(text, attachedQuote, sending);
  };

  // 2d: the composer stays typeable during a run, and Enter queues the draft
  // instead of sending — it goes on the wire the moment the run settles. A
  // manual stop (Esc or the ■ button) clears the queue: stopping is an
  // intervention, and auto-firing the held message would undo it.
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    if (chatRunning || !queued) return;
    setQueued(false);
    handleSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gate on the run
    // settling, not on every keystroke re-creating handleSend
  }, [chatRunning, queued]);

  const handleStop = () => {
    setQueued(false);
    stopChat();
  };

  // 2d: 正在生成 · mm:ss — timed from when this run started.
  const [runSeconds, setRunSeconds] = useState(0);
  useEffect(() => {
    if (!chatRunning) return;
    setRunSeconds(0);
    const startedAt = Date.now();
    const id = window.setInterval(
      () => setRunSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [chatRunning]);
  const runClock = `${String(Math.floor(runSeconds / 60)).padStart(2, "0")}:${String(runSeconds % 60).padStart(2, "0")}`;

  // Enter sends — unless a CJK IME is mid-word, where Enter commits the typed
  // letters and must not also fire off the message. See lib/ime.
  const ime = useImeGuard();
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Only while the picker is actually on screen. It renders nothing with no
    // matches, and Chinese prose has no space to end a mention — so an `@`
    // typed mid-sentence used to leave this branch swallowing Enter for the
    // rest of the message: no send, no newline, no feedback.
    if (mention.open && mentionItems.length > 0) {
      if (e.key === "Escape") { e.preventDefault(); mention.close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); mention.move(1, mentionItems.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mention.move(-1, mentionItems.length); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !ime.isComposing(e)) {
        e.preventDefault();
        void handlePickMention(mentionItems[mention.active] ?? mentionItems[0]);
        return;
      }
    }
    // 2d: Esc 同效 — while a run is live, Esc anywhere in the composer stops
    // it (the mention branch above already claimed Esc for closing the picker).
    if (e.key === "Escape" && chatRunning) {
      e.preventDefault();
      handleStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !ime.isComposing(e)) {
      e.preventDefault();
      if (chatRunning) {
        if (draftRef.current.trim() && activeModelId) setQueued(true);
        return;
      }
      handleSend();
    }
  };

  // What the *next* request will carry, not what the session has been billed.
  // `chatUsage.inputTokens` accumulates across turns and across every tool
  // round inside them, so after a few turns it read `400k / 128k` — the one
  // question this indicator answers is "how much room is left", and the
  // cumulative figure answers it backwards.
  //
  // Measured off the live history rather than the last `round-start` event: that
  // event is a mid-turn snapshot, zero before the first run and one turn stale
  // afterwards. See lib/agent/contextBreakdown.ts for the other two corrections
  // (the ceiling as denominator, and counting the tool schemas).
  const chatHistory = useAgentStore((s) => s.chatHistory);
  const chatMeta = useAgentStore((s) => s.chatMeta);
  const chatContextVersion = useAgentStore((s) => s.chatContextVersion);
  const contextUtilization = useAppStore((s) => s.contextUtilization);
  // Measured off the *routed* toolset — what sendChat actually puts on the wire
  // (agentStore routeTools with the session's sub-agent overrides), not the raw
  // preset: routing strips read_image/generate_image and appends delegate, and
  // a 系统+工具 segment that ignored the chips it sits next to drifted from the
  // request it claims to describe. The registry still patches lore-category
  // enums per call, but that only swaps category names in and out — noise
  // against several KB of schema, and not worth re-measuring per lore scan.
  const toolTokens = useMemo(
    () =>
      estimateToolsTokens(
        getToolDefinitions(routePlannedTools(AGENT_ASSIST_PRESET, effectiveSubs, models).tools),
      ),
    [effectiveSubs, models],
  );
  const context = useMemo(
    () =>
      computeContextBreakdown(
        chatHistory,
        chatMeta,
        toolTokens,
        inputCeilingFor(activeModel?.contextSize, contextUtilization),
        activeModel?.contextSize ?? 0,
      ),
    // `chatContextVersion` is the real trigger — the history array is mutated
    // in place, so its reference alone would never announce a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatHistory, chatMeta, chatContextVersion, toolTokens, activeModel?.contextSize, contextUtilization],
  );

  return (
    <div className={styles.chat}>
      <div ref={messagesRef} className={styles.messages}>
        {turns.length === 0 && (
          <div className={styles.emptyHint}>
            {t("ai.chat.emptyHint", { doc: terms.doc, docs: terms.docs, kb: terms.kb })}
          </div>
        )}
        {foldableAt > 0 && (
          <button className={styles.foldBar} onClick={toggleFold} aria-expanded={showAll}>
            {showAll ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {showAll
              ? t("ai.chat.collapseEarlier", { defaultValue: "收起早前对话" })
              : t("ai.chat.showEarlier", {
                  defaultValue: "更早的 {{n}} 轮对话",
                  n: hiddenExchanges,
                })}
          </button>
        )}
        {turns.slice(foldAt).map((turn) =>
          turn.role === "user" ? (
            <div key={turn.id} className={styles.userBlock}>
              {turn.quote && (
                <div className={styles.quote}>
                  <div className={styles.quoteLabel}>
                    {t("ai.chat.quotedSelection", { defaultValue: "引用选区" })}
                  </div>
                  <div className={styles.quoteBody}>{turn.quote}</div>
                </div>
              )}
              <div className={styles.userTurn}><MentionText text={turn.text} /></div>
              {/* Below the words, unlike an assistant turn's pictures: there the
                  prose is a caption for the image, here it is the instruction
                  the image came with. */}
              <TurnImages paths={turn.images} align="end" />
              <div className={styles.turnTime}>{formatTime(turn.at)}</div>
            </div>
          ) : (
            <AssistantTurn
              key={turn.id}
              text={turn.text}
              log={turn.log}
              images={turn.images}
              isLive={chatRunning && turn.id === turns[turns.length - 1]?.id}
            />
          ),
        )}
      </div>

      {chatError && <div className={styles.error}>{chatError}</div>}

      {/* Lore plans + manuscript edits + round-cap questions — the loop is blocked on these */}
      {(pendingPlans.length > 0 || pending.length > 0 || pendingRoundLimits.length > 0) && (
        <div className={styles.approvals}>
          {pendingPlans.map((p) => (
            <PlanCard key={p.plan.id} item={p} />
          ))}
          {pending.map((p) => (
            <ApprovalCard key={p.proposal.id} item={p} />
          ))}
          {pendingRoundLimits.map((p) => (
            // Keyed by the run, like the other two lists are keyed by their
            // subject — an array index makes React reuse one blocked run's
            // card for another's the moment an earlier one resolves.
            <RoundLimitCard key={p.id} item={p} />
          ))}
        </div>
      )}

      {/* Band ④ — the task the agent split the work into. One per session, not
          one per turn: a plan written in turn 1 and ticked off in turn 4 is not
          a property of either. See TaskPanel.tsx. */}
      <div className={styles.taskBand}>
        <TaskPanel
          projectPath={projectPath}
          taskId={chatTaskId}
          revision={taskRevision}
          tokens={taskTokens}
        />
      </div>

      <div className={styles.composer}>
        <ContextBar context={context} />

        <div className={styles.attachRow}>
          {attachedQuote ? (
            <button
              className={styles.attachChip}
              onClick={() => setDetached(true)}
              title={t("ai.chat.detachSelection", { defaultValue: "不附带选区" })}
            >
              {t("ai.chat.selectionChip", {
                defaultValue: "选区 {{n}} 字",
                n: attachedQuote.length,
              })}
              <X size={10} strokeWidth={2} />
            </button>
          ) : selection ? (
            <button className={styles.attachChipGhost} onClick={() => setDetached(false)}>
              + {t("ai.chat.selectionChip", {
                defaultValue: "选区 {{n}} 字",
                n: selection.length,
              })}
            </button>
          ) : (
            <span className={styles.attachEmpty}>
              {t("ai.chat.noSelection", { defaultValue: "未选中正文" })}
            </span>
          )}
          {/* @ references, beside the selection chip: both are "material this
              message carries", and splitting them across two rows would read
              as two unrelated mechanisms. */}
          {refs.map((r) => {
            const key = attachedKey(r);
            const label = r.kind === "lore" ? r.entity.name : r.file.name;
            return (
              <button
                key={key}
                className={styles.attachChip}
                onClick={() => setRefs((prev) => prev.filter((x) => attachedKey(x) !== key))}
                title={t("ai.chat.removeRef")}
              >
                {/* A picture is the one attachment whose cost the author can't
                    read off its name — mark it as what it is. */}
                {r.kind === "image" && <ImageIcon size={10} strokeWidth={2} />}
                @{label}
                <X size={10} strokeWidth={2} />
              </button>
            );
          })}
          {/* Standing affordances for the two things worth referencing. `@`
              still works and is faster once known — these exist so the author
              finds out that it does. */}
          <span className={styles.attachSpacer} />
          <button
            className={styles.attachChipGhost}
            onClick={() => openMentionFor("lore")}
            disabled={!candidates.some((c) => c.type === "lore")}
            title={t("ai.chat.addRefHint", { defaultValue: "插入引用（等同于输入 @）" })}
          >
            + {terms.entry}
          </button>
          <button
            className={styles.attachChipGhost}
            onClick={() => openMentionFor("text")}
            disabled={!candidates.some((c) => matchesKind(c, "text"))}
            title={t("ai.chat.addRefHint", { defaultValue: "插入引用（等同于输入 @）" })}
          >
            + {terms.doc}
          </button>
          {/* Only when the model chain can see images: on a text-only setup without
              vision subagent the chip would be permanently dead. */}
          {canSeeImages && (
            <button
              className={styles.attachChipGhost}
              onClick={() => openMentionFor("image")}
              disabled={!candidates.some((c) => matchesKind(c, "image"))}
              title={t("ai.chat.addRefHint", { defaultValue: "插入引用（等同于输入 @）" })}
            >
              + {t("ai.chat.imageRef", { defaultValue: "图片" })}
            </button>
          )}
          {/* Subagent session toggles (search, vision, longread) */}
          <SubAgentChips />
          {/* Same family of session switch: how the assistant works, not what
              the message carries. */}
          <PlanModeChip />
          {/* Only while 本次对话都批准 is live — see AutoApproveChip. */}
          <AutoApproveChip owner={CHAT_AUTO_APPROVE_KEY} />
          {/* Trailing edge, past the `+ …` affordances: this one doesn't add
              material to the message, it changes how the model answers it. */}
          <ReasoningControls variant="compact" />
        </div>

        {refError && <div className={styles.refError}>{refError}</div>}

        <div className={`${styles.inputRow} ${chatRunning ? styles.inputRowRunning : ""}`}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={3}
            value={draft}
            onChange={handleDraftChange}
            onKeyDown={handleKeyDown}
            {...ime.imeProps}
            placeholder={activeModelId ? t("ai.chat.placeholder", { kb: terms.kb }) : t("ai.errors.noModel")}
            disabled={!activeModelId}
          />
          {mention.open && (
            // Anchored to the textarea itself rather than a wrapper: the
            // composer is a flex column, and an extra box in it would change
            // how the input sizes.
            <MentionPicker
              anchorRef={inputRef}
              items={mentionItems}
              usedKeys={refKeys}
              activeIndex={mention.active}
              preferAbove
              onPick={(item) => void handlePickMention(item)}
              onDismiss={mention.close}
            />
          )}
          <div className={styles.inputFooter}>
            {/* Insert (not send): a snippet is a starting point the author
                completes before sending. */}
            <SnippetPicker
              onPick={(c) => setDraft((prev) => (prev.trim() ? `${prev}\n${c}` : c))}
            />
            {chatRunning && (
              <span className={styles.runningNote}>
                <span className={styles.runningDots} aria-hidden>
                  <span /><span /><span />
                </span>
                {t("ai.chat.generating", { defaultValue: "正在生成" })} · {runClock}
              </span>
            )}
            <span className={styles.inputHint}>
              {chatRunning
                ? queued
                  ? t("ai.chat.queuedHint", { defaultValue: "已排队 · 本轮结束后发送" })
                  : t("ai.chat.stopHint", { defaultValue: "Esc 停止" })
                : t("ai.chat.sendHint", { defaultValue: "Enter 发送 · Shift+Enter 换行" })}
            </span>
            {chatRunning ? (
              // 2d: the ink square is the *stop* mark — same slot, the raised
              // block framed in the run accent.
              <button className={`${styles.sendBtn} ${styles.stopBtn}`} onClick={handleStop} title={t("ai.chat.stop")}>
                <span className={styles.sendGlyph} aria-hidden />
              </button>
            ) : (
              <button className={styles.sendBtn} onClick={handleSend} disabled={!canSend} title={t("ai.chat.send")}>
                <ArrowUp size={14} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Context bar ──────────────────────────────────────────────────────────────

const SEGMENT_LABELS: Record<ContextSegmentKey, { key: string; fallback: string }> = {
  system:       { key: "ai.chat.ctxSystem",       fallback: "系统+工具" },
  summary:      { key: "ai.chat.ctxSummary",      fallback: "摘要" },
  seed:         { key: "ai.chat.ctxSeed",         fallback: "种子" },
  injected:     { key: "ai.chat.ctxInjected",     fallback: "注入{{entry}}" },
  conversation: { key: "ai.chat.ctxConversation", fallback: "对话" },
  free:         { key: "ai.chat.ctxFree",         fallback: "空余" },
};

/**
 * The composer's memory strip: what the next request's context is made of, and
 * how much room is left before compaction folds the oldest turns away.
 *
 * The legend is collapsed by default and the bar carries per-segment `title`
 * tooltips instead. Six always-on legend chips wrap to three lines in a narrow
 * rail, and this sits directly above the input — permanent chrome there costs
 * message space on every session, whether or not the author is watching memory.
 */
function ContextBar({ context }: { context: ContextBreakdown }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [showLegend, setShowLegend] = useState(false);

  // No declared window means no real ceiling either — inputCeilingFor falls back
  // to an assumed one, and drawing a precise-looking bar against a guess would
  // be the wrong kind of confidence.
  if (context.contextSize <= 0) return null;

  const label = (key: ContextSegmentKey) =>
    t(SEGMENT_LABELS[key].key, { defaultValue: SEGMENT_LABELS[key].fallback, entry: terms.entry });

  return (
    <div className={styles.ctx}>
      <button
        // Warned once past the *mark* the bar itself draws (COMPACT_TRIGGER),
        // not once packed full — a bar standing beyond its own line while
        // looking calm was the state 2c exists to fix.
        className={`${styles.ctxBar} ${context.willCompact ? styles.ctxBarWarn : ""}`}
        onClick={() => setShowLegend((v) => !v)}
        aria-expanded={showLegend}
        title={t("ai.chat.ctxToggle", { defaultValue: "展开/收起上下文构成" })}
      >
        {context.segments.map((seg) =>
          seg.tokens > 0 ? (
            <span
              key={seg.key}
              className={`${styles.ctxSeg} ${styles[`ctxSeg_${seg.key}`]}`}
              style={{ flexGrow: seg.tokens }}
              title={`${label(seg.key)} ≈ ${formatTokens(seg.tokens)} tk`}
            />
          ) : null,
        )}
        {/* Where compaction starts folding the oldest turns — the one threshold
            on this bar the author can actually anticipate. */}
        <span
          className={styles.ctxMark}
          style={{ left: `${context.compactMarkerPct}%` }}
          title={t("ai.chat.ctxCompactAt", { defaultValue: "超过此处将折叠最早的对话" })}
        />
      </button>

      <div className={styles.ctxMeter}>
        <span>
          {t("ai.chat.contextMeter", { defaultValue: "上下文" })}{" "}
          <span className={context.willCompact ? styles.ctxCountWarn : undefined}>
            {formatTokens(context.usedTokens)}
          </span>{" "}
          / {formatTokens(context.ceilingTokens)} tk
        </span>
        <span className={styles.ctxWindow}>
          {t("ai.chat.ctxWindow", {
            defaultValue: "窗口 {{n}}",
            n: formatTokens(context.contextSize),
          })}
        </span>
      </div>

      {showLegend && (
        <div className={styles.ctxLegend}>
          {CONTEXT_SEGMENT_ORDER.map((key) => {
            const seg = context.segments.find((s) => s.key === key);
            if (!seg || seg.tokens <= 0) return null;
            return (
              <span key={key} className={styles.ctxLegendItem}>
                <span className={`${styles.ctxSwatch} ${styles[`ctxSeg_${key}`]}`} />
                {label(key)}
                <span className={styles.ctxLegendValue}>{formatTokens(seg.tokens)}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* What crossing the mark means, said once and only to someone looking:
          the legend is the bar's opened state, and permanent chrome above the
          input costs message space on every session (see the legend note). */}
      {showLegend && context.willCompact && (
        <div className={styles.ctxExplain}>
          {t("ai.chat.ctxCompactExplain", {
            defaultValue:
              "越过竖线后，下一轮把最早的对话归纳成摘要——执行日志里出现「已归纳前 N 轮对话」，摘要段随之变宽。",
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A turn's pictures, as a row of thumbnails. Shared by both turn kinds: the
 * assistant's are ones it drew, the author's are ones they attached, and there
 * is no reason for a picture in a conversation to look like two different
 * things depending on who put it there. Click reveals the file, as the gallery
 * does.
 */
function TurnImages({ paths, align }: { paths?: string[]; align?: "start" | "end" }) {
  const { t } = useTranslation();
  // Thumbnails, not full resolution — a generated picture can be several
  // megabytes (DashScope's wan models return up to 4096×4096), which both
  // wastes memory and can silently fail to render at all as an oversized
  // `<img src="data:...">`. Clicking still reveals the full-resolution file.
  const urls = useImageThumbnails(paths ?? []);
  if (!paths?.length) return null;
  return (
    <div className={styles.turnImages} style={align === "end" ? { justifyContent: "flex-end" } : undefined}>
      {paths.map((path) => (
        <button
          key={path}
          className={styles.turnImage}
          onClick={() => void revealItemInDir(path)}
          title={t("ai.chat.revealImage")}
        >
          {urls[path] ? <img src={urls[path]} alt="" /> : <span className={styles.turnImageLoading} />}
        </button>
      ))}
    </div>
  );
}

/**
 * A sent message's text with its `@[名称]` references in the accent color —
 * the same amber the ref chips wore before sending, so the bubble reads as the
 * record of that composition. Plain spans keep `.userTurn`'s pre-wrap intact.
 */
function MentionText({ text }: { text: string }) {
  return (
    <>
      {splitMentions(text).map((seg, i) =>
        seg.kind === "mention"
          ? <span key={i} className={styles.mentionRef}>{seg.text}</span>
          : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

function AssistantTurn({ text, log, images, isLive }: {
  text: string;
  log: AgentEvent[];
  images?: string[];
  isLive: boolean;
}) {
  const { t } = useTranslation();
  // Markdown render is cheap at chat sizes; memo keeps streaming smooth anyway.
  const html = useMemo(() => renderMarkdown(text), [text]);

  return (
    // Marker gutter + one content column: the execution log, the prose and any
    // cards are siblings in the same grid track, so they cannot drift out of
    // alignment with each other no matter what each one contains.
    <div className={styles.assistantTurn}>
      <span className={`${styles.turnMarker} ${isLive ? styles.turnMarkerLive : ""}`} />
      <div className={styles.turnContent}>
        {log.length > 0 && <AgentLog log={log} isRunning={isLive} compact />}
        {/* Pictures this turn produced, above the prose: the assistant's text
            is a caption for them, and reading the caption first is backwards. */}
        <TurnImages paths={images} />
        {text ? (
          <div className={styles.assistantBody} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          // Only until the log exists. Once it does, its in-flight round is
          // already a 思考中 line carrying the round count — a second one right
          // below it says nothing more and reads as two things happening.
          isLive && log.length === 0 && (
            <div className={styles.thinking}>
              <span className={styles.thinkingSpinner} />
              {t("ai.chat.thinking")}
            </div>
          )
        )}
      </div>
    </div>
  );
}
