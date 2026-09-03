/**
 * Tool registry for the agent runtime.
 *
 * Every tool the model can call is registered here once: its wire definition
 * (OpenAI function schema), its access level, and its executor. Task presets
 * (presets.ts) pick tools by id; the runtime resolves definitions and dispatches
 * calls through this registry instead of a hardcoded switch.
 *
 * Access levels gate what a tool may do to the project:
 *   - "read"           — no writes anywhere (current four tools)
 *   - "write-auto"     — may write lore/.ai-writer state; applied automatically
 *                        with a backup (PR2)
 *   - "write-approval" — produces a proposal the user must approve before it
 *                        lands (manuscript edits, PR4)
 * The runtime itself only executes; enforcement of the write policies lives
 * with the write tools' executors + the approval queue (see
 * docs/feature/agent/unified-agent-plan.md §3.2).
 */

import type { ToolDefinition } from "../ai/types";
import type { Insertion } from "./editApply";
import type { DocxOutline } from "../docx";
import type { DocFormat, SpecRow } from "../docx/format";
import type { SheetSpec, SheetSummary } from "../xlsx/sheets";
import type { FormatChange, FormatOrigin } from "../docx/resolve";
import i18n from "../../i18n";
import { type LoreIndex, type LoreScope } from "../lore";
import { loreCategories, loreCategoryIds } from "../profile/active";
import { categoryRef } from "../profile/model";
import {
  formatLoreIndex,
  listWritingFiles,
  readLoreEntity,
  readLoreImage,
  readProjectImage,
  readSlidesFile,
  readWritingFile,
  searchWritingFiles,
  type ToolCall,
  type ToolResult,
} from "./tools";
import { LORE_PLAN_ACTIONS, LORE_PLAN_TARGETS, type LorePlan, type PlanDecision, type PlanGate } from "./plan";
import { editImageTool, generateImageTool, redrawLoreImageTool } from "./imageTools";
import { exportPptxTool } from "./pptxTools";
import { readDocumentFile } from "./documentTools";
import { inspectHtmlTool } from "./htmlTools";
import {
  createLoreCategoryTool,
  fileLoreEntriesTool,
  manageCollectionTool,
} from "./organizeTools";
import { exportDocxTool, readDocFormatTool } from "./docxTools";
import { exportXlsxTool } from "./xlsxTools";
import {
  listScenesTool,
  readSceneMemoryTool,
  readSceneSummaryTool,
  readSceneTool,
  searchScenesTool,
  type SceneReader,
} from "../roleplay/sceneTools";
import {
  recallTool,
  rememberTool,
  reviseMemoryTool,
  type AgentMemoryStore,
} from "../roleplay/memoryTools";
import {
  readConversationTool,
  searchConversationTool,
  type ConversationReader,
} from "../roleplay/conversationTools";
import {
  copyFileTool,
  addLoreImageTool,
  copyLoreFileTool,
  createChapterTool,
  createDirectoryTool,
  createFileTool,
  createLoreEntityTool,
  createLoreFacetTool,
  appendLoreFileTool,
  editLoreFileTool,
  rewriteLoreLinesTool,
  deleteChapterTool,
  deleteDirectoryTool,
  deleteLoreEntityTool,
  deleteLoreFileTool,
  deleteLoreImageTool,
  moveChapterTool,
  moveLoreEntityTool,
  setLoreAvatarTool,
  updateFacetMetaTool,
  updateLoreImageTool,
  proposeEditTool,
  appendFileTool,
  rewriteDocumentTool,
  rewriteLinesTool,
  insertLinesTool,
  proposeLorePlanTool,
  readMemoryTool,
  updateLoreFileTool,
  updateLoreMetaTool,
  updateMemoryTool,
} from "./writeTools";
import type { TaskWorkspaceHandle } from "./taskWorkspace";
import {
  listNotesTool,
  readNoteTool,
  taskPlanTool,
  taskProgressTool,
  writeNoteTool,
} from "./scratchpadTools";
import { splitCoreCall, splitFacetCall, type SplitSink } from "./splitTools";
import { executeDelegate, type SubAgentKind } from "./subagent";
import { executeRunPack } from "./packs";
import { translateTool } from "../translate/tool";
import { activeWorkflows, findWorkflow, scanWorkflows } from "../workflow";
import type { AgentEvent, ToolProgress } from "./events";
import type { AiConn } from "../ai/conn";

export type ToolAccess = "read" | "write-auto" | "write-approval";

/** What every proposal carries, whatever it wants done. */
interface ProposalBase {
  id: string;
  /**
   * Absolute path the proposal acts on — a project file for the manuscript
   * kinds (never inside .ai-writer/), the destination folder or file for an
   * illustration.
   */
  path: string;
  /** Model's one-line justification, shown on the approval card. */
  reason?: string;
  /**
   * The content came straight from the writer subagent's stream — no model
   * re-typed it (lib/agent/handoff `deliverWriterOutput`).
   *
   * The card says so, and that claim is the whole trust argument for the
   * feature: the author approves the same bytes they just read in the
   * conversation. Set it only where that is literally true; the moment some
   * model transcribes the text on the way here, this flag has to come off.
   */
  fromWriter?: true;
}

/** Rewrite a passage in place. */
export interface EditProposal extends ProposalBase {
  kind: "edit";
  /** Exact text to replace. */
  find: string;
  replace: string;
  /**
   * How many times `find` occurred when this proposal was built.
   *
   * Recorded rather than recomputed at apply time: it is what the card showed
   * the author, so it is what the write must still find to be the write they
   * approved. See `agent/editApply`.
   */
  occurrences: number;
  /**
   * Which occurrence to replace — a 1-based index, or "all". Absent means the
   * only one, which is the shape every edit had before targeting existed.
   */
  target?: number | "all";
  /**
   * Present when the edit came from `rewrite_lines`: the line range the model
   * named. Display only — the write is located by `find` like any other edit —
   * but it is what tells the author on the card that they are approving a
   * region of the file rather than a snippet somewhere in it.
   */
  range?: { from: number; to: number };
}

/**
 * Replace a whole manuscript file's contents.
 *
 * The counterpart to `edit`, and it exists because formatting work is not
 * expressible as find/replace: normalising blank lines, indents or quote marks
 * targets precisely the text that *repeats*, so every such edit bounces off
 * `edit`'s uniqueness rule, and a document-wide pass would be dozens of cards
 * besides. One card for the whole file is the honest unit of review here.
 *
 * `originalChars` rides along so the card can lead with the size delta — the
 * one number that catches the failure mode this kind introduces, a rewrite
 * composed from a partial read that would silently truncate the document.
 */
export interface RewriteProposal extends ProposalBase {
  kind: "rewrite";
  /** Full new file body, replacing everything currently there. */
  content: string;
  /** Length of the file at proposal time. */
  originalChars: number;
}

/**
 * Add text to the end of a file that already exists.
 *
 * The tool that makes a big deliverable possible at all. A model's *output*
 * cap — not its context window — is what a 60k-character HTML page runs into,
 * and neither `create_file` nor `rewrite_document` can express "the rest of
 * it": both take the whole body as one argument, so the whole body has to fit
 * in one reply. Appending is the one write whose per-call size is decoupled
 * from the file's size, which is why every agent that writes real files has
 * some version of it.
 */
export interface AppendProposal extends ProposalBase {
  kind: "append";
  /** Text added at the end; the existing content is never touched. */
  content: string;
  /** Length of the file before the append — the card's "grew from" figure. */
  originalChars: number;
}

/**
 * Splice new lines into a document without touching a byte of what is there.
 *
 * The kind that exists because "add structure to this" — headings over a wall
 * of text, section breaks, a blank line between welded paragraphs — is not a
 * replacement at all, and expressing it as one is what made it expensive. As an
 * `edit` it is unaddressable (the text being inserted *at* repeats), and as a
 * `rewrite`/`rewrite_lines` the model has to re-emit every original line it is
 * keeping: the body is paid for twice, once on the way in and once on the way
 * back, and each character it re-types is one it can quietly paraphrase. On a
 * long document, after compaction has folded the original read away, "re-type
 * it" means "reconstruct it from memory" — which is the one failure the author
 * cannot see on a card, because the diff they would have to read is the whole
 * file.
 *
 * So the model sends coordinates and new text only, and the runtime assembles
 * the bytes. `lineCount` is this kind's version of `EditProposal.occurrences`:
 * the file's length when the author saw the card, re-checked at apply time, so
 * a document that moved on while the card waited is refused rather than
 * spliced at stale positions.
 */
export interface InsertProposal extends ProposalBase {
  kind: "insert";
  /** Each `text` goes in before its 1-based `line`, applied bottom-up. */
  insertions: Insertion[];
  /**
   * A line of the file either side of each insertion point, captured when the
   * proposal was built — so the card can show *where* each piece lands without
   * reading the file again. Indexed alongside `insertions`.
   */
  context: { before: string; after: string }[];
  /** Lines the file had when this proposal was built. See the note above. */
  lineCount: number;
}

/** Add a file (or folder) that does not exist yet, with its opening text. */
export interface CreateProposal extends ProposalBase {
  kind: "create";
  /** Body the new file starts with; may be empty. Always empty for a folder. */
  content: string;
  /** True when `path` is a new empty folder rather than a file. */
  isDir?: true;
}

/** Rename a chapter, or move it into another volume. */
export interface MoveProposal extends ProposalBase {
  kind: "move";
  newPath: string;
  /** True when `path` is a volume folder — the move carries every chapter in it. */
  isDir: boolean;
}

/**
 * Remove a chapter file, or (isDir) a whole folder. Sharing the "delete" kind
 * is what keeps the folder variant permanently outside 本次都批准 grants —
 * the exclusion is by kind (see autoApprove), so it cannot be forgotten per
 * tool. On approval the target moves into `.ai-writer/backups`, never unlink.
 */
export interface DeleteProposal extends ProposalBase {
  kind: "delete";
  /** Size at proposal time, so the card can say what is at stake. 0 for a folder. */
  chars: number;
  /** True when `path` is a folder — the deletion takes everything inside. */
  isDir?: true;
  /** Recursive file count, the folder card's headline number. */
  fileCount?: number;
}

/**
 * Duplicate a file (or folder) into a destination directory. The copy keeps
 * the source's name unless `newName` renames it; a collision is auto-numbered
 * ("稿 (1).md") by the apply step, and the actual landing path travels back on
 * the decision so the model can refer to the file it just made.
 */
export interface CopyProposal extends ProposalBase {
  kind: "copy";
  /** Directory the copy lands in. */
  destDir: string;
  /** Name for the copy; absent = the source's own name. */
  newName?: string;
  /** True when `path` is a folder — the copy carries everything in it. */
  isDir: boolean;
}

/**
 * Draw a picture and file it.
 *
 * The odd one out: approving this **spends money**, where the other kinds only
 * move text around. That is precisely why generation happens on approval
 * rather than before it — the author reviews the prompt and the price, and a
 * rejected proposal costs nothing. Everything the run needs is carried here so
 * the card can show it and `applyProposal` can act on it without re-deriving.
 */
export interface IllustrateProposal extends ProposalBase {
  kind: "illustrate";
  /** The prompt exactly as it will be sent. The thing being approved. */
  prompt: string;
  /** Where the picture lands, in words the author recognises. */
  destination: string;
  dest:
    | {
        kind: "lore";
        entityName: string;
        entityDir: string;
        /** Image slot the new picture files into; null/absent = unclassified. */
        slot?: string | null;
      }
    | { kind: "document"; docPath: string }
    /**
     * Beside an existing picture, in the folder it already lives in.
     *
     * The destination for an edit that names no home — the author handed the
     * agent a project image and asked for a change. Its own folder is the one
     * place that needs no guessing: a document's asset folder is named after
     * the document through a lossy `safeAssetName`, so a picture's path cannot
     * be reversed into the document that owns it.
     */
    | { kind: "file"; dir: string };
  /** One line describing the picture — alt text / gallery description. */
  note: string;
  /** Config-row id of the image model, resolved at apply time. */
  modelId: string;
  /** Display name, so the card can say what is about to be paid for. */
  modelName: string;
  /** Estimated USD for this run. Zero when the model has no price configured. */
  costUsd: number;
  aspect?: string;
  /** Resolution tier ("1K"/"2K"/"4K") — resolved through the model's dialect. */
  resolution?: string;
  /** Quality tier ("low"/"medium"/"high") — GPT-Image dialect only. */
  quality?: string;
  /**
   * What must NOT appear — the sampler's own negative conditioning.
   *
   * Only ever set when the bound model runs the comfyui route, because it is
   * the only route with a wire field for it. Filtered at proposal time rather
   * than at apply time so the card never shows the author a line that will be
   * dropped — and never folded into `prompt` for the routes that lack it: SD
   * attracts what it reads, so "no watermark" in the positive invites one.
   */
  negative?: string;
  /**
   * Existing picture this one edits, as an absolute path. Present makes the
   * run an edit; the card shows it, since "change this picture" is only
   * reviewable when you can see the picture.
   */
  sourcePath?: string;
  /**
   * Reference images for a generation, as absolute paths — sent to the model
   * alongside the prompt ("draw her in this outfit", "match this style").
   * Unlike `sourcePath` the result is still a new picture, not a variation of
   * one; the card shows them, since a prompt that leans on a reference is only
   * reviewable next to it.
   */
  refPaths?: string[];
}

/**
 * Turn a project `.html` page into a PowerPoint deck beside it.
 *
 * Nothing model-authored lands here: the bytes are a deterministic rendering of
 * a page the author already has (and already approved). What the card is for is
 * that a *new file* appears in their project — the same reason every other
 * manuscript write blocks — so it names both ends and stays out of the way.
 *
 * The conversion runs on approval rather than at proposal time because it needs
 * a DOM to lay the page out in, and that exists in the renderer where proposals
 * are applied — not in the tool loop. See lib/pptx.
 *
 * **The division, though, is knowable now** — it is text-level (`splitHtmlDeck`)
 * — and it is the one thing about this export an author can act on before
 * approving. "12 slides on `section.slide`" and "1 slide, the whole page" are
 * the difference between a deck and a page someone only thinks is a deck, and
 * until these two fields existed the card could not tell them apart: it showed
 * two paths, the author approved, and a squashed one-slide deck appeared.
 */
export interface PptxProposal extends ProposalBase {
  kind: "pptx";
  /** The `.html` the deck is rendered from. `path` is where the .pptx lands. */
  sourcePath: string;
  /** How many slides the page divides into, counted at proposal time. */
  slides: number;
  /** The selector that divided it, or the "whole page" fallback's own name. */
  tier: string;
  /** True when no slide selector matched and the page became one slide. */
  wholePage: boolean;
}

/**
 * Turn a markdown document into a Word file.
 *
 * Unlike the pptx card, this one has something to weigh **before** approving,
 * and it is the whole point: the format. So the proposal carries the already
 * resolved spec rather than an id — re-resolving at apply time would silently
 * use a different preset if the author changed their default in between.
 */
export interface DocxProposal extends ProposalBase {
  kind: "docx";
  /** The `.md` the document is converted from. `path` is where the .docx lands. */
  sourcePath: string;
  /** Exactly what will be applied. Resolved once, at proposal time. */
  format: DocFormat;
  /** Where that format came from — the card's headline, see `describeOrigin`. */
  originKind: FormatOrigin["kind"];
  originLabel: string;
  /** The quiet right-hand note: 内置 · 未改动 / 未存为预设 / the preset's name. */
  originNote?: string;
  /** Only when the preset was overridden this once: which fields, from → to. */
  changed?: FormatChange[];
  /** The five-row spec table, already in final values. */
  spec: SpecRow[];
  /** Fonts this format names that are not installed here. Not an error. */
  missingFonts: string[];
  sourceChars: number;
  /**
   * What the conversion will produce, counted from the markdown at proposal
   * time — the content half of the preflight the format half already had.
   */
  outline: DocxOutline;
}

/**
 * Turn a markdown document's tables into an Excel workbook.
 *
 * The card's job is the one thing an author cannot check afterwards without
 * opening Excel: **whether the numbers are numbers**. So the proposal carries
 * the finished grid — every cell already classified — and a per-sheet tally of
 * those decisions. Nothing is re-derived at apply time, which is why what was
 * approved and what lands are the same workbook even if the source file moves
 * on in between (pptx cannot promise that: it must render to measure).
 */
export interface XlsxProposal extends ProposalBase {
  kind: "xlsx";
  /** The `.md` the tables come from. `path` is where the .xlsx lands. */
  sourcePath: string;
  /** Exactly what will be written. Built once, at proposal time. */
  sheets: SheetSpec[];
  /** One row per sheet on the card: size, and how the cells were read. */
  summaries: SheetSummary[];
  /** What the document holds that a worksheet has nowhere to put. */
  skipped: string[];
}

/**
 * Something the agent wants done that only the author may authorise. Nothing
 * happens until the card is approved, and the tool call stays blocked until it
 * is decided either way.
 *
 * A discriminated union rather than one wide shape: each kind carries only the
 * fields it needs, so the approval card and the apply step both narrow instead
 * of guessing which optional fields are meaningful.
 */
export type Proposal =
  | EditProposal
  | RewriteProposal
  | AppendProposal
  | InsertProposal
  | CreateProposal
  | MoveProposal
  | DeleteProposal
  | CopyProposal
  | IllustrateProposal
  | PptxProposal
  | DocxProposal
  | XlsxProposal;

export type ApprovalDecision =
  | {
      approved: true;
      backupPath?: string | null;
      /**
       * Where the applied change actually landed, when that differs from what
       * was proposed — today only a copy, whose collision auto-numbering picks
       * the final name at apply time. Not `backupPath`: that field's wording
       * is backup-specific in every report that includes it.
       */
      resultPath?: string;
      /**
       * Applied under a standing 本次都批准 grant, so no human read this one.
       * Reported to the model (see writeTools.reportDecision) precisely so it
       * cannot mistake "approved" for "the author checked my work".
       */
      auto?: true;
    }
  | { approved: false; reason?: string };

/**
 * A question the model puts to the author mid-run (the `ask_author` tool).
 * The tool call blocks on the answer — the same contract as an L2 approval,
 * except nothing is applied: the answer itself is the whole outcome.
 */
export interface AskQuestion {
  /** The decision being asked for, one sentence. */
  question: string;
  /** 2–4 mutually exclusive options, rendered as the card's buttons. */
  options: string[];
}

/**
 * What the author did with a question card. `other` exists structurally — the
 * free-text field is part of the card, not one of the model's options — so the
 * model can never switch it off.
 */
export type AskAnswer =
  | { kind: "option"; index: number; text: string }
  | { kind: "other"; text: string }
  /** Only ever produced by rejectAll: the run was stopped with the card open. */
  | { kind: "dismissed" };

/**
 * 重整知识库组织结构的能力（见 `ToolContext.organize`）。
 *
 * `collections` 随上下文带上而不是让工具再去要一次：验证「这个集合存不存在」是每
 * 一次调用的第一步，而模型给的名字有一半会是它自己编的。
 */
export interface LoreOrganizer {
  /** 当前声明的集合，按作者排的顺序。 */
  collections: string[];
  createCollection: (name: string) => Promise<void>;
  renameCollection: (from: string, to: string) => Promise<void>;
  deleteCollection: (name: string) => Promise<void>;
  /** 把条目（按 dirPath）归入 / 移出集合。 */
  file: (dirPaths: string[], add: string[], remove: string[]) => Promise<void>;
  /** 新建分类，传作者能读的标签，返回真正落成的 id。 */
  createCategory: (label: string) => Promise<string>;
}

/** Everything an executor may need about the running project. */
export interface ToolContext {
  projectPath: string;
  loreIndex: LoreIndex;
  /**
   * 作者当前设定的**取材范围**：一个集合名，或 null / 缺席＝不设围栏
   * （见 lib/lore/collections）。
   *
   * 这里存的是范围本身而不是一份过滤过的索引，因为围栏挡的是**自动发现**，不是
   * 访问：`list_lore_entities` 按它收窄并如实说明挡掉了多少，而
   * `findEntityByName` 一路不设防——作者点名要改范围外的某一条时，运行不该假装
   * 那条不存在。同一条规则在注入侧的样子是 `selectLore` 里 pin 豁免围栏。
   *
   * 顺带也是新建条目的归属：范围生效时 `create_lore_entity` 把新条目直接归进范围里
   * 的实集合，否则模型刚建好的东西立刻从它自己看得见的那份清单里消失。
   */
  loreScope?: LoreScope;
  /**
   * 重整知识库的能力：建/改名/删集合、把条目归入或移出、新建分类。
   *
   * 是一个**能力对象**而不是三个回调，因为它们要么一起有要么一起没有——缺席意味着
   * 「当前 surface 不能重整知识库」，工具据此直接说明而不是静默无操作。
   *
   * 方法体都薄薄地转交给 projectStore 已有的那四条路径（UI 走的也是它们），而不是
   * 在 agent 层重写一遍：集合改名要改写所有成员的 frontmatter、删除要解除归属、
   * 新建分类要落盘 profile.json 并 scaffold 目录——同一件事有两份实现，迟早会有
   * 一份忘了做其中一步。
   */
  organize?: LoreOrganizer;
  /** Whether the active model accepts image inputs (controls lore gallery payloads). */
  multimodal: boolean;
  /**
   * The tools this run may actually call — filled in by `executeRegisteredTool`
   * from its own `allowed` list, never by callers. Read-side handlers use it to
   * keep their result trailers honest: `read_lore_entity`'s gutter note names
   * `rewrite_lore_lines` only when the running toolset holds it, because on the
   * eight presets that don't, a note advertising the tool steers the model into
   * an unknown-tool round (and on the assist preset the tool is deferred — it
   * genuinely isn't callable until a plan loads its group).
   */
  allowedTools?: readonly ToolId[];
  /**
   * Called after a write-auto tool changed lore on disk: rescan loreStore so
   * the UI reflects the agent's edit immediately, and **return the fresh
   * index** so the run's snapshot can be brought back in line with it (see
   * `writeTools.syncLore`).
   *
   * The return value is the whole point. `ctx.loreIndex` is captured once at
   * run start, so without it a tool that creates an entity leaves every later
   * call in the same run unable to resolve it — while the result text tells
   * the model the index was refreshed, and the model goes and creates it twice.
   *
   * Optional only because the read-only presets legitimately have no lore to
   * write (see `presets.ts`). Any context whose preset carries a lore *write*
   * tool must supply it.
   */
  onLoreChanged?: () => LoreIndex | void | Promise<LoreIndex | void>;
  /** Same, for story-memory writes (memoryStore refresh). */
  onMemoryChanged?: () => void;
  /**
   * L2 approval channel: propose_edit blocks on this until the author approves
   * (the resolver applies the edit before resolving) or rejects. Absent when
   * the surface can't render an approval card — the tool then errors.
   */
  requestApproval?: (
    proposal: Proposal,
    /**
     * Where to report the wait *after* the author approves, for the kinds whose
     * apply is the slow part — a picture polls for minutes (`lib/image`), and
     * by then this tool is parked inside the promise below with no other way to
     * say anything. Pass `ctx.onProgress` and the store calls it while it works
     * (agentStore.settleApproval); the row it advances is this call's own,
     * because it is this call's own callback.
     */
    onApplyProgress?: (p: ToolProgress) => void,
  ) => Promise<ApprovalDecision>;
  /**
   * Plan-approval channel, same blocking contract, for propose_lore_plan.
   * Absent (or `lorePlan` absent) means the surface can't gate lore changes,
   * and the lore write tools refuse rather than write ungated.
   */
  requestPlanApproval?: (plan: LorePlan) => Promise<PlanDecision>;
  /** This run's approved-plan record — see lib/agent/plan.ts. */
  lorePlan?: PlanGate;
  /**
   * 提问通道：`ask_author` 阻塞在这里，直到作者点了一个选项或自由作答——契约
   * 与 `requestApproval` 相同。缺席意味着当前 surface 渲染不了提问卡；路由
   * （routing.ts 的 `askAuthor`）应保证那样的 surface 根本拿不到这个工具，
   * handler 里的报错只是兜底。
   */
  askAuthor?: (q: AskQuestion) => Promise<AskAnswer>;
  /**
   * Collector for a facet-split run (lib/agent/splitTools). Nothing is written
   * to disk — the modal reviews the sink and the author's Apply does the
   * writing. Absent means this surface isn't a split, and the split_* tools
   * refuse rather than dropping the model's work on the floor.
   */
  splitSink?: SplitSink;
  /** Active on-disk task workspace (.ai-writer/tasks/<taskId>/). */
  taskWorkspace?: TaskWorkspaceHandle;
  /**
   * Abort signal for this run. Tools that launch nested runs (delegate) must
   * share it so cancelling the parent run cancels all child work.
   */
  signal?: AbortSignal;
  /**
   * Forward events from nested child agents into the parent's execution log.
   */
  onNestedEvent?: (event: AgentEvent) => void;
  /**
   * Report how far along this call is, for tools that take minutes.
   *
   * The runtime re-emits its own running step with the progress attached, so
   * the tool never has to reconstruct the step's identity (round, call id,
   * arguments) — getting any of those wrong would print a second row instead of
   * advancing the first. Call it as often as there is something new to say; the
   * log replaces in place.
   */
  onProgress?: (progress: ToolProgress) => void;
  /**
   * Resolver for child agent connections. Injected by the caller from aiStore,
   * avoiding reverse dependencies from lib/agent into stores.
   *
   * Typed on the full `SubAgentKind` rather than `DelegateKind`: the writer is
   * resolved through here too (lib/agent/handoff), and it is deliberately not a
   * delegate. `delegate` still validates its own argument against
   * `DELEGATE_KINDS` before calling, so widening the resolver does not widen
   * what that tool can dispatch to.
   */
  resolveSubAgent?: (kind: SubAgentKind) => Promise<AiConn | { error: string }>;
  /**
   * The connection this run itself is on — what `run_pack` dispatches its
   * sub-run with. Injected by the caller that resolved the conn, because the
   * runtime only ever sees the flattened `ConnOptions` and cannot rebuild the
   * `Model`/`Provider` rows a nested run's accounting needs.
   *
   * A separate field from `resolveSubAgent` on purpose: a pack runs the
   * *parent's own model* (tool-pack-plan D1 — its point is a narrower toolset,
   * not a different binding), so routing it through the subagent resolver
   * would invent a kind that isn't one. Absent = this surface cannot run
   * packs, and `run_pack` says so instead of failing downstream.
   */
  selfConn?: AiConn;
  /**
   * The author's context-utilization setting, for sizing a pack sub-run's own
   * message ceiling. Injected (appStore state) because lib cannot read stores;
   * a pack falls back to `CONTEXT_UTILIZATION_DEFAULT` when absent.
   */
  contextUtilization?: number;
  /**
   * A narrator's window onto the other roleplay scenes. **Reaches only
   * transcript.md / summary.md** — another agent's wire history has no path
   * here, which is what makes the isolation structural rather than a promise
   * in a prompt (docs/feature/roleplay/01-overview.md, invariant 3).
   *
   * Absent means this surface is not a narrator, and the scene tools say so
   * rather than quietly returning nothing.
   */
  scenes?: SceneReader;
  /**
   * 本 agent **自己这一场**的对话记录（`transcript.md`）。只读。
   *
   * 和 `scenes` 的区别是作用域，不是权限：这里没有 agent id 可传，通道由调用方
   * 绑死在本次运行的那个 agent 上。所以给一个扮演 agent 装上它，不会让它多看见
   * 任何别人的东西——不变量三仍然是结构性的。
   *
   * 缺席意味着当前 surface 不是扮演面板，工具直接说明而不是静默返回空。
   */
  conversation?: ConversationReader;
  /**
   * 本 agent 的私有长期记忆（约定 / 待办 / 事件 / 关系）。
   *
   * 与 `scenes` 相反，这是**可写**的，而且是 L1：写进去不过审批卡。安全阀在
   * lib/roleplay/memory 的三条规则——只增改不删、写前备份、没有整篇重写的工具
   * ——所以一次坏调用的爆炸半径是一条记录。
   *
   * 缺席意味着当前 surface 不是扮演面板，记忆工具直接说明而不是静默无操作。
   */
  agentMemory?: AgentMemoryStore;
}

/**
 * A set of tools that is **not sent until the run has earned it**.
 *
 * The schemas ride on every round, so a tool the model cannot legally call yet
 * is pure cost — and `lore_write` is exactly that: `plan.ts` refuses every one
 * of these until the author has approved a plan, so before that moment they can
 * only ever come back as an error telling the model to call `propose_lore_plan`
 * first. Withholding the definitions changes nothing about what the model can
 * do; it only stops the run paying for nine schemas it cannot use.
 *
 * A tool with no group is resident — the default, and what every tool was
 * before this existed.
 */
export type ToolGroup = "lore_write" | "lore_organize";

export interface RegisteredTool {
  definition: ToolDefinition;
  access: ToolAccess;
  execute: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
  /** Deferred group this tool belongs to; absent = resident. See {@link ToolGroup}. */
  group?: ToolGroup;
  /**
   * This tool touches nothing on disk, so it works with no folder open.
   *
   * The default — absent — is the fence: `executeRegisteredTool` refuses every
   * other tool when `ctx.projectPath` is empty, the same rule the icon rail
   * applies to the knowledge base and the library (`appStore.viewNeedsProject`).
   * Containment is a prefix test and *every* absolute path is inside the empty
   * prefix, so a run without a root doesn't fail closed on its own — it fails
   * open, onto the whole disk (`readProjectImage` found this first).
   *
   * A new tool that forgets the flag is refused, which is the safe direction.
   * Only the split collector carries it, and only because it writes to an
   * in-memory sink — see splitTools.ts, and `lore/splitter.ts`, which is the
   * one caller that deliberately runs the loop with no project at all.
   */
  projectFree?: true;
  /**
   * Parameter names whose `enum` must be filled in from the *active profile's*
   * lore categories when the definition is handed to the model.
   *
   * The categories are profile-defined (lib/profile), but this registry is a
   * module-level constant evaluated once at import — baking the list in here
   * would freeze it to whichever profile loaded first and then offer a TTRPG
   * author "characters"/"world". `getToolDefinitions` patches it per call
   * instead. See `withProfileCategories`.
   */
  profileCategoryParams?: readonly string[];
}

export type ToolId =
  | "list_lore_entities"
  | "read_lore_entity"
  | "read_lore_image"
  | "read_image"
  | "list_files"
  | "read_file"
  | "read_slides"
  | "read_document"
  | "inspect_html"
  | "search_text"
  | "read_memory"
  | "read_workflow"
  | "ask_author"
  | "propose_lore_plan"
  | "create_lore_entity"
  | "create_lore_facet"
  | "update_lore_file"
  | "update_lore_meta"
  | "append_lore_file"
  | "edit_lore_file"
  | "rewrite_lore_lines"
  | "update_facet_meta"
  | "delete_lore_file"
  | "add_lore_image"
  | "update_lore_image"
  | "delete_lore_image"
  | "manage_collection"
  | "file_lore_entries"
  | "create_lore_category"
  | "set_lore_avatar"
  | "copy_lore_file"
  | "move_lore_entity"
  | "delete_lore_entity"
  | "update_memory"
  | "split_core"
  | "split_facet"
  | "propose_edit"
  | "rewrite_document"
  | "rewrite_lines"
  | "insert_lines"
  | "append_file"
  | "create_chapter"
  | "create_file"
  | "create_directory"
  | "move_chapter"
  | "copy_file"
  | "delete_chapter"
  | "delete_directory"
  | "export_pptx"
  | "export_docx"
  | "export_xlsx"
  | "read_doc_format"
  | "generate_image"
  | "edit_image"
  | "redraw_lore_image"
  | "task_plan"
  | "task_progress"
  | "write_note"
  | "read_note"
  | "list_notes"
  | "list_scenes"
  | "read_scene"
  | "search_scenes"
  | "read_scene_summary"
  | "read_scene_memory"
  | "search_conversation"
  | "read_conversation"
  | "remember"
  | "revise_memory"
  | "recall"
  | "delegate"
  | "run_pack"
  | "translate";

function parseArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

/**
 * Stands in for the active profile's category ids inside a tool *description*,
 * substituted by `getToolDefinitions`. Same reason the enums are patched there:
 * this registry is a module-level constant, so anything baked in freezes to
 * whichever profile happened to load first.
 */
const CATEGORY_PLACEHOLDER = "{{categories}}";

const REGISTRY: Record<ToolId, RegisteredTool> = {
  list_lore_entities: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_lore_entities",
        description:
          `List all lore entities (${CATEGORY_PLACEHOLDER}) in the project. Returns entity names, categories, and one-line summaries. Call this first to discover available lore before reading specific entries.`,
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async (call, ctx) => ({
      toolCallId: call.id,
      content: formatLoreIndex(ctx.loreIndex, ctx.loreScope, ctx.organize?.collections, i18n.language === "zh-CN"),
    }),
  },

  read_lore_entity: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_lore_entity",
        description:
          "Read a lore entity: its index.md and supplementary .md files, with per-file line numbers. A very large entry comes back as index.md plus a table of its other files — pass 'file' to read one of those (paged; 'start_line' continues). The entity may also have a gallery (avatar + images.md listing additional pictures with descriptions and image slots) — this only returns filenames and text descriptions, never the images themselves. Call read_lore_image afterwards for any specific picture you actually need to see. Call list_lore_entities first to get the exact entity names.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "One .md filename inside the entity to read alone — for a facet of a large entry, or to continue past the page limit. Omit for the whole entity.",
            },
            start_line: {
              type: "number",
              description: "1-based line to start at, with 'file' only. Omit to read from the top.",
            },
          },
          required: ["entity"],
        },
      },
    },
    execute: async (call, ctx) => {
      // `name` accepted as a fallback — the parameter's pre-1.28 spelling.
      const args = JSON.parse(call.arguments || "{}") as {
        entity?: string; name?: string; file?: string; start_line?: number;
      };
      const entity = args.entity ?? args.name;
      if (!entity) return { toolCallId: call.id, content: "Error: 'entity' argument is required." };
      return readLoreEntity(
        call.id, entity, ctx.loreIndex, ctx.multimodal, args.file, args.start_line,
        ctx.allowedTools?.includes("rewrite_lore_lines") ?? false,
      );
    },
  },

  read_lore_image: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_lore_image",
        description:
          "Fetch ONE specific image from a lore entity's gallery (or its avatar) as visual input. Call read_lore_entity first to see which filenames and descriptions are available, then call this only for the picture(s) actually relevant to the current task — not the whole gallery.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The image filename exactly as listed in read_lore_entity's gallery block",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: async (call, ctx) => {
      // `name` accepted as a fallback — the parameter's pre-1.28 spelling.
      const args = JSON.parse(call.arguments || "{}") as { entity?: string; name?: string; file?: string };
      const entity = args.entity ?? args.name;
      if (!entity || !args.file) {
        return { toolCallId: call.id, content: "Error: 'entity' and 'file' arguments are required." };
      }
      return readLoreImage(call.id, entity, args.file, ctx.loreIndex, ctx.multimodal);
    },
  },

  read_image: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_image",
        description:
          "View an image file from the project as visual input: a document's illustrations (they live in an `assets/` folder beside it, which list_files shows), or any reference picture the author keeps in the project. For a lore entity's avatar or gallery picture use read_lore_image instead — it takes the entity and filename read_lore_entity lists. Call this only for a picture the current task actually needs; each one is expensive to send.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Absolute path to the image — a list_files folder line + \"/\" + the filename. A link written inside a document, ![](assets/…/x.png), is relative to that document's own folder: join the document's folder with it.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = parseArgs<{ path?: string }>(call.arguments);
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readProjectImage(call.id, args.path, ctx.projectPath, ctx.multimodal);
    },
  },

  list_files: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List the project's document tree, recursively — the whole workspace folder, every subfolder included (the app's own .ai-writer data never appears). Output is grouped like `ls -R`: an absolute folder path on its own line, then that folder's filenames indented under it. A file's full path, as read_file wants it, is the folder line + \"/\" + the filename. Use this to see what files exist; to find where something is written, use search_text instead.",
        parameters: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description:
                "Subfolder to list, relative to the project root (e.g. one volume). Omit to list the whole project.",
            },
          },
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { folder?: string };
      return listWritingFiles(call.id, ctx.projectPath, args.folder);
    },
  },

  read_file: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read the text content of a project file (anywhere in the workspace except the app's .ai-writer data). Up to 4000 characters come back per call, cut on a line boundary; if the file is longer the result ends with the line range shown and the start_line to pass next, so a long chapter can be read in order. To jump straight to a passage search_text found, pass its line number as start_line.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path, built from a list_files folder line + \"/\" + filename",
            },
            start_line: {
              type: "number",
              description:
                "1-based line to start reading at — a search_text hit's line number, or the start_line the previous call handed back. Omit to read from the top.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { path?: string; start_line?: number };
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readWritingFile(call.id, args.path, ctx.projectPath, args.start_line);
    },
  },

  read_slides: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_slides",
        description:
          "Read a presentation in the project **by slide** — either a .pptx or an .html deck. For a .pptx: read_file cannot open one (it is a compressed archive, not text), and slides come back as markdown in running order — one `## Slide N` heading per slide, bullets nested by outline level, tables as markdown tables, pictures named, speaker notes quoted. For an .html deck: each slide comes back as its **verbatim HTML source** under the same `## Slide N` heading, which is what you quote into propose_edit to change one slide — use this instead of paging the whole page with read_file. Around 4000 characters come back per call, cut on a slide boundary; if the deck is longer the result ends with the slide range shown and the start_slide to pass next, so a long deck can be read in order. Legacy .ppt files (PowerPoint 97-2003) cannot be read at all.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path, built from a list_files folder line + \"/\" + filename",
            },
            start_slide: {
              type: "number",
              description:
                "1-based slide to start at — the start_slide the previous call handed back. Omit to read from the first slide.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { path?: string; start_slide?: number };
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readSlidesFile(call.id, args.path, ctx.projectPath, args.start_slide);
    },
  },

  read_document: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_document",
        description:
          "Read a Word (.docx), Excel (.xlsx) or PDF file in the project as text — read_file cannot open these. It is converted to markdown (headings, tables, one `## sheet` per worksheet, `<!-- page N -->` markers in a PDF) and paged like read_file: about 4000 characters per call, with the start_line to pass next. The conversion is cached outside the workspace; nothing is written to the project and the original is untouched. Pictures inside it are extracted and named in the result, for read_image. For a .pptx use read_slides.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path, built from a list_files folder line + \"/\" + filename",
            },
            start_line: {
              type: "number",
              description: "1-based line to start at — the start_line the previous call handed back. Omit for the top.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { path?: string; start_line?: number };
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readDocumentFile(call.id, args.path, ctx.projectPath, args.start_line);
    },
  },

  inspect_html: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "inspect_html",
        description:
          "Lay a project .html page out in a real browser and report what it MEASURED — the one way to check a page you cannot see. Writes nothing. Reports how the page divided into slides and on which selector, the slide size, any box that ends up outside its slide (and by how many pixels), slides that render empty, and pictures that failed to load. Call it after writing or revising a deck or a diagram, before export_pptx and before telling the author it is done: a heading that spills off slide 3 is invisible in the source and obvious here. Takes a few seconds — it waits for fonts and images.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the .html page to measure",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => inspectHtmlTool(call.id, parseArgs(call.arguments), ctx),
  },

  search_text: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "search_text",
        description:
          "Full-text search across the project's documents AND its knowledge-base entries. Scans every document file in the workspace (recursively, including subfolders) plus the body of every entry, returning each hit as a line number and the text around it. This is the way to locate a scene, a name, or a piece of foreshadowing — and the way to find which entry mentions something, instead of opening entries one by one with read_lore_entity. Knowledge-base blocks are headed \"entity · file\", the two arguments edit_lore_file takes. Matching is literal and case-insensitive; regular expressions are NOT supported. Search a distinctive name or phrase: a common word returns capped, unhelpful results.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "The exact text to look for. Distinctive proper nouns or phrases work; common words get truncated away.",
            },
            folder: {
              type: "string",
              description:
                "Subfolder to limit the search to, relative to the project root (e.g. one volume). Omit to search the whole project — passing it also skips the knowledge base, which has no folders.",
            },
          },
          required: ["query"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { query?: string; folder?: string };
      return searchWritingFiles(call.id, ctx.projectPath, args.query ?? "", {
        folder: args.folder,
        loreIndex: ctx.loreIndex,
        loreScope: ctx.loreScope,
        onProgress: ctx.onProgress,
      });
    },
  },

  read_memory: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_memory",
        description:
          "Read the story memory (rolling plot summary) of a document: numbered segments, each covering a source character range. Call this before update_memory to learn the segment indices and current summaries.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => readMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_workflow: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_workflow",
        description:
          "Read the step-by-step procedure of one workflow card from the 可用工作流 list in your instructions. When the author's request matches a card's description, call this FIRST and follow the steps. Cards are house procedure, advisory: the author's explicit instructions in chat always win over a card.",
        parameters: {
          type: "object",
          properties: {
            workflow: {
              type: "string",
              description: "The card's name exactly as it appears in the list",
            },
          },
          required: ["workflow"],
        },
      },
    },
    execute: async (call, ctx) => {
      // `name` accepted as a fallback — the parameter's pre-1.28 spelling.
      const args = parseArgs<{ workflow?: string; name?: string }>(call.arguments);
      const wanted = args.workflow ?? args.name;
      if (!wanted) return { toolCallId: call.id, content: "Error: 'workflow' argument is required." };
      const cards = await scanWorkflows(ctx.projectPath);
      const card = findWorkflow(cards, wanted);
      if (!card) {
        const names = activeWorkflows(cards).map((c) => c.name).join("、");
        return {
          toolCallId: call.id,
          content: `Error: no workflow card named "${wanted}". Available: ${names || "(none)"}. Copy a name from the 可用工作流 list.`,
        };
      }
      return { toolCallId: call.id, content: `# ${card.name}\n\n${card.body}` };
    },
  },

  // Read-tier but BLOCKING: nothing is written, yet the call awaits the author
  // the way an L2 approval does. Access tiers gate writes; blocking is
  // orthogonal (every approval tool blocks too).
  ask_author: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "ask_author",
        description:
          "Ask the author ONE question you are blocked on, with 2-4 short mutually exclusive options; the run pauses until they answer, and the card always offers a free-text field besides your options — whatever comes back is the author's decision, follow it verbatim. Use it only for a decision you cannot settle from the project or the task (a direction to take, a fact only the author knows); anything findable in the project you look up yourself. Never use it to ask permission for a write — the write tools already show an approval card, so asking first makes the author decide twice. Consecutive questions are an interruption: fold related decisions into one.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The decision you need, as one clear sentence",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description: "2-4 short, mutually exclusive answers the author can pick with one click",
            },
          },
          required: ["question", "options"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = parseArgs<{ question?: string; options?: unknown }>(call.arguments);
      const question = args.question?.trim();
      const options = Array.isArray(args.options)
        ? args.options
            .filter((o): o is string => typeof o === "string")
            .map((o) => o.trim())
            .filter(Boolean)
        : [];
      if (!question) {
        return { toolCallId: call.id, content: "Error: 'question' is required." };
      }
      if (options.length < 2 || options.length > 4) {
        return {
          toolCallId: call.id,
          content: "Error: 'options' must list 2-4 non-empty strings.",
        };
      }
      // Routing should keep this tool off any surface that cannot render the
      // card; this is the defensive floor, and it tells the model what to do
      // instead of leaving it to retry.
      if (!ctx.askAuthor) {
        return {
          toolCallId: call.id,
          content: "Error: no one is watching this run — decide yourself and proceed.",
        };
      }
      const answer = await ctx.askAuthor({ question, options });
      const content =
        answer.kind === "option"
          ? `作者选择：「${answer.text}」`
          : answer.kind === "other"
            ? `作者的回答：「${answer.text}」`
            : "运行已停止，问题未获回答。";
      return { toolCallId: call.id, content };
    },
  },

  propose_lore_plan: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "propose_lore_plan",
        description:
          "Submit your intended lore changes to the author for approval. REQUIRED before any create/update/move/delete of lore — those tools refuse anything this plan does not cover. Investigate first, then send ONE plan covering every entity you mean to touch; the author approves or rejects the whole card, and the call blocks until they decide. Do not write the plan out as a chat message — it only reaches the author as this tool call. If the plan needs to change later, call this again with the revised steps.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "One line on what this pass is for, shown above the steps",
            },
            steps: {
              type: "array",
              description: "Every change you intend to make, one entry each",
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: LORE_PLAN_ACTIONS,
                    description: "Which lore tool this step will use",
                  },
                  entity: {
                    type: "string",
                    description:
                      "What this step acts on: an entity name (for 'create', the name you will give it), or — when 'target' says collection/category — that collection's or category's name",
                  },
                  target: {
                    type: "string",
                    enum: LORE_PLAN_TARGETS,
                    description:
                      "What kind of thing this step acts on. Omit for an entity (the usual case). Use 'collection' to create/rename/delete one or move entries in or out, 'category' to create one or move entries into it. A reorganisation belongs in ONE step per collection or category, not one step per entry — the author has to be able to read the card.",
                  },
                  members: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "collection/category steps: the entries this step moves. Naming them here is what authorises moving them — the write refuses any entry the step did not list.",
                  },
                  file: {
                    type: "string",
                    description:
                      "update/delete only: the target inside the entity dir — a .md filename, a gallery image filename, or `avatar`. Omit to leave the file open.",
                  },
                  detail: {
                    type: "string",
                    description:
                      "Concretely what changes, in the author's language — this is the text they decide on",
                  },
                },
                required: ["action", "entity", "detail"],
              },
            },
          },
          required: ["steps"],
        },
      },
    },
    execute: (call, ctx) => proposeLorePlanTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_lore_entity: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "create_lore_entity",
        description:
          "Create a new lore entity. Fails if an entity with the same name (or alias) already exists — use update_lore_file for changes. The 'content' is the body markdown only; frontmatter is generated from the other arguments. Applied immediately; the lore index refreshes automatically.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Entity display name" },
            category: {
              type: "string",
              // Filled from the active profile — see profileCategoryParams below.
              enum: [],
              description:
                "Entity category — must be one that already exists (create_lore_category, plan-gated, adds one only when none fits).",
            },
            summary: { type: "string", description: "One-line summary shown in listings and used for activation" },
            aliases: {
              type: "array",
              items: { type: "string" },
              description: "Alternative names the text may use for this entity",
            },
            content: {
              type: "string",
              description: "Body markdown for index.md (no frontmatter)",
            },
          },
          required: ["name", "category", "summary", "content"],
        },
      },
    },
    profileCategoryParams: ["category"],
    execute: (call, ctx) => createLoreEntityTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_lore_facet: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "create_lore_facet",
        description:
          "Add a NEW facet to an existing entity — one aspect of it (an outfit, a form, a stretch of backstory, one set of relationships) kept in its own file so it is injected only when the manuscript is actually about that aspect. THE tool for 'split this entry into facets' and for filling an empty facet slot: writing a new .md through update_lore_file instead produces an inert attachment that is never injected, because a facet is its frontmatter and only this tool generates it. 'content' is the body markdown alone (no frontmatter). 'keys' are the trigger words the injector matches against the manuscript — without any, a mode=auto facet never fires. Facets sharing a 'group' compete, so only the highest 'priority' one is injected. read_lore_entity lists the category's facet slots and what already covers them.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            title: {
              type: "string",
              description: "What this facet is, e.g. \"战甲形象\" — heads the author's card and names the file",
            },
            content: {
              type: "string",
              description: "The facet's body markdown, no frontmatter. Omit it only when promoting an attachment (see 'file'), to keep that text verbatim.",
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description: "4-8 trigger words the injector matches against the manuscript — each specific enough that its appearance really means this facet is relevant; no pronouns or common verbs. Without any, a mode=auto facet never fires.",
            },
            slot: {
              type: "string",
              description: "The facet slot this fills, from read_lore_entity's facet-slot list. Omit when it fits none.",
            },
            group: {
              type: "string",
              description: "Mutual-exclusion group: facets that cannot both be true (all outfits, all forms) share one, e.g. \"outfit\" — only the highest 'priority' one is injected.",
            },
            priority: { type: "number", description: "Within a group, higher wins. Default 0." },
            mode: {
              type: "string",
              enum: ["auto", "always", "manual"],
              description: "auto = injected when a key matches (default), always = every time, manual = only when the author pins it",
            },
            file: {
              type: "string",
              description: "Only to promote an EXISTING attachment of this entity into a facet — the .md filename read_lore_entity showed. Omit for a new facet: the filename comes from the title.",
            },
          },
          required: ["entity", "title"],
        },
      },
    },
    execute: (call, ctx) => createLoreFacetTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_lore_file",
        description:
          "Overwrite one .md file of an existing lore entity with complete new content (send the WHOLE file, not a diff). Reach for it only when a whole file must be re-laid-out: to change metadata use update_lore_meta / update_facet_meta, to add a section use append_lore_file, to fix a sentence use edit_lore_file, and to add a facet use create_lore_facet — none of which make you re-emit the rest of the entry. NOT the tool for a new facet: a new filename here becomes an inert ATTACHMENT that is never injected, because a facet is defined by frontmatter this tool does not generate. index.md must include full frontmatter (name/aliases/category/summary) and may not change the name, the category or the dict flag (renames go through move_lore_entity). An existing facet file must keep its facet frontmatter. images.md cannot be written — the gallery has its own tools. Read the current content with read_lore_entity first. The previous version is backed up automatically before writing.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md). A filename that does not exist yet creates an inert attachment, NOT a facet — use create_lore_facet for that.",
            },
            content: { type: "string", description: "The complete new file content" },
          },
          required: ["entity", "content"],
        },
      },
    },
    execute: (call, ctx) => updateLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_lore_meta: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_lore_meta",
        description:
          "Change an entity's index.md metadata — summary and/or aliases — WITHOUT resending its body. The entity-level twin of update_facet_meta, and the right tool for 'fix this one-line summary' or 'she is also called X': update_lore_file would make you re-emit the whole entry, paying for the content twice and risking silently reworded prose. Name and category are deliberately NOT here — both relocate the entity's folder, so they go through move_lore_entity. Omitted fields keep their current values; `aliases` replaces the whole list, `add_aliases` appends to it. The previous index.md is backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            summary: {
              type: "string",
              description: "One-line summary shown in listings and used for activation",
            },
            aliases: {
              type: "array",
              items: { type: "string" },
              description:
                "Replaces the current alias list entirely — pass every alias the entity should keep, not just the new one",
            },
            add_aliases: {
              type: "array",
              items: { type: "string" },
              description: "Aliases to add to the current list, leaving the existing ones in place",
            },
          },
          required: ["entity"],
        },
      },
    },
    execute: (call, ctx) => updateLoreMetaTool(call.id, parseArgs(call.arguments), ctx),
  },

  append_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "append_lore_file",
        description:
          "Add text to the END of one of an entity's .md files, leaving everything already in it untouched — a new section on an entry, one more event on a timeline, another note under a heading. Nothing before the addition is re-sent, so this write cannot damage it and you do not pay for the existing content twice. Send ONLY the new text: no frontmatter, no repetition of what is already there. One blank line is inserted between the existing ending and your text. Defaults to index.md; a facet's filename appends to that facet. Use edit_lore_file to change text that already exists, and update_lore_file only when the whole file must be re-laid-out. Backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md). The file must already exist.",
            },
            content: {
              type: "string",
              description: "The new text to add at the end — only the addition itself",
            },
          },
          required: ["entity", "content"],
        },
      },
    },
    execute: (call, ctx) => appendLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  edit_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "edit_lore_file",
        description:
          "Replace an exact snippet inside an entity's .md file — correct a sentence, update a number, fix a name in the prose — without resending the rest. What propose_edit is for the manuscript, this is for the knowledge base (applied immediately with a backup, once the approved lore plan covers it). 'find' must be text that currently exists in the file's BODY. When it occurs more than once you have the same three ways to say which one you mean as propose_edit: make 'find' unique by including surrounding text, pass 'occurrence' for the Nth, or pass replace_all=true to change every one — the refusal names the lines they are on. Read the file with read_lore_entity or search_text first and copy the snippet verbatim, whitespace included. Pass an empty 'replace' to delete the found text. Frontmatter is never touched — use update_lore_meta or update_facet_meta for metadata. Defaults to index.md.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md)",
            },
            find: {
              type: "string",
              description: "Exact existing text to replace, from the file body",
            },
            replace: {
              type: "string",
              description: "The replacement text; an empty string deletes the found text",
            },
            occurrence: {
              type: "number",
              description:
                "1-based: which occurrence of 'find' to replace, when it appears more than once. Omit when 'find' is unique.",
            },
            replace_all: {
              type: "boolean",
              description: "Replace EVERY occurrence of 'find' in the file body. Cannot be combined with 'occurrence'.",
            },
          },
          required: ["entity", "find", "replace"],
        },
      },
    },
    execute: (call, ctx) => editLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  rewrite_lore_lines: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "rewrite_lore_lines",
        description:
          "Replace a REGION of an entity's .md file, named by line numbers, with new text — what rewrite_lines is for the manuscript, this is for the knowledge base (applied immediately with a backup, once the approved lore plan covers it). This is how a LONG facet gets restructured without re-emitting the whole file: only the replacement is sent. Line numbers are the ones read_lore_entity shows — per file, frontmatter counted — but the frontmatter itself is off-limits (use update_lore_meta / update_facet_meta for metadata). Pass an empty 'content' to delete the lines. For one exact snippet use edit_lore_file instead.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md)",
            },
            start_line: {
              type: "number",
              description: "First line to replace (1-based, as read_lore_entity numbers them)",
            },
            end_line: { type: "number", description: "Last line to replace (inclusive)" },
            content: {
              type: "string",
              description: "The new text for those lines; an empty string deletes them",
            },
          },
          required: ["entity", "start_line", "end_line", "content"],
        },
      },
    },
    execute: (call, ctx) => rewriteLoreLinesTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_facet_meta: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_facet_meta",
        description:
          "Retune ONE facet's activation metadata — its title, slot, keys, group, priority or mode — without touching its body text. This is the right tool for 'this facet never fires' or 'these two outfits should exclude each other': update_lore_file would make you resend the whole file, risking silent edits to the prose. The file must ALREADY be a facet — create one with create_lore_facet. `keys` are the trigger words the injector matches against the manuscript; facets sharing a `group` compete so only the highest `priority` one is injected; `mode` auto = key-matched, always = every time, manual = pinned only. Read the file with read_lore_entity first — the fields you omit keep their current values.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The facet's .md filename inside the entity directory (not index.md)",
            },
            title: { type: "string", description: "Facet display title" },
            slot: {
              type: "string",
              description:
                "Which slot of the entity's category type schema this facet fills, by id. read_lore_entity lists the category's slots and what already covers each; an id that category doesn't declare is refused. Pass an empty string to leave the facet unclassified.",
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description:
                "Trigger words, replacing the current list entirely — distinctive nouns the text would actually use, not generic words",
            },
            group: {
              type: "string",
              description:
                "Mutual-exclusion group (e.g. \"outfit\"); pass an empty string to clear it",
            },
            priority: {
              type: "number",
              description: "Higher wins within a group; default 0",
            },
            mode: {
              type: "string",
              enum: ["auto", "always", "manual"],
              description: "auto = key-matched, always = always injected, manual = pin-only",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => updateFacetMetaTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "delete_lore_file",
        description:
          "Delete ONE facet or attachment .md file from an entity, backing it up first. Use this to retire a facet that has been merged elsewhere or is no longer canon — delete_lore_entity would remove the entire character. index.md and images.md cannot be deleted this way.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: { type: "string", description: "The .md filename inside the entity directory" },
            reason: {
              type: "string",
              description: "One line on why it is being removed, shown to the author in the log",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => deleteLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  add_lore_image: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "add_lore_image",
        description:
          "File a picture that ALREADY EXISTS in the project into a lore entity's gallery — art the author imported, a document illustration, a reference image list_files shows. This is the tool for \"add this picture to that entry\": generate_image DRAWS a new one and costs money, so it is the wrong answer when the picture is already there. The source file is copied, not moved, and stays where it is. To bring a picture over from ANOTHER entity's gallery use copy_lore_file; to make it the entity's portrait use set_lore_avatar.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            path: {
              type: "string",
              description:
                "Full path of the image in the project — a list_files folder line + \"/\" + the filename.",
            },
            desc: {
              type: "string",
              description:
                "One line saying what the picture shows, in the author's language. This is all a text-only model will ever see of it, so write one unless you genuinely cannot tell (read_image will show you).",
            },
            slot: {
              type: "string",
              description:
                "Which image slot of the entity's category this picture fills, by id (read_lore_entity lists them). Omit when it fits none — update_lore_image can classify it later.",
            },
          },
          required: ["entity", "path"],
        },
      },
    },
    execute: (call, ctx) => addLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_lore_image: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_lore_image",
        description:
          "Retune ONE gallery image's metadata — its description and/or its image slot — without touching the picture itself. The gallery counterpart of update_facet_meta: the description is all a text-only model ever sees of the picture, and the slot is how it fills the category's image checklist. read_lore_entity lists the gallery and the category's image slots. To change the picture use redraw_lore_image; to remove it use delete_lore_image. The fields you omit keep their current values.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The image filename exactly as listed in read_lore_entity's gallery block",
            },
            desc: {
              type: "string",
              description: "New description — one line saying what the picture shows, in the author's language",
            },
            slot: {
              type: "string",
              description:
                "Which image slot of the entity's category this picture fills, by id. An id the category doesn't declare is refused; pass an empty string to leave the picture unclassified.",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => updateLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  // ── 重整组织结构（deferred: "lore_organize"，见 ./organizeTools） ──────────
  manage_collection: {
    access: "write-auto",
    group: "lore_organize",
    definition: {
      type: "function",
      function: {
        name: "manage_collection",
        description:
          "Create, rename or delete a knowledge-base COLLECTION — the second axis, which body of work an entry belongs to (a novel, a client's report). Not a category: a category is what an entry IS (character / location), a collection is which project it is FOR, and an entry has exactly one category but any number of collections. Requires an approved plan step with target 'collection'. Deleting never deletes entries — it only removes that membership.",
        parameters: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["create", "rename", "delete"], description: "What to do" },
            collection: { type: "string", description: "The collection to act on — for 'create', the name you are giving it" },
            new_name: { type: "string", description: "rename only: the new name" },
          },
          required: ["op", "collection"],
        },
      },
    },
    execute: (call, ctx) => manageCollectionTool(call.id, parseArgs(call.arguments), ctx),
  },

  file_lore_entries: {
    access: "write-auto",
    group: "lore_organize",
    definition: {
      type: "function",
      function: {
        name: "file_lore_entries",
        description:
          "File entries into and/or out of collections — the bulk move that reorganising a knowledge base is made of. Pass every entry that goes to the same collection in ONE call. Membership is additive: 'add' never removes the collections an entry is already in, so use 'remove' to take it out of one. Requires an approved plan step with target 'collection' whose 'members' name the entries — anything not on that list is refused. The collections in 'add' must already exist (create them with manage_collection first).",
        parameters: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: { type: "string" },
              description: "Entity names exactly as returned by list_lore_entities",
            },
            add: { type: "array", items: { type: "string" }, description: "Collections these entries join" },
            remove: { type: "array", items: { type: "string" }, description: "Collections these entries leave" },
          },
          required: ["entities"],
        },
      },
    },
    execute: (call, ctx) => fileLoreEntriesTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_lore_category: {
    access: "write-auto",
    group: "lore_organize",
    definition: {
      type: "function",
      function: {
        name: "create_lore_category",
        description:
          "Create a new knowledge-base CATEGORY — what an entry IS (人物 / 地点 / 合同), which is also its folder on disk. Reach for it only when existing categories genuinely cannot hold a kind of entry; to group by project use a collection instead. Requires an approved plan step with target 'category'. There is deliberately no rename or delete counterpart: those would relocate every member entry's folder.",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: "What the author will see this category called; the folder id is derived from it" },
          },
          required: ["label"],
        },
      },
    },
    execute: (call, ctx) => createLoreCategoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_lore_image: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "delete_lore_image",
        description:
          "Remove ONE picture from an entity's gallery. The image file is moved into .ai-writer/backups/ rather than erased, and its images.md entry is dropped, so the author can restore both. The avatar cannot be removed this way — set_lore_avatar replaces it.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The image filename exactly as listed in read_lore_entity's gallery block",
            },
            reason: {
              type: "string",
              description: "One line on why it is being removed, shown to the author in the log",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => deleteLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  set_lore_avatar: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "set_lore_avatar",
        description:
          "Set an entity's avatar (its card portrait) from a picture that already exists — one of its own gallery filenames, or the path of an image in the project. The source is copied, not moved, and the previous avatar goes into .ai-writer/backups/ first. To draw a brand-new portrait, generate_image into the gallery first, then promote it with this.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description:
                "A gallery filename of this entity (as listed by read_lore_entity), or a project image path. Must be png/jpg/jpeg/webp.",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => setLoreAvatarTool(call.id, parseArgs(call.arguments), ctx),
  },

  copy_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "copy_lore_file",
        description:
          "Copy one file from one lore entity to another, byte for byte — a facet/attachment .md (frontmatter and all), or a gallery image (picture plus its description and slot). THE tool for merging entities and for promoting a facet into its own entry, because the content never passes through you: reading a file and re-sending it with update_lore_file risks silently reworded prose, a copy cannot. The source entity is untouched — when the copy was really a move, retire the source file with delete_lore_file / delete_lore_image under its own plan step. index.md and images.md themselves cannot be copied.",
        parameters: {
          type: "object",
          properties: {
            from_entity: {
              type: "string",
              description: "Source entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The filename to copy — a facet .md or a gallery image of the source entity",
            },
            to_entity: {
              type: "string",
              description: "Target entity name exactly as returned by list_lore_entities",
            },
            new_file: {
              type: "string",
              description: "Filename on the target (default: same as the source). Required when the name is already taken there.",
            },
          },
          required: ["from_entity", "file", "to_entity"],
        },
      },
    },
    execute: (call, ctx) => copyLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  move_lore_entity: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "move_lore_entity",
        description:
          "Rename a lore entity and/or move it to a different category. This is the ONLY way to change an entity's name or category — update_lore_file refuses both because the folder location is what the scanner trusts. On a rename the old name is kept as an alias by default so it still matches in already-written chapters (pass keep_old_name_as_alias=false when the old name was simply wrong), and the entity's folder is re-slugged to match — the result reports where it now lives. Moving many entries into one category needs only ONE plan step (target 'category', that category as `entity`, the entries in `members`) — call this once per entry against that single step, rather than proposing a step each. The previous index.md is backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            new_name: { type: "string", description: "New display name (omit to keep the current one)" },
            new_category: {
              type: "string",
              // Filled from the active profile — see profileCategoryParams below.
              enum: [],
              description:
                "Category to move the entity into — must exist (create_lore_category adds one only when none fits). Omit to keep the current one.",
            },
            keep_old_name_as_alias: {
              type: "boolean",
              description: "Default true — set false to drop the old name instead of aliasing it",
            },
          },
          required: ["entity"],
        },
      },
    },
    profileCategoryParams: ["new_category"],
    execute: (call, ctx) => moveLoreEntityTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_lore_entity: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "delete_lore_entity",
        description:
          "Remove a lore entity from the project. The entity's whole folder (including its images) is moved into .ai-writer/backups/ rather than erased, so the author can restore it. Use this for duplicates and abandoned entries. When MERGING two entities, the working order is: 1. carry everything worth keeping into the survivor (copy_lore_file for facet files and gallery images, edit/append for index.md content), 2. delete the loser, 3. only THEN add its name and aliases to the survivor with update_lore_meta add_aliases — the alias check refuses names that still resolve to a living entity, so aliases must come after the deletion.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            reason: {
              type: "string",
              description: "One line on why it is being removed, shown to the author in the execution log",
            },
          },
          required: ["entity"],
        },
      },
    },
    execute: (call, ctx) => deleteLoreEntityTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_memory: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_memory",
        description:
          "Replace the summary text of one story-memory segment of a document. Segment ranges are fixed — only the summary wording changes. Call read_memory first to see segment indices and current text. The previous memory file is backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            segment_index: {
              type: "number",
              description: "Zero-based segment index from read_memory",
            },
            summary: { type: "string", description: "The replacement summary text" },
          },
          required: ["path", "segment_index", "summary"],
        },
      },
    },
    execute: (call, ctx) => updateMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  // ── Facet split (lib/agent/splitTools) ──
  // "read" access is accurate, oddly enough: these two write nothing anywhere.
  // They collect the reorganization into the run's sink, and the author's
  // Apply in the split modal is what reaches disk.
  split_core: {
    access: "read",
    projectFree: true,
    definition: {
      type: "function",
      function: {
        name: "split_core",
        description:
          "Submit the slimmed-down CORE CARD of the entry being split — the part that stays in index.md. Call this once, before the facets. Calling it again replaces what you sent. Send only the body text; the entry's frontmatter is preserved for you.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Full body of the core card, moved verbatim from the entry. Never empty.",
            },
          },
          required: ["content"],
        },
      },
    },
    execute: splitCoreCall,
  },

  split_facet: {
    access: "read",
    projectFree: true,
    definition: {
      type: "function",
      function: {
        name: "split_facet",
        description:
          "Submit ONE facet of the entry being split — one outfit, one backstory arc, one set of relationships, one ability. Call it once per facet, never batching several into one call: each call is size-capped on its own, so a long facet can only ever cut short itself, and you can resend just that one. Re-sending a title already submitted REPLACES it, which is how you retry a call that came back truncated.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Facet name, e.g. \"Battle armor\". Also its identity when resending.",
            },
            slot: {
              type: "string",
              description:
                "Which slot of the category's type schema this facet fills, by id — the FACET SLOTS list in the prompt names them (a category may declare none, in which case leave this out). Omit it when the facet genuinely fits none; an id that isn't declared is refused.",
            },
            content: {
              type: "string",
              description: "The paragraphs this facet takes from the entry, moved verbatim.",
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description:
                "4-8 trigger words that make this facet inject: referring terms from the text, scene triggers, common synonyms. Each must pass \"if this word appears in prose, this facet is almost certainly relevant\". Without keys the facet never fires.",
            },
            group: {
              type: "string",
              description:
                "Mutual-exclusion group. Facets only one of which can be true at a time (outfits, forms, phase states) MUST share one, e.g. \"outfit\". Omit when the facet excludes nothing.",
            },
            priority: {
              type: "number",
              description: "Higher wins within a group; default 0.",
            },
          },
          required: ["title", "content", "keys"],
        },
      },
    },
    execute: splitFacetCall,
  },

  propose_edit: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "propose_edit",
        description:
          "Propose a change to a document file in the project. NOTHING is written until the author approves the proposal on a review card; the call blocks until they decide, and a rejection (with their reason) comes back so you can adjust. 'find' must be the EXACT text currently in the file. When it occurs more than once you have three ways to say which one you mean: make 'find' unique by including surrounding text, pass 'occurrence' to target the Nth (read_slides numbers an .html deck's slides for exactly this), or pass replace_all=true to change every one — that last is how a document-wide substitution is done WITHOUT rewrite_document. Propose one focused edit per call.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            find: {
              type: "string",
              description: "Exact existing text to replace (unique in the file)",
            },
            replace: { type: "string", description: "The replacement text" },
            occurrence: {
              type: "number",
              description:
                "1-based: which occurrence of 'find' to replace, when it appears more than once. Omit when 'find' is unique.",
            },
            replace_all: {
              type: "boolean",
              description: "Replace EVERY occurrence of 'find' in the file. Cannot be combined with 'occurrence'.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "find", "replace"],
        },
      },
    },
    execute: (call, ctx) => proposeEditTool(call.id, parseArgs(call.arguments), ctx),
  },

  rewrite_document: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "rewrite_document",
        description:
          "Replace the ENTIRE contents of a document file in the project. Use this for whole-document work that propose_edit cannot express — reformatting, normalising punctuation or indentation, restructuring headings — i.e. changes that touch text repeated throughout the file, and ONLY when the whole new body comfortably fits in one reply. For a long document use rewrite_lines instead, region by region: this tool carries the entire file as one argument, so on a long one the call is truncated and writes nothing. Also the way to overhaul an .html deliverable (keep it self-contained: inline CSS/JS, inline SVG, no external dependencies). For a single localised change, use propose_edit instead. You MUST read the whole file first (call read_file repeatedly until it stops reporting more lines): 'content' replaces everything, so anything you did not read is deleted. NOTHING is written until the author approves the card; the call blocks until they decide, and the previous version is backed up on approval.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            content: {
              type: "string",
              description: "The complete new file body — everything currently in the file is replaced by this",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => rewriteDocumentTool(call.id, parseArgs(call.arguments), ctx),
  },

  rewrite_lines: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "rewrite_lines",
        description:
          "Replace a RANGE OF LINES of a document with new text, leaving the rest of the file untouched. This is how a long file gets restructured or re-laid-out: read a region with read_file, send back only its replacement, repeat for the next region. Use it instead of rewrite_document whenever the file is long — rewrite_document carries the WHOLE new body in one call, so on a long document it runs past the output cap and a call cut off there writes nothing at all, losing everything you generated. You do NOT quote the old lines: give start_line and end_line (the numbers read_file and search_text report) and the tool reads that range itself. end_line past the last line means 'to the end of the file'; an empty 'content' deletes the range. NOTHING is written until the author approves the card; the call blocks until they decide. After each approved call the line numbers below the region have moved — re-read before naming the next range, or work from the bottom of the file upwards.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            start_line: {
              type: "number",
              description: "1-based first line to replace",
            },
            end_line: {
              type: "number",
              description: "1-based last line to replace (inclusive). Past the end of the file means 'to the end'.",
            },
            content: {
              type: "string",
              description:
                "The replacement text for those lines — only this region, never the whole file. An empty string deletes them.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "start_line", "end_line", "content"],
        },
      },
    },
    execute: (call, ctx) => rewriteLinesTool(call.id, parseArgs(call.arguments), ctx),
  },

  insert_lines: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "insert_lines",
        description:
          "Add lines to a document without re-sending anything already in it: headings over a wall of text, section breaks, blank lines. Send every insertion point in ONE call. They apply bottom-up, so the line numbers you read stay valid across the whole list — never compensate for your own shifts. Use this rather than rewrite_lines whenever nothing existing changes; rewrite_lines makes you re-type every line you keep. append_file adds at the very end. Nothing is written until the author approves the card; the call blocks until they decide.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            insertions: {
              type: "array",
              description: "Every insertion point, any order",
              items: {
                type: "object",
                properties: {
                  line: {
                    type: "number",
                    description: "1-based line to insert BEFORE (read_file's numbers)",
                  },
                  text: {
                    type: "string",
                    description:
                      "Lines to insert. A trailing newline is added; start with one to leave a blank line above.",
                  },
                },
                required: ["line", "text"],
              },
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "insertions"],
        },
      },
    },
    execute: (call, ctx) => insertLinesTool(call.id, parseArgs(call.arguments), ctx),
  },

  append_file: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "append_file",
        description:
          "Add text to the END of an existing file, leaving everything already in it untouched. This is how you write a file too large to emit in one reply: create_file the skeleton first, then append_file one section at a time — each call only has to carry its own section, so the file can grow past what a single response could ever hold. Nothing before the appended text is re-sent or re-read, so it cannot be damaged by a partial write. Use propose_edit to change text that is already there, and rewrite_document only when the whole file must be re-laid-out. NOTHING is written until the author approves the card; the call blocks until they decide. The card offers the author a per-file grant, so a long build does not mean a click per section.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the existing file, as returned by list_files",
            },
            content: {
              type: "string",
              description:
                "Text to add at the end. Start it with the newline(s) you want between the existing ending and this section — nothing is inserted for you.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => appendFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_chapter: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "create_chapter",
        description:
          "Propose a NEW chapter file anywhere in the project, with its opening text. NOTHING is written until the author approves the card; the call blocks until they decide. Give the full destination path — a subfolder that does not exist yet is created with it, which is how a new volume comes into being. Fails if something is already at that path: use propose_edit to change an existing chapter. A chapter created here lands at the end of its volume's order, which the author can rearrange in the outline view.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Full path of the new file, e.g. <project folder>/卷二/第31章.md. A missing extension becomes .md.",
            },
            content: {
              type: "string",
              description: "The chapter's starting text. Pass an empty string for a blank chapter.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => createChapterTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_file: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "create_file",
        description:
          "Propose a NEW file of any type — notes, data, config (e.g. .json, .csv, .txt), anywhere in the project. NOTHING is written until the author approves the card; the call blocks until they decide. The filename MUST carry an explicit extension: for manuscript text use create_chapter instead, which defaults to .md and enters the outline. Fails if something is already at that path. Parent folders that do not exist yet are created with the file. For a visual deliverable — a diagram, an architecture chart, a promo or landing page — write a SELF-CONTAINED .html file: all CSS and JS inline, graphics drawn as inline SVG, no external CDN or network dependencies. The approval card and the app preview render it live in a sandboxed offline frame, and the author can open it in their system browser. Relative <img> links resolve against the file's own folder.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the new file, extension included, e.g. <project folder>/资料/人物表.csv",
            },
            content: {
              type: "string",
              description: "The file's starting content. Pass an empty string for an empty file.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => createFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_directory: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "create_directory",
        description:
          "Propose a NEW empty folder anywhere in the project — a volume, a materials directory, any grouping. NOTHING is created until the author approves the card; the call blocks until they decide. Note that create_chapter/create_file already create missing parent folders on the way to a file — reach for this only when the folder itself is the point (e.g. preparing a structure before filling it).",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the new folder, e.g. <project folder>/素材/访谈记录",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => createDirectoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  move_chapter: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "move_chapter",
        description:
          "Propose renaming or moving ANY project file — a chapter, a note, a data file — or a whole folder; both are the same operation, expressed as a new full path. Renaming a folder carries everything inside it, and a document's illustration folder follows automatically. NOTHING is moved until the author approves the card. Fails if the destination already exists, so a move can never overwrite. Only manuscript files (.md/.markdown/.txt) default to .md when the destination has no extension — any other file's destination must spell out its extension. Propose one move per call.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Current full path of the file (or folder) to move",
            },
            new_path: {
              type: "string",
              description:
                "Full destination path, including the filename — not just the target folder",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "new_path"],
        },
      },
    },
    execute: (call, ctx) => moveChapterTool(call.id, parseArgs(call.arguments), ctx),
  },

  copy_file: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "copy_file",
        description:
          "Propose duplicating a file (or a whole folder) into a destination directory — e.g. drafting a variant of a chapter, or snapshotting material before a heavy edit. NOTHING is copied until the author approves the card. The copy keeps the source's name unless new_name renames it in the same step; if the name is taken in the destination, it is auto-numbered (\"稿 (1).md\") and the result reports where the copy actually landed. A copied document's illustration folder is duplicated with it, so the copy's pictures are its own. The destination directory must already exist (create_directory first if not).",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the file or folder to copy",
            },
            dest_dir: {
              type: "string",
              description: "Full path of the existing destination folder the copy lands in (the project folder itself is allowed)",
            },
            new_name: {
              type: "string",
              description:
                "Name for the copy (no paths). For a file it must carry the full filename including its extension; omit to keep the source's name.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "dest_dir"],
        },
      },
    },
    execute: (call, ctx) => copyFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  export_pptx: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "export_pptx",
        description:
          "Turn a project .html page into a PowerPoint file (.pptx) beside it. NOTHING is written until the author approves the card. Write the deck as HTML first with create_file, then call this — the conversion is deterministic code, not a model: it lays the page out in a browser and writes every box it measures as a PowerPoint shape, so text stays real editable text. Rules for an .html that converts well: ONE `<section class=\"slide\">` per slide, every slide the same fixed pixel size (1280x720 for 16:9); lay out however you like inside it (absolute, flex, grid all work — only the final measured layout matters); use SYSTEM fonts (PingFang SC / Microsoft YaHei / Arial / Helvetica / Georgia) because a web font cannot travel into a .pptx and PowerPoint will substitute it and shift the layout; keep text in real text elements rather than drawing it inside an SVG. What degrades: inline SVG becomes a picture (fine for diagrams), a gradient background becomes its average solid colour, and CSS filters, blend modes, shadows on text and animation are dropped. Put `data-pptx-skip` on anything decorative that should not become a shape. The result reports the slide count and everything that degraded — pass that on to the author.",
        parameters: {
          type: "object",
          properties: {
            html_path: {
              type: "string",
              description: "Full path of the .html page to convert",
            },
            out_path: {
              type: "string",
              description:
                "Full path for the .pptx. Omit to write it beside the page under the same name.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["html_path"],
        },
      },
    },
    execute: (call, ctx) => exportPptxTool(call.id, parseArgs(call.arguments), ctx),
  },

  export_docx: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "export_docx",
        description:
          "Turn a project markdown document into a Word file (.docx). NOTHING is written until the author approves the card. Write the document with create_file first, then call this: the conversion runs no model — headings, lists, quotes, tables and pictures are laid out by Word from a named format preset. NEVER put formatting in the markdown (no inline HTML, no '设成三号仿宋' notes, no manual page breaks): structure comes from the markdown, appearance from the preset. Omit `format_id` for the author's default — right unless they named a format. Maths, mermaid, lore citations and .webp/.svg pictures fall back to simpler forms; the result lists what did, so pass it on.",
        parameters: {
          type: "object",
          properties: {
            source_path: {
              type: "string",
              description: "Full path of the .md document to convert",
            },
            out_path: {
              type: "string",
              description:
                "Full path for the .docx. Omit to write it beside the document under the same name.",
            },
            format_id: {
              type: "string",
              description:
                "Id of a format preset. Omit for the author's default, which is almost always right.",
            },
            overrides: {
              type: "object",
              description:
                "ONLY for a change the author named for this one export; anything larger belongs in a preset. bodySize takes 三号 or 16; lineSpacing takes 固定值28磅 / 最小值20磅 / 1.5倍; firstLineChars is CHARACTERS (2 is the Chinese norm); marginsMm is [top, right, bottom, left].",
              properties: {
                bodyFontEastAsia: { type: "string" },
                bodyFontAscii: { type: "string" },
                bodySize: { type: "string" },
                lineSpacing: { type: "string" },
                firstLineChars: { type: "number" },
                marginsMm: { type: "array", items: { type: "number" } },
              },
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["source_path"],
        },
      },
    },
    execute: (call, ctx) => exportDocxTool(call.id, parseArgs(call.arguments), ctx),
  },

  export_xlsx: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "export_xlsx",
        description:
          "Turn a project markdown document's tables into an Excel workbook (.xlsx). NOTHING is written until the author approves the card. Write the tables with create_file first: each table becomes one sheet named by the heading above it. Cells are typed by deterministic rules — a bare number, a percentage, an ISO date and a cell starting with = become a real number, percentage, date and formula; a value carrying a unit ('12000元') or a leading zero stays text. So write bare values, and real =SUM(...) formulas where a total belongs. Text outside tables is left behind; the result lists the sheets and what was skipped.",
        parameters: {
          type: "object",
          properties: {
            source_path: {
              type: "string",
              description: "Full path of the .md document whose tables to convert",
            },
            out_path: {
              type: "string",
              description:
                "Full path for the .xlsx. Omit to write it beside the document under the same name.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["source_path"],
        },
      },
    },
    execute: (call, ctx) => exportXlsxTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_doc_format: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_doc_format",
        description:
          "Look up one layout format in full — margins, per-level headings, document grid — beyond the one-line summary in your briefing. Pass a preset id to inspect it, or the path of a .docx/.dotx the author wants copied: reading a Word file registers its layout as a format id you hand straight to export_docx. Use it when they name a template ('照这份来') or when a requirement the summary omits has to be checked. Only .docx/.dotx — a PDF or screenshot would be a guess.",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "A format preset id, or the full path of a .docx/.dotx in the project",
            },
          },
          required: ["target"],
        },
      },
    },
    execute: (call, ctx) => readDocFormatTool(call.id, parseArgs(call.arguments), ctx),
  },

  generate_image: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Draw a NEW picture and file it. This COSTS MONEY and is only for a picture that does not exist yet — to file one the project already has into an entity's gallery, use add_lore_image instead. Give either `entity` (goes into that lore entity's gallery) or `path` (a document in the project — the image is saved beside it and the markdown to place it comes back in the result, which you then position with propose_edit). The author reviews the prompt and its cost on a card before anything is generated, so write the prompt you actually want. Write prompts in concrete visual nouns — appearance, clothing, pose, setting, lighting, framing — never the subject's name, which the image model does not know. Read the entity or the passage first so the picture matches what is written. To keep a character or style consistent with existing pictures, pass their paths in `references` — the image model then sees them alongside the prompt.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The image prompt: what is visible. No names, no narrative.",
            },
            entity: {
              type: "string",
              description: "Lore entity whose gallery this belongs in, exactly as listed by list_lore_entities.",
            },
            path: {
              type: "string",
              description: "Full path of a .md document in the project, when the picture illustrates the text rather than an entity.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Existing images to send as visual references — a project path, or a gallery filename from read_lore_entity. Use for character/style consistency. Only works if the image model accepts input images.",
            },
            desc: {
              type: "string",
              description: "One line saying what the picture shows, in the author's language. Becomes the gallery description (or a document's alt text) — this is all a text-only model will ever see of it, and update_lore_image edits the same field later.",
            },
            slot: {
              type: "string",
              description:
                "With `entity` only: which image slot of its category the picture files into, by id (read_lore_entity lists them). Omit when it fits none — update_lore_image can classify it later.",
            },
            aspect: {
              type: "string",
              enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "16:9", "9:16", "21:9"],
              description: "Framing. Portraits lean vertical, scenes and banners horizontal.",
            },
            resolution: {
              type: "string",
              enum: ["1K", "2K", "4K"],
              description: "Resolution tier; default 1K. Higher costs more.",
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Quality tier (GPT-Image only; big price difference). Omit for default.",
            },
            negative: {
              type: "string",
              description:
                "What must NOT appear — 'watermark, extra fingers, blurry'. Comma-separated tags, never phrased as an instruction ('avoid X' draws X). Local ComfyUI models only; dropped for every other image model.",
            },
            reason: {
              type: "string",
              description: "One line for the approval card: why this picture, now.",
            },
          },
          required: ["prompt"],
        },
      },
    },
    execute: async (call, ctx) =>
      generateImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  edit_image: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "edit_image",
        description:
          "Redraw an existing image FILE in the project with a change applied — 'silver hair', 'three-quarter view', 'remove the background'. `source` is that file's path, as list_files spells it: a document illustration, reference art the author dropped in, anything on disk. A knowledge-base entry's gallery picture is NOT a file path — it belongs to an entry, so redraw_lore_image handles that one and this tool refuses it. The result is saved as a NEW file beside the source (or beside a document, with `path`) and the original is never overwritten. Blocks on the author's approval and costs money once approved. If the image model cannot edit, the result is regenerated from the instruction instead and the author is told — so prefer generate_image when you want a genuinely new picture rather than a variation of this one.",
        parameters: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Path of the image file to change, exactly as list_files spells it.",
            },
            instruction: {
              type: "string",
              description: "What to change about the picture.",
            },
            path: {
              type: "string",
              description: "File the result beside this .md document instead of beside the source — the markdown to place it comes back in the result, which you then position with propose_edit.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Extra images to send alongside the source — 'put her in this outfit', 'match this style'. A project path, or a gallery filename from read_lore_entity.",
            },
            aspect: {
              type: "string",
              enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "16:9", "9:16", "21:9"],
              description: "Recompose to this framing; omit to keep the original's.",
            },
            resolution: {
              type: "string",
              enum: ["1K", "2K", "4K"],
              description: "Resolution tier; omit for default.",
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Quality tier (GPT-Image only); omit for default.",
            },
            desc: {
              type: "string",
              description: "One line describing the new picture, used as its alt text when it is placed in a document.",
            },
            reason: {
              type: "string",
              description: "One line for the approval card: why this change.",
            },
            negative: {
              type: "string",
              description:
                "What must NOT appear in the result — 'watermark, extra fingers, blurry'. Comma-separated tags, never phrased as an instruction ('avoid X' draws X). Local ComfyUI models only; dropped for every other image model.",
            },
          },
          required: ["source", "instruction"],
        },
      },
    },
    execute: async (call, ctx) =>
      editImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  // Deliberately NOT in the `lore_write` group, unlike every other tool that
  // writes to an entity: that group is deferred until a lore *plan* is
  // approved, and a plan is the gate on changing what an entry SAYS. What this
  // one spends is the author's money, so its gate is the illustrate card —
  // exactly like generate_image filing a picture into the same gallery.
  redraw_lore_image: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "redraw_lore_image",
        description:
          "Redraw one picture in a knowledge-base entry's gallery with a change applied — 'silver hair', 'three-quarter view'. Call read_lore_entity first for the exact filename; a gallery picture is addressed by its entry plus that filename, never by a path. The result is filed as a NEW gallery picture inheriting the original's image slot, and the original is never overwritten. This is the gallery counterpart of edit_image, which takes a file path and handles every OTHER image in the project. To change only a picture's description or slot use update_lore_image — it draws nothing and costs nothing. Blocks on the author's approval and costs money once approved.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "The entry that owns the picture, exactly as listed by list_lore_entities.",
            },
            file: {
              type: "string",
              description: "Gallery filename, exactly as listed by read_lore_entity. A bare name, never a path.",
            },
            instruction: {
              type: "string",
              description: "What to change about the picture.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Extra images to send alongside the picture being changed — 'put her in this outfit', 'match this style'. A project path, or another gallery filename.",
            },
            aspect: {
              type: "string",
              enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "16:9", "9:16", "21:9"],
              description: "Recompose to this framing; omit to keep the original's.",
            },
            resolution: {
              type: "string",
              enum: ["1K", "2K", "4K"],
              description: "Resolution tier; omit for default.",
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Quality tier (GPT-Image only); omit for default.",
            },
            desc: {
              type: "string",
              description: "One line describing the new picture, for its gallery description — the same field update_lore_image edits. Defaults to the original's.",
            },
            reason: {
              type: "string",
              description: "One line for the approval card: why this change.",
            },
            negative: {
              type: "string",
              description:
                "What must NOT appear in the result — 'watermark, extra fingers, blurry'. Comma-separated tags, never phrased as an instruction ('avoid X' draws X). Local ComfyUI models only; dropped for every other image model.",
            },
          },
          required: ["entity", "file", "instruction"],
        },
      },
    },
    execute: async (call, ctx) =>
      redrawLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_chapter: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "delete_chapter",
        description:
          "Propose deleting ONE file — a chapter or any other project file. NOTHING is removed until the author approves the card, and on approval the file (with a document's illustration folder) is moved into .ai-writer/backups rather than erased, so it stays recoverable. Folders are refused — use delete_directory for those. When merging two chapters, propose_edit the surviving one FIRST, then delete the other.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full path of the chapter file to delete" },
            reason: {
              type: "string",
              description:
                "Why it should go, in the author's language — they decide from this line alone",
            },
          },
          required: ["path", "reason"],
        },
      },
    },
    execute: (call, ctx) => deleteChapterTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_directory: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "delete_directory",
        description:
          "Propose deleting a whole folder and EVERYTHING inside it. The heavyweight deletion: the card leads with the file count, the author must approve it individually EVERY time (a standing 本次都批准 grant never covers deletions), and on approval the entire folder is moved into .ai-writer/backups in one piece, so it stays recoverable. The project folder itself cannot be deleted. For a single file use delete_chapter.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full path of the folder to delete" },
            reason: {
              type: "string",
              description:
                "Why the whole folder should go, in the author's language — they decide from this line alone",
            },
          },
          required: ["path", "reason"],
        },
      },
    },
    execute: (call, ctx) => deleteDirectoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  task_plan: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "task_plan",
        description:
          "Initialize or rewrite the task goal and step checklist in the on-disk task workspace (task.md). Use this at the start of a multi-step task to establish a clear roadmap, then keep it updated with task_progress as you execute.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Clear title summarizing the task goal" },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "List of actionable steps to execute",
            },
          },
          required: ["title", "steps"],
        },
      },
    },
    execute: taskPlanTool,
  },

  task_progress: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "task_progress",
        description:
          "Update the task checklist in task.md. Use 'check' to mark a step done, 'start' to mark in-progress, 'skip' to skip, 'add_step' to append a new step, or 'log' to record a progress note. Call it the moment a step's state changes: 'start' right before you begin a step, 'check' as soon as it is finished. Never batch all the updates at the end of the task.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["check", "start", "skip", "add_step", "log"],
              description: "The progress action to perform",
            },
            step: {
              type: "integer",
              description: "1-indexed step number (required for check, start, skip)",
            },
            text: {
              type: "string",
              description: "Text content for add_step or log",
            },
          },
          required: ["action"],
        },
      },
    },
    execute: taskProgressTool,
  },

  write_note: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "write_note",
        description:
          "Save an intermediate finding, research note, or analysis to notes/<slug>.md in the task workspace. Returns the relative path. Use this before context is trimmed to keep crucial conclusions on disk.",
        parameters: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Short alphanumeric identifier for the note filename, e.g. search-nobles",
            },
            title: {
              type: "string",
              description: "Human-readable title for the note",
            },
            content: {
              type: "string",
              description: "Markdown content to save in the note",
            },
            sources: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of source URLs or file paths referenced",
            },
          },
          required: ["slug", "title", "content"],
        },
      },
    },
    execute: writeNoteTool,
  },

  read_note: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_note",
        description:
          "Read a saved note from the task workspace. Supports line-based pagination (up to 4000 chars per call).",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative note path (e.g. .ai-writer/tasks/<taskId>/notes/foo.md) or slug",
            },
            start_line: {
              type: "integer",
              description: "1-indexed line to start reading from (defaults to 1)",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: readNoteTool,
  },

  list_notes: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_notes",
        description:
          "List all saved notes in the active task workspace, including their slug, title, path, and size.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    execute: listNotesTool,
  },

  // ── Roleplay scenes (lib/roleplay/sceneTools) ──
  // Narrator-only, and read-only by construction: they reach transcript.md and
  // summary.md, never another agent's wire history. See the note on
  // ToolContext.scenes.
  list_scenes: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_scenes",
        description:
          "List the roleplay scenes in this project. Each character the author plays with has a *history* of scenes, not just a current one: this returns the current scene plus the archived ones, with their titles and dates. Call this first; every other scene tool takes an address from here. Addresses are <id> for the current scene or <id>#<n> for scene n. You are not in this list.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: (call, ctx) => listScenesTool(call.id, ctx),
  },

  read_scene: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_scene",
        description:
          "Read the verbatim transcript of one roleplay scene by turn range. Pass <id>#<n> to read an archived scene, or a bare <id> for the current one. Omit from/to to get the most recent turns. Prefer read_scene_summary first on a long scene, then read only the range that matters.",
        parameters: {
          type: "object",
          properties: {
            scene: { type: "string", description: "Scene address from list_scenes: <id> (current scene) or <id>#<n> (scene n)" },
            from: { type: "integer", description: "First turn number (1-based, inclusive). Omit for the latest window." },
            to: { type: "integer", description: "Last turn number (inclusive)." },
          },
          required: ["scene"],
        },
      },
    },
    execute: (call, ctx) => readSceneTool(call.id, parseArgs(call.arguments), ctx),
  },

  search_scenes: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "search_scenes",
        description:
          "Search every scene of every character — current and archived — in two layers at once. The verbatim layer searches transcript lines; the index layer searches scene recaps and the characters' memory areas, which is what finds an event the author is paraphrasing in their own words rather than quoting. Matching in both layers is literal and case-insensitive, so pass a distinctive word rather than a sentence. Both layers answer with a scene address you can hand to read_scene. This is how you find something from an earlier scene without reading everything.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to look for" },
            scene: { type: "string", description: "Restrict to one character (address from list_scenes; the #n part is ignored here). Omit to search all of them." },
          },
          required: ["query"],
        },
      },
    },
    execute: (call, ctx) => searchScenesTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_scene_summary: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_scene_summary",
        description:
          "Read one scene's summary — the cheap way to catch up before deciding which turns to read verbatim. Works on archived scenes too: pass <id>#<n>. Start here rather than pulling a whole transcript into context.",
        parameters: {
          type: "object",
          properties: { scene: { type: "string", description: "Scene address from list_scenes: <id> or <id>#<n>" } },
          required: ["scene"],
        },
      },
    },
    execute: (call, ctx) => readSceneSummaryTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_scene_memory: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_scene_memory",
        description:
          "Read what a character remembers, in two tiers: what is still binding on them right now (pacts, to-dos, events, bonds), and what has settled into their memory area from earlier scenes. Far cheaper than the transcript. Note that this is what the character *believes* — it can disagree with the manuscript, and it is not a source of fact for anything you write.",
        parameters: {
          type: "object",
          properties: {
            scene: { type: "string", description: "Address from list_scenes; memory belongs to the character, so the #n part is ignored here" },
            include_closed: {
              type: "boolean",
              description: "Include kept (done) and called-off (void) records",
            },
          },
          required: ["scene"],
        },
      },
    },
    execute: (call, ctx) => readSceneMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  // ── This agent's own conversation (lib/roleplay/conversationTools) ──
  // Scoped by construction: no agent id to pass, so they reach only the record
  // of the run's own conversation. See the note on ToolContext.conversation.
  search_conversation: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "search_conversation",
        description:
          "Search your own record of every scene you have been through with this person — the one you are in now and the earlier ones — including the parts you no longer remember word for word. Returns matching turn numbers with the matching line; read_conversation then gives you what was actually said around them. This is how you answer \"do you remember what we said back then\" instead of guessing. Matching is literal and case-insensitive: search a distinctive word that was actually spoken.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to look for, as it was said" },
            scene: {
              type: "integer",
              description: "Restrict to one of your scenes. Omit to search all of them, which is usually what you want.",
            },
          },
          required: ["query"],
        },
      },
    },
    execute: (call, ctx) => searchConversationTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_conversation: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_conversation",
        description:
          "Read your own record back, verbatim, by turn number — use it on the turns search_conversation pointed at. Omit scene to read the one you are in now; pass an earlier scene number to read a scene that has already ended. Omit from/to to re-read the most recent turns. The recent ones are usually still fresh in your mind; what this is for is the stretch that has faded. Turn numbers restart in every scene, so a turn number only means something together with its scene.",
        parameters: {
          type: "object",
          properties: {
            scene: {
              type: "integer",
              description: "Which of your scenes. Omit for the one you are in now.",
            },
            from: { type: "integer", description: "First turn number (1-based, inclusive). Omit for the latest window." },
            to: { type: "integer", description: "Last turn number (inclusive)." },
          },
        },
      },
    },
    execute: (call, ctx) => readConversationTool(call.id, parseArgs(call.arguments), ctx),
  },

  // ── Agent memory (lib/roleplay/memoryTools) ──
  // L1: applied without a card. The safety valve is that nothing can be
  // destroyed — see lib/roleplay/memory's three write rules.
  remember: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "remember",
        description:
          "Record something that will still matter many turns from now: a pact the two of you made, something you mean to do, an event that changed things, or a shift in how you feel about someone. This is your own private long-term memory and it survives context compaction, unlike the conversation itself. Do NOT record ordinary dialogue, atmosphere, or anything the knowledge base already says — a memory full of noise pushes the real commitments out.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["pact", "todo", "event", "bond", "note"],
              description: "pact = agreed with someone; todo = you intend to do it; event = it happened and changed things; bond = how you regard someone; note = anything else worth keeping",
            },
            title: { type: "string", description: "One line. This is what you see first when you look back." },
            body: { type: "string", description: "The detail: what exactly was agreed, what changed, why it matters." },
            subject: { type: "string", description: "Who or what this is about, if any." },
            keys: {
              type: "array",
              items: { type: "string" },
              description:
                "2-5 words that should bring this back to mind later: names, places, objects, " +
                "the promise itself. Use the words as they appear in the scene. Once this scene " +
                "ends, these are how you find this memory again.",
            },
          },
          required: ["kind", "title"],
        },
      },
    },
    execute: (call, ctx) => rememberTool(call.id, parseArgs(call.arguments), ctx),
  },

  revise_memory: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "revise_memory",
        description:
          "Update one memory record you already made — mark a pact kept (done) or called off (void), or rewrite how you now see someone. Records are never deleted; voiding one keeps its text. Call recall first if you need the ids.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Record id, e.g. m3" },
            body: { type: "string", description: "Replacement detail text" },
            status: { type: "string", enum: ["open", "done", "void"] },
          },
          required: ["id"],
        },
      },
    },
    execute: (call, ctx) => reviseMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  recall: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "recall",
        description:
          "Read your own memory records. The titles of the active ones are already in your context; the ones marked with an ellipsis have detail you have not been shown. Pass id to expand exactly one of them — that is the common case. Without an id it lists records, which is how you look further back: kept pacts, called-off agreements, or older ones that did not fit.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Expand one record by its id (the (m3) in your memory block). Everything else is ignored when this is given.",
            },
            kind: { type: "string", enum: ["pact", "todo", "event", "bond", "note"] },
            include_closed: { type: "boolean", description: "Include kept (done) and called-off (void) records" },
          },
        },
      },
    },
    execute: (call, ctx) => recallTool(call.id, parseArgs(call.arguments), ctx),
  },

  delegate: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "delegate",
        description:
          "Hand a context-heavy or capability-specific job to a specialist subagent " +
          "running on its own model. The subagent works in a separate context, writes " +
          "its full findings to a note file, and returns only a short summary plus the " +
          "note path — so its raw material never enters this conversation. Use it for " +
          "web research, reading images, reading PDF files, and digesting long documents.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["search", "vision", "longread", "pdf"],
              description:
                "search — look things up on the web; vision — describe or analyse images; " +
                "longread — read long text documents and presentations (.pptx) and report what matters; " +
                "pdf — read PDF files (refs must be .pdf paths; the only way to read a PDF's contents).",
            },
            task: {
              type: "string",
              description:
                "A complete, self-contained instruction. The subagent cannot see this " +
                "conversation, so state everything it needs to know.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description: "Paths the subagent should work on (documents, images, or PDF files).",
            },
          },
          required: ["kind", "task"],
        },
      },
    },
    execute: executeDelegate,
  },

  run_pack: {
    // "read" is honest here even though packs write: the dispatch itself puts
    // nothing on disk. Every write inside the sub-run still lands through its
    // own tool's tier — L2 blocks on the same approval card, L1 lore writes on
    // the same plan gate — because the child receives the parent's channel
    // objects themselves (tool-pack-plan D3). There is no write this tool can
    // reach that its caller's surface couldn't already.
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "run_pack",
        description:
          "Dispatch one self-contained WRITE job to a specialist agent carrying a focused toolset for it. " +
          "Packs: 'file_write' — create, edit or restructure project documents (md/txt/html); " +
          "'lore_edit' — create, update or reorganize knowledge-base entries, including their galleries (file an existing picture, retune or remove one); " +
          "'export' — convert documents to pptx/docx/xlsx. " +
          "The specialist cannot see this conversation: state the WHOLE job in 'task' — source paths, " +
          "target file or entry names, and the exact changes wanted — and list material files or note " +
          "paths in 'references'. Its writes go through the author's usual approval cards. " +
          "Reading, research and answering questions are YOUR job, never a pack's.",
        parameters: {
          type: "object",
          properties: {
            pack: {
              type: "string",
              enum: ["file_write", "lore_edit", "export"],
              description:
                "file_write — document work; lore_edit — knowledge-base work; export — file conversion.",
            },
            task: {
              type: "string",
              description:
                "A complete, self-contained brief. The pack agent cannot see this conversation, " +
                "so state everything it needs to do the whole job.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description: "Paths the pack should read: source documents and/or task note paths.",
            },
          },
          required: ["pack", "task"],
        },
      },
    },
    execute: executeRunPack,
  },

  translate: {
    // The `path` form writes a file, so it blocks on the author's approval like
    // every other L2 tool. The `text` form writes nothing — but a tool's tier is
    // its *ceiling*, and splitting one capability across two tiers to save an
    // approval on half of it is how a write tool ends up reachable without one.
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "translate",
        description:
          "Translate Japanese into Chinese with the author's dedicated translation model. " +
          "Give either `text` (a short passage — the translation comes back to you) or `path` " +
          "(a document in the project — it is translated chunk by chunk and saved as a NEW " +
          "<name>.zh.md beside it, which the author approves on a card; the original is never " +
          "touched). ONLY Japanese to Chinese — it cannot translate in any other direction or " +
          "between any other languages, and given Chinese it hands the text back barely changed " +
          "rather than failing. It reads no instructions: pass the source verbatim and nothing " +
          "else, because any wording you add comes back translated as part of the passage. Line " +
          "structure is preserved. Prefer this over translating Japanese yourself — the model is " +
          "trained on light novels and is markedly better at them.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "A short Japanese passage, verbatim. No instructions, no preamble, no framing. " +
                "Use `path` instead for anything longer than a page.",
            },
            path: {
              type: "string",
              description:
                "Full path of a Japanese document in the project. The translation is saved " +
                "beside it as <name>.zh.md; the call fails if that file already exists.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown on the approval card (path form only).",
            },
          },
        },
      },
    },
    execute: (call, ctx) => translateTool(call.id, parseArgs(call.arguments), ctx),
  },
};

/**
 * Copy a tool definition with everything category-dependent resolved from the
 * active profile: the `enum` of each parameter named in `profileCategoryParams`,
 * and any `{{categories}}` placeholder in the description.
 *
 * Copies rather than mutates: REGISTRY is shared across every run, and writing
 * into it would leave one project's categories in place after the author
 * switched profiles. Only the objects on the path being changed are cloned —
 * the untouched parameter schemas are shared, which is safe because nothing
 * else writes to them.
 */
function withProfileCategories(
  definition: ToolDefinition,
  params: readonly string[] | undefined,
): ToolDefinition {
  const describesCategories = definition.function.description.includes(CATEGORY_PLACEHOLDER);
  if (!describesCategories && !params?.length) return definition;

  const ids = loreCategoryIds();
  const fn = { ...definition.function };

  // A tool that names the categories in prose is as misleading as a wrong enum:
  // told "characters, world, …", a model asks for lore that doesn't exist here.
  // Rendered through `categoryRef` — `id(label)` — because the id alone is the
  // other half of that bug: a model that has never seen 「characters ＝ 人物」
  // answers a Chinese author by creating a duplicate category. This rides the
  // resident schema (~40 tokens for the default workspace), priced in
  // agentToolBudget.test.ts when the resident cap moved to 12,000.
  if (describesCategories) {
    const refs = loreCategories().map((c) => categoryRef(c, i18n.language === "zh-CN"));
    // split/join rather than replaceAll — the project's TS target predates it.
    fn.description = fn.description.split(CATEGORY_PLACEHOLDER).join(refs.join(", "));
  }

  const properties = definition.function.parameters.properties;
  if (params?.length && properties && typeof properties === "object") {
    const nextProperties: Record<string, unknown> = { ...(properties as Record<string, unknown>) };
    for (const name of params) {
      const schema = nextProperties[name];
      if (!schema || typeof schema !== "object") continue;
      nextProperties[name] = { ...(schema as Record<string, unknown>), enum: ids };
    }
    fn.parameters = { ...definition.function.parameters, properties: nextProperties };
  }

  return { ...definition, function: fn };
}

/**
 * Split a toolset into what the request carries from the start and what waits
 * for the run to earn it, preserving order within each part.
 *
 * Order matters twice over. It is what the model reads, and — on the Anthropic
 * family — it is the cached prefix (`lib/ai/anthropic.ts`): keeping the
 * resident tools in their original positions means a group loading mid-run
 * appends to the array rather than reshuffling it, so the cached prefix
 * covering the resident half survives the load.
 */
export function partitionByGroup(ids: readonly ToolId[]): {
  resident: ToolId[];
  deferred: Record<ToolGroup, ToolId[]>;
} {
  const resident: ToolId[] = [];
  const deferred: Record<ToolGroup, ToolId[]> = { lore_write: [], lore_organize: [] };
  for (const id of ids) {
    const group = REGISTRY[id].group;
    if (group) deferred[group].push(id);
    else resident.push(id);
  }
  return { resident, deferred };
}

/**
 * May one round's call to this tool run concurrently with its neighbours?
 *
 * The read tier — `delegate` included — is pure IO against its own inputs:
 * nothing it touches is mutated by another read, so a round of several may
 * overlap. Every write tool says no, and for two different reasons that both
 * matter: the L2 tools block on an approval card (two in flight is two stacked
 * cards, and editApply's occurrence count assumes the document does not move
 * between proposal and apply), and the L1 auto tools mutate the run's lore
 * snapshot and the disk under it. `access` is already the exact boundary, so
 * the answer is derived from it rather than kept as a second list to drift.
 *
 * Unknown names are safe by construction: `executeRegisteredTool` answers them
 * with error text without executing anything.
 */
export function isParallelSafeTool(name: string): boolean {
  const tool = (REGISTRY as Record<string, RegisteredTool | undefined>)[name];
  return !tool || tool.access === "read";
}

/**
 * Every tool id in the registry, in declaration order.
 *
 * Derived from `REGISTRY` rather than written out, so a sweep over "all tools"
 * cannot silently miss a new one — which is the whole value of the convention
 * checks in `agentToolConventions.test.ts`: a hand-copied list would be a list
 * that stops covering the tool added the day after it was written.
 */
export const ALL_TOOL_IDS = Object.keys(REGISTRY) as ToolId[];

/**
 * Whether `id` is fenced behind an open folder — see
 * {@link RegisteredTool.projectFree}. Exposed so the convention test can pin
 * the exemption list, which is the half of this rule a reviewer can't check.
 */
export function toolNeedsProject(id: ToolId): boolean {
  return !REGISTRY[id].projectFree;
}

/** Resolve wire definitions for a preset's toolset, preserving order. */
export function getToolDefinitions(ids: readonly ToolId[]): ToolDefinition[] {
  return ids.map((id) => {
    const tool = REGISTRY[id];
    return withProfileCategories(tool.definition, tool.profileCategoryParams);
  });
}

/**
 * Execute one model-requested tool call. Unknown tools and executor throws both
 * come back as error-text results — the model gets to read the error and retry,
 * and a single bad call never kills the run.
 */
export async function executeRegisteredTool(
  call: ToolCall,
  allowed: readonly ToolId[],
  ctx: ToolContext,
): Promise<ToolResult> {
  // Narrowed rather than asserted: `call.name` is whatever the model emitted,
  // so a double cast here would hand a `RegisteredTool` shape to something
  // that may be undefined.
  const isAllowed = (name: string): name is ToolId =>
    (allowed as readonly string[]).includes(name);
  const tool = isAllowed(call.name) ? REGISTRY[call.name] : undefined;
  if (!tool) return { toolCallId: call.id, content: `Unknown tool: ${call.name}` };
  // The fence (see RegisteredTool.projectFree). Here rather than in each
  // handler because it has to hold for the forty-odd that never thought about
  // it, and for the next one: this is the single door every model-requested
  // call comes through, on every surface, including a subagent's and a pack's.
  if (!tool.projectFree && !ctx.projectPath) {
    return {
      toolCallId: call.id,
      content: `Error: no folder is open, so ${call.name} has nothing to read or write. Do not call any other tool either — tell the author to open a folder first.`,
    };
  }
  try {
    // A copy, not a mutation: ctx is shared across a round's calls. Handlers
    // that patch run state do it through the objects ctx points at (the lore
    // snapshot, the plan gate), which the spread preserves by reference.
    return await tool.execute(call, { ...ctx, allowedTools: allowed });
  } catch (e) {
    return { toolCallId: call.id, content: `Error: ${String(e)}` };
  }
}
