/**
 * Review card for a pending manuscript proposal (L2 "write-approval").
 *
 * The agent's tool loop is blocked on this decision: approve applies the
 * proposal (with automatic backup) and unblocks the run; reject feeds the
 * optional reason back to the model verbatim so it can adjust course.
 *
 * The card is one frame — title, file, a metric, the reason, and the
 * approve/reject footer — around a body that varies by proposal kind. Adding a
 * kind means adding a body and a case to each switch, not reshaping the frame.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { EditProposal, Proposal } from "../../lib/agent/registry";
import { useAgentStore } from "../../stores/agentStore";
import styles from "./ApprovalCard.module.css";

/** Header metric — the size of what the author is being asked to weigh. */
function headerMeta(proposal: Proposal, t: TFunction): string {
  const chars = t("ai.panel.unitChars", { defaultValue: "字" });
  switch (proposal.kind) {
    case "edit":
      return `${proposal.find.length} → ${proposal.replace.length} ${chars}`;
  }
}

/**
 * An edit reads as a suggestion, so the replacement leads and the original is
 * one click away rather than stacked above it — that keeps the card the size of
 * a suggestion instead of a diff view.
 */
function EditBody({ proposal }: { proposal: EditProposal }) {
  const { t } = useTranslation();
  const [showOriginal, setShowOriginal] = useState(false);

  return (
    <>
      <pre className={styles.replaceBlock}>{proposal.replace}</pre>
      <button className={styles.originalToggle} onClick={() => setShowOriginal((v) => !v)}>
        {showOriginal ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {t("ai.approval.findLabel")}
      </button>
      {showOriginal && <pre className={styles.findBlock}>{proposal.find}</pre>}
    </>
  );
}

function ProposalBody({ proposal }: { proposal: Proposal }) {
  switch (proposal.kind) {
    case "edit":
      return <EditBody proposal={proposal} />;
  }
}

export function ApprovalCard({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  const { approve, reject } = useAgentStore();
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);

  const fileName = proposal.path.split(/[\\/]/).pop() ?? proposal.path;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t("ai.approval.title")}</span>
        <span className={styles.headerFile} title={proposal.path}>{fileName}</span>
        <span className={styles.headerDelta}>{headerMeta(proposal, t)}</span>
      </div>

      <div className={styles.body}>
        {proposal.reason && <div className={styles.reason}>{proposal.reason}</div>}
        <ProposalBody proposal={proposal} />
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
        <button
          className={styles.btnApprove}
          onClick={() => { setDeciding(true); void approve(proposal.id); }}
          disabled={deciding}
        >
          {t("ai.approval.approve")}
        </button>
      </div>
    </div>
  );
}
