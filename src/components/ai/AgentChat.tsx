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

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, ChevronDown, ChevronRight, ChevronsDown, Image as ImageIcon, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { SnippetPicker } from "./SnippetPicker";
import { useSnippetSave, type SnippetSave } from "./SnippetSaveMenu";
import {
  MentionPicker,
  filterMentions,
  mentionKey,
  mentionLabel,
  useMentionState,
  type MentionItem,
} from "../common/MentionPicker";
import { useStickToBottom } from "../common/useStickToBottom";
import { renderMarkdown } from "../../lib/fs/markdown";
import {
  MAX_IMAGE_BYTES, imageToThumbnailDataUrl, readTextFileContent,
} from "../../lib/fs/images";
import { chatImageSource } from "../../lib/agent/chatImages";
import { downscaleNote, imageForModel } from "../../lib/image/normalize";
import { attachedKey } from "../../lib/lore/aiTask";
import { chainCanSeeImages, subAgentModel, withSessionOverrides } from "../../lib/agent/subagent";
import { useImageThumbnails } from "../lore/useImageDataUrl";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectFiles, useProjectStore, useTerms } from "../../stores/projectStore";
import { useAgentStore, type ChatTurn } from "../../stores/agentStore";
import { cardsForSurface } from "../../lib/agent/approvalRouting";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { useAiTaskStore } from "../../stores/aiTaskStore";
import { useComposerStore } from "../../stores/composerStore";
import { AgentLog } from "./AgentLog";
import { ApprovalCard } from "./ApprovalCard";
import { PlanCard } from "./PlanCard";
import { RoundLimitCard } from "./RoundLimitCard";
import { TruncationCard } from "./TruncationCard";
import { TaskPanel } from "./TaskPanel";
import { sumTokens, taskDocRevision } from "../../lib/agent/logModel";
import { useImeGuard } from "../../lib/ime";
import type { AgentEvent } from "../../lib/agent/events";
import { foldBoundary } from "../../lib/agent/transcriptFold";
import { splitMentions } from "../../lib/agent/mentionText";
import {
  computeContextBreakdown,
} from "../../lib/agent/contextBreakdown";
import { AGENT_ASSIST_PRESET } from "../../lib/agent/presets";
import { plannedToolTokens } from "../../lib/agent/toolCost";
import { inputCeilingFor } from "../../lib/context/budget";
import { ReasoningControls } from "./ReasoningControls";
import { SubAgentChips } from "./SubAgentChips";
import {
  findHandoff, handoffFailed, WorkOrder, WriterGutter, WriterUnavailable,
  type TurnHandoff,
} from "./WriterTurn";
import { markWriterIntroSeen, WriterIntro, WriterStrip, writerIntroSeen } from "./WriterStrip";
import writer from "./WriterTurn.module.css";
import { ContextBar } from "./ContextBar";
import { ScopeBand, ScopeMenu, type ScopeMenuAnchor } from "../lore/collections/ScopePicker";
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
  // Field selectors — the store is written on every streamed flush, and a
  // whole-store subscription would also re-render this on writes it never
  // reads (usage totals, other surfaces' bookkeeping).
  const turns = useAgentStore((s) => s.turns);
  const chatRunning = useAgentStore((s) => s.chatRunning);
  const chatError = useAgentStore((s) => s.chatError);
  const allPending = useAgentStore((s) => s.pending);
  const allPlans = useAgentStore((s) => s.pendingPlans);
  const allRoundLimits = useAgentStore((s) => s.pendingRoundLimits);
  const allTruncations = useAgentStore((s) => s.pendingTruncations);
  const sendChat = useAgentStore((s) => s.sendChat);
  const stopChat = useAgentStore((s) => s.stopChat);
  const toggleSubAgent = useAgentStore((s) => s.toggleSubAgent);
  const openSettings = useAppStore((s) => s.openSettings);
  const openModelPicker = useAppStore((s) => s.openModelPicker);
  const chatCompacting = useAgentStore((s) => s.chatCompacting);
  const compactChatNow = useAgentStore((s) => s.compactChatNow);
  // 只渲染没有 surface 标记的卡片。带标记的属于扮演面板那样的独立界面——
  // 一张出现在错误 tab 里的卡片，等于把那次运行永久挂在作者看不见的地方。
  // 规则与理由见 lib/agent/approvalRouting。
  const pending = cardsForSurface(allPending, null);
  const pendingPlans = cardsForSurface(allPlans, null);
  const pendingRoundLimits = cardsForSurface(allRoundLimits, null);
  const pendingTruncations = cardsForSurface(allTruncations, null);
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
  // Auto-scroll is a mode, not a reflex — see useStickToBottom.
  const stick = useStickToBottom(messagesRef);

  // ── @ references ──
  const projectPath = useProjectStore((s) => s.projectPath);
  const loreIndex = useLoreStore((s) => s.index);
  const loreScope = useLoreStore((s) => s.scope);
  const setLoreScope = useLoreStore((s) => s.setScope);
  const collections = useProjectStore((s) => s.collections);
  const [scopeMenu, setScopeMenu] = useState<ScopeMenuAnchor | null>(null);
  // From the sidebar's tree, so a file that appeared after the project opened
  // is pickable as soon as the tree knows about it — no separate snapshot.
  const projectFiles = useProjectFiles();
  const refs = useComposerStore((s) => s.chatRefs);
  const setRefs = useComposerStore((s) => s.setChatRefs);
  const clearComposer = useComposerStore((s) => s.clearChatComposer);
  const mention = useMentionState();
  // Right-click → 存为片段, shared by the composer and every turn on screen.
  const snippetSave = useSnippetSave();
  /* After an insert the caret belongs at the very end and the box scrolled to
     it. Deferred a frame because the value React just received has not been
     written to the DOM yet — measuring before that lands puts the caret at the
     end of the *old* text. */
  const focusEndOfInput = () => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    });
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Set only when the picker was opened from a `+ 设定` / `+ 章节` chip: the
  // author has already said which kind they want, so the list shouldn't make
  // them re-narrow it by typing. Cleared the moment the mention closes, so a
  // hand-typed `@` always searches everything.
  const [pickKind, setPickKind] = useState<PickKind | null>(null);
  useEffect(() => { if (!mention.open) setPickKind(null); }, [mention.open]);
  /** Rejected attachment (too large, unreadable) — cleared by the next pick. */
  const [refError, setRefError] = useState<string | null>(null);

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
        // May come back re-encoded: an oversized picture is shrunk to fit
        // rather than refused, and only a picture that survives even that is
        // turned away below.
        const { dataUrl, bytes, downscaled } = await imageForModel(item.file.path);
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
        setRefs((prev) => [...prev, { kind: "image", file: item.file, dataUrl, downscaled }]);
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
    stick.toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Follow the newest content while a turn is streaming — but only while the
  // reader is still at the live end. Scrolling up during a run (to re-read what
  // the question was, or what the agent did three tools ago) used to be undone
  // by the next chunk; now it disarms the follow and raises the jump button
  // instead. Layout effect so the transcript never paints a frame behind.
  useLayoutEffect(() => {
    if (chatRunning) stick.follow();
  }, [turns, chatRunning, stick]);

  // ── Task plan (band ④) ──
  // The handle's `taskId` is a getter on a stable object, so it is read through
  // a selector rather than off the object: the store's turns change on every
  // agent event, which is exactly when a workspace comes into being.
  const chatTaskId = useAgentStore((s) => s.chatTaskWorkspace?.taskId ?? null);
  const turnLogs = useMemo(() => turns.map((tn) => tn.log), [turns]);
  const taskRevision = useMemo(() => taskDocRevision(turnLogs), [turnLogs]);
  const taskTokens = useMemo(() => sumTokens(turnLogs), [turnLogs]);

  const attachedQuote = !detached && selection ? selection : undefined;
  // chatCompacting too: a manual compaction is swapping the history a send
  // would append onto, so the composer waits it out (agentStore guards as well).
  const canSend = !!draft.trim() && !chatRunning && !chatCompacting && !!activeModelId;

  const handleSend = () => {
    if (!canSend) return;
    const text = draft;
    const sending = refs;
    setRefError(null);
    // References are per-message, like the typed text: the next question is
    // rarely about the same files, and the material stays in the conversation
    // history anyway.
    clearComposer();
    // Asking a question is an intent to watch the answer: re-arm the follow even
    // if the author had scrolled back into history to write it.
    stick.toBottom();
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

  /**
   * Everything the signature needs that a single turn cannot know on its own.
   *
   * Two of the three are session-scoped by design: the model name is spelled
   * out **once** (first turn) and afterwards only on hover — "名字退场，边界留下"
   * — and the degraded explanation collapses to one line from the third
   * occurrence, because by then it is a property of the model, not of the turn.
   *
   * The map holds the two **events**, not the `TurnHandoff` wrapper
   * `findHandoff` builds: `turns` is a fresh array on every streamed chunk, so
   * this memo re-runs per chunk and a wrapper allocated here would be a new
   * object identity every time — which is enough on its own to defeat
   * `AssistantTurn`'s memo for the whole transcript. The events themselves are
   * appended once and never replaced (lib/agent/events.appendAgentEventTo only
   * supersedes tool-step and reasoning), so they *are* stable, and the turn
   * reassembles the wrapper from them.
   */
  const handoffs = useMemo(() => {
    const byTurn = new Map<string, TurnHandoff>();
    const degradedOrdinal = new Map<string, number>();
    let firstTurnId: string | null = null;
    let degradedSoFar = 0;
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      const h = findHandoff(turn.log);
      if (!h) continue;
      byTurn.set(turn.id, h);
      if (firstTurnId === null) firstTurnId = turn.id;
      if (h.open.degraded) degradedOrdinal.set(turn.id, ++degradedSoFar);
    }
    return { byTurn, firstTurnId, degradedOrdinal };
  }, [turns]);

  /**
   * When the live turn is in the writer's hands — the strip's "正在成文" state.
   * An open handoff with no close is exactly that window.
   */
  const composingSince = (() => {
    if (!chatRunning) return null;
    const last = turns[turns.length - 1];
    if (!last || last.role !== "assistant") return null;
    const h = findHandoff(last.log);
    return h && !h.done ? h.open.at : null;
  })();

  /**
   * The one-time explanation, armed the moment a usable writer first exists.
   *
   * State, not a bare pref read: dismissing it has to repaint this component,
   * and the settings pane's 再看一次说明 has to be able to bring it back — the
   * pref is where it persists, this is where it lives while the panel is open.
   */
  const writerLive = subAgentModel("writer", models, subAgents) !== null;
  const [writerIntroDone, setWriterIntroDone] = useState(writerIntroSeen);
  useEffect(() => {
    if (writerLive && !writerIntroSeen()) setWriterIntroDone(false);
  }, [writerLive]);
  const showWriterIntro = writerLive && !writerIntroDone;
  const dismissWriterIntro = () => {
    markWriterIntroSeen(true);
    setWriterIntroDone(true);
  };

  // The three below are handed to every AssistantTurn, which is memo'd — and
  // this component re-renders on every streamed chunk. A fresh closure here is
  // a changed prop there, i.e. the whole transcript reconciling per chunk, so
  // these have to be stable even though each is a one-liner.
  const disableWriterForSession = useCallback(() => {
    if (!useAgentStore.getState().disabledSubAgents.includes("writer")) toggleSubAgent("writer");
  }, [toggleSubAgent]);
  const openSubAgentSettings = useCallback(() => openSettings("subagents"), [openSettings]);

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
  // request it claims to describe. lib/agent/toolCost does the routing and the
  // measuring, and is the same function agentStore budgets the run with — this
  // bar and that ceiling cannot disagree about what the tools cost.
  const toolTokens = useMemo(
    // `{ handoff: true }` for the same reason agentStore passes it: this bar
    // reports what the *next* request will carry, and on a writer run that
    // includes the handoff schema.
    () => plannedToolTokens(AGENT_ASSIST_PRESET, effectiveSubs, models, { handoff: true }),
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
  // The 立即归纳 affordance appears only when a forced fold would actually fold
  // something. Read off the breakdown rather than re-derived here: this used to
  // test the turn count alone and miss planFold's *other* refusal (a
  // non-positive message ceiling), so on a model whose tool schemas fill the
  // window the button showed up and then silently did nothing. The bar needs
  // the same answer for its own line — two copies of one rule is how they drift.
  const canCompact = context.canFold;

  return (
    <div className={styles.chat}>
      {/* 取材范围的骑缝带（设计稿 03 屏 26-B）。围栏在**运行发生的地方**必须看得见
          ——知识库墙上写着一遍不够，作者写作时看的是这一栏。同一个控件的窄栏形态：
          省掉分类分布，只留条目数。 */}
      {loreScope !== null && (
        <ScopeBand
          index={loreIndex}
          scope={loreScope}
          variant="narrow"
          onSwitch={setScopeMenu}
          onReset={() => setLoreScope(projectPath, null)}
        />
      )}
      {scopeMenu && (
        <ScopeMenu
          index={loreIndex}
          declared={collections}
          scope={loreScope}
          anchor={scopeMenu}
          variant="narrow"
          onPick={(next) => setLoreScope(projectPath, next)}
          onClose={() => setScopeMenu(null)}
        />
      )}

      {/* The transcript and its jump button share a positioning box: the button
          belongs to the bottom of the *scroller*, and the chrome below it
          (approval cards, task band, composer) changes height constantly. */}
      <div className={styles.viewport}>
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
              <UserTurn key={turn.id} turn={turn} onCtx={snippetSave.onMessageContextMenu} />
            ) : (
              <AssistantTurn
                key={turn.id}
                text={turn.text}
                log={turn.log}
                images={turn.images}
                isLive={chatRunning && turn.id === turns[turns.length - 1]?.id}
                onCtx={snippetSave.onMessageContextMenu}
                handoffOpen={handoffs.byTurn.get(turn.id)?.open ?? null}
                handoffDone={handoffs.byTurn.get(turn.id)?.done ?? null}
                firstHandoff={handoffs.firstTurnId === turn.id}
                degradedOrdinal={handoffs.degradedOrdinal.get(turn.id) ?? 0}
                onDisableWriter={disableWriterForSession}
                onOpenSettings={openSubAgentSettings}
                onChangeModel={openModelPicker}
              />
            ),
          )}
        </div>

        {!stick.pinned && (
          <button
            type="button"
            className={styles.jumpLatest}
            onClick={stick.toBottom}
            title={t("ai.chat.jumpToLatest", { defaultValue: "回到最新" })}
          >
            <ChevronsDown size={13} />
            {t("ai.chat.jumpToLatest", { defaultValue: "回到最新" })}
          </button>
        )}
      </div>

      {chatError && <div className={styles.error}>{chatError}</div>}

      {/* Lore plans + manuscript edits + round-cap questions — the loop is blocked on these */}
      {(pendingPlans.length > 0 || pending.length > 0 || pendingRoundLimits.length > 0
        || pendingTruncations.length > 0) && (
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
          {pendingTruncations.map((p) => (
            <TruncationCard key={p.id} item={p} />
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
        <ContextBar
          context={context}
          onCompact={canCompact && !chatRunning ? () => void compactChatNow() : undefined}
          compacting={chatCompacting}
        />

        {/* 「接下来谁写」——常驻，在芯片行之上，因为它不是一项能力而是一道工序。
            设置里没开写手时整条不存在（角色扮演面板同理，它根本不渲染这个组件）。 */}
        {showWriterIntro && <WriterIntro onDismiss={dismissWriterIntro} />}
        <WriterStrip composingSince={composingSince} />

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
            // Silently sending a shrunken picture is how an author ends up
            // unable to explain why the model can't read the fine print in
            // their screenshot. The chip is the only place they'd look.
            const shrunk = r.kind === "image" && r.downscaled
              ? t("ai.chat.imageDownscaled", {
                  defaultValue: "已缩小以适应发送上限（{{detail}}）",
                  detail: downscaleNote(r.downscaled),
                })
              : null;
            return (
              <button
                key={key}
                className={styles.attachChip}
                onClick={() => setRefs((prev) => prev.filter((x) => attachedKey(x) !== key))}
                title={shrunk ? `${shrunk} · ${t("ai.chat.removeRef")}` : t("ai.chat.removeRef")}
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
            onContextMenu={snippetSave.onTextareaContextMenu}
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
              value={draft}
              onInsert={setDraft}
              onAfterInsert={focusEndOfInput}
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
      {/* The right-click menu / naming popover for every surface in this panel. */}
      {snippetSave.node}
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

/**
 * memo: the transcript re-renders on every streamed flush (the turns array is
 * rebuilt per store write), but only the *patched* turn gets a new object —
 * every earlier turn keeps its identity, so memoized turns skip entirely and
 * a stream only ever re-renders the one turn it is writing into.
 */
const UserTurn = memo(function UserTurn({ turn, onCtx }: {
  turn: ChatTurn;
  onCtx: SnippetSave["onMessageContextMenu"];
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.userBlock} onContextMenu={(e) => onCtx(e, turn.text)}>
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
  );
});

/**
 * Same memo contract as {@link UserTurn} — props are the turn's own fields.
 *
 * "Own fields" is load-bearing, not descriptive: the parent re-renders on every
 * streamed chunk, so anything passed here that is freshly allocated per render
 * — an inline arrow, a wrapper object — re-renders the entire transcript per
 * chunk and silently turns this memo into a no-op. Hence the handoff arriving
 * as its two stable events rather than as a `TurnHandoff`, and the three
 * callbacks being `useCallback`'d up there.
 */
const AssistantTurn = memo(function AssistantTurn({
  text, log, images, isLive, onCtx, handoffOpen, handoffDone, firstHandoff, degradedOrdinal,
  onDisableWriter, onOpenSettings, onChangeModel,
}: {
  text: string;
  log: AgentEvent[];
  images?: string[];
  isLive: boolean;
  onCtx: SnippetSave["onMessageContextMenu"];
  /** This turn's handoff events, when the writer produced its text. */
  handoffOpen: TurnHandoff["open"] | null;
  handoffDone: TurnHandoff["done"] | null;
  /** True on the session's first handoff — the one turn that spells the name out. */
  firstHandoff: boolean;
  degradedOrdinal: number;
  onDisableWriter: () => void;
  onOpenSettings: () => void;
  /** 降级说明里唯一可点的东西：换掉**助手**的模型，不是写手的。 */
  onChangeModel: () => void;
}) {
  const { t } = useTranslation();
  // Reassembled here so the wrapper is allocated once per *actual* change
  // rather than once per chunk — see the memo note above.
  const handoff = useMemo<TurnHandoff | null>(
    () => (handoffOpen ? { open: handoffOpen, ...(handoffDone ? { done: handoffDone } : {}) } : null),
    [handoffOpen, handoffDone],
  );
  const failed = handoff ? handoffFailed(handoff) : false;

  return (
    // Marker gutter + one content column: the execution log, the prose and any
    // cards are siblings in the same grid track, so they cannot drift out of
    // alignment with each other no matter what each one contains.
    //
    // A writer turn adds a SECOND row to the same two-column grid rather than
    // nesting inside the first: its rule has to live in the very same gutter as
    // the dot above it, and its prose has to start at the very same left edge.
    // Nested, one of those two would be indented — and the rule's whole claim is
    // that it measures the writer's text exactly.
    <div
      className={`${styles.assistantTurn} ${handoff ? writer.turn : ""}`}
      onContextMenu={(e) => onCtx(e, text)}
    >
      <span className={`${styles.turnMarker} ${isLive ? styles.turnMarkerLive : ""}`} />
      <div className={styles.turnContent}>
        {log.length > 0 && <AgentLog log={log} isRunning={isLive} compact />}
        {/* Pictures this turn produced, above the prose: the assistant's text
            is a caption for them, and reading the caption first is backwards. */}
        <TurnImages paths={images} />
        {!handoff && (text ? (
          <AssistantBody text={text} />
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
        ))}
        {/* The writer could not run: an app notice, not a reply. It gets no
            gutter and no rule — nothing was authored, so there is no boundary
            to mark. See lib/agent/runtime, which deliberately leaves the turn's
            text empty rather than putting app prose in the reading column. */}
        {failed && (
          <WriterUnavailable
            reason={handoff!.done!.error!}
            onOpenSettings={onOpenSettings}
            onDisable={onDisableWriter}
          />
        )}
      </div>

      {handoff && !failed && (
        <>
          <WriterGutter degraded={handoff.open.degraded} />
          <div className={writer.body}>
            <WorkOrder
              handoff={handoff}
              first={firstHandoff}
              degradedOrdinal={degradedOrdinal}
              onChangeModel={onChangeModel}
            />
            {text && <AssistantBody text={text} className={writer.prose} />}
          </div>
        </>
      )}
    </div>
  );
});

/**
 * How wide a picture in a reply is decoded, in pixels of its longest side.
 *
 * Thumbnails rather than the file's own pixels, for the reason {@link
 * TurnImages} gives: a generated picture can be 4096², which WebKit silently
 * refuses to decode as a `data:` URI past a certain size — and this column is
 * a few hundred CSS pixels wide. Larger than TurnImages' tiles, since this one
 * renders at the full width of the column rather than as a strip of tiles.
 */
const BODY_IMAGE_MAX_DIM = 640;

/**
 * The assistant's prose, with any picture it embedded actually shown.
 *
 * A markdown `![](…)` in a reply is the one image link in the app that comes
 * from the *model* rather than from a file the author is editing, which is why
 * this cannot just be `dangerouslySetInnerHTML` (as it was — and every such
 * picture rendered as the webview's broken-image glyph):
 *
 * - The webview cannot load a filesystem path at all — `img-src` allows only
 *   `'self' data: blob: ai-writer-asset:`, and the app stopped emitting that
 *   protocol itself (see lib/lore/entity.ts). So the bytes are read off disk
 *   and inlined, the same as `Preview` and `MarkdownPreview` already do.
 * - Which folder a link is relative to, and which are refused outright, is
 *   `lib/agent/chatImages` — the policy is model-facing, so it is pure and
 *   tested rather than inlined here.
 *
 * Both prose columns of a turn render through here — the assistant's own, and
 * the writer's when the turn was handed off. `className` is the only thing that
 * differs: it is the same markdown from the same run, and a picture in it is
 * the same picture.
 */
function AssistantBody({ text, className }: { text: string; className?: string }) {
  const projectPath = useProjectStore((s) => s.projectPath);
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Decoded pictures by absolute path — the value once it has landed, or the
   * in-flight read that will produce it. A live turn rebuilds this DOM on
   * every streamed chunk, so without it each chunk re-read and re-encoded
   * every picture already on screen, and each one blinked out while it did.
   *
   * A landed value is kept for the life of the turn, with no staleness check,
   * because nothing this app writes can invalidate one: every generated
   * picture goes through `uniqueAssetName` (lib/image/assets), so it lands on a
   * path that was free — the bytes under a path the chat has already rendered
   * never change. A *failed* read is forgotten instead, and that asymmetry is
   * the point: the file may not exist yet.
   */
  const decoded = useRef(new Map<string, string | Promise<string>>());
  const cachedFor = useRef(projectPath);

  // Layout, not passive: this writes the DOM the render it belongs to was
  // supposed to produce. As a `useEffect` it lands after paint, so every
  // streamed chunk paints the *previous* chunk's prose first and the text
  // visibly trails the stream by a frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // A path only means anything relative to a project. Replaced rather than
    // `.clear()`ed, and reset in here rather than in an effect of its own:
    // a read still in flight resolves into the map it started in (now
    // unreachable) instead of seeding the new project's cache with the old
    // project's path, and one effect cannot run in the wrong order against
    // itself.
    if (cachedFor.current !== projectPath) {
      decoded.current = new Map();
      cachedFor.current = projectPath;
    }
    const cache = decoded.current;

    el.innerHTML = renderMarkdown(text);

    el.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const raw = img.getAttribute("src") ?? "";
      const src = chatImageSource(projectPath ?? "", raw);
      if (src.kind === "skip") return;
      if (src.kind === "refuse") { markBroken(img, raw); return; }

      const hit = cache.get(src.path);
      if (typeof hit === "string") { img.src = hit; return; }
      // The `src` the renderer wrote is a path this webview cannot load. Drop
      // it now, or the browser spends the wait showing its own broken-image
      // icon — which is exactly what this whole component is here to stop.
      img.removeAttribute("src");
      img.setAttribute("data-loading", "true");

      const pending = hit ?? imageToThumbnailDataUrl(src.path, BODY_IMAGE_MAX_DIM)
        .then((url) => { cache.set(src.path, url); return url; });
      if (!hit) cache.set(src.path, pending);
      pending
        .then((url) => { img.removeAttribute("data-loading"); img.src = url; })
        .catch(() => {
          // Forgotten rather than remembered as broken: the file may be about
          // to be written by a tool call in this very run.
          cache.delete(src.path);
          markBroken(img, raw);
        });
    });
  }, [text, projectPath]);

  return (
    <div
      ref={ref}
      className={className ? `${styles.assistantBody} ${className}` : styles.assistantBody}
    />
  );
}

/** Mark a picture that isn't coming, and say which one it was. */
function markBroken(img: HTMLImageElement, raw: string) {
  img.removeAttribute("src");
  img.removeAttribute("data-loading");
  // The alt text is what the CSS prints inside the box, and a bare `![](…)`
  // carries none — a blank dashed rectangle is not a diagnosis, the path is.
  if (!img.getAttribute("alt")) img.setAttribute("alt", raw);
  img.setAttribute("data-broken", "true");
}
