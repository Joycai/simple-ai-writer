/**
 * Review card for a pending manuscript edit (L2 "write-approval").
 *
 * The agent's tool loop is blocked on this decision: approve applies the edit
 * (with automatic backup) and unblocks the run; reject feeds the optional
 * reason back to the model verbatim so it can adjust course.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePen } from "lucide-react";
import type { EditProposal } from "../../lib/agent/registry";
import { useAgentStore } from "../../stores/agentStore";
import styles from "./ApprovalCard.module.css";

export function ApprovalCard({ proposal }: { proposal: EditProposal }) {
  const { t } = useTranslation();
  const { approve, reject } = useAgentStore();
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);

  const fileName = proposal.path.split(/[\\/]/).pop() ?? proposal.path;

  const handleApprove = async () => {
    setDeciding(true);
    await approve(proposal.id);
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerIcon}><FilePen size={13} /></span>
        {t("ai.approval.title")}
        <span className={styles.headerFile} title={proposal.path}>{fileName}</span>
      </div>
      <div className={styles.body}>
        {proposal.reason && <div className={styles.reason}>{proposal.reason}</div>}
        <div>
          <div className={styles.blockLabel}>{t("ai.approval.findLabel")}</div>
          <pre className={`${styles.textBlock} ${styles.findBlock}`}>{proposal.find}</pre>
        </div>
        <div>
          <div className={styles.blockLabel}>{t("ai.approval.replaceLabel")}</div>
          <pre className={`${styles.textBlock} ${styles.replaceBlock}`}>{proposal.replace}</pre>
        </div>
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
