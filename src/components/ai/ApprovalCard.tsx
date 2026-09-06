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

import { Fragment, useMemo, useState } from "react";
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
  InsertProposal,
  RewriteProposal,
  IllustrateProposal,
  PptxProposal,
  DocxProposal,
  XlsxProposal,
  ConvertProposal,
  MoveProposal,
  Proposal,
} from "../../lib/agent/registry";
import { ILLUSTRATE_GRANT_MAX, autoApproveScope, isAutoApprovable } from "../../lib/agent/autoApprove";
import type { TranscribeProposal } from "../../lib/agent/registry";
import { formatBytes, formatClock, isVideoExt } from "../../lib/asr";
import { useImageDataUrl, useImageThumbnails } from "../lore/useImageDataUrl";
import { useAgentStore, type PendingApproval } from "../../stores/agentStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import type { ResolvedTerms } from "../../lib/profile";
import styles from "./ApprovalCard.module.css";
import { baseName, dirName, projectRelative as projectRel, toPosixPath } from "../../lib/paths";

/** Above this, a new chapter's preview is clipped behind a toggle. */
const CLIP_CHARS = 600;

/** Insertion rows shown before the list collapses behind a toggle. */
const INSERT_ROWS_CLIPPED = 12;

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
    case "insert":
      return t("ai.approval.titleInsert", { ...words, defaultValue: "插入内容" });
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
    case "docx":
      return t("ai.approval.titleDocx");
    case "xlsx":
      return t("ai.approval.titleXlsx", { defaultValue: "导出 Excel" });
    case "convert":
      return t("ai.approval.titleConvert", { defaultValue: "转换为 Markdown" });
    case "transcribe":
      return t("ai.approval.titleTranscribe", { defaultValue: "请求转写" });
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
    case "insert":
      // How many places, not how many characters: the stake here is the number
      // of decisions the author is signing off in one click. Nothing existing
      // changes, so a size delta would measure the wrong thing entirely.
      return t("ai.approval.insertCount", {
        n: proposal.insertions.length,
        defaultValue: "{{n}} 处",
      });
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
    case "docx":
      // Page count would need Word's own layout, so the honest metric is the
      // size of what is being converted. The *format* is the thing to weigh
      // here, and it gets the band below rather than this one line.
      return `${kilo(proposal.sourceChars)} ${chars}`;
    case "xlsx":
      // 工作表数是这张卡最上面该有的那个数：它是「这份文档被读成了几张表」的
      // 全部答案，而每张表多大、格子被判成了什么在下面逐行写着。
      return t("ai.approval.xlsxSheetCount", {
        n: proposal.summaries.length,
        defaultValue: "{{n}} 个工作表",
      });
    case "convert":
      // How much text came out — for a scan that is the number that says
      // "nothing", which the body then explains.
      return `${kilo(proposal.chars)} ${chars}`;
    case "transcribe":
      // The size of what is about to be uploaded — the only number known
      // before the paid step (设计稿 02f 屏 1e: mono right column "2.4 MB").
      return formatBytes(proposal.bytes);
  }
}

/** 9412 → "9.4k"；小于一千就写原数。 */
function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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

      <div className={styles.pptxSplit}>
        <span className={styles.pptxSlides}>
          {t("ai.approval.pptxSlideCount", {
            n: proposal.slides,
            defaultValue: "{{n}} 张幻灯片",
          })}
        </span>
        {/* 兜底那一支没有选择器可报，下面那句警告才是它要说的话。 */}
        {!proposal.wholePage && <span className={styles.pptxTier}>{proposal.tier}</span>}
      </div>

      {proposal.wholePage && (
        <div className={styles.pptxWarn}>
          {t("ai.approval.pptxWholePage", {
            defaultValue:
              "页面里没有幻灯片分节，整页会压成一张。分页请用 <section class=\"slide\">。",
          })}
        </div>
      )}

      <div className={styles.emptyNote}>{t("ai.approval.pptxNote")}</div>
    </>
  );
}


/**
 * 导出 Word。
 *
 * 和 pptx 卡的关键差别：那张卡批准前没什么可权衡的（页数要渲染完才知道），这
 * 张**恰恰相反——可权衡的东西就是格式，而且它在批准前完全已知**。所以卡上有
 * 两样 pptx 没有的东西：一条说清「这次用的是哪来的格式」的带子，和一张写着
 * 最终值的规格表。
 *
 * 「默认格式」是最常见的一种，所以它最安静（没有竖条）；其余三种都带赭石竖
 * 条，因为它们都是作者这一次特意要的东西。
 */
function DocxBody({ proposal }: { proposal: DocxProposal }) {
  const { t } = useTranslation();
  // 「页码 / 编号」那一行永远不会被改过：overrides 只有六项，不含这两组（05h 1z · C3）。
  const changedKeys = new Set<string>((proposal.changed ?? []).map((c) => c.key));
  const quiet = proposal.originKind === "default";

  return (
    <>
      <div className={styles.moveBlock}>
        <span className={styles.movePath}>{projectRelative(proposal.sourcePath)}</span>
        <ArrowRight size={12} className={styles.moveArrow} />
        <span className={styles.movePath}>{projectRelative(proposal.path)}</span>
      </div>

      {/* 内容侧的预检。格式那一栏说的是「长什么样」，这一行说的是「有什么」——
          一份作者以为写了三张表的报告在这里写着「表格 0」，是打开 Word 之前
          唯一能发现它的地方。 */}
      <div className={styles.docxOutline}>
        <span>
          {t("ai.approval.docxBlocks", { n: proposal.outline.blocks, defaultValue: "{{n}} 块" })}
        </span>
        {proposal.outline.headings > 0 && (
          <span>
            {t("ai.approval.docxHeadings", {
              n: proposal.outline.headings,
              defaultValue: "标题 {{n}}",
            })}
          </span>
        )}
        {proposal.outline.tables > 0 && (
          <span>
            {t("ai.approval.docxTables", { n: proposal.outline.tables, defaultValue: "表格 {{n}}" })}
          </span>
        )}
        {proposal.outline.images > 0 && (
          <span>
            {t("ai.approval.docxImages", { n: proposal.outline.images, defaultValue: "图片 {{n}}" })}
          </span>
        )}
      </div>

      {proposal.outline.degraded.length > 0 && (
        <div className={styles.emptyNote}>
          {t("ai.approval.docxWillDegrade", {
            what: proposal.outline.degraded.join("、"),
            defaultValue: "会落成简单形式：{{what}}",
          })}
        </div>
      )}

      <div
        className={`${styles.docxOrigin} ${quiet ? "" : styles.docxOriginMarked} ${
          proposal.originKind === "imitated" ? styles.docxOriginImitated : ""
        }`}
      >
        <div className={styles.docxOriginTop}>
          <span className={styles.docxOriginLabel}>{t("ai.approval.docxOrigin")}</span>
          <span className={quiet ? styles.docxOriginNameQuiet : styles.docxOriginName}>
            {proposal.originLabel}
          </span>
          {proposal.changed && proposal.changed.length > 0 && (
            <span className={styles.docxChangedChip}>
              {t("ai.approval.docxChanged", { count: proposal.changed.length })}
            </span>
          )}
          {proposal.originNote && <span className={styles.docxOriginNote}>{proposal.originNote}</span>}
        </div>
        {proposal.changed && proposal.changed.length > 0 && (
          <div className={styles.docxChanges}>
            {proposal.changed.map((c, i) => (
              <div key={i} className={styles.docxChange}>
                <span className={styles.docxChangeMark}>{t("ai.approval.docxChangeMark")}</span>
                <span className={styles.docxChangeLabel}>{c.label}</span>
                <span className={styles.docxChangeValue}>
                  <span className={styles.docxChangeFrom}>{c.from}</span>
                  <span className={styles.docxChangeArrow}> → </span>
                  <span className={styles.docxChangeTo}>{c.to}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {/* 「未在文件里出现的项按 Word 默认值补（2 项）」——只有照文件模仿时才有话可说。
            它在带子里面、贴着底边：说的是这条来源本身的成色，不是导出的结果。 */}
        {proposal.originFootnote && (
          <div className={styles.docxOriginFoot}>{proposal.originFootnote}</div>
        )}
      </div>

      <div className={styles.docxSpec}>
        {proposal.spec.map((row) => (
          <Fragment key={row.key}>
            <span className={styles.docxSpecLabel}>{row.label}</span>
            <span className={changedKeys.has(row.key) ? styles.docxSpecValueChanged : styles.docxSpecValue}>
              {row.value}
            </span>
          </Fragment>
        ))}
      </div>

      {/* 字体没装不是错误：文件仍然是对的，只是本机预览会替换。中性一句话。 */}
      {proposal.missingFonts.length > 0 && (
        <div className={styles.docxFontNote}>
          {t("ai.approval.docxFontMissing", { fonts: proposal.missingFonts.join("、") })}
        </div>
      )}
    </>
  );
}

/**
 * 导出 Excel。
 *
 * 这张卡要替作者核对的只有一件事，而它恰恰是打开 Excel 之前唯一看不出来的：
 * **数字有没有被当成数字**。所以每张工作表一行，右边写着这张表里有多少个格子
 * 被判成了数字 / 日期 / 公式——一张明明是报价表却写着「数字 0」的表，在这里
 * 一眼就能看见，而不是等到求和栏里出现 0 才发现。
 *
 * 表格之外的段落不进工作簿（工作表没有地方放一段话），所以最后那句把跳过的
 * 东西数出来：悄悄扔掉才是错的。
 */
function XlsxBody({ proposal }: { proposal: XlsxProposal }) {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.moveBlock}>
        <span className={styles.movePath}>{projectRelative(proposal.sourcePath)}</span>
        <ArrowRight size={12} className={styles.moveArrow} />
        <span className={styles.movePath}>{projectRelative(proposal.path)}</span>
      </div>

      <div className={styles.xlsxSheets}>
        {proposal.summaries.map((sheet, i) => (
          <div key={i} className={styles.xlsxSheet}>
            <span className={styles.xlsxSheetName}>{sheet.name}</span>
            <span className={styles.xlsxSheetSize}>
              {sheet.rows}×{sheet.cols}
            </span>
            <span className={styles.xlsxTypes}>
              <span className={sheet.numbers === 0 ? styles.xlsxTypeZero : undefined}>
                {t("ai.approval.xlsxNumbers", { n: sheet.numbers, defaultValue: "数字 {{n}}" })}
              </span>
              {sheet.dates > 0 && (
                <span>{t("ai.approval.xlsxDates", { n: sheet.dates, defaultValue: "日期 {{n}}" })}</span>
              )}
              {sheet.formulas > 0 && (
                <span>
                  {t("ai.approval.xlsxFormulas", { n: sheet.formulas, defaultValue: "公式 {{n}}" })}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      {proposal.skipped.length > 0 && (
        <div className={styles.emptyNote}>
          {t("ai.approval.xlsxSkipped", {
            what: proposal.skipped.join("、"),
            defaultValue: "不会进工作簿：{{what}}",
          })}
        </div>
      )}
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

/**
 * 把项目里的 Office / PDF 文件转成旁边的一份 markdown。
 *
 * 转换在提卡片时就跑完了，所以卡上给作者看的是**真会落盘的那份**的开头，而不是
 * 「将要转换」的承诺——一份转出来全是乱码或全是空白的文档，在这里就该看见。
 * 扫描件单独说：字数为 0 不是转换失败，是原件没有文本层。
 */
function ConvertBody({ proposal }: { proposal: ConvertProposal }) {
  const { t } = useTranslation();
  const html = useMemo(
    () => (proposal.excerpt.trim() ? renderMarkdown(proposal.excerpt) : ""),
    [proposal.excerpt],
  );
  return (
    <>
      <div className={styles.moveBlock}>
        <span className={styles.movePath}>{projectRelative(proposal.sourcePath)}</span>
        <ArrowRight size={12} className={styles.moveArrow} />
        <span className={styles.movePath}>{projectRelative(proposal.path)}</span>
      </div>
      {proposal.scanned ? (
        <div className={styles.emptyNote}>
          {t("ai.approval.convertScanned", { defaultValue: "这份 PDF 没有文本层（扫描件）：转出来只有页面图片，没有文字。" })}
        </div>
      ) : html ? (
        <div className={styles.previewBlockClipped} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className={styles.emptyNote}>{t("ai.approval.convertEmpty", { defaultValue: "转换结果为空。" })}</div>
      )}
      {proposal.pictures > 0 && (
        <div className={styles.emptyNote}>
          {t("ai.approval.convertPictures", { n: proposal.pictures, defaultValue: "抽出 {{n}} 张图片，落在文档旁的 assets/ 里。" })}
        </div>
      )}
      <div className={styles.emptyNote}>
        {t("ai.approval.convertNote", { defaultValue: "原件保留不动；重名时新文件自动编号，不会覆盖任何文件。" })}
      </div>
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
      {/* Only ever present for a ComfyUI model (the proposal drops it
          otherwise), and shown as its own line rather than appended to the
          prompt — it is the half the author is most likely to want to veto,
          and reading it inside the positive prompt is exactly the confusion
          that makes someone approve a picture of what they excluded. */}
      {proposal.negative && (
        <pre className={styles.replaceBlock}>{t("ai.approval.imageNegative", { text: proposal.negative })}</pre>
      )}
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

/**
 * What the author is actually being asked to approve here is a **structure** —
 * a list of headings and breaks — so the card is that list, one row per
 * insertion, and not a diff of the document.
 *
 * The temptation was to compose the result and show it as a rewrite: the apply
 * path already exists and the author would see the finished file. It is the
 * wrong unit of review. Forty insertions into a long document produce a card
 * whose new text is 99% text the author already approved by writing it, and the
 * decisions — is this the right heading, does it belong here — are buried in
 * it. Each row instead carries only the inserted text and the line it lands
 * before, with that line quoted so "here" means something without scrolling.
 */
function InsertBody({ proposal }: { proposal: InsertProposal }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? proposal.insertions : proposal.insertions.slice(0, INSERT_ROWS_CLIPPED);
  const hidden = proposal.insertions.length - rows.length;

  return (
    <>
      <div className={styles.insertList}>
        {rows.map((ins, i) => (
          <div key={i} className={styles.insertRow}>
            <span className={styles.insertLine}>L{ins.line}</span>
            <div className={styles.insertPiece}>
              <pre className={styles.insertText}>{ins.text.replace(/\n+$/, "")}</pre>
              {/* The line it lands in front of — what makes "before line 120"
                  reviewable without opening the file. */}
              {proposal.context[i]?.after && (
                <div className={styles.insertContext}>{proposal.context[i].after}</div>
              )}
            </div>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button className={styles.originalToggle} onClick={() => setExpanded(true)}>
          <ChevronRight size={10} />
          {t("ai.approval.insertMore", { n: hidden, defaultValue: "还有 {{n}} 处" })}
        </button>
      )}
      {expanded && proposal.insertions.length > INSERT_ROWS_CLIPPED && (
        <button className={styles.originalToggle} onClick={() => setExpanded(false)}>
          <ChevronDown size={10} />
          {t("ai.approval.collapse")}
        </button>
      )}
      <div className={styles.emptyNote}>
        {t("ai.approval.insertNote", {
          defaultValue: "只插入这些内容，文档里已有的一个字都不会改动。",
        })}
      </div>
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
    case "insert":
      return <InsertBody proposal={proposal} />;
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
    case "docx":
      return <DocxBody proposal={proposal} />;
    case "xlsx":
      return <XlsxBody proposal={proposal} />;
    case "convert":
      return <ConvertBody proposal={proposal} />;
    case "transcribe":
      return <TranscribeBody proposal={proposal} />;
  }
}

/**
 * 「要不要花这笔钱」——和 `convert` 那张「已经转好了，看一眼再落盘」相反，这张卡
 * 出现时什么都还没跑（设计稿 02f 屏 1e）。四行按「是什么 → 花多少 → 去哪里 →
 * 落在哪」排；估价只有 WAV 算得出时长且模型行填了单价时才有数，否则虚线 + 一句
 * 「转写完成后按实际秒数计」。「去处」那句是隐私事实，陈述句、不加色、不进 tooltip。
 *
 * 说话人分离是**本次**的值：默认来自子代理里的偏好，作者在卡上改的只管这一次。
 * 直接写回 `proposal.diarization`——apply 读的就是这个对象，而不是这张卡的 state。
 */
function TranscribeBody({ proposal }: { proposal: TranscribeProposal }) {
  const { t } = useTranslation();
  const [dia, setDia] = useState(proposal.diarization);
  const video = isVideoExt(proposal.ext);
  const sizeLine = proposal.seconds !== null
    ? `${formatBytes(proposal.bytes)} · ${formatClock(proposal.seconds * 1000)}`
    : t("ai.approval.transcribeNoLength", { size: formatBytes(proposal.bytes), ext: proposal.ext, defaultValue: "{{size}} · {{ext}} 上传前算不出时长" });
  const estimate = proposal.estimate !== null && proposal.seconds !== null
    ? {
        v: `¥ ${proposal.estimate.toFixed(2)}`,
        sub: t("ai.approval.transcribeEstimateSub", {
          s: Math.round(proposal.seconds).toLocaleString(),
          p: proposal.pricePerSecond,
          defaultValue: "{{s}} 秒 × ¥{{p}} / 秒",
        }),
        dash: false,
      }
    : {
        v: t("ai.approval.transcribeEstimateUnknown", { defaultValue: "转写完成后按实际秒数计" }),
        sub: proposal.pricePerSecond === undefined
          ? t("ai.approval.transcribeNoPrice", { defaultValue: "模型行没填每秒单价 · 用量页记不了这笔钱" })
          : t("ai.approval.transcribeRate", { defaultValue: "约 ¥0.8 / 小时" }),
        dash: true,
      };
  const rows: { k: string; v: string; sub?: string; dash?: boolean }[] = [
    { k: t("ai.approval.transcribeFile", { defaultValue: "文件" }), v: proposal.sourceLabel, sub: sizeLine },
    { k: t("ai.approval.transcribeEstimate", { defaultValue: "估价" }), ...estimate },
    {
      k: t("ai.approval.transcribeGoesTo", { defaultValue: "去处" }),
      v: video
        ? t("ai.approval.transcribeGoesToVideo", { defaultValue: "上传到阿里云临时存储（会抽取音轨），48 小时后自动清理。由千问录音文件识别模型处理。" })
        : t("ai.approval.transcribeGoesToText", { defaultValue: "上传到阿里云临时存储，48 小时后自动清理。由千问录音文件识别模型处理。" }),
    },
    {
      k: t("ai.approval.transcribeWrites", { defaultValue: "写到" }),
      v: projectRelative(proposal.path),
      sub: t("ai.approval.transcribeWritesSub", { defaultValue: "已有同名则加序号" }),
    },
  ];
  return (
    <>
      <div className={styles.emptyNote}>
        {t("ai.approval.transcribeLead", { defaultValue: "这一步会上传文件并按秒计费；任务提交后不能取消。" })}
      </div>
      <div className={styles.specRows}>
        {rows.map((r) => (
          <div key={r.k} className={styles.specRow}>
            <span className={styles.specKey}>{r.k}</span>
            <span className={styles.specBody}>
              <span className={r.dash ? styles.specValDash : styles.specVal}>{r.v}</span>
              {r.sub && <span className={styles.specSub}>{r.sub}</span>}
            </span>
          </div>
        ))}
        <label className={styles.specRow}>
          <span className={styles.specKey}>{t("ai.approval.transcribeThisRun", { defaultValue: "本次" })}</span>
          <span className={styles.specBody}>
            <span className={styles.specToggleLine}>
              <input
                type="checkbox"
                checked={dia}
                onChange={(e) => {
                  proposal.diarization = e.target.checked;
                  setDia(e.target.checked);
                }}
              />
              <span className={styles.specVal}>{t("ai.approval.transcribeDiarization", { defaultValue: "说话人分离" })}</span>
            </span>
            <span className={styles.specSub}>
              {t("ai.approval.transcribeDiarizationSrc", { defaultValue: "默认来自 子代理 → 音频转写 · 只改这一次 · 开了多约 2 秒，多一列「说话人 N」" })}
            </span>
          </span>
        </label>
      </div>
    </>
  );
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
        {/* 信任靠的是几何上的连续，不是一句承诺：对话里那道署名线一路穿过正文
            走到这张卡旁边，而这一行小字说的是同一件事——这段字没有经过任何模型
            转手。**如果哪天它被转写了，这一行必须消失**（ProposalBase.fromWriter
            就是那个开关）。放在按钮行开头、等宽小字，不抢焦点。 */}
        {proposal.fromWriter && (
          <span className={styles.verbatim}>{t("ai.approval.verbatimFromWriter")}</span>
        )}
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
          {proposal.kind === "transcribe"
            ? t("ai.approval.approveTranscribe", { defaultValue: "批准并转写" })
            : t("ai.approval.approve")}
        </button>
      </div>
    </div>
  );
}
