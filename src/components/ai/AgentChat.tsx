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
import { Send, Square, X } from "lucide-react";
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
import { scanProjectFiles, readTextFileContent, type ProjectFile } from "../../lib/fs/images";
import { attachedKey, type AttachedItem } from "../../lib/lore/aiTask";
import { useImageDataUrls } from "../lore/useImageDataUrl";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useAgentStore } from "../../stores/agentStore";
import { useAiStore } from "../../stores/aiStore";
import { useAiTaskStore } from "../../stores/aiTaskStore";
import { AgentLog } from "./AgentLog";
import { ApprovalCard } from "./ApprovalCard";
import { PlanCard } from "./PlanCard";
import { RoundLimitCard } from "./RoundLimitCard";
import { useImeGuard } from "../../lib/ime";
import type { AgentEvent } from "../../lib/agent/events";
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

export function AgentChat() {
  const { t } = useTranslation();
  const {
    turns, chatRunning, chatError, pending, pendingPlans, pendingRoundLimits,
    sendChat, stopChat,
  } = useAgentStore();
  const activeModelId = useAiStore((s) => s.activeModelId);
  const activeModel = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId));
  const selection = useAiTaskStore((s) => s.selection);
  const terms = useTerms();

  const [draft, setDraft] = useState("");
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
  const [refs, setRefs] = useState<AttachedItem[]>([]);
  const mention = useMentionState();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!projectPath) { setProjectFiles([]); return; }
    scanProjectFiles(projectPath).then(setProjectFiles).catch(() => {});
  }, [projectPath]);

  const candidates: MentionItem[] = useMemo(() => [
    ...Object.values(loreIndex).flat().map((entity): MentionItem => ({ type: "lore", entity })),
    // Text only: this turn goes out as a string, and a chat message that
    // becomes a multimodal parts array breaks the shape every later turn is
    // appended to. Pictures belong in the lore modals, which build a fresh
    // request each time.
    ...projectFiles
      .filter((f) => f.kind === "text")
      .map((file): MentionItem => ({ type: "file", file })),
  ], [loreIndex, projectFiles]);

  const mentionItems = filterMentions(candidates, mention.query);
  const refKeys = new Set(refs.map(attachedKey));

  const handleDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    mention.sync(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const handlePickMention = async (item: MentionItem) => {
    if (refKeys.has(mentionKey(item))) { mention.close(); return; }
    if (item.type === "lore") {
      setRefs((prev) => [...prev, { kind: "lore", entity: item.entity }]);
    } else {
      try {
        const content = await readTextFileContent(item.file.path);
        setRefs((prev) => [...prev, { kind: "text", file: item.file, content }]);
      } catch {
        return; // unreadable — leave the draft alone
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

  const attachedQuote = !detached && selection ? selection : undefined;
  const canSend = !!draft.trim() && !chatRunning && !!activeModelId;

  const handleSend = () => {
    if (!canSend) return;
    const text = draft;
    const sending = refs;
    setDraft("");
    // References are per-message, like the typed text: the next question is
    // rarely about the same files, and the material stays in the conversation
    // history anyway.
    setRefs([]);
    void sendChat(text, attachedQuote, sending);
  };

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
    if (e.key === "Enter" && !e.shiftKey && !ime.isComposing(e)) {
      e.preventDefault();
      handleSend();
    }
  };

  // What the *next* request will carry, not what the session has been billed.
  // `chatUsage.inputTokens` accumulates across turns and across every tool
  // round inside them, so after a few turns it read `400k / 128k` — the one
  // question this indicator answers is "how much room is left", and the
  // cumulative figure answers it backwards. The runtime already measures the
  // real thing at the top of each round.
  const contextTokens = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      for (let j = turns[i].log.length - 1; j >= 0; j--) {
        const e = turns[i].log[j];
        if (e.kind === "round-start") return e.estInputTokens;
      }
    }
    return 0;
  }, [turns]);
  const contextWindow = activeModel?.contextSize ?? 0;

  return (
    <div className={styles.chat}>
      <div ref={messagesRef} className={styles.messages}>
        {turns.length === 0 && (
          <div className={styles.emptyHint}>
            {t("ai.chat.emptyHint", { doc: terms.doc, docs: terms.docs, kb: terms.kb })}
          </div>
        )}
        {turns.map((turn) =>
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
              <div className={styles.userTurn}>{turn.text}</div>
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
            <PlanCard key={p.plan.id} plan={p.plan} />
          ))}
          {pending.map((p) => (
            <ApprovalCard key={p.proposal.id} proposal={p.proposal} />
          ))}
          {pendingRoundLimits.map((p) => (
            // Keyed by the run, like the other two lists are keyed by their
            // subject — an array index makes React reuse one blocked run's
            // card for another's the moment an earlier one resolves.
            <RoundLimitCard key={p.id} item={p} />
          ))}
        </div>
      )}

      <div className={styles.composer}>
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
                @{label}
                <X size={10} strokeWidth={2} />
              </button>
            );
          })}
          {contextWindow > 0 && (
            <span className={styles.contextMeter}>
              {t("ai.chat.contextMeter", { defaultValue: "上下文" })}{" "}
              {formatTokens(contextTokens)} / {formatTokens(contextWindow)} tk
            </span>
          )}
        </div>

        <div className={styles.inputRow}>
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
            <span className={styles.inputHint}>
              {t("ai.chat.sendHint", { defaultValue: "Enter 发送 · Shift+Enter 换行" })}
            </span>
            {chatRunning ? (
              <button className={`${styles.sendBtn} ${styles.stopBtn}`} onClick={stopChat} title={t("ai.chat.stop")}>
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button className={styles.sendBtn} onClick={handleSend} disabled={!canSend} title={t("ai.chat.send")}>
                <Send size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({ text, log, images, isLive }: {
  text: string;
  log: AgentEvent[];
  images?: string[];
  isLive: boolean;
}) {
  const { t } = useTranslation();
  const imageUrls = useImageDataUrls(images ?? []);
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
            is a caption for them, and reading the caption first is backwards.
            Click opens the file, the way the gallery does. */}
        {images && images.length > 0 && (
          <div className={styles.turnImages}>
            {images.map((path) => (
              <button
                key={path}
                className={styles.turnImage}
                onClick={() => void revealItemInDir(path)}
                title={t("ai.chat.revealImage")}
              >
                {imageUrls[path]
                  ? <img src={imageUrls[path]} alt="" />
                  : <span className={styles.turnImageLoading} />}
              </button>
            ))}
          </div>
        )}
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
