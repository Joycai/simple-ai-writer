/**
 * 查看完整提示 — a read-only look at the messages a run actually sent.
 *
 * The panel's allocation bar forecasts how the window *will* be divided; this
 * is the only surface that shows what the four layers (system → 设定 → 前情 →
 * 任务) resolved to in the end. That is normally the answer to "why did it
 * refuse / why did it ignore my brief", so it sits on the failure card rather
 * than behind a debug setting.
 *
 * Nothing here is editable: the request has already gone out.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, X } from "lucide-react";
import type { StreamMessage } from "../../lib/ai/types";
import { ModalShell } from "../common/ModalShell";
import styles from "./PromptViewer.module.css";

/** One message as plain text — image parts are counted, never inlined. */
function messageText(m: StreamMessage): string {
  if ("tool_calls" in m && m.tool_calls) {
    return m.tool_calls
      .map((c) => `${c.function.name}(${c.function.arguments})`)
      .join("\n");
  }
  const { content } = m;
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) =>
      p.type === "text"
        ? p.text
        : p.type === "file"
          ? `<file ${p.file.filename}, ${p.file.file_data.length.toLocaleString()} chars>`
          : `<image ${p.image_url.url.length.toLocaleString()} chars>`,
    )
    .join("\n");
}

function asPlainText(messages: StreamMessage[]): string {
  return messages.map((m) => `### ${m.role}\n${messageText(m)}`).join("\n\n");
}

export function PromptViewer({
  messages, onClose,
}: { messages: StreamMessage[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();
  // Latest-value ref so the mount-only listener below always calls the
  // current requestClose (which itself reads shellCloseRef.current fresh).
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The drawer behind this listens for Escape too — the topmost surface
      // is the one the key belongs to.
      e.preventDefault();
      e.stopPropagation();
      requestCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const copyAll = () => {
    void navigator.clipboard.writeText(asPlainText(messages)).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => { /* clipboard may be blocked — the text is on screen either way */ },
    );
  };

  const totalChars = messages.reduce((n, m) => n + messageText(m).length, 0);

  return (
    <ModalShell
      overlayClassName={styles.overlay}
      onClose={onClose}
      closeOnEscape={false}
      closeRef={shellCloseRef}
    >
      <div className={styles.modal} role="dialog" aria-modal data-ai-surface>
        <div className={styles.header}>
          <span className={styles.title}>
            {t("ai.panel.promptViewerTitle", { defaultValue: "完整提示词" })}
          </span>
          <span className={styles.meta}>
            {t("ai.panel.promptViewerMeta", {
              defaultValue: "{{n}} 条消息 · {{chars}} 字",
              n: messages.length,
              chars: totalChars.toLocaleString(),
            })}
          </span>
          <span className={styles.spacer} />
          <button className={styles.headerBtn} onClick={copyAll}>
            <Copy size={11} strokeWidth={1.8} />
            {copied
              ? t("ai.panel.copied", { defaultValue: "已复制" })
              : t("ai.panel.promptViewerCopy", { defaultValue: "复制全部" })}
          </button>
          <button className={styles.closeBtn} onClick={requestClose} aria-label="Close">
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>

        <div className={styles.body}>
          {messages.map((m, i) => {
            const text = messageText(m);
            return (
              <div key={i} className={styles.message}>
                <div className={styles.roleRow}>
                  <span className={styles.role}>{m.role}</span>
                  <span className={styles.roleRule} />
                  <span className={styles.roleChars}>{text.length.toLocaleString()}</span>
                </div>
                <pre className={styles.content}>
                  {/* Display-only: tint [[lore:…]] citations, leave text intact. */}
                  {text.split(/(\[\[lore:[^\]]+\]\])/g).map((part, j) =>
                    part.startsWith("[[lore:") ? (
                      <span key={j} className={styles.loreRef}>{part}</span>
                    ) : (
                      part
                    ),
                  )}
                </pre>
              </div>
            );
          })}
        </div>
      </div>
    </ModalShell>
  );
}
