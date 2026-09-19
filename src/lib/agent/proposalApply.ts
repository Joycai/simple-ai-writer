/**
 * Carrying out an approved proposal: the write half of every L2 card.
 *
 * The pure text transforms are `editApply.ts`; this is where they meet the
 * disk — backup first, then through the open editor when the target is the
 * file on screen (so unsaved typing is kept and the change shows at once),
 * straight to disk otherwise — and where the kinds whose approval *is* the
 * work (illustrate, transcribe, command, the three exports) run.
 *
 * Moved out of `agentStore` (docs/feature/code-structure-plan.md P5). What it
 * needs from the app — the project, the open editor, the file tree, the AI
 * settings, the lore index — comes in as {@link ProposalApplyDeps}, because
 * `lib/` does not import `stores/`; the store builds those from its
 * neighbours. Getters, not values: each is read at the moment the apply
 * reaches it, exactly as the store reads were.
 */

import i18n from "../../i18n";
import { backupFile } from "./backup";
import { applyFindReplace, applyInsertions } from "./editApply";
import type { ToolProgress } from "./events";
import type { TurnExport } from "./chatSession";
import type {
  AppendProposal, EditProposal, InsertProposal, Proposal, RewriteProposal,
} from "./registry";
import type { AiSettingsSnapshot } from "./subagentModel";
import { formatLintFindings } from "../pptx/lint";
import { parentDir } from "../context/outline";
import { readFile, writeFile } from "../fs/fileio";
import { isSamePath } from "../paths";
import type { LoreEntityAddress, LoreIndex } from "../lore";

/** What an apply reads from the app, handed in by the store that approves. */
export interface ProposalApplyDeps {
  projectPath: () => string | null;
  /** The file the author has open (projectStore.activeFilePath). */
  activeFilePath: () => string | null;
  /** The open editor's buffer — writes to the open file go through it. */
  editor: () => { content: string; setContent: (content: string) => void; saveNow: () => Promise<void> };
  /** projectStore's entry operations (they keep the open document pointed at a moved file). */
  entries: () => {
    createEntry: (parentDir: string, name: string, type: "file" | "folder", content?: string) => Promise<string>;
    moveEntry: (from: string, to: string) => Promise<void>;
    copyEntry: (from: string, destDir: string, isDir: boolean, newName?: string) => Promise<string>;
    deleteEntry: (path: string, isDir: boolean, opts?: { backup?: boolean }) => Promise<string | null>;
  };
  /** Anything written with the raw byte writer is invisible to the tree until this runs. */
  refreshFileTree: () => Promise<void>;
  aiSettings: () => AiSettingsSnapshot;
  lore: () => {
    index: LoreIndex;
    refreshEntity: (projectPath: string, target: LoreEntityAddress) => Promise<void>;
    scanProject: (projectPath: string) => Promise<void>;
  };
}

/**
 * Put a change that went through the open editor on disk now, not in two
 * seconds. Everything after an approval reads the file back — the write
 * receipt's line echo, the log's change record and its fingerprint — and a
 * debounced save hands all three the text from before the change: a diff that
 * says nothing happened, and an undo that later refuses because the file
 * "changed after" the write. A failed save is logged by the store and retried
 * on the next edit; the change is in the buffer either way.
 */
export async function flushEditor(editor: { saveNow: () => Promise<void> }): Promise<void> {
  await editor.saveNow().catch(() => {});
}

/**
 * Apply an approved edit. Returns the pre-write backup path.
 *
 * The find text is re-located at apply time rather than trusting the offset the
 * proposal was built from: the author may have kept typing while the card sat
 * there, and silently writing at a stale position would corrupt the passage.
 */
async function applyEdit(proposal: EditProposal, deps: ProposalApplyDeps): Promise<string | null> {
  const projectPath = deps.projectPath();
  const activeFilePath = deps.activeFilePath();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  // Which occurrence(s), and what to do when the file has moved on, are
  // `agent/editApply`'s job — the same reasoning as rag.ts's resolveEditRange
  // (repeated lines are ordinary in a draft, so writing at "wherever it happens
  // to appear first" would change text the author never approved), generalised
  // to the targeted edits propose_edit can now make.
  const rewrite = (text: string): string =>
    applyFindReplace(text, proposal.find, proposal.replace, proposal.occurrences, proposal.target);

  if (isSamePath(activeFilePath, proposal.path)) {
    // The file is open — go through the editor so unsaved edits are kept
    // and the change is visible (and autosaved) immediately.
    const { content, setContent } = deps.editor();
    setContent(rewrite(content));
    await flushEditor(deps.editor());
  } else {
    await writeFile(proposal.path, rewrite(await readFile(proposal.path)));
  }
  return backupPath;
}

/**
 * Apply an approved whole-file rewrite. Returns the pre-write backup path.
 *
 * Unlike applyEdit there is nothing to re-locate — the proposal is the entire
 * new file — so the author's concurrent typing cannot be detected, only
 * overwritten. The backup is therefore load-bearing rather than a courtesy,
 * and it is taken before anything is written.
 */
async function applyRewrite(proposal: RewriteProposal, deps: ProposalApplyDeps): Promise<string | null> {
  const projectPath = deps.projectPath();
  const activeFilePath = deps.activeFilePath();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  if (isSamePath(activeFilePath, proposal.path)) {
    // Same reason as applyEdit: go through the editor so the change is visible
    // and autosaved rather than being clobbered by the open buffer on next save.
    deps.editor().setContent(proposal.content);
    await flushEditor(deps.editor());
  } else {
    await writeFile(proposal.path, proposal.content);
  }
  return backupPath;
}

/**
 * Apply an approved append. Returns the pre-write backup path.
 *
 * Reads the file *now* rather than trusting the length the proposal recorded:
 * the author may have kept typing while the card sat there, and an append is
 * the one write where that is harmless — whatever they added stays, and the
 * new section lands after it. The recorded length is only the card's "grew
 * from" figure, never a precondition.
 */
async function applyAppend(proposal: AppendProposal, deps: ProposalApplyDeps): Promise<string | null> {
  const projectPath = deps.projectPath();
  const activeFilePath = deps.activeFilePath();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  if (isSamePath(activeFilePath, proposal.path)) {
    // Same reason as applyEdit/applyRewrite: through the editor, so the open
    // buffer doesn't overwrite the append on its next autosave.
    const { content, setContent } = deps.editor();
    setContent(content + proposal.content);
    await flushEditor(deps.editor());
  } else {
    const raw = await readFile(proposal.path);
    await writeFile(proposal.path, raw + proposal.content);
  }
  return backupPath;
}

/**
 * Apply approved insertions. Returns the pre-write backup path.
 *
 * The recorded line count is passed through to be re-checked against the file
 * as it stands now — `applyInsertions` owns that refusal, exactly as
 * `applyFindReplace` owns the occurrence check `applyEdit` relies on. The
 * author may have kept typing while the card sat there, and every line number
 * on that card points somewhere else the moment they did.
 */
async function applyInsert(proposal: InsertProposal, deps: ProposalApplyDeps): Promise<string | null> {
  const projectPath = deps.projectPath();
  const activeFilePath = deps.activeFilePath();
  const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

  const splice = (text: string): string =>
    applyInsertions(text, proposal.insertions, proposal.lineCount);

  if (isSamePath(activeFilePath, proposal.path)) {
    // Same reason as applyEdit: through the editor, so unsaved work survives
    // and the change is visible and autosaved at once.
    const { content, setContent } = deps.editor();
    setContent(splice(content));
    await flushEditor(deps.editor());
  } else {
    await writeFile(proposal.path, splice(await readFile(proposal.path)));
  }
  return backupPath;
}

/**
 * What an applied proposal reports.
 *
 * `report` is what the model is told (historically just a backup path, hence
 * the field it travels back in). `imagePath` is carried separately rather than
 * scraped out of that prose — the wording is for a reader, and parsing it
 * would silently break the transcript the next time it is reworded.
 */
interface ApplyOutcome {
  report: string | null;
  imagePath?: string;
  /** Where a copy actually landed (collision auto-numbering decides at apply time). */
  resultPath?: string;
  /**
   * An export that finished, for the turn to keep (设计稿 05f 屏 1k). Carried
   * separately from `report` for the same reason `imagePath` is: that prose is
   * addressed to the model, and reparsing it would break the author's card the
   * next time it is reworded.
   */
  exportSummary?: TurnExport;
}

/**
 * Carry out what an approved proposal asked for. Throwing here is how a failure
 * reaches the model as a rejection — never swallow one and report success.
 */
export async function applyProposal(
  proposal: Proposal,
  deps: ProposalApplyDeps,
  signal?: AbortSignal,
  onProgress?: (p: ToolProgress) => void,
): Promise<ApplyOutcome> {
  const { createEntry, moveEntry, deleteEntry, copyEntry } = deps.entries();

  switch (proposal.kind) {
    case "edit":
      return { report: await applyEdit(proposal, deps) };

    case "rewrite":
      return { report: await applyRewrite(proposal, deps) };

    case "append":
      return { report: await applyAppend(proposal, deps) };

    case "insert":
      return { report: await applyInsert(proposal, deps) };

    case "create": {
      const dir = parentDir(proposal.path);
      const name = proposal.path.slice(dir.length + 1);
      await createEntry(dir, name, proposal.isDir ? "folder" : "file", proposal.content);
      return { report: null }; // nothing existed to back up
    }

    case "move":
      await moveEntry(proposal.path, proposal.newPath);
      return { report: null }; // the file still exists, at its new path

    case "copy":
      // The source is untouched; the interesting fact is where the copy
      // landed, which collision auto-numbering decides only now.
      return {
        report: null,
        resultPath: await copyEntry(proposal.path, proposal.destDir, proposal.isDir, proposal.newName),
      };

    case "convert": {
      // The conversion already ran when the card was raised; this copies that
      // exact entry out of the cache beside the source (lib/import/materialize).
      const { materializeConversion } = await import("../import/materialize");
      const landed = await materializeConversion(proposal.sourcePath, proposal.cacheDir);
      // Written with the raw file writer — the tree needs telling.
      await deps.refreshFileTree();
      return {
        resultPath: landed,
        report: [
          `Converted ${proposal.sourcePath} to ${landed} (${proposal.chars} characters; the original is untouched).`,
          proposal.pictures > 0
            ? `${proposal.pictures} picture(s) extracted to the document's assets/ folder, linked from the text.`
            : "",
          proposal.scanned
            ? "NOTE: this PDF had no text layer (a scan), so the document holds page pictures and no text. Say so to the author."
            : "",
        ].filter(Boolean).join("\n"),
      };
    }

    case "loreStep":
      // Approval is the whole act: the lore tool that raised the card does the
      // write itself once it hears yes (writeTools `pauseForStep`), with its
      // own backup — there is nothing to apply or back up on this side.
      return { report: null };

    case "command": {
      // Like `transcribe`: nothing has run yet, and approval is what starts
      // the process. The runner owns the abort → kill wiring and the log; the
      // tool row gets a once-a-second elapsed label so a long command reads as
      // running rather than hung (docs/feature/agent/shell-command-plan.md §3.7).
      const { runCommand } = await import("../cli/run");
      const outcome = await runCommand({
        projectPath: deps.projectPath() ?? "",
        command: proposal.command,
        cwd: proposal.path,
        timeoutMs: proposal.timeoutMs,
        signal,
        onTick: (ms) =>
          onProgress?.({ label: i18n.t("ai.approval.commandRunning", { s: Math.round(ms / 1000), defaultValue: "运行中 · {{s}} 秒" }) }),
      });
      return { report: outcome.report };
    }

    case "transcribe": {
      // The opposite of `convert`: nothing has run yet. Approval *is* the
      // paid step — upload, submit, poll, write — and the three stages report
      // through `onProgress` so the tool row shows where the wait is
      // (docs/feature/asr/01-execution-plan.md §5).
      const asr = await import("../asr");
      const conn = await asr.resolveAsrConn(deps.aiSettings());
      if (asr.isAsrUnavailable(conn)) throw new Error(conn.error);
      const { formatBytes, formatClock } = asr;
      const label = (p: import("../asr").TranscribeProgress): string => {
        switch (p.phase) {
          case "reading": return "读取中";
          case "uploading": return `上传中 · ${formatBytes(proposal.bytes)}`;
          case "queued": return "排队中";
          case "running": return p.polls ? `识别中 · 第 ${p.polls} 次查询` : "识别中";
          case "downloading": return "取回结果";
        }
      };
      const outcome = await asr.transcribeFile({
        projectPath: deps.projectPath() ?? "",
        sourcePath: proposal.sourcePath,
        conn,
        options: {
          diarization: proposal.diarization,
          ...(proposal.speakerCount ? { speakerCount: proposal.speakerCount } : {}),
          ...(proposal.languageHints?.length ? { languageHints: proposal.languageHints } : {}),
        },
        onProgress: (p) => onProgress?.({ label: label(p) }),
        signal,
      });
      const { isAsrTimestampsEnabled } = asr;
      const landed = await asr.writeTranscript(proposal.sourcePath, outcome.transcript, {
        modelId: conn.modelId,
        timestamps: isAsrTimestampsEnabled(),
        speakers: proposal.diarization,
      });
      await deps.refreshFileTree();
      {
        const projectPath = deps.projectPath();
        if (projectPath) await asr.recordTranscriptionUsage(projectPath, conn.model, outcome);
      }
      const seconds = outcome.billedSeconds ?? Math.round(outcome.transcript.durationMs / 1000);
      return {
        resultPath: landed,
        report: [
          `Transcribed ${proposal.sourcePath} to ${landed} (${formatClock(outcome.transcript.durationMs)}, ${outcome.transcript.sentences.length} sentences${outcome.transcript.speakers ? ", speakers labelled" : ""}). Read it with read_file.`,
          outcome.cached ? "Served from the transcription cache — the file had been transcribed before with the same settings, so nothing was billed." : `Billed ${seconds} seconds of audio.`,
          ...(asr.speakersMissing(proposal.diarization, outcome.transcript)
            ? ["Speaker separation was requested, but the result carries no speaker labels — the endpoint ignored it. Tell the author the transcript is unlabelled; do not retry, the same request gets the same answer."]
            : []),
        ].join("\n"),
      };
    }

    case "delete":
      // The backup is what makes an approved deletion recoverable, so it is
      // not optional. The entry — file or folder — is renamed into backups whole.
      return { report: await deleteEntry(proposal.path, !!proposal.isDir, { backup: true }) };

    case "illustrate": {
      // The only kind whose "apply" spends money and calls out to a provider.
      // Approving is the author paying, so it happens here rather than at
      // proposal time — a rejected card costs nothing.
      const { runIllustration } = await import("../image/illustrate");
      const root = deps.projectPath();
      const outcome = await runIllustration(proposal, root ?? "", deps.aiSettings(), signal, onProgress);
      if (proposal.dest.kind === "lore") {
        // The gallery grew — refresh so the entity view shows it at once.
        // Awaited: this function's caller reports the outcome to the model, and
        // an unawaited refresh makes "saved" race the index that proves it.
        // One folder when the index still knows it; the walk otherwise (the
        // proposal carries the folder, not the entry, and only the walk can
        // place a folder the index has lost track of).
        if (root) {
          const lore = deps.lore();
          const dir = proposal.dest.entityDir;
          const entity = Object.values(lore.index).flat().find((e) => e.dirPath === dir);
          if (entity) await lore.refreshEntity(root, entity);
          else await lore.scanProject(root);
        }
      } else {
        // Same reason the pptx case below refreshes: the picture is written
        // with the raw byte writer, which the file tree knows nothing about, so
        // without this it stays invisible in the sidebar until something else
        // happens to refresh — and the author is told a file exists that they
        // cannot see.
        await deps.refreshFileTree();
      }
      // Reported back to the model through backupPath (see the shared apply
      // contract): the document case needs the markdown to place next, and
      // every case needs to know whether an edit was silently regenerated.
      return {
        imagePath: outcome.path,
        report: [
          `Saved to ${outcome.path}.`,
          // Without this the assistant apologises for being unable to show the
          // picture it just made — it has no other way to know the app has
          // already put it in the transcript.
          "This picture is shown to the author in the conversation, so do not say you cannot display it — just say what you made and offer the next step.",
          outcome.markdown
            ? `Place it with propose_edit using exactly:\n${outcome.markdown.trim()}`
            : "",
          outcome.degraded
            ? "NOTE: this model cannot edit an existing picture, so it was regenerated from the instruction — it will not resemble the original. Tell the author."
            : "",
        ].filter(Boolean).join("\n"),
      };
    }

    case "pptx": {
      // Applied here rather than in the tool for the same reason `illustrate`
      // is: the work needs something the tool loop does not have. There it was
      // the author's money; here it is a DOM — the page has to be laid out by
      // a real browser before anything can be measured (lib/pptx).
      const { exportHtmlToPptx } = await import("../pptx");
      const outcome = await exportHtmlToPptx(proposal.sourcePath, proposal.path);
      // The deck is written with the raw byte writer, which the file tree knows
      // nothing about — without this the new file is invisible until something
      // else refreshes.
      await deps.refreshFileTree();
      return {
        resultPath: outcome.path,
        report: [
          `Exported ${outcome.slides} slide(s) to ${outcome.path}.`,
          outcome.degraded.length
            ? `These did not carry across faithfully — tell the author:\n- ${outcome.degraded.join("\n- ")}`
            : "",
          // Two lists, two kinds of fact: the one above is what the conversion
          // *measured* and degraded; this one is what the source said before
          // anything was rendered — the ::before bullets the harvester never
          // saw. Only both together are the whole account.
          formatLintFindings(proposal.lint),
        ].filter(Boolean).join("\n"),
      };
    }

    case "docx": {
      // Same reason as the pptx case: the work needs something the tool loop
      // does not have — here it is a 1 MB library that must stay out of the
      // startup bundle, and a binary write.
      const { exportMarkdownToDocx } = await import("../docx");
      // Measured around the conversion alone — the card reports how long *this*
      // took, and the author's decision time is not part of that.
      const startedAt = performance.now();
      const outcome = await exportMarkdownToDocx(proposal.sourcePath, proposal.format, proposal.path);
      const ms = Math.round(performance.now() - startedAt);
      // Written with the raw byte writer, which the file tree knows nothing
      // about — without this the new file is invisible until something else
      // refreshes.
      await deps.refreshFileTree();
      return {
        resultPath: outcome.path,
        exportSummary: {
          path: outcome.path,
          blocks: outcome.blocks,
          ms,
          // 「默认格式（手稿）」/「预设：公文（改了 2 项）」。默认那一套要带上它
          // 的名字——「默认格式」四个字不说是哪一套；点名的预设名字已经在里面了，
          // 再挂一句「内置 · 未改动」只是噪音（设计稿 05f 屏 1k）。
          formatLine: proposal.originLabel
            + (proposal.originKind === "default" && proposal.originNote ? `（${proposal.originNote}）` : "")
            + (proposal.changed?.length ? `（改了 ${proposal.changed.length} 项）` : ""),
          degraded: outcome.degraded,
        },
        report: [
          // The card's origin line is deliberately short — the preset name and
          // the override count sit beside it as a note and a chip. The model
          // has neither, so the sentence it gets says all three.
          `Exported ${outcome.blocks} block(s) to ${outcome.path}, laid out by ${proposal.originLabel}`
            + (proposal.originNote ? ` (${proposal.originNote})` : "")
            + (proposal.changed?.length
              ? `, with ${proposal.changed.length} field(s) changed just for this run: `
                + proposal.changed.map((c) => `${c.label} ${c.from} → ${c.to}`).join("; ")
              : "")
            + ".",
          outcome.degraded.length
            ? `These fell back to a simpler form — state them plainly to the author, they are facts rather than errors:\n- ${outcome.degraded.join("\n- ")}`
            : "Nothing degraded.",
          // Naming it here is the only way the assistant knows not to promise a
          // preview that matches the author's screen.
          proposal.missingFonts.length
            ? `NOTE: ${proposal.missingFonts.join("、")} is not installed on this machine. The file is still correct — it will render properly wherever the font exists — but the author's own preview will substitute it.`
            : "",
        ].filter(Boolean).join("\n"),
      };
    }

    case "xlsx": {
      // Unlike the two above, nothing is converted here: the workbook was built
      // when the card was raised, so this step only turns the approved grid
      // into bytes (lib/xlsx/write.ts) and puts them on disk.
      const { writeWorkbook } = await import("../xlsx");
      await writeWorkbook(proposal.sheets, proposal.path);
      // Written with the raw byte writer, which the file tree knows nothing
      // about — without this the new file is invisible until something else
      // refreshes.
      await deps.refreshFileTree();
      const cells = proposal.summaries.reduce(
        (acc, s) => ({
          numbers: acc.numbers + s.numbers,
          dates: acc.dates + s.dates,
          formulas: acc.formulas + s.formulas,
        }),
        { numbers: 0, dates: 0, formulas: 0 },
      );
      return {
        resultPath: proposal.path,
        report: [
          `Exported ${proposal.summaries.length} sheet(s) to ${proposal.path}: ${proposal.summaries
            .map((s) => `"${s.name}" ${s.rows}×${s.cols}`)
            .join(", ")}.`,
          `Typed cells: ${cells.numbers} number(s), ${cells.dates} date(s), ${cells.formulas} formula(s). Everything else is text.`,
          proposal.skipped.length
            ? `These are in the document but not in the workbook — a worksheet has nowhere to put them. State them plainly to the author:\n- ${proposal.skipped.join("\n- ")}`
            : "",
          // Without this the assistant promises a total the author will not see
          // until they open the file in a real spreadsheet app.
          cells.formulas > 0
            ? "NOTE: formulas are written without a cached result, so Excel and LibreOffice compute them on open; a preview that only reads stored values may show those cells blank until then."
            : "",
        ].filter(Boolean).join("\n"),
      };
    }
  }
}
