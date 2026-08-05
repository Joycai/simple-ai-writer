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
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { renderMarkdown } from "../../lib/fs/markdown";
import type {
  CreateProposal,
  DeleteProposal,
  EditProposal,
  MoveProposal,
  Proposal,
} from "../../lib/agent/registry";
import { useAgentStore } from "../../stores/agentStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import type { ResolvedTerms } from "../../lib/profile";
import styles from "./ApprovalCard.module.css";

/** Above this, a new chapter's preview is clipped behind a toggle. */
const CLIP_CHARS = 600;

/** Drop the project prefix — the author knows which project they are in. */
function projectRelative(path: string): string {
  const root = useProjectStore.getState().projectPath;
  const norm = path.replace(/\\/g, "/");
  if (!root) return norm;
  const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return norm.startsWith(prefix) ? norm.slice(prefix.length) : norm;
}

/** Card title — what the author is being asked to authorise. */
function headerTitle(proposal: Proposal, t: TFunction, terms: ResolvedTerms): string {
  const words = { doc: terms.doc, group: terms.group };
  switch (proposal.kind) {
    case "edit":
      return t("ai.approval.title", words);
    case "create":
      return t("ai.approval.titleCreate", words);
    case "move":
      return proposal.isDir ? t("ai.approval.titleMoveVolume", words) : t("ai.approval.titleMove", words);
    case "delete":
      return t("ai.approval.titleDelete", words);
  }
}

/** Header metric — the size of what the author is being asked to weigh. */
function headerMeta(proposal: Proposal, t: TFunction): string {
  const chars = t("ai.panel.unitChars", { defaultValue: "字" });
  switch (proposal.kind) {
    case "edit":
      return `${proposal.find.length} → ${proposal.replace.length} ${chars}`;
    case "create":
      return `${proposal.content.length} ${chars}`;
    case "move":
      return "";
    case "delete":
      return `${proposal.chars} ${chars}`;
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

/**
 * A new chapter is prose the author is about to accept into the book, so it is
 * rendered rather than shown as source — the same reading surface the preview
 * pane gives them. Long openings collapse: the card is a decision, not a reader.
 */
function CreateBody({ proposal }: { proposal: CreateProposal }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [expanded, setExpanded] = useState(false);

  if (!proposal.content.trim()) {
    return <div className={styles.emptyNote}>{t("ai.approval.emptyChapter", { doc: terms.doc })}</div>;
  }
  return (
    <>
      <div
        className={expanded ? styles.previewBlock : styles.previewBlockClipped}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(proposal.content) }}
      />
      {proposal.content.length > CLIP_CHARS && (
        <button className={styles.originalToggle} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {expanded ? t("ai.approval.collapse") : t("ai.approval.expand")}
        </button>
      )}
    </>
  );
}

/** Old → new, with the shared leading directories dropped so the change stands out. */
function MoveBody({ proposal }: { proposal: MoveProposal }) {
  const from = projectRelative(proposal.path);
  const to = projectRelative(proposal.newPath);
  return (
    <div className={styles.moveBlock}>
      <span className={styles.movePath}>{from}</span>
      <ArrowRight size={12} className={styles.moveArrow} />
      <span className={styles.movePath}>{to}</span>
    </div>
  );
}

function DeleteBody({ proposal }: { proposal: DeleteProposal }) {
  const { t } = useTranslation();
  return (
    <div className={styles.deleteBlock}>
      <div className={styles.movePath}>{projectRelative(proposal.path)}</div>
      <div className={styles.emptyNote}>{t("ai.approval.deleteRecoverable")}</div>
    </div>
  );
}

function ProposalBody({ proposal }: { proposal: Proposal }) {
  switch (proposal.kind) {
    case "edit":
      return <EditBody proposal={proposal} />;
    case "create":
      return <CreateBody proposal={proposal} />;
    case "move":
      return <MoveBody proposal={proposal} />;
    case "delete":
      return <DeleteBody proposal={proposal} />;
  }
}

export function ApprovalCard({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const { approve, reject } = useAgentStore();
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);

  const fileName = proposal.path.split(/[\\/]/).pop() ?? proposal.path;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{headerTitle(proposal, t, terms)}</span>
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
