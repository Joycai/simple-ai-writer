/**
 * Review card for a pending manuscript edit (L2 "write-approval").
 *
 * The agent's tool loop is blocked on this decision: approve applies the edit
 * (with automatic backup) and unblocks the run; reject feeds the optional
 * reason back to the model verbatim so it can adjust course.
 *
 * The replacement is what the author is deciding on, so it leads; the original
 * is one click away rather than stacked above it, which keeps the card the size
 * of a suggestion instead of a diff view.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { EditProposal } from "../../lib/agent/registry";
import { useAgentStore } from "../../stores/agentStore";
import styles from "./ApprovalCard.module.css";

export function ApprovalCard({ proposal }: { proposal: EditProposal }) {
  const { t } = useTranslation();
  const { approve, reject } = useAgentStore();
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);

  const fileName = proposal.path.split(/[\\/]/).pop() ?? proposal.path;

  const handleApprove = async () => {
    setDeciding(true);
    await approve(proposal.id);
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t("ai.approval.title")}</span>
        <span className={styles.headerFile} title={proposal.path}>{fileName}</span>
        <span className={styles.headerDelta}>
          {proposal.find.length} → {proposal.replace.length}{" "}
          {t("ai.panel.unitChars", { defaultValue: "字" })}
        </span>
      </div>

      <div className={styles.body}>
        {proposal.reason && <div className={styles.reason}>{proposal.reason}</div>}
        <pre className={styles.replaceBlock}>{proposal.replace}</pre>
        <button className={styles.originalToggle} onClick={() => setShowOriginal((v) => !v)}>
          {showOriginal ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {t("ai.approval.findLabel")}
        </button>
        {showOriginal && <pre className={styles.findBlock}>{proposal.find}</pre>}
      </div>

      <div className={styles.footer}>
        <input
          className={styles.rejectInput}
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder={t("ai.approval.rejectPlaceholder")}
          disabled={deciding}
        />
        <button
          className={styles.btnReject}
          onClick={() => { setDeciding(true); reject(proposal.id, rejectReason.trim() || undefined); }}
          disabled={deciding}
        >
          {t("ai.approval.reject")}
        </button>
        <button className={styles.btnApprove} onClick={handleApprove} disabled={deciding}>
          {t("ai.approval.approve")}
        </button>
      </div>
    </div>
  );
}
