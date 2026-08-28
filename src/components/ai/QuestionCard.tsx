/**
 * Question card (`ask_author`) — the agent is blocked on a decision only the
 * author can make.
 *
 * The model supplies the question and 2–4 options; the free-text row is the
 * card's own, always present, so the author can answer outside the offered
 * choices no matter what the model sent. Any answer resolves the blocked tool
 * call verbatim — there is no approve/reject here, the answer IS the outcome,
 * which is why this is not an eleventh Proposal kind (see
 * docs/feature/agent/ask-author-plan.md §7-B).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentStore, type PendingQuestion } from "../../stores/agentStore";
import styles from "./QuestionCard.module.css";

export function QuestionCard({ item }: { item: PendingQuestion }) {
  const { t } = useTranslation();
  const resolveQuestion = useAgentStore((s) => s.resolveQuestion);
  const [other, setOther] = useState("");

  const sendOther = () => {
    const text = other.trim();
    if (!text) return;
    resolveQuestion(item.id, { kind: "other", text });
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          {t("ai.question.title", { defaultValue: "助手在等你决定" })}
        </span>
      </div>
      <div className={styles.body}>{item.question}</div>
      <div className={styles.options}>
        {item.options.map((opt, i) => (
          <button
            // Options are free strings and may repeat; position is identity.
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className={styles.option}
            onClick={() => resolveQuestion(item.id, { kind: "option", index: i, text: opt })}
          >
            {opt}
          </button>
        ))}
      </div>
      <div className={styles.footer}>
        <input
          className={styles.otherInput}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) sendOther();
          }}
          placeholder={t("ai.question.otherPlaceholder", { defaultValue: "其他答案…" })}
        />
        <button className={styles.btnSend} disabled={!other.trim()} onClick={sendOther}>
          {t("ai.question.send", { defaultValue: "回答" })}
        </button>
      </div>
    </div>
  );
}
