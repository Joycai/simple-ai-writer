/**
 * The agent tool registry's types: every proposal kind an approval card can
 * show, the run's `ToolContext`, and the `RegisteredTool` / `ToolId` shape of
 * the table itself. Split out of `registry.ts` (docs/feature/code-structure-plan.md
 * P6) for size; `registry.ts` re-exports all of it, so importers keep
 * `from "./registry"`.
 */

import type { ToolDefinition } from "../ai/types";
import type { EditMatch, Insertion } from "./editApply";
import type { DocxOutline } from "../docx";
import type { LintFinding } from "../pptx/lint";
import type { DocFormat, DocFormatPreset, SpecRow } from "../docx/format";
import type { SheetSpec, SheetSummary } from "../xlsx/sheets";
import type { FormatChange, FormatOrigin } from "../docx/resolve";
import { type LoreEntityAddress, type LoreIndex, type LoreScope } from "../lore";
import { type ToolCall, type ToolResult } from "./tools";
import { type LorePlan, type PlanDecision, type PlanGate } from "./plan";
import type { ShellInfo } from "../cli/shell";
import type { DangerKind } from "../cli/command";
import type { ConvertExt } from "../import";
import { type SceneReader } from "../roleplay/sceneTools";
import { type AgentMemoryStore } from "../roleplay/memoryTools";
import { type ConversationReader } from "../roleplay/conversationTools";
import type { TaskWorkspaceHandle } from "./taskWorkspace";
import { type SplitSink } from "./splitTools";
import { type ReviewSink } from "../consistency/reviewTools";
import type { AiSettingsSnapshot, SubAgentKind } from "./subagentModel";
import type { AgentEvent, ToolProgress } from "./events";
import type { AgentRunResult, AgentRuntimeOptions } from "./runtime";
import type { TaskPreset } from "./presets";
import { type SearchableTools, type ToolSearchHandle } from "./toolSearch";
import type { AiConn } from "../ai/conn";


type ToolAccess = "read" | "write-auto" | "write-approval";

/** What every proposal carries, whatever it wants done. */
export interface ProposalBase {
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
   * Where each occurrence sits, in document order, with the line either side.
   *
   * `matches[i]` is occurrence `i+1`, so `target` indexes straight into it —
   * and `matches.length` is `occurrences` by construction, both being read off
   * the same scan of the file. The pair is kept rather than collapsed because
   * `occurrences` is what the apply step re-checks the document against, and a
   * safety count is not something to make a card's display data responsible
   * for.
   *
   * This is what lets an edit card say *where* the change lands. Before it,
   * only an edit that came from `rewrite_lines` could — the model had named a
   * range there, and everywhere else the card knew the text and not the place.
   */
  matches: EditMatch[];
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
 * The text being replaced rides along in `original`. The size delta computed
 * from it is the one number that catches the failure mode this kind introduces
 * — a rewrite composed from a partial read, silently truncating the document —
 * and the text itself is what lets a card show *which* passage a shrinking
 * rewrite dropped. It is already in hand when the proposal is built (the tool
 * has to read the file to compare), so carrying it costs a reference; pending
 * proposals live in memory for as long as the card is on screen and are never
 * persisted.
 */
export interface RewriteProposal extends ProposalBase {
  kind: "rewrite";
  /** Full new file body, replacing everything currently there. */
  content: string;
  /** The file's body at proposal time — what `content` replaces. */
  original: string;
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
  /**
   * A file's opening text, so the card can show what is about to go — a
   * deletion card that says only "3,042 字" is asking the author to authorise
   * a number. Absent for a folder, and for a file that could not be read
   * (still proposable: it exists, it is listed, it just cannot be shown).
   *
   * An excerpt rather than the whole body: the file is still on disk while the
   * card waits, so a surface that wants more can read it, and every other kind
   * of file in a project — a pasted book, a saved page — would otherwise ride
   * on a proposal whole.
   */
  excerpt?: string;
  /**
   * A folder's contents, capped — `fileCount` stays the true total, so a card
   * can say "and N more" without the list having to be complete. Absent when
   * the folder could not be listed.
   */
  entries?: DeleteEntry[];
  /** Sub-folders inside it, so the card can say the deletion goes deeper. */
  dirCount?: number;
  /** Lines in the file, for a card that shows only its opening. */
  lines?: number;
  /**
   * When the file last changed, ms since the epoch — the card's 「最后改于」.
   * Absent for a folder (its time moves only with its direct children, which
   * would say the wrong thing) and where the filesystem keeps none.
   */
  modifiedAt?: number;
  /**
   * Documents that link to this file, project-relative.
   *
   * The one fact about a deletion that cannot be established afterwards: the
   * text is in the backup and the size is on the log, but once the file is
   * gone its inbound links are just broken, and nobody knows they were whole.
   * Absent for a folder — its files carry their own.
   */
  backlinks?: string[];
  /**
   * The backlink scan stopped at its cap, so the list is a floor rather than a
   * total. The card has to say so: "no other document links to it" is a much
   * stronger claim than "none of the 600 I looked at".
   */
  backlinksPartial?: true;
}

/** One file inside a folder that is about to go. */
export interface DeleteEntry {
  /** Path relative to the deleted folder — its name is already on the card. */
  path: string;
  chars: number;
  /** Documents outside linking to it, project-relative. */
  backlinks?: string[];
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
  /**
   * The agent said this edit needs pixels outside a transparent source's
   * shape (a background, a wider scene), so its transparency must not be
   * kept. Only the explicit `false` is stored: keeping it is the default, and
   * it applies only where the model declares `caps.transparent` and the
   * source is a lone PNG with alpha (illustrate.ts).
   */
  keepTransparency?: false;
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
  /**
   * What the source says will not carry across (lib/pptx/lint) — found at
   * proposal time, like the slide count, because it needs no rendering. The
   * card shows it so the author approves knowing what the file will lack;
   * the apply report repeats it beside what the conversion itself degraded.
   */
  lint: LintFinding[];
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
  /**
   * Where that format came from — the card's headline, see `originName`. It is
   * deliberately the *short* name: the preset's own name and the override count
   * ride in `originNote` and the 改了 N 项 chip beside it, and repeating either
   * here reads as two different facts (设计稿 05f 屏 1j).
   */
  originKind: FormatOrigin["kind"];
  originLabel: string;
  /** The quiet right-hand note: 内置 · 未改动 / 未存为预设 / the preset's name. */
  originNote?: string;
  /** One parenthetical under the band — today only "N items Word defaulted". */
  originFootnote?: string;
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
 * Land a Word / Excel / PDF / PowerPoint file in the project as a markdown
 * document beside it — the write half of `read_document`.
 *
 * The conversion has already run when the card is raised (through the same
 * cache `read_document` reads from), so the card shows what will land and the
 * apply step copies that entry out rather than converting again: what was
 * approved and what lands are the same bytes even if the source moved on
 * (lib/import/materialize). The source is never touched; a name collision
 * numbers the new file. docs/feature/agent/document-read-plan.md §10.
 */
export interface ConvertProposal extends ProposalBase {
  kind: "convert";
  /** The office file. `path` is the intended `.md` beside it, before numbering. */
  sourcePath: string;
  ext: ConvertExt;
  /** The cache entry holding the finished conversion. */
  cacheDir: string;
  chars: number;
  pictures: number;
  /** A PDF whose text layer came out empty — a scan. The card says so. */
  scanned: boolean;
  /** The opening of the converted text, for the card. */
  excerpt: string;
}

/**
 * Transcribe an audio / video file in the project into a timestamped markdown
 * transcript beside it (lib/asr). The one proposal whose card comes *before*
 * the expensive step rather than after it: the transcription is the paid,
 * uploading, uncancellable action, so nothing has run when the card is raised
 * — the card carries only what the file header gives (size, a WAV's duration,
 * an estimate when the model row has a price). Approval runs upload → submit
 * → poll → write in the apply step, reporting the three stages through
 * `onApplyProgress`. docs/feature/asr/01-execution-plan.md §1 不变量 4.
 */
export interface TranscribeProposal extends ProposalBase {
  kind: "transcribe";
  /** The audio / video file. `path` is the intended `.md` beside it, after numbering. */
  sourcePath: string;
  /** Project-relative spelling of `sourcePath`, for the card. */
  sourceLabel: string;
  ext: string;
  bytes: number;
  /** Known before upload only for WAV; null means "billed by actual seconds once done". */
  seconds: number | null;
  /** The model row's per-second price; undefined = the usage page cannot price the run. */
  pricePerSecond: number | undefined;
  /** `seconds × pricePerSecond` when both exist. */
  estimate: number | null;
  /** This run's speaker diarization — the card's own switch may flip it before approval. */
  diarization: boolean;
  speakerCount?: number;
  languageHints?: string[];
  /**
   * The bound row uses the synchronous endpoint: nothing goes to temporary
   * storage, and the transcript comes back without timestamps or speakers —
   * the card says so and has no diarization switch.
   */
  sync?: boolean;
  /** The bound model's display name. */
  modelName: string;
}

/**
 * Run one shell command on the author's machine (lib/cli, the `run_command`
 * tool). Like `transcribe`, the card comes *before* the action: nothing has
 * run when it is raised, and approval is what starts the process. The card
 * shows `command` verbatim — it is the only thing between the model and the
 * author's account (docs/feature/agent/shell-command-plan.md §1 不变量 1–3).
 *
 * The command judgements `lib/cli/command` makes are computed before this
 * proposal: read-only lines never create one; compound/danger are carried so
 * the card and the counted-batch gate see the same answer for a write.
 */
export interface CommandProposal extends ProposalBase {
  kind: "command";
  /** The line, exactly as it will be handed to the shell. `path` is the cwd. */
  command: string;
  /** Project-relative spelling of the cwd, for the card (`.` = the root). */
  cwdLabel: string;
  timeoutMs: number;
  /** The shell it will run in — the card says so, next to the syntax. */
  shell: ShellInfo;
  /** `isCompound(command)`: separators, pipes, redirections, substitution. */
  compound: boolean;
  /** `looksDangerous(command)`: changes the card's face, never blocks. */
  danger: DangerKind | null;
  /**
   * The programs 「始终允许」 would add — exactly those this line lacks, and
   * only when adding them would let this very line through
   * (`allowlistCandidates`). Absent: the card offers no such button.
   */
  allowPrograms?: string[];
}

/**
 * An approved lore step that still stops before it is written (设计稿 02h 1g).
 *
 * The plan was the author's grant for the pass, and most of its steps land
 * without asking. Two do not: deleting an entry, and replacing most of an
 * entry's text (`agent/destructive`). The lore tool raises this card and does
 * the write itself once it hears yes — so approving applies nothing here, and
 * declining skips this one step while the rest of the plan stands.
 *
 * Never covered by a standing grant: it is not in `AUTO_APPROVABLE`, and the
 * plan being approved is exactly the grant this card exists to second-guess.
 */
export interface LoreStepProposal extends ProposalBase {
  kind: "loreStep";
  trigger: "deleteEntity" | "majorRewrite";
  entity: string;
  category: string;
  /** The plan step's own sentence — what the author approved, word for word. */
  detail: string;
  /** 1-based position among the run's approved steps, and how many there are. */
  stepNumber: number;
  stepTotal: number;
  /** majorRewrite: which file of the entry. */
  file?: string;
  /** majorRewrite: the texts, when small enough to carry (`CHANGE_TEXT_CHARS`). */
  before?: string;
  after?: string;
  /** majorRewrite: the body's length, and how much of it the write removes. */
  originalChars?: number;
  removedChars?: number;
  /** deleteEntity: the entry's files, capped, each with its opening line. */
  files?: { name: string; chars: number; head: string }[];
  totalChars?: number;
  fileCount?: number;
  /** deleteEntity: documents that cite the entry, project-relative. */
  citedBy?: string[];
  /** The citation scan hit its cap, so `citedBy` is a floor. */
  citedPartial?: true;
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
  | XlsxProposal
  | ConvertProposal
  | TranscribeProposal
  | CommandProposal
  | LoreStepProposal;

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
  /**
   * 改名与删除都改写**成员条目的 frontmatter**（集合的 id 就是它的名字），所以
   * 两者都交回真的动过的那几条地址——调用方拿它回灌运行快照。空数组＝这个集合
   * 一个成员都没有，不是失败。
   */
  renameCollection: (from: string, to: string) => Promise<LoreEntityAddress[]>;
  deleteCollection: (name: string) => Promise<LoreEntityAddress[]>;
  /** 把条目（按 dirPath）归入 / 移出集合；同样交回真的动过的那几条。 */
  file: (dirPaths: string[], add: string[], remove: string[]) => Promise<LoreEntityAddress[]>;
  /** 新建分类，传作者能读的标签，返回真正落成的 id。 */
  createCategory: (label: string) => Promise<string>;
  /**
   * **作者自建**的分类 id。改名和删除只对这些生效：能力包带来的分类属于那个包
   * （去掉它得整包关掉），孤儿文件夹压根没有声明可改。写成 getter，理由同
   * `collections`——同一次运行里刚建的分类，下一句就要能改名。
   */
  userCategories: string[];
  /**
   * 改分类的**标签**。id 就是磁盘上的文件夹名，这里一个字都不碰它，所以没有任何
   * 条目搬家、没有 `[[lore:分类/id]]` 失效、没有置顶要重指——这是分类改名和
   * 「把条目换个分类」代价完全不同的地方。
   */
  renameCategory: (id: string, label: string) => Promise<void>;
  /**
   * 把分类的**声明**从 profile.json 摘掉。磁盘上的文件夹一动不动，所以调用方必须
   * 先确认它是空的：留着成员就等于把一整个分类降级成孤儿（标签退化成文件夹 id），
   * 而那是作者该亲眼看着做的事。
   */
  deleteCategory: (id: string) => Promise<void>;
}

/**
 * How a tool starts a nested agent run. The runtime fills it for every run it
 * starts (`runAgent` itself, and the toolCost seam a sub-run sizes its message
 * ceiling with). `delegate` and `run_pack` take it from here rather than
 * importing `runtime` / `toolCost`, because both of those import this
 * registry — a direct import closes an import cycle through the one table
 * every tool lives in (docs/feature/code-structure-plan.md P2).
 */
export interface SubRunner {
  run: (opts: AgentRuntimeOptions) => Promise<AgentRunResult>;
  messageCeilingForTools: (
    contextSize: number | undefined,
    utilization: number,
    tools: readonly ToolId[],
    residentGroups?: TaskPreset["residentGroups"],
  ) => number;
}

/**
 * Live app state a tool reads at call time — the author's AI settings and the
 * .docx format list — plus the two notices a tool sends the other way.
 * Injected by the store that starts the run (`stores/toolAppState.ts`),
 * because `lib/` never imports `stores/`: each of these used to be an
 * `await import` of a store from inside a tool, which is how aiStore ended up
 * inside the agent subsystem's import cycle
 * (docs/feature/code-structure-plan.md P3). Getters, not values: a tool reads
 * the settings as they are when it runs, the same moment the store read did.
 */
export interface ToolAppState {
  aiSettings: () => AiSettingsSnapshot;
  /** docFormatStore's list and default — what `export_docx` resolves `format_id` against. */
  docFormats: () => { presets: DocFormatPreset[]; defaultId: string };
  /** Park a format read from a .docx in this session's list (docFormatStore.addImitated). */
  addImitatedFormat: (preset: DocFormatPreset) => void;
  /**
   * `manage_category`'s `describe` just wrote `lore/<id>/index.md`. The
   * category note is not on `LoreIndex`, so no rescan carries it; this is how
   * the wall's cached summary line learns to re-read (loreStore.categoryNotes).
   */
  categoryNoteWritten: (categoryId: string) => void;
}

/** Everything an executor may need about the running project. */
export interface ToolContext {
  projectPath: string;
  loreIndex: LoreIndex;
  /**
   * {@link ToolAppState}. Absent on surfaces whose presets carry none of the
   * tools that read it (lore modals, the splitter); a tool reached without it
   * says so instead of guessing.
   */
  appState?: ToolAppState;
  /**
   * Nested runs ({@link SubRunner}). Set by `runAgent` on the context it hands
   * its tools, so every caller gets it without passing it; absent only when a
   * tool is executed outside a run (tests), where the tools that need it fail
   * with a message instead of reaching for the runtime.
   */
  subRun?: SubRunner;
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
   * Whether a usable vision subagent reads pictures for this run — from
   * `routeTools`, which is also what stripped `read_image` / `read_lore_image`
   * from the toolset.
   *
   * Read tools use it to keep a *listing* honest about who can open what it
   * lists. `multimodal` alone cannot: with vision live it is the wrong model's
   * property — a text-only main model behind a multimodal vision subagent said
   * "text descriptions only", and the run then never asked for the picture the
   * author had switched a subagent on to read.
   */
  visionDelegate?: boolean;
  /**
   * Whether the search subagent this run delegates to can open a web page
   * itself (its model declares `web_extractor`) — from `routeTools`, like
   * `visionDelegate`. Read when the definitions are handed out: `delegate`'s
   * description offers "read this URL" only when it is true, so the main model
   * (whose own server tools routing withheld) knows where a link goes.
   */
  searchReadsPages?: boolean;
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
   *
   * `changed` names the entities a write stayed inside of — a body edit, a
   * facet, a gallery picture, or the N entries one filing call re-tagged — so
   * the surface can re-read those folders alone (`loreStore.refreshEntities`)
   * instead of walking the whole knowledge base, which is what a full rescan
   * costs after *every* write call. Omitted when the write changed what
   * entities exist or where (create / move / delete / pack runs): those need
   * the walk. A surface may ignore the hint and rescan.
   */
  onLoreChanged?: (
    changed?: LoreEntityAddress | LoreEntityAddress[],
  ) => LoreIndex | void | Promise<LoreIndex | void>;
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
  /**
   * Collector for a 一致性检查 window (lib/consistency/reviewTools). Same
   * contract as `splitSink`: nothing on disk, the panel reads the sink live.
   * Absent means this surface is not a check, and report_* refuse.
   */
  reviewSink?: ReviewSink;
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
   * The run's handle for loading the `file_ops` / `image` groups on request —
   * injected by `runAgent` when the run has any of them, absent otherwise.
   */
  toolSearch?: ToolSearchHandle;
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
 * `file_ops` and `image` are the other kind: no gate, just rarely needed. The
 * model loads those itself through `search_tools` (see ./toolSearch, and
 * agent-tool-context-lld.md §6 for why that indirection was reopened).
 *
 * A tool with no group is resident — the default, and what every tool was
 * before this existed.
 */
export type ToolGroup = "lore_write" | "lore_organize" | "file_ops" | "image";

/** What a `describe` may depend on besides the machine: the run's own shape. */
export interface DescribeContext {
  /** The searchable groups this run carries — see ./toolSearch. */
  searchable: SearchableTools;
  /** `ToolContext.searchReadsPages` for this run — `delegate`'s description reads it. */
  searchReadsPages: boolean;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  /**
   * A description computed when the definitions are handed out, replacing
   * `definition.function.description`. For tools whose right wording depends
   * on the machine or the run: `run_command` names the shell it will actually
   * run in, `delegate` offers page reading only when the search subagent can
   * do it — neither is knowable at import. Same reason `profileCategoryParams`
   * exists — this registry is a module constant, the world is not.
   */
  describe?: (ctx: DescribeContext) => string;
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
  | "manage_category"
  | "set_lore_avatar"
  | "copy_lore_file"
  | "move_lore_entity"
  | "delete_lore_entity"
  | "update_memory"
  | "split_core"
  | "split_facet"
  | "report_issue"
  | "report_pass"
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
  | "convert_document"
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
  | "translate"
  | "transcribe_audio"
  | "run_command"
  | "search_tools";
