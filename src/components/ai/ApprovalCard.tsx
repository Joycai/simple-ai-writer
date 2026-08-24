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

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { renderMarkdown } from "../../lib/fs/markdown";
import { isHtmlPath } from "../../lib/fs/images";
import { HtmlFrame } from "../editor/HtmlPreview";
import type {
  AppendProposal,
  CopyProposal,
  CreateProposal,
  DeleteProposal,
  EditProposal,
  RewriteProposal,
  IllustrateProposal,
  PptxProposal,
  MoveProposal,
  Proposal,
} from "../../lib/agent/registry";
import { ILLUSTRATE_GRANT_MAX, autoApproveScope, isAutoApprovable } from "../../lib/agent/autoApprove";
import { useImageDataUrl, useImageThumbnails } from "../lore/useImageDataUrl";
import { useAgentStore, type PendingApproval } from "../../stores/agentStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import type { ResolvedTerms } from "../../lib/profile";
import styles from "./ApprovalCard.module.css";
import { baseName, dirName, projectRelative as projectRel, toPosixPath } from "../../lib/paths";

/** Above this, a new chapter's preview is clipped behind a toggle. */
const CLIP_CHARS = 600;

/** Drop the project prefix — the author knows which project they are in. */
function projectRelative(path: string): string {
  const root = useProjectStore.getState().projectPath;
  return (root ? projectRel(root, path) : null) ?? toPosixPath(path);
}

/** Card title — what the author is being asked to authorise. */
function headerTitle(proposal: Proposal, t: TFunction, terms: ResolvedTerms): string {
  const words = { doc: terms.doc, group: terms.group };
  switch (proposal.kind) {
    case "edit":
      return t("ai.approval.title", words);
    case "rewrite":
      return t("ai.approval.titleRewrite", words);
    case "append":
      return t("ai.approval.titleAppend", { ...words, defaultValue: "追加内容" });
    case "create":
      return proposal.isDir ? t("ai.approval.titleCreateFolder", words) : t("ai.approval.titleCreate", words);
    case "move":
      return proposal.isDir ? t("ai.approval.titleMoveVolume", words) : t("ai.approval.titleMove", words);
    case "copy":
      return proposal.isDir ? t("ai.approval.titleCopyFolder", words) : t("ai.approval.titleCopy", words);
    case "delete":
      return proposal.isDir ? t("ai.approval.titleDeleteVolume", words) : t("ai.approval.titleDelete", words);
    case "illustrate":
      return proposal.sourcePath
        ? t("ai.approval.titleEditImage")
        : t("ai.approval.titleIllustrate");
    case "pptx":
      return t("ai.approval.titlePptx");
  }
}

/** Header metric — the size of what the author is being asked to weigh. */
function headerMeta(proposal: Proposal, t: TFunction): string {
  const chars = t("ai.panel.unitChars", { defaultValue: "字" });
  switch (proposal.kind) {
    case "edit":
      return `${proposal.find.length} → ${proposal.replace.length} ${chars}`;
    case "rewrite":
      // Whole-file scale, so the delta is the header's whole job: it is what
      // tells the author at a glance that a "reformat" is quietly dropping text.
      return `${proposal.originalChars} → ${proposal.content.length} ${chars}`;
    case "append":
      // Both ends, like a rewrite: what matters is that the file *grew* by this
      // much and lost nothing — an append that reads as a replacement would be
      // the one thing worth catching here.
      return `${proposal.originalChars} → ${proposal.originalChars + proposal.content.length} ${chars}`;
    case "create":
      return proposal.isDir ? "" : `${proposal.content.length} ${chars}`;
    case "move":
    case "copy":
      return "";
    case "delete":
      // A folder's stake is how many files it takes with it, not characters.
      return proposal.isDir
        ? t("ai.approval.fileCount", { n: proposal.fileCount ?? 0 })
        : `${proposal.chars} ${chars}`;
    case "illustrate":
      // The price is the metric here — it is what makes this decision
      // different from every other card.
      return proposal.costUsd > 0 ? `≈ $${proposal.costUsd.toFixed(3)}` : "";
    case "pptx":
      // Nothing to weigh in advance: the slide count is only known once the
      // page has been rendered, which is what approving sets off.
      return "";
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
  const all = proposal.target === "all";
  // What the author is being asked to authorise, beyond the diff itself: which
  // region of the file, and — when `find` repeats — which of its matches. A
  // rewrite_lines edit is scoped by both, so they read as one line.
  const scope = [
    proposal.range && t("ai.approval.editLines", { from: proposal.range.from, to: proposal.range.to }),
    proposal.occurrences > 1 &&
      (all
        ? t("ai.approval.editAll", { n: proposal.occurrences })
        : t("ai.approval.editNth", {
            n: typeof proposal.target === "number" ? proposal.target : 1,
            total: proposal.occurrences,
          })),
  ].filter(Boolean);

  return (
    <>
      {scope.length > 0 && (
        <div className={all ? styles.editScopeWarn : styles.editScope}>{scope.join(" · ")}</div>
      )}
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
 * An .html proposal is judged as a page, not a source listing — the card
 * renders it in the same sandboxed frame the editor's preview pane uses
 * (HtmlFrame owns the sandbox parameters, so they cannot drift). The toggle
 * here trades viewport height rather than clipping text: a page has no
 * natural "first 600 characters".
 */
function HtmlProposalBody({ path, content }: { path: string; content: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const baseDir = dirName(path);

  return (
    <>
      <HtmlFrame
        source={content}
        baseDir={baseDir}
        className={expanded ? styles.htmlFrameTall : styles.htmlFrame}
      />
      <button className={styles.originalToggle} onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {expanded ? t("ai.approval.collapse") : t("ai.approval.expand")}
      </button>
    </>
  );
}

/**
 * A rewrite replaces everything, so unlike an edit there is no "original" worth
 * folding away — the decision is entirely "is this still my chapter?". The new
 * text is therefore rendered in full (clipped, expandable) the way a new
 * chapter is, with the size change called out above it because that is the one
 * signal that a formatting pass has quietly eaten a section.
 */
function RewriteBody({ proposal }: { proposal: RewriteProposal }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const delta = proposal.content.length - proposal.originalChars;
  // A whole chapter's markdown — parsed once, not on every parent re-render
  // (approvals sit next to surfaces that re-render while other runs stream).
  const html = useMemo(() => renderMarkdown(proposal.content), [proposal.content]);

  return (
    <>
      {delta !== 0 && (
        <div className={delta < 0 ? styles.rewriteDeltaWarn : styles.rewriteDelta}>
          {t(delta < 0 ? "ai.approval.rewriteShrink" : "ai.approval.rewriteGrow", {
            n: Math.abs(delta),
          })}
        </div>
      )}
      {isHtmlPath(proposal.path) ? (
        <HtmlProposalBody path={proposal.path} content={proposal.content} />
      ) : (
        <div
          className={expanded ? styles.previewBlock : styles.previewBlockClipped}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {!isHtmlPath(proposal.path) && proposal.content.length > CLIP_CHARS && (
        <button className={styles.originalToggle} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {expanded ? t("ai.approval.collapse") : t("ai.approval.expand")}
        </button>
      )}
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
  // Before the early returns (hooks are unconditional); empty for the branches
  // that never render markdown so their proposals don't pay for a parse.
  const html = useMemo(
    () =>
      proposal.isDir || !proposal.content.trim() || isHtmlPath(proposal.path)
        ? ""
        : renderMarkdown(proposal.content),
    [proposal.isDir, proposal.content, proposal.path],
  );

  if (proposal.isDir) {
    return <div className={styles.emptyNote}>{t("ai.approval.emptyFolder")}</div>;
  }
  if (!proposal.content.trim()) {
    return <div className={styles.emptyNote}>{t("ai.approval.emptyChapter", { doc: terms.doc })}</div>;
  }
  if (isHtmlPath(proposal.path)) {
    return <HtmlProposalBody path={proposal.path} content={proposal.content} />;
  }
  return (
    <>
      <div
        className={expanded ? styles.previewBlock : styles.previewBlockClipped}
        dangerouslySetInnerHTML={{ __html: html }}
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

/**
 * Page → deck. Both ends and nothing else: the content is a page the author
 * already has and has already seen previewed, so re-rendering it on the card
 * would ask them to review the same thing twice. What is new is that a file
 * appears — so the card says which file, from what.
 */
function PptxBody({ proposal }: { proposal: PptxProposal }) {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.moveBlock}>
        <span className={styles.movePath}>{projectRelative(proposal.sourcePath)}</span>
        <ArrowRight size={12} className={styles.moveArrow} />
        <span className={styles.movePath}>{projectRelative(proposal.path)}</span>
      </div>
      <div className={styles.emptyNote}>{t("ai.approval.pptxNote")}</div>
    </>
  );
}

/**
 * Source → destination folder. The copy's decision is only "should this exist
 * twice" — no content to weigh, so the card stays two lines plus the note
 * that a name collision auto-numbers rather than overwrites.
 */
function CopyBody({ proposal }: { proposal: CopyProposal }) {
  const { t } = useTranslation();
  const from = projectRelative(proposal.path);
  // A renamed copy shows its full landing path — the rename is part of what
  // the author is approving, not a detail to discover afterwards.
  const to = projectRelative(
    proposal.newName ? `${proposal.destDir}/${proposal.newName}` : proposal.destDir,
  );
  return (
    <>
      <div className={styles.moveBlock}>
        <span className={styles.movePath}>{from}</span>
        <ArrowRight size={12} className={styles.moveArrow} />
        <span className={styles.movePath}>{to || "/"}</span>
      </div>
      <div className={styles.emptyNote}>{t("ai.approval.copyNote")}</div>
    </>
  );
}

function DeleteBody({ proposal }: { proposal: DeleteProposal }) {
  const { t } = useTranslation();
  return (
    <div className={styles.deleteBlock}>
      <div className={styles.movePath}>{projectRelative(proposal.path)}</div>
      <div className={styles.emptyNote}>
        {proposal.isDir
          ? t("ai.approval.deleteFolderRecoverable", { n: proposal.fileCount ?? 0 })
          : t("ai.approval.deleteRecoverable")}
      </div>
    </div>
  );
}

/**
 * The prompt leads, because it is the thing being approved — everything else
 * on this card is context for judging it. An edit additionally shows the
 * picture it would change: "make her hair silver" is not reviewable without
 * seeing whose hair.
 */
function IllustrateBody({ proposal }: { proposal: IllustrateProposal }) {
  const { t } = useTranslation();
  const sourceUrl = useImageDataUrl(proposal.sourcePath);
  const refUrls = useImageThumbnails(proposal.refPaths ?? []);

  return (
    <div className={styles.illustrateBlock}>
      {proposal.sourcePath && (
        <div className={styles.illustrateSource}>
          {sourceUrl && <img src={sourceUrl} alt="" />}
          <span className={styles.emptyNote}>{t("ai.approval.imageSource")}</span>
        </div>
      )}
      {/* References ride the same visual slot as an edit's source: a prompt
          that leans on them is only reviewable next to them. */}
      {(proposal.refPaths?.length ?? 0) > 0 && (
        <div className={styles.illustrateSource}>
          {proposal.refPaths!.map((p) => refUrls[p] && <img key={p} src={refUrls[p]} alt="" />)}
          <span className={styles.emptyNote}>{t("ai.approval.imageRefs")}</span>
        </div>
      )}
      <pre className={styles.replaceBlock}>{proposal.prompt}</pre>
      <div className={styles.emptyNote}>
        {t("ai.approval.imageMeta", {
          destination: proposal.destination,
          model: proposal.modelName,
        })}
        {/* The framing/tier being paid for — quality tiers differ in price by
            an order of magnitude, so they belong on the card, not in a log. */}
        {(() => {
          const params = [proposal.aspect, proposal.resolution, proposal.quality]
            .filter(Boolean)
            .join(" · ");
          return params ? ` · ${params}` : "";
        })()}
      </div>
    </div>
  );
}

/**
 * An append shows only what is being added — the existing file is untouched by
 * definition, so putting it on the card would bury the decision under text
 * nobody needs to re-read. Rendered raw rather than as markdown or a page: a
 * section pulled out of its document is a fragment, and previewing a fragment
 * as if it were the whole (half an HTML page, a heading with no context) is
 * more misleading than showing the source.
 */
function AppendBody({ proposal }: { proposal: AppendProposal }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <pre className={expanded ? styles.replaceBlock : styles.replaceBlockClipped}>
        {proposal.content}
      </pre>
      {proposal.content.length > CLIP_CHARS && (
        <button className={styles.originalToggle} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {expanded ? t("ai.approval.collapse") : t("ai.approval.expand")}
        </button>
      )}
    </>
  );
}

function ProposalBody({ proposal }: { proposal: Proposal }) {
  switch (proposal.kind) {
    case "edit":
      return <EditBody proposal={proposal} />;
    case "rewrite":
      return <RewriteBody proposal={proposal} />;
    case "append":
      return <AppendBody proposal={proposal} />;
    case "create":
      return <CreateBody proposal={proposal} />;
    case "move":
      return <MoveBody proposal={proposal} />;
    case "copy":
      return <CopyBody proposal={proposal} />;
    case "delete":
      return <DeleteBody proposal={proposal} />;
    case "illustrate":
      return <IllustrateBody proposal={proposal} />;
    case "pptx":
      return <PptxBody proposal={proposal} />;
  }
}

export function ApprovalCard({ item }: { item: PendingApproval }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const { approve, reject, enableAutoApprove, grantAppendPath, grantIllustrations } = useAgentStore();
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);
  /** How many follow-up pictures 批准并连批 covers. */
  const [batchCount, setBatchCount] = useState(3);

  const { proposal, autoApproveKey } = item;
  const fileName = baseName(proposal.path) || proposal.path;
  // Absent on a surface that cannot hold a grant, and never offered for the
  // two kinds a grant may not cover — so 删除 and 配图 cards simply don't grow
  // a third button, which needs no explaining.
  const canGrant = autoApproveKey !== undefined && isAutoApprovable(proposal.kind);

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
        {/* Building one deliverable is a dozen appends to the same file, and a
            dozen identical cards is how an author learns to stop reading them.
            Narrower than 本次都批准 on both axes — this file, appends only —
            so the click that ends the noise is not also a blanket write grant. */}
        {proposal.kind === "append" && autoApproveKey !== undefined && (
          <button
            className={styles.btnApproveAlways}
            onClick={() => {
              setDeciding(true);
              grantAppendPath(autoApproveKey, proposal.path);
              void approve(proposal.id);
            }}
            disabled={deciding}
            title={t("ai.approval.appendAlwaysHint", {
              defaultValue: "之后追加到这个文件都直接应用，其它改动照常询问",
            })}
          >
            {t("ai.approval.appendAlways", { defaultValue: "本文件都追加" })}
          </button>
        )}
        {/* The counted grant an illustrate card gets INSTEAD of 本次都批准:
            approving a picture spends money, so the author authorises an
            amount — the next N pictures of this run — never a mode. */}
        {proposal.kind === "illustrate" && autoApproveKey !== undefined && (
          <div className={styles.batchGroup}>
            <select
              className={styles.batchCount}
              value={batchCount}
              onChange={(e) => setBatchCount(parseInt(e.target.value, 10))}
              disabled={deciding}
              aria-label={t("ai.approval.illustrateBatchCount", { defaultValue: "连批张数" })}
            >
              {Array.from({ length: ILLUSTRATE_GRANT_MAX }, (_, i) => (
                <option key={i + 1} value={i + 1}>{i + 1}</option>
              ))}
            </select>
            <button
              className={styles.btnApproveAlways}
              onClick={() => {
                setDeciding(true);
                grantIllustrations(autoApproveKey, item.runId, batchCount);
                void approve(proposal.id);
              }}
              disabled={deciding}
              title={t("ai.approval.illustrateBatchHint", {
                defaultValue: "接下来 {{n}} 张配图不再逐张询问（每张仍会计费）；本轮结束或次数用完即恢复审批",
                n: batchCount,
              })}
            >
              {t("ai.approval.illustrateBatch", { defaultValue: "批准并连批 {{n}} 张", n: batchCount })}
            </button>
          </div>
        )}
        {canGrant && (
          <button
            className={styles.btnApproveAlways}
            onClick={() => {
              setDeciding(true);
              enableAutoApprove(autoApproveKey, "proposals");
              void approve(proposal.id);
            }}
            disabled={deciding}
          >
            {autoApproveScope(autoApproveKey) === "session"
              ? t("ai.approval.approveAlways", { defaultValue: "本次对话都批准" })
              : t("ai.approval.approveAlwaysRun", { defaultValue: "本次任务都批准" })}
          </button>
        )}
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
