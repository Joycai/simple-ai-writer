/**
 * Manuscript proposals (L2 — approval required): create / copy / move / delete, `propose_edit`, `rewrite_lines`, `insert_lines`, `rewrite_document`, and the applied-region receipt.
 *
 * Part of the L1/L2 write tools, split out of `writeTools.ts` by section
 * (docs/feature/code-structure-plan.md P6); `writeTools.ts` re-exports the
 * tools, so importers keep one address. The policy every handler follows is
 * in that file's header.
 */


import { isChapterFile, normalizeChapterFileName, parentDir } from "../../context/outline";
import { isFolderNoteFile } from "../../fs/folderNote";
import { readDir, readFile } from "../../fs/fileio";
import { readDirRecursive, type FileNode } from "../../project";
import { modifiedAt } from "../../fs/modified";
import { backlinksOf } from "../../fs/links";
import { changeAfterWrite, changeOf } from "../backup";
import { clipContextLine, countLines, describeEditTarget, findOccurrences, insertionLanding, locateMatches, occurrenceAt, sliceLines, type Insertion } from "../editApply";
import { echoRegion, lineOfOffset, shiftNote } from "../lineEcho";
import type { ApprovalDecision, DeleteEntry, ToolContext } from "../registry";
import { isStrictDescendant, normalizePathSegments, resolveWorkspacePath } from "../../paths";
import { headingIndex, type ToolResult } from "../tools";
import { baseName, dirName } from "../../paths";

import { nextProposalSeq } from "./shared";

// ─── Manuscript proposals (L2 — approval required) ───────────────────────────


/**
 * Shared preamble for every manuscript proposal: a trimmed path that is really
 * inside the project (and not inside `.ai-writer/`), and a live approval
 * channel to block on. Returns the error result to hand straight back to the
 * model when either is missing.
 */
function manuscriptTarget(
  toolCallId: string,
  tool: string,
  rawPath: string | undefined,
  ctx: ToolContext,
): { path: string } | { refusal: ToolResult } {
  const raw = rawPath?.trim();
  if (!raw) {
    return { refusal: { toolCallId, content: "Error: 'path' argument is required." } };
  }
  // Project files only — .ai-writer is the app's data; lore/memory have their
  // own (L1) tools with their own approval protocols, and letting a document
  // tool write there would bypass the lore plan gate wholesale. A relative path
  // is rebased on the project root first (see resolveWorkspacePath).
  const path = resolveWorkspacePath(ctx.projectPath, raw);
  if (!path) {
    return {
      refusal: {
        toolCallId,
        content: `Error: ${tool} only works on files inside the project folder (the app's .ai-writer data is off-limits — use the lore/memory tools for that).`,
      },
    };
  }
  if (!ctx.requestApproval) {
    return {
      refusal: {
        toolCallId,
        content: `Error: this surface cannot review manuscript changes — do not call ${tool} here.`,
      },
    };
  }
  return { path };
}

/**
 * Whether `path` exists, and whether it is a directory — read from the parent's
 * listing, since fs_exists cannot tell the two apart and `delete_chapter` must
 * refuse folders.
 */
export async function statEntry(path: string): Promise<{ isDir: boolean } | null> {
  const parent = dirName(path);
  if (!parent) return null;
  try {
    const entries = await readDir(parent);
    const name = baseName(path);
    const hit = entries.find((e) => e.name === name);
    return hit ? { isDir: hit.isDirectory } : null;
  } catch {
    return null;
  }
}

/**
 * What an approved manuscript write hands the execution log (设计稿 02h 1j): the
 * change as it landed — read back, because the approval applied it and the log
 * should show what is on disk, not what was proposed — and whether a standing
 * grant let it through unread.
 *
 * Out of band from the result text, like the lore writes' records: the model
 * does not need a second copy of what it just wrote, and the author does.
 */
async function writeReceipt(
  ctx: ToolContext,
  decision: ApprovalDecision,
  path: string,
  before?: string,
): Promise<Pick<ToolResult, "change" | "autoApproved">> {
  if (!decision.approved) return {};
  return {
    change: await changeAfterWrite({
      projectPath: ctx.projectPath,
      path,
      before,
      backupPath: decision.backupPath,
    }),
    ...(decision.auto ? { autoApproved: true as const } : {}),
  };
}

/** Turn an approval decision into the result text the model reads. */
export function reportDecision(
  toolCallId: string,
  decision: ApprovalDecision,
  done: string,
  /** An approved write's record, for the log. */
  extra?: Pick<ToolResult, "change">,
): ToolResult {
  if (!decision.approved) {
    return {
      toolCallId,
      content:
        `The author REJECTED this change${decision.reason ? ` — reason: ${decision.reason}` : "."} ` +
        "Do not retry the same change; adjust per the reason or move on.",
    };
  }
  return {
    toolCallId,
    ...extra,
    ...(decision.auto ? { autoApproved: true as const } : {}),
    content:
      `${done}` +
      (decision.backupPath ? ` The previous state was backed up to ${decision.backupPath}.` : "") +
      (decision.auto
        ? " NOTE: this was auto-approved under a standing grant — the author did not review it. Hold yourself to the same standard you would if they had."
        : ""),
  };
}

/**
 * The map of a file the model just created: how many lines it came to, and
 * where its headings landed.
 *
 * A create is the one write whose content the model knows perfectly and whose
 * *coordinates* it does not know at all. The next call is usually
 * `append_file` (positionless, needs nothing) — but when it is `rewrite_lines`
 * into the skeleton just written, the model has no line numbers, and the only
 * way to get them is to read back a file it wrote itself. That read is a whole
 * round of tool schema for text already in the conversation.
 *
 * Measured from the file rather than counted off the argument, for the same
 * reason §4.3's shift is: a trailing newline has more than one place to be off
 * by one, and being off by one here is silent. The index is `read_file`'s own,
 * so a section is named the same way whether the model read the file or made
 * it (edit-loop-plan.md §5.1).
 */
async function createdMap(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path);
  } catch {
    return ""; // the file is written; not being able to describe it is not an error
  }
  const lines = countLines(text);
  const index = headingIndex(text);
  return ` It is ${lines} line${lines === 1 ? "" : "s"} long.` + (index ? `\n\n${index}` : "");
}

export async function createChapterTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "create_chapter", args.path, ctx);
  if ("refusal" in target) return target.refusal;
  if (typeof args.content !== "string") {
    return { toolCallId, content: "Error: 'content' argument is required (may be an empty string)." };
  }

  // A path the model wrote without an extension would land as a file the
  // outline does not recognise as a chapter, so normalise it up front and tell
  // the model what the file will actually be called.
  const dir = parentDir(target.path);
  const name = normalizeChapterFileName(target.path.slice(dir.length + 1));
  if (!isChapterFile(name)) {
    // The one .md that is not a chapter gets its own sentence: the generic
    // refusal would tell the model that index.md "must end in .md".
    return {
      toolCallId,
      content: isFolderNoteFile(name)
        ? `Error: "${name}" is a folder note (the folder's own description), not a chapter — create it with create_file.`
        : `Error: "${name}" is not a manuscript file — chapters must end in .md, .markdown or .txt.`,
    };
  }
  const path = `${dir}/${name}`;

  if (await statEntry(path)) {
    return {
      toolCallId,
      content: `Error: "${name}" already exists. Use propose_edit to change it, or pick another name.`,
    };
  }

  const decision = await ctx.requestApproval!({
    kind: "create",
    id: `create-${nextProposalSeq()}`,
    path,
    content: args.content,
    reason: args.reason?.trim() || undefined,
  });
  const done = `Created ${path}.` + (decision.approved ? await createdMap(path) : "");
  return reportDecision(
    toolCallId, decision, done,
    decision.approved ? { change: await changeAfterWrite({ projectPath: ctx.projectPath, path }) } : undefined,
  );
}

/**
 * Create a file of any type — the general-purpose counterpart to
 * `create_chapter`, for everything the outline should NOT treat as a chapter
 * (notes, data files, config). The extension is therefore *required* rather
 * than defaulted: a bare name here means the model has not decided what kind
 * of file it is making, and silently appending `.md` would quietly turn data
 * into a chapter.
 */
export async function createFileTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "create_file", args.path, ctx);
  if ("refusal" in target) return target.refusal;
  if (typeof args.content !== "string") {
    return { toolCallId, content: "Error: 'content' argument is required (may be an empty string)." };
  }

  const dir = parentDir(target.path);
  const name = target.path.slice(dir.length + 1);
  // The two refusals are different problems and deserve different words: a
  // dotfile is unsupported by design (hidden from the tree, invisible to the
  // author), a bare name means the model has not decided what it is making.
  if (name.startsWith(".")) {
    return {
      toolCallId,
      content: `Error: "${name}" is a hidden file (dotfile) — those are not shown in the project tree and cannot be created here. Pick a visible filename.`,
    };
  }
  if (!/^[^.].*\.[^./\\]+$/.test(name)) {
    return {
      toolCallId,
      content:
        `Error: "${name}" has no file extension. Give the full filename (e.g. 大纲.md, 人物表.csv, 配置.json) — ` +
        "or use create_chapter for manuscript text, which defaults to .md.",
    };
  }

  if (await statEntry(target.path)) {
    return {
      toolCallId,
      content: `Error: "${name}" already exists. Use propose_edit or rewrite_document to change it, or pick another name.`,
    };
  }

  const decision = await ctx.requestApproval!({
    kind: "create",
    id: `create-${nextProposalSeq()}`,
    path: target.path,
    content: args.content,
    reason: args.reason?.trim() || undefined,
  });
  const done = `Created ${target.path}.` + (decision.approved ? await createdMap(target.path) : "");
  return reportDecision(
    toolCallId, decision, done,
    decision.approved
      ? { change: await changeAfterWrite({ projectPath: ctx.projectPath, path: target.path }) }
      : undefined,
  );
}

/** Create an empty folder — a volume, a materials directory, any grouping. */
export async function createDirectoryTool(
  toolCallId: string,
  args: { path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "create_directory", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  if (await statEntry(target.path)) {
    return { toolCallId, content: `Error: something already exists at "${target.path}".` };
  }

  const decision = await ctx.requestApproval!({
    kind: "create",
    id: `create-${nextProposalSeq()}`,
    path: target.path,
    content: "",
    isDir: true,
    reason: args.reason?.trim() || undefined,
  });
  return reportDecision(toolCallId, decision, `Created folder ${target.path}.`);
}

/**
 * Duplicate a file or folder into a destination directory. The copy keeps the
 * source's name unless `new_name` renames it in the same step — a collision is
 * auto-numbered by the apply step either way, and the final path comes back on
 * the decision (`resultPath`), so the report tells the model where the copy
 * actually landed.
 */
export async function copyFileTool(
  toolCallId: string,
  args: { path?: string; dest_dir?: string; new_name?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "copy_file", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const rawDestDir = args.dest_dir?.trim();
  if (!rawDestDir) {
    return { toolCallId, content: "Error: 'dest_dir' argument is required (the folder the copy lands in)." };
  }
  const destDir = resolveWorkspacePath(ctx.projectPath, rawDestDir);
  if (!destDir) {
    return { toolCallId, content: "Error: the destination must be inside the project folder (not in .ai-writer)." };
  }

  const source = await statEntry(target.path);
  if (!source) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }

  // Optional rename-in-the-same-step. The extension requirement mirrors
  // create_file's: a copy that silently changed or dropped its extension would
  // change what kind of file it is.
  const newName = args.new_name?.trim();
  if (newName) {
    if (!/^[^/\\]+$/.test(newName) || newName.includes("..")) {
      return { toolCallId, content: "Error: 'new_name' must be a plain name (no paths)." };
    }
    if (!source.isDir && !/^[^.].*\.[^./\\]+$/.test(newName)) {
      return {
        toolCallId,
        content: `Error: 'new_name' ("${newName}") must be the full filename including its extension — omit it to keep the source's name.`,
      };
    }
  }
  // The project root always exists but has no parent listing for statEntry to
  // find it in — accept it without stat. Anything else must be a real folder.
  if (normalizePathSegments(destDir) !== normalizePathSegments(ctx.projectPath)) {
    const dest = await statEntry(destDir);
    if (!dest?.isDir) {
      return { toolCallId, content: `Error: destination folder "${destDir}" does not exist (create_directory first), or is a file.` };
    }
  }
  if (source.isDir && (target.path === destDir || isStrictDescendant(target.path, destDir))) {
    return { toolCallId, content: "Error: cannot copy a folder into itself." };
  }

  const decision = await ctx.requestApproval!({
    kind: "copy",
    id: `copy-${nextProposalSeq()}`,
    path: target.path,
    destDir,
    ...(newName ? { newName } : {}),
    isDir: source.isDir,
    reason: args.reason?.trim() || undefined,
  });
  const landed = decision.approved ? (decision.resultPath ?? destDir) : destDir;
  return reportDecision(toolCallId, decision, `Copied ${target.path} to ${landed}.`);
}

export async function moveChapterTool(
  toolCallId: string,
  args: { path?: string; new_path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "move_chapter", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  if (!args.new_path?.trim()) {
    return { toolCallId, content: "Error: 'new_path' argument is required (the full destination path)." };
  }
  const dest = resolveWorkspacePath(ctx.projectPath, args.new_path.trim());
  if (!dest) {
    return { toolCallId, content: "Error: the destination must also be inside the project folder (not in .ai-writer)." };
  }

  const source = await statEntry(target.path);
  if (!source) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }

  // Only a manuscript file gets its extension defaulted; for any other file a
  // bare destination is refused rather than silently rewritten into `.md` —
  // that would change what kind of file it is (数据.csv moved to 数据 must not
  // become 数据.md). A volume folder keeps its bare name.
  const destDir = parentDir(dest);
  const destName = dest.slice(destDir.length + 1);
  const sourceName = baseName(target.path) ?? "";
  let destLeaf = destName;
  if (!source.isDir) {
    if (isChapterFile(sourceName)) {
      destLeaf = normalizeChapterFileName(destName);
    } else if (!destName.includes(".")) {
      return {
        toolCallId,
        content:
          `Error: the destination "${destName}" has no file extension, and "${sourceName}" is not a manuscript file, so nothing is appended for you. ` +
          "Give the full destination filename including its extension.",
      };
    }
  }
  const newPath = source.isDir ? dest : `${destDir}/${destLeaf}`;

  if (newPath === target.path) {
    return { toolCallId, content: "Error: the destination is the same as the source." };
  }
  if (await statEntry(newPath)) {
    return { toolCallId, content: `Error: "${newPath}" already exists — moving there would overwrite it.` };
  }
  if (isStrictDescendant(target.path, newPath)) {
    return { toolCallId, content: "Error: cannot move a folder into itself." };
  }

  const decision = await ctx.requestApproval!({
    kind: "move",
    id: `move-${nextProposalSeq()}`,
    path: target.path,
    newPath,
    isDir: source.isDir,
    reason: args.reason?.trim() || undefined,
  });
  return reportDecision(toolCallId, decision, `Moved ${target.path} to ${newPath}.`);
}

export async function deleteChapterTool(
  toolCallId: string,
  args: { path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "delete_chapter", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const reason = args.reason?.trim();
  if (!reason) {
    return { toolCallId, content: "Error: 'reason' argument is required — the author decides on the card, and needs to know why." };
  }

  const stat = await statEntry(target.path);
  if (!stat) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }
  if (stat.isDir) {
    return {
      toolCallId,
      content:
        "Error: delete_chapter removes a single chapter file, not a volume folder — use delete_directory for a whole folder (it needs its own approval).",
    };
  }

  let chars = 0;
  let lines = 0;
  let excerpt: string | undefined;
  // Kept whole for the log's record: the file is gone once this is approved,
  // and the record is the only place its text is still shown.
  let body: string | undefined;
  try {
    body = await readFile(target.path);
    chars = body.length;
    lines = countLines(body);
    excerpt = body.slice(0, DELETE_EXCERPT_CHARS);
  } catch {
    // Unreadable but listed — still proposable; the card just cannot size it.
  }
  // 「最后改于 8 月 3 日」 (1c): the abandoned draft or this morning's work.
  const modifiedMs = await modifiedAt(target.path);

  // Costs a pass over the workspace, and a deletion is rare enough to pay for
  // it: this is the only question on the card that cannot be answered once the
  // file is gone.
  const links = await backlinksOf(ctx.projectPath, [target.path]);

  const decision = await ctx.requestApproval!({
    kind: "delete",
    id: `delete-${nextProposalSeq()}`,
    path: target.path,
    chars,
    lines,
    excerpt,
    ...(modifiedMs !== undefined ? { modifiedAt: modifiedMs } : {}),
    backlinks: links.byTarget.get(target.path) ?? [],
    ...(links.complete ? {} : { backlinksPartial: true as const }),
    reason,
  });
  return reportDecision(
    toolCallId,
    decision,
    `Deleted ${target.path}. It was moved to .ai-writer/backups and can be restored.`,
    decision.approved
      ? {
          change: changeOf({
            projectPath: ctx.projectPath,
            path: target.path,
            before: body ?? "",
            backupPath: decision.backupPath,
          }),
        }
      : undefined,
  );
}

/**
 * Opening text kept on a file's delete card.
 *
 * Enough to recognise the file by — the first heading and a paragraph or two.
 * The decision is "is this the thing I meant", not "is every line of it
 * expendable", and the file is still on disk while the card waits.
 */
const DELETE_EXCERPT_CHARS = 600;

/**
 * Names listed on a folder's delete card before it says "and N more".
 *
 * `fileCount` carries the true total, so the list is allowed to be a sample —
 * but a sample of nothing is what the card shows today, and "12 个文件" is not
 * something an author can check.
 */
const DELETE_FILES_LISTED = 50;

/**
 * Files read to size them before the folder card gives up on a total.
 *
 * Sizing means reading, and a folder someone has pasted a library into is not
 * worth the wait — past this the card leads with the file count alone, which
 * is what it did before any of this existed.
 */
const DELETE_SIZE_MAX_FILES = 200;

/** Files inside a directory tree, recursively — the number the delete card leads with. */
export function countFiles(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += node.is_dir ? countFiles(node.children ?? []) : 1;
  }
  return n;
}

/** Sub-folders inside it — 「含 1 个子文件夹」 is how deep the deletion goes. */
function countDirs(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.is_dir) n += 1 + countDirs(node.children ?? []);
  }
  return n;
}

/**
 * Paths inside the tree, folder-relative, depth-first, stopping at `limit`.
 *
 * Folder-relative rather than project-relative because every entry would
 * otherwise repeat the folder the card's header already names.
 */
function listFiles(nodes: FileNode[], limit: number, prefix = ""): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (out.length >= limit) break;
    const rel = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.is_dir) out.push(...listFiles(node.children ?? [], limit - out.length, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Propose deleting a whole folder. The heavyweight counterpart to
 * `delete_chapter`: the blast radius is every file inside, so the proposal
 * carries a recursive file count for the card to lead with, and the kind
 * ("delete") keeps it permanently outside 本次都批准 grants — every folder
 * deletion is its own card, every time. On approval the whole directory is
 * renamed into `.ai-writer/backups`, so it stays recoverable as one piece.
 */
export async function deleteDirectoryTool(
  toolCallId: string,
  args: { path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "delete_directory", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const reason = args.reason?.trim();
  if (!reason) {
    return { toolCallId, content: "Error: 'reason' argument is required — the author decides on the card, and needs to know why." };
  }

  // isWorkspacePath accepts the project root itself; deleting it is not a
  // proposal, it is the workspace.
  if (!isStrictDescendant(ctx.projectPath, target.path)) {
    return { toolCallId, content: "Error: cannot delete the project folder itself." };
  }

  const stat = await statEntry(target.path);
  if (!stat) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }
  if (!stat.isDir) {
    return { toolCallId, content: "Error: delete_directory removes a folder — for a single file use delete_chapter." };
  }

  let fileCount = 0;
  let dirCount = 0;
  let totalChars = 0;
  let entries: DeleteEntry[] | undefined;
  let partial = false;
  try {
    const tree = await readDirRecursive(target.path);
    fileCount = countFiles(tree);
    dirCount = countDirs(tree);
    const paths = listFiles(tree, Number.MAX_SAFE_INTEGER);
    const sized = paths.length <= DELETE_SIZE_MAX_FILES;
    const links = await backlinksOf(
      ctx.projectPath,
      sized ? paths.map((rel) => `${target.path}/${rel}`) : [],
    );
    partial = !links.complete;
    const measured: DeleteEntry[] = [];
    for (const rel of paths.slice(0, sized ? paths.length : DELETE_FILES_LISTED)) {
      const abs = `${target.path}/${rel}`;
      let chars = 0;
      if (sized) {
        try {
          chars = (await readFile(abs)).length;
        } catch {
          // Unreadable: it still goes, and the row still names it.
        }
      }
      totalChars += chars;
      const backlinks = links.byTarget.get(abs) ?? [];
      measured.push({ path: rel, chars, ...(backlinks.length ? { backlinks } : {}) });
    }
    // Biggest first: what an author checks a bulk deletion against is whether
    // something *large* is in it, and a name they do not recognise at the top
    // is the whole point of the list.
    measured.sort((a, b) => b.chars - a.chars);
    entries = measured.slice(0, DELETE_FILES_LISTED);
  } catch {
    // Unlistable but present — still proposable; the card just cannot size it.
  }

  const decision = await ctx.requestApproval!({
    kind: "delete",
    id: `delete-${nextProposalSeq()}`,
    path: target.path,
    chars: totalChars,
    isDir: true,
    fileCount,
    dirCount,
    entries,
    ...(partial ? { backlinksPartial: true as const } : {}),
    reason,
  });
  return reportDecision(
    toolCallId,
    decision,
    `Deleted the folder ${target.path} (${fileCount} file(s)). It was moved to .ai-writer/backups and can be restored as a whole.`,
  );
}

// ─── the applied-region receipt ──────────────────────────────────────────────

/**
 * What an approved write hands back instead of "re-read before naming another
 * range": where the change now sits, what moved, and what the file says there.
 *
 * The shift is measured from the file — `countLines(after) - countLines(before)`
 * — rather than reasoned about from the text that was sent. That is not
 * fastidiousness: a replacement's line span depends on whether it ends in a
 * newline, whether the slice it replaced did, and whether the tool restored a
 * terminator the model omitted, and each of those is a place to be off by one.
 * An off-by-one here is silent and lands the *next* edit on the wrong lines.
 * The file already knows the answer.
 *
 * Read back rather than reconstructed for the same reason: this shows what
 * actually landed, which is the only version that can catch an apply that did
 * something other than what the model expected.
 *
 * Best-effort by design — a failed read must never turn a write that succeeded
 * into a tool result that reads like a failure, so it degrades to nothing at
 * all. The line before it already reports the range that was rewritten.
 */
export async function appliedReceipt(
  path: string,
  before: string,
  from: number,
  oldTo: number,
): Promise<string> {
  let after: string;
  try {
    after = await readFile(path);
  } catch {
    return "";
  }
  const shift = countLines(after) - countLines(before);
  const newTo = oldTo + shift;
  return ` ${shiftNote(from, newTo, shift)}\n\n${echoRegion(after, from, newTo)}`;
}

/**
 * The same receipt for `propose_edit`, which names its target by text rather than
 * by line — so where the change landed has to be derived from the occurrence.
 *
 * `replace_all` over several occurrences is the one case that gets no receipt and
 * an explicit instruction to re-read: the shifts accumulate down the file, so
 * there is no single region to show and no single number that describes what
 * moved. Saying so is the honest answer; inventing one would be the dangerous
 * one, because a wrong line range does not fail — it edits the wrong place.
 */
async function editReceipt(
  path: string,
  before: string,
  find: string,
  target: number | "all" | undefined,
): Promise<string> {
  const positions = findOccurrences(before, find);
  if (target === "all" && positions.length > 1) {
    return (
      ` ${positions.length} places changed, so line numbers below the first one have all moved —` +
      " read the file again before naming a line range."
    );
  }
  const at = positions[target === "all" || target === undefined ? 0 : target - 1];
  if (at === undefined) return "";

  // Everything before the occurrence is untouched, so its offset means the
  // same thing in both versions of the file — which is what lets the region be
  // located in the old text and the shift be measured from the new.
  return appliedReceipt(
    path,
    before,
    lineOfOffset(before, at),
    lineOfOffset(before, at + Math.max(0, find.length - 1)),
  );
}

// ─── propose_edit ────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of `find` in `text`. */
export async function proposeEditTool(
  toolCallId: string,
  args: {
    path?: string;
    find?: string;
    replace?: string;
    occurrence?: number;
    replace_all?: boolean;
    reason?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const checked = manuscriptTarget(toolCallId, "propose_edit", args.path, ctx);
  if ("refusal" in checked) return checked.refusal;
  const path = checked.path;
  if (typeof args.find !== "string" || !args.find) {
    return { toolCallId, content: "Error: 'find' argument is required (the exact text to replace)." };
  }
  if (typeof args.replace !== "string") {
    return { toolCallId, content: "Error: 'replace' argument is required." };
  }

  let content: string;
  try {
    content = await readFile(path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }
  const positions = findOccurrences(content, args.find);
  const occurrences = positions.length;
  if (occurrences === 0) {
    return {
      toolCallId,
      content: "Error: 'find' text not found in the file. Re-read the file and copy the target text exactly.",
    };
  }

  const all = args.replace_all === true;
  const nth = args.occurrence === undefined ? undefined : Math.floor(Number(args.occurrence));
  if (all && nth !== undefined) {
    return {
      toolCallId,
      content: "Error: pass either 'occurrence' (one of them) or replace_all=true (every one), not both.",
    };
  }
  if (nth !== undefined && (!Number.isFinite(nth) || nth < 1)) {
    return { toolCallId, content: "Error: 'occurrence' must be a whole number ≥ 1 (1 = the first match)." };
  }
  if (nth !== undefined && nth > occurrences) {
    return {
      toolCallId,
      content: `Error: 'find' occurs ${occurrences} time(s) in the file, so occurrence ${nth} does not exist.`,
    };
  }
  // Ambiguity is only an error when the call has not resolved it. Saying which
  // of the three ways out applies is the whole point — the old bare refusal
  // left rewrite_document as the model's only move on a repetitive file.
  if (occurrences > 1 && !all && nth === undefined) {
    return {
      toolCallId,
      content:
        `Error: 'find' text occurs ${occurrences} times, so this call does not say which one you mean. ` +
        "Either include more surrounding text so it is unique, or pass occurrence=N (1-based) for one of them, " +
        "or replace_all=true to change all of them.",
    };
  }

  // A file with a single match is the plain case however it was addressed —
  // normalising here keeps the card and the apply path from having to spell
  // out "occurrence 1 of 1".
  const target = occurrences === 1 ? undefined : all ? ("all" as const) : (nth ?? 1);

  const decision = await ctx.requestApproval!({
    kind: "edit",
    id: `edit-${nextProposalSeq()}`,
    path,
    find: args.find,
    replace: args.replace,
    occurrences,
    matches: locateMatches(content, args.find, positions),
    target,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The author REJECTED this edit${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry the same change; adjust per the reason or move on.`,
    };
  }
  const scope = describeEditTarget(occurrences, target);
  return {
    toolCallId,
    ...(await writeReceipt(ctx, decision, path, content)),
    content:
      `Edit approved and applied${scope ? ` (${scope})` : ""}.` +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : "") +
      (await editReceipt(path, content, args.find, target)),
  };
}

// ─── rewrite_lines ───────────────────────────────────────────────────────────

/**
 * Replace a range of lines — the chunked path `rewrite_document` never had.
 *
 * `rewrite_document` takes the whole new body as one tool argument, so the
 * file it is most needed for is the file it cannot finish: a long HTML page
 * re-laid-out in one reply runs past the model's output cap, and a tool call
 * cut off there writes NOTHING — the dozen `read_file` calls that preceded it
 * are spent for nothing too. Creation already had the answer to this
 * (`create_file` a skeleton, then `append_file` per section); revision did
 * not, and `propose_edit` cannot express "restructure this whole region"
 * without quoting every original line into `find`.
 *
 * So: the model names a line range it has already read and sends only the
 * replacement. The tool reads that range off disk and builds an ordinary
 * **edit** proposal from it — same card, same approval, same apply path,
 * including the occurrence bookkeeping that refuses a file which moved on
 * while the card was waiting. Nothing here is a new kind of write; the only
 * new thing is that the model no longer has to say the old text out loud.
 *
 * A full re-layout is then K of these, each one landing on disk, so a
 * truncation costs one chunk instead of the whole document.
 */
export async function rewriteLinesTool(
  toolCallId: string,
  args: { path?: string; start_line?: number; end_line?: number; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "rewrite_lines", args.path, ctx);
  if ("refusal" in target) return target.refusal;
  if (typeof args.content !== "string") {
    return {
      toolCallId,
      content: "Error: 'content' argument is required (the replacement text for those lines; an empty string deletes them).",
    };
  }

  const from = Math.floor(Number(args.start_line));
  const to = Math.floor(Number(args.end_line));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
    return {
      toolCallId,
      content: "Error: 'start_line' and 'end_line' must be whole numbers with start_line ≥ 1 and end_line ≥ start_line (read_file's trailer reports the numbers).",
    };
  }

  let original: string;
  try {
    original = await readFile(target.path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }

  const slice = sliceLines(original, from, to);
  if (!slice) {
    return {
      toolCallId,
      content: `Error: start_line ${from} is past the end of the file, which has ${countLines(original)} line(s).`,
    };
  }
  // An empty file has one line of nothing, and an empty `find` can never be
  // located — the proposal would be unappliable. Starting a file is a
  // different tool's job.
  if (slice.text === "") {
    return {
      toolCallId,
      content: `Error: ${target.path} is empty, so there are no lines to replace. Use append_file to write into it.`,
    };
  }

  // Welding guard: the range carries the terminator of its last line, so a
  // replacement without one would run the following line onto this text. The
  // model is not asked to remember that — it is the kind of detail that goes
  // wrong once per long document and shows up as a corrupted heading.
  let replacement = args.content;
  if (slice.text.endsWith("\n") && replacement !== "" && !replacement.endsWith("\n")) {
    replacement += "\n";
  }
  if (replacement === slice.text) {
    return { toolCallId, content: `Lines ${from}-${slice.to} already read exactly like that — nothing to do.` };
  }

  const { occurrences, index, positions } = occurrenceAt(original, slice.text, slice.start);
  const decision = await ctx.requestApproval!({
    kind: "edit",
    id: `edit-${nextProposalSeq()}`,
    path: target.path,
    find: slice.text,
    replace: replacement,
    occurrences,
    matches: locateMatches(original, slice.text, positions),
    target: occurrences === 1 ? undefined : index,
    range: { from, to: slice.to },
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The author REJECTED this rewrite${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not resend the same content; adjust per the reason or move on.`,
    };
  }
  const grew = replacement.length - slice.text.length;
  return {
    toolCallId,
    ...(await writeReceipt(ctx, decision, target.path, original)),
    content:
      `Rewrote lines ${from}-${slice.to} of ${target.path} (${slice.text.length} → ${replacement.length} chars, ` +
      `${grew >= 0 ? "+" : ""}${grew}). The rest of the file is untouched.` +
      (decision.auto ? " Applied under a standing grant — nobody read it." : "") +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : "") +
      (await appliedReceipt(target.path, original, from, slice.to)),
  };
}

// ─── insert_lines ────────────────────────────────────────────────────────────

/**
 * Insertion points one call may carry.
 *
 * Generous, because the whole point is that a document's structure arrives as
 * one list and one card: 60 headings over a long manuscript is the case this
 * tool was written for, not an abuse of it. What the cap is really for is the
 * degenerate shape — a model inserting a blank line between every paragraph of
 * a 5,000-line file — where the card stops being reviewable and the argument
 * list stops fitting in a reply. Splitting into several calls costs a card
 * each, which is the right price for work that large.
 */
const MAX_INSERTIONS = 100;

/** Rows of "old line → new line" the receipt prints before it summarises. */
const INSERT_RECEIPT_ROWS = 40;

/** Insertions echoed with their surrounding lines; past this, numbers only. */
const INSERT_ECHO_MAX = 3;

/**
 * Add structure to a document without re-sending it.
 *
 * The shape this completes: `append_file` decoupled per-call size from file
 * size at the *end* of a file, and this does it in the middle. Everything else
 * on the manuscript side needs the old text in hand — `propose_edit` quotes it
 * into `find`, `rewrite_lines` replaces it, `rewrite_document` carries all of
 * it — so "put a heading here" was previously priced as "re-emit the section
 * you are putting it in front of". On the document this tool exists for (long,
 * unstructured, being given headings) that is the whole file, twice, plus the
 * paraphrase risk of every re-typed character.
 *
 * The model therefore sends coordinates and new text only. Bottom-up
 * application is the mechanism rather than an instruction (see
 * `applyInsertions`), so the numbers it read stay usable across the whole list.
 */
export async function insertLinesTool(
  toolCallId: string,
  args: { path?: string; insertions?: unknown; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "insert_lines", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const raw = Array.isArray(args.insertions) ? args.insertions : null;
  if (!raw || raw.length === 0) {
    return {
      toolCallId,
      content:
        "Error: 'insertions' must be a non-empty array of {line, text} — every place to insert, in one call.",
    };
  }
  if (raw.length > MAX_INSERTIONS) {
    return {
      toolCallId,
      content:
        `Error: ${raw.length} insertions in one call, which is past the ${MAX_INSERTIONS} limit — the author ` +
        "could not review that as one card. Send the document's structure in several calls, top to bottom; " +
        "line numbers do not shift between calls as long as you work from the bottom of the file upwards.",
    };
  }

  let original: string;
  try {
    original = await readFile(target.path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }

  const lines = original.split(/\r?\n/);
  const lineCount = countLines(original);
  if (original === "") {
    return {
      toolCallId,
      content: `Error: ${target.path} is empty, so there are no lines to insert before. Use append_file to write into it.`,
    };
  }

  const insertions: Insertion[] = [];
  const seen = new Map<number, number>();
  for (const [i, item] of raw.entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const line = Math.floor(Number(entry.line));
    if (!Number.isFinite(line) || line < 1) {
      return {
        toolCallId,
        content: `Error: insertion ${i + 1} has line "${String(entry.line)}" — it must be a whole number ≥ 1 (read_file numbers the lines).`,
      };
    }
    if (line > lineCount) {
      return {
        toolCallId,
        content:
          `Error: insertion ${i + 1} names line ${line}, but the file has ${lineCount} line(s). ` +
          "Text goes in BEFORE the line you name, so the last usable number is " + lineCount +
          " — to add at the very end of the file, use append_file.",
      };
    }
    if (typeof entry.text !== "string" || entry.text === "") {
      return {
        toolCallId,
        content: `Error: insertion ${i + 1} is missing 'text' — the lines to insert. To remove lines instead, use rewrite_lines with an empty 'content'.`,
      };
    }
    const clash = seen.get(line);
    if (clash !== undefined) {
      return {
        toolCallId,
        content:
          `Error: insertions ${clash + 1} and ${i + 1} both target line ${line}, so their order is undefined. ` +
          "Combine them into one entry whose 'text' carries both pieces in the order you want them.",
      };
    }
    seen.set(line, i);
    insertions.push({ line, text: entry.text });
  }

  const landing = insertionLanding(insertions);
  const context = landing.map((l) => ({
    before: clipContextLine(lines[l.line - 2]),
    after: clipContextLine(lines[l.line - 1]),
  }));

  const decision = await ctx.requestApproval!({
    kind: "insert",
    id: `insert-${nextProposalSeq()}`,
    path: target.path,
    // Sorted, so the card reads down the document and the receipt below
    // indexes the same way the author saw it.
    insertions: landing.map((l) => ({
      line: l.line,
      text: insertions.find((ins) => ins.line === l.line)!.text,
    })),
    context,
    lineCount,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content:
        `The author REJECTED these insertions${decision.reason ? ` — reason: ${decision.reason}` : "."} ` +
        "Nothing was written. Adjust per the reason or move on; do not resend the same list.",
    };
  }

  const added = landing.reduce((n, l) => n + l.added, 0);
  return {
    toolCallId,
    ...(await writeReceipt(ctx, decision, target.path, original)),
    content:
      `Inserted ${landing.length} piece(s) into ${target.path}, ${added} new line(s) in all. ` +
      "Nothing that was already in the file changed." +
      (decision.auto ? " Applied under a standing grant — nobody read it." : "") +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : "") +
      (await insertReceipt(target.path, original, landing)),
  };
}

/**
 * Where the insertions actually landed — this kind's version of §4.3's receipt.
 *
 * An insertion pass shifts everything below every insertion point, so without
 * this the model's whole map of the file is stale the moment the card is
 * approved, and a follow-up edit would need the document read again. The
 * arithmetic is `insertionLanding`'s; what happens here is that it is **checked
 * against the file** before being handed over. If the two disagree, the honest
 * answer is to say so and let the model re-read — a confidently wrong line
 * number does not fail, it edits the wrong place (I3).
 */
export async function insertReceipt(
  path: string,
  before: string,
  landing: readonly { line: number; newLine: number; added: number }[],
): Promise<string> {
  let after: string;
  try {
    after = await readFile(path);
  } catch {
    return ""; // the write succeeded; not being able to describe it is not an error
  }

  const measured = countLines(after) - countLines(before);
  const expected = landing.reduce((n, l) => n + l.added, 0);
  if (measured !== expected) {
    return (
      ` The file grew by ${measured} line(s), not the ${expected} these insertions add — ` +
      "something else changed it too, so read it again before naming any line numbers."
    );
  }

  const shown = landing.slice(0, INSERT_RECEIPT_ROWS);
  const rows = shown.map((l) => `  line ${l.line} → now line ${l.newLine}`).join("\n");
  const omitted = landing.length - shown.length;
  const last = landing[landing.length - 1];
  const tail =
    `\nEverything below line ${last.newLine} has moved by +${expected}; nothing above the first ` +
    "insertion moved at all — no need to re-read to name the next range.";

  // A pass of two or three is a targeted change and worth showing; forty is a
  // restructuring, where echoing every region would spend the round this whole
  // tool exists to save.
  const echo =
    landing.length <= INSERT_ECHO_MAX
      ? `\n\n${landing
          .map((l) => echoRegion(after, l.newLine, l.newLine + l.added - 1))
          .join("\n  ⋮\n")}`
      : "";

  return ` Where they landed:\n${rows}` + (omitted > 0 ? `\n  [... ${omitted} more ...]` : "") + tail + echo;
}

// ─── rewrite_document ────────────────────────────────────────────────────────

/**
 * Below this fraction of the original length, a rewrite is refused outright
 * rather than shown as a card.
 *
 * read_file pages at 4000 chars, so the standing hazard is a model that read
 * the first page, reformatted it, and sent that back as "the whole document" —
 * which would delete the rest. The author *could* catch that on the card, but
 * a proposal that is half the file is far more often this bug than a genuine
 * intent, and bouncing it back to the model (which can then finish reading)
 * fixes it without spending the author's attention. Deliberate large cuts
 * still have propose_edit and delete_chapter.
 */
const REWRITE_MIN_RATIO = 0.5;

/**
 * Add text to the end of an existing file.
 *
 * Deliberately the *only* write that never carries the file's existing
 * content. `create_file` and `rewrite_document` both take the whole body as
 * one tool argument, which means the whole body has to fit inside one model
 * reply — a 60k-character HTML page does not, and the failure mode is a
 * truncated tool call that writes nothing after the model spent the output
 * budget generating it. Appending decouples per-call size from file size:
 * skeleton first, then a section per call, each one landing on disk before the
 * next is generated.
 *
 * The file must already exist. Appending to a missing path would be a
 * disguised create — with none of create_file's extension check, and no way
 * for the author's card to say whether they are approving a new file or an
 * addition to one they know.
 */
export async function appendFileTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "append_file", args.path, ctx);
  if ("refusal" in target) return target.refusal;
  if (typeof args.content !== "string" || args.content === "") {
    return {
      toolCallId,
      content: "Error: 'content' argument is required — the text to add at the end of the file.",
    };
  }

  let original: string;
  try {
    original = await readFile(target.path);
  } catch {
    return {
      toolCallId,
      content:
        `Error: "${target.path}" does not exist (or cannot be read). append_file only extends a file that is ` +
        "already there — use create_file (or create_chapter) to start it.",
    };
  }

  const decision = await ctx.requestApproval!({
    kind: "append",
    id: `append-${nextProposalSeq()}`,
    path: target.path,
    content: args.content,
    originalChars: original.length,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The author REJECTED this addition${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not resend the same text; adjust per the reason or move on.`,
    };
  }
  // Where the file now ends, because building a deliverable section by section
  // means the next call often edits what this one just wrote — and the whole
  // point of appending is that the model never had to read the file to do it.
  // Nothing above the addition moved, so a line number is all it needs.
  const endLine = await appendedEndLine(target.path);
  return {
    toolCallId,
    ...(await writeReceipt(ctx, decision, target.path, original)),
    content:
      `Appended ${args.content.length} chars to ${target.path} (now ${original.length + args.content.length}).` +
      (endLine ? ` The file now ends at line ${endLine}; nothing before the addition moved.` : "") +
      (decision.auto ? " Applied under a standing grant — nobody read it." : "") +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : ""),
  };
}

/** The file's last line number after an append, or 0 if it cannot be read. */
async function appendedEndLine(path: string): Promise<number> {
  try {
    return countLines(await readFile(path));
  } catch {
    return 0;
  }
}

export async function rewriteDocumentTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const checked = manuscriptTarget(toolCallId, "rewrite_document", args.path, ctx);
  if ("refusal" in checked) return checked.refusal;
  const path = checked.path;
  if (typeof args.content !== "string") {
    return { toolCallId, content: "Error: 'content' argument is required (the complete new file body)." };
  }

  let original: string;
  try {
    original = await readFile(path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }

  if (args.content === original) {
    return { toolCallId, content: "The proposed content is identical to the file — nothing to do." };
  }
  if (original.length > 0 && args.content.length < original.length * REWRITE_MIN_RATIO) {
    return {
      toolCallId,
      content:
        `Error: the proposed content is ${args.content.length} chars but the file is ${original.length} — ` +
        `that would delete most of it. If you only read part of the file, call read_file again with start_line ` +
        `until it reports no more lines, then resend the complete document. To remove a passage on purpose, use propose_edit.`,
    };
  }

  const decision = await ctx.requestApproval!({
    kind: "rewrite",
    id: `rewrite-${nextProposalSeq()}`,
    path,
    content: args.content,
    original,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The author REJECTED this rewrite${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not resend the same content; adjust per the reason or move on.`,
    };
  }
  return {
    toolCallId,
    ...(await writeReceipt(ctx, decision, path, original)),
    content:
      `Rewrite approved and applied (${original.length} → ${args.content.length} chars).` +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : ""),
  };
}
