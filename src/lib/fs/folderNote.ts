/**
 * The folder note: a directory's own `index.md`, telling the assistant what the
 * folder holds and whether to consult it.
 *
 * Optional everywhere. A folder without one behaves exactly as before; a folder
 * with one is *described* wherever the assistant discovers folders on its own
 * (`list_files`, `search_text`, the 【当前文件】 brief), and a folder whose note
 * says `status: deprecated` is not expanded by that discovery — the same two
 * invariants the 取材范围 fence follows: it narrows automatic discovery only
 * (an explicit path, `@` reference or `folder` argument still passes), and what
 * it hides is counted, never silently dropped.
 *
 * The format borrows the Open Knowledge Format's `index.md` (one paragraph of
 * description, an optional `* [title](path) - note` list) and adds one
 * frontmatter key, `status`, which is the only thing the app reads by machine.
 * "How much to trust this folder" is prose in the summary, not a number: a
 * numeric weight would drive no mechanism here and a model handed `0.6` can
 * only guess. Decisions: docs/feature/lore/folder-note-plan.md.
 */

import { parseFrontmatter } from "./markdown";
import { readFile } from "./fileio";
import { isPathWithin, pathKey } from "../paths";

/** The reserved filename. Same word as the knowledge base's headword on purpose. */
export const FOLDER_NOTE_FILE = "index.md";

/**
 * The three states. Absent is `stable`; an unknown value is read as `stable`
 * too, because a consumer of this format must tolerate keys and values it does
 * not know (an OKF requirement, and the only behaviour that lets an author
 * write a note by hand without the app refusing it).
 */
type FolderStatus = "draft" | "stable" | "deprecated";

export interface FolderNote {
  status: FolderStatus;
  /** The first prose paragraph, capped — `null` when the note has no prose yet. */
  summary: string | null;
}

/** Longest summary a tool result or brief carries; longer ones are elided. */
export const FOLDER_NOTE_SUMMARY_MAX = 160;

export function isFolderNoteFile(name: string): boolean {
  return name.toLowerCase() === FOLDER_NOTE_FILE;
}

function statusOf(raw: unknown): FolderStatus {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s === "draft" || s === "deprecated" ? s : "stable";
}

/**
 * The first paragraph of prose: not a heading, not a list item, not inside an
 * HTML comment (the template the app writes is one long comment explaining how
 * to fill the note — until the author or the assistant replaces it, the note
 * has nothing to say and must read as such, not as instructions to the model).
 */
function firstParagraph(body: string): string | null {
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
  const paragraphs = stripped.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[0])) continue;
    return lines.join(" ");
  }
  return null;
}

function cap(text: string): string {
  return text.length > FOLDER_NOTE_SUMMARY_MAX
    ? `${text.slice(0, FOLDER_NOTE_SUMMARY_MAX)}…`
    : text;
}

/** Parse a note's text. Never throws — a malformed note is a `stable` note without prose. */
export function parseFolderNote(text: string): FolderNote {
  const { data, content } = parseFrontmatter(text);
  const prose = firstParagraph(content);
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const summary = prose ?? (description || null);
  return { status: statusOf(data.status), summary: summary ? cap(summary) : null };
}

/**
 * Read `dir`'s note, or `null` when there is none (or it cannot be read — an
 * unreadable note is, for every consumer here, the same as no note).
 */
export async function readFolderNote(dir: string): Promise<FolderNote | null> {
  try {
    return parseFolderNote(await readFile(`${dir}/${FOLDER_NOTE_FILE}`));
  } catch {
    return null;
  }
}

/** Where a file's folder chain meets a note. */
export interface FolderNoteContext {
  /** The nearest ancestor (the file's own folder first) that has a note. */
  dir: string;
  note: FolderNote;
  /** Any ancestor on the way up to the project root is `deprecated`. */
  deprecated: boolean;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The note that applies to `filePath`: the nearest one walking up from the
 * file's own folder to the project root, plus whether any folder on that walk
 * is `deprecated` (a chapter three levels under 废稿/ is still a discarded
 * chapter, whatever its own folder says).
 *
 * A folder note opened as the document is not its own context: the walk then
 * starts one level up, so the brief never quotes the file to itself.
 *
 * The walk compares folders through `pathKey`, never raw strings: on Windows
 * the project path and the file path can differ in case (`D:/Proj` vs
 * `d:/proj/…`), and a raw comparison would never meet the root — each step
 * awaiting a failing read, for ever. The segment budget is the second stop.
 */
export async function nearestFolderNote(
  projectPath: string,
  filePath: string,
): Promise<FolderNoteContext | null> {
  const root = normalize(projectPath);
  if (!root) return null;
  const file = normalize(filePath);
  const cut = file.lastIndexOf("/");
  if (cut < 0 || !isPathWithin(root, file)) return null;
  let dir = file.slice(0, cut);
  if (isFolderNoteFile(file.slice(cut + 1))) {
    if (pathKey(dir) === pathKey(root)) return null;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  if (!isPathWithin(root, dir)) return null;

  let nearest: { dir: string; note: FolderNote } | null = null;
  let deprecated = false;
  const rootKey = pathKey(root);
  for (let depth = dir.split("/").length; depth > 0; depth--) {
    const note = await readFolderNote(dir);
    if (note) {
      nearest ??= { dir, note };
      if (note.status === "deprecated") deprecated = true;
    }
    if (pathKey(dir) === rootKey) break;
    const up = dir.lastIndexOf("/");
    if (up < 0) break;
    dir = dir.slice(0, up);
  }
  return nearest ? { ...nearest, deprecated } : null;
}

/**
 * What 「新建目录说明」 writes before the assistant fills it: a title and one
 * comment saying how. All in a comment so that, until it is filled, the note
 * has no summary — `parseFolderNote` skips comments precisely so a fresh
 * template never reads as a description of the folder.
 */
export function folderNoteTemplate(folderName: string, isZh: boolean): string {
  const help = isZh
    ? [
        "目录说明：第一段用一两句话写这个分组装什么、写作时该怎么参考。",
        "不再参考的分组，在文件最顶上加三行：",
        "---",
        "status: deprecated",
        "---",
        "（草稿分组写 draft；不写就是正常参考。）",
        "下面可以列出主要文件，每行一个：* [文件名](文件名) - 一句话",
      ]
    : [
        "Folder note: in the first paragraph, say in a sentence or two what this group holds and how to use it.",
        "For a group that should no longer be consulted, add three lines at the very top:",
        "---",
        "status: deprecated",
        "---",
        "(draft for work in progress; nothing means the group is consulted as usual.)",
        "Below, optionally list the main files, one per line: * [name](name) - one line",
      ];
  return `# ${folderName}\n\n<!--\n${help.join("\n")}\n-->\n`;
}
