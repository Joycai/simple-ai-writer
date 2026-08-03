/**
 * Tool implementations for the agent runtime.
 *
 * This module owns the *handlers* — reading lore, listing/reading writing
 * files. Wire definitions and dispatch live in registry.ts; the loop that
 * drives calls lives in runtime.ts; the path-containment helpers that keep
 * model-controlled path arguments inside the project live in lib/paths.ts,
 * shared with the file-mutation actions in stores/projectStore.
 */

import { isChapterFile, naturalCompare } from "../context/outline";
import { readFile } from "../fs/fileio";
import { imageToDataUrl } from "../fs/images";
import { readEntityFile, type LoreEntity, type LoreIndex } from "../lore";
import { isPathWithin } from "../paths";
import { readDirRecursive, type FileNode } from "../project";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  imageDataUrls?: string[];
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function formatLoreIndex(loreIndex: LoreIndex): string {
  const lines: string[] = [];
  for (const [category, entities] of Object.entries(loreIndex)) {
    if (!entities.length) continue;
    lines.push(`[${category}]`);
    for (const e of entities) {
      lines.push(`  - ${e.name}: ${e.summary || "(no summary)"}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No lore entities found in this project.";
}

/** Case-insensitive entity lookup by name or alias across all categories. */
export function findEntityByName(loreIndex: LoreIndex, name: string): LoreEntity | undefined {
  const lower = name.toLowerCase();
  for (const entities of Object.values(loreIndex)) {
    const found = entities.find(
      (e) =>
        e.name.toLowerCase() === lower ||
        e.aliases?.some((a) => a.toLowerCase() === lower),
    );
    if (found) return found;
  }
  return undefined;
}

/** Flat "Name, Name, …" list for not-found error messages. */
export function allEntityNames(loreIndex: LoreIndex): string {
  return Object.values(loreIndex)
    .flat()
    .map((e) => e.name)
    .join(", ");
}

/**
 * Read an entity's text content (index.md + facets) plus a gallery listing of
 * its avatar/images by filename and description — never the binary images
 * themselves. A task that actually needs to see a specific picture calls
 * `read_lore_image` for it by name (see below); this keeps a routine lore
 * lookup from unconditionally paying to encode and transmit an entity's whole
 * gallery (previously: 5 images / ~35MB on one call, timing out — see the
 * 2026-07-31 trigger-keywords hang).
 */
export async function readLoreEntity(
  toolCallId: string,
  name: string,
  loreIndex: LoreIndex,
  multimodal: boolean,
): Promise<ToolResult> {
  const found = findEntityByName(loreIndex, name);

  if (!found) {
    return {
      toolCallId,
      content: `Entity "${name}" not found. Available: ${allEntityNames(loreIndex) || "none"}`,
    };
  }

  const filenames = found.mdFiles?.length ? found.mdFiles : ["index.md"];
  const parts: string[] = [];
  for (const filename of filenames) {
    if (filename === "images.md") continue; // surfaced separately as the gallery block
    try {
      const content = await readEntityFile(found.dirPath, filename);
      parts.push(`=== ${filename} ===\n${content}`);
    } catch {
      // skip unreadable files silently
    }
  }

  const galleryLines: string[] = [];
  if (found.avatarPath) {
    const fname = found.avatarPath.split(/[\\/]/).pop() ?? "avatar";
    galleryLines.push(`- ${fname}: (avatar)`);
  }
  for (const img of found.images) {
    galleryLines.push(`- ${img.file}: ${img.desc || "(no description)"}`);
  }
  if (galleryLines.length) {
    const header = multimodal
      ? `=== images === (descriptions; call read_lore_image(name: "${name}", file: ...) to view one)`
      : "=== images === (text descriptions only — current model is text-only)";
    parts.push(`${header}\n${galleryLines.join("\n")}`);
  }

  return { toolCallId, content: parts.join("\n\n") || "(no content)" };
}

/** Ceiling on one attached image's size, so a single oversized file can't
 *  reproduce the same timeout this tool exists to avoid. */
const MAX_SINGLE_IMAGE_BYTES = 12 * 1024 * 1024; // ~12MB, before base64 inflation

/** Fetch one specific image from an entity's gallery (or its avatar) as
 *  visual input — the on-demand counterpart to read_lore_entity's
 *  text-only gallery listing. */
export async function readLoreImage(
  toolCallId: string,
  name: string,
  file: string,
  loreIndex: LoreIndex,
  multimodal: boolean,
): Promise<ToolResult> {
  if (!multimodal) {
    return { toolCallId, content: "Error: the active model is text-only and cannot accept images." };
  }

  const found = findEntityByName(loreIndex, name);
  if (!found) {
    return {
      toolCallId,
      content: `Entity "${name}" not found. Available: ${allEntityNames(loreIndex) || "none"}`,
    };
  }

  const avatarName = found.avatarPath?.split(/[\\/]/).pop();
  const wantLower = file.trim().toLowerCase();
  const path = avatarName && avatarName.toLowerCase() === wantLower
    ? found.avatarPath
    : found.images.find((i) => i.file.toLowerCase() === wantLower)?.absPath;

  if (!path) {
    const available = [
      ...(avatarName ? [avatarName] : []),
      ...found.images.map((i) => i.file),
    ].join(", ") || "none";
    return { toolCallId, content: `Image "${file}" not found on "${name}". Available: ${available}` };
  }

  try {
    const { dataUrl, bytes } = await imageToDataUrl(path);
    if (bytes.length > MAX_SINGLE_IMAGE_BYTES) {
      return {
        toolCallId,
        content: `Error: "${file}" is too large to attach (${(bytes.length / 1024 / 1024).toFixed(1)}MB, limit ${MAX_SINGLE_IMAGE_BYTES / 1024 / 1024}MB).`,
      };
    }
    return { toolCallId, content: `Image "${file}" from ${name}.`, imageDataUrls: [dataUrl] };
  } catch (e) {
    return { toolCallId, content: `Error reading "${file}": ${String(e)}` };
  }
}

/** Ceiling on how many files one listing reports, before it starts omitting. */
const LIST_MAX_FILES = 300;

interface DirListing {
  /** Absolute directory path — the prefix its filenames join onto. */
  dir: string;
  files: string[];
}

/**
 * Flatten a recursive tree into one listing per directory, parents before
 * children and each level in natural order. Empty directories are kept: a
 * volume folder with no chapters yet is information, not noise.
 */
function collectListings(nodes: FileNode[], dir: string, out: DirListing[]): void {
  const files = nodes.filter((n) => !n.is_dir).map((n) => n.name);
  files.sort(naturalCompare);
  out.push({ dir, files });

  const subdirs = nodes.filter((n) => n.is_dir);
  subdirs.sort((a, b) => naturalCompare(a.name, b.name));
  for (const sub of subdirs) collectListings(sub.children ?? [], sub.path, out);
}

/**
 * List the manuscript tree under `writing/`, recursively.
 *
 * Grouped as `ls -R` does — absolute directory path, then its filenames
 * indented — rather than one absolute path per line: repeating a long project
 * prefix on every one of several hundred chapters costs more context than the
 * listing itself is worth.
 */
export async function listWritingFiles(
  toolCallId: string,
  projectPath: string,
  folder?: string,
): Promise<ToolResult> {
  const base = `${projectPath}/writing`;
  const target = folder ? `${base}/${folder}` : base;
  // The folder argument is model-controlled — reject `../` escapes.
  if (!isPathWithin(base, target)) {
    return { toolCallId, content: "Error: Folder is outside the project writing directory." };
  }

  const scope = folder ? `writing/${folder}` : "writing/";
  let listings: DirListing[];
  try {
    listings = [];
    collectListings(await readDirRecursive(target), target, listings);
  } catch (e) {
    return { toolCallId, content: `Error listing files: ${String(e)}` };
  }

  const totalFiles = listings.reduce((n, l) => n + l.files.length, 0);
  if (totalFiles === 0) {
    return { toolCallId, content: `No files found in ${scope}.` };
  }

  const blocks: string[] = [];
  let shown = 0;
  for (const { dir, files } of listings) {
    const room = Math.max(0, LIST_MAX_FILES - shown);
    const visible = files.slice(0, room);
    shown += visible.length;
    const omitted = files.length - visible.length;
    const body = visible.length
      ? visible.map((f) => `  ${f}`).join("\n")
      : omitted > 0
        ? ""
        : "  (empty)";
    blocks.push(
      [dir, body, omitted > 0 ? `  [... ${omitted} more file(s) here ...]` : ""]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const dirCount = listings.length;
  const header =
    `${totalFiles} file${totalFiles === 1 ? "" : "s"} in ${dirCount} folder${dirCount === 1 ? "" : "s"} under ${scope} ` +
    "(a file's full path is its folder line + \"/\" + its filename):";
  const trailer =
    shown < totalFiles
      ? `\n\n[... ${totalFiles - shown} file(s) not shown — pass 'folder' to list one volume at a time ...]`
      : "";
  return { toolCallId, content: `${header}\n\n${blocks.join("\n")}${trailer}` };
}

// ─── search_text ─────────────────────────────────────────────────────────────

/**
 * Caps on what one search returns. Without them a common word ("她") in a
 * 300-chapter book would flood the context with thousands of lines and starve
 * the rest of the run — the per-file cap additionally stops one long chapter
 * from consuming the whole budget before later chapters are ever reported.
 */
const SEARCH_MAX_HITS = 40;
const SEARCH_MAX_PER_FILE = 8;
/** Longest snippet emitted per hit; longer lines are windowed around the match. */
const SNIPPET_MAX = 160;

/** Manuscript files under a recursively-listed tree, depth-first. */
function collectChapterFiles(nodes: FileNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.is_dir) collectChapterFiles(n.children ?? [], out);
    else if (isChapterFile(n.name)) out.push(n.path);
  }
}

/**
 * One line's worth of context around a hit. Prose is often one paragraph per
 * line, so returning the whole line would blow the budget on a single hit —
 * window around the match instead, keeping enough on both sides to read.
 */
function snippetAround(line: string, at: number, matchLen: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= SNIPPET_MAX) return trimmed;
  const pad = Math.max(20, Math.floor((SNIPPET_MAX - matchLen) / 2));
  const start = Math.max(0, at - pad);
  const end = Math.min(line.length, at + matchLen + pad);
  return (start > 0 ? "…" : "") + line.slice(start, end).trim() + (end < line.length ? "…" : "");
}

/**
 * Plain-text, case-insensitive search across the manuscript. Deliberately not
 * regex: the query comes from a model, and a pathological pattern would hang
 * the UI thread with no way for the author to interrupt it.
 */
export async function searchWritingFiles(
  toolCallId: string,
  projectPath: string,
  query: string,
  folder?: string,
): Promise<ToolResult> {
  const q = (query ?? "").trim();
  if (!q) return { toolCallId, content: "Error: 'query' argument is required." };

  const base = `${projectPath}/writing`;
  const target = folder ? `${base}/${folder}` : base;
  // The folder argument is model-controlled — reject `../` escapes.
  if (!isPathWithin(base, target)) {
    return { toolCallId, content: "Error: Folder is outside the project writing directory." };
  }

  const files: string[] = [];
  try {
    collectChapterFiles(await readDirRecursive(target), files);
  } catch (e) {
    return { toolCallId, content: `Error searching: ${String(e)}` };
  }
  files.sort(naturalCompare);

  const scope = folder ? `writing/${folder}` : "writing/";
  const needle = q.toLowerCase();
  const blocks: string[] = [];
  let totalHits = 0;
  let shownHits = 0;
  let matchedFiles = 0;

  for (const path of files) {
    let text: string;
    try {
      text = await readFile(path);
    } catch {
      continue; // unreadable file — skip rather than fail the whole search
    }
    if (!text.toLowerCase().includes(needle)) continue;
    matchedFiles++;

    const lines = text.split(/\r?\n/);
    const hits: string[] = [];
    let inFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].toLowerCase().indexOf(needle);
      if (at < 0) continue;
      inFile++;
      totalHits++;
      if (hits.length < SEARCH_MAX_PER_FILE && shownHits < SEARCH_MAX_HITS) {
        hits.push(`  L${i + 1}: ${snippetAround(lines[i], at, q.length)}`);
        shownHits++;
      }
    }
    if (!hits.length) continue; // counted above; the global cap ate its budget
    const omitted = inFile - hits.length;
    blocks.push(
      `${path}\n${hits.join("\n")}` +
        (omitted > 0 ? `\n  [... ${omitted} more in this file ...]` : ""),
    );
  }

  if (totalHits === 0) {
    return {
      toolCallId,
      content:
        `No matches for "${q}" in ${scope} (${files.length} file${files.length === 1 ? "" : "s"} searched). ` +
        "Matching is literal and case-insensitive — try a shorter or differently-worded phrase.",
    };
  }

  const header =
    `${totalHits} matching line${totalHits === 1 ? "" : "s"} in ${matchedFiles} file${matchedFiles === 1 ? "" : "s"} ` +
    `for "${q}" (${files.length} searched):`;
  const trailer =
    shownHits < totalHits
      ? `\n\n[... ${totalHits - shownHits} more matching lines not shown — narrow the query, or pass 'folder' to scope the search ...]`
      : "";
  return { toolCallId, content: `${header}\n\n${blocks.join("\n\n")}${trailer}` };
}

/** Characters one read_file call may return, before it pages. */
const READ_MAX_CHARS = 4000;

/**
 * Read a manuscript file, optionally starting partway in.
 *
 * Paging is by *line*, not character offset, because that is the coordinate the
 * model already has: search_text reports hits as `L34`, so "read from line 34"
 * is a direct follow-up while "read from character 1200" would be a guess.
 */
export async function readWritingFile(
  toolCallId: string,
  path: string,
  projectPath: string,
  startLine?: number,
): Promise<ToolResult> {
  // The path argument is model-controlled. A plain startsWith check would
  // accept `../` traversal (`/project/../etc/x`) and prefix siblings
  // (`/project-evil/x`), so compare lexically normalized paths on whole
  // component boundaries. Scoped to writing/ like list_files/search_text —
  // the tool is documented (and its `path` built) as manuscript-only, so a
  // prompt-injected model can't use it to read profile.json, memory, or lore.
  const base = `${projectPath}/writing`;
  if (!isPathWithin(base, path)) {
    return { toolCallId, content: "Error: Path is outside the project writing directory." };
  }

  let raw: string;
  try {
    raw = await readFile(path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }

  const lines = raw.split(/\r?\n/);
  const from = Math.max(1, Math.floor(startLine ?? 1));
  if (from > lines.length) {
    return {
      toolCallId,
      content: `Error: start_line ${from} is past the end of the file, which has ${lines.length} line(s).`,
    };
  }

  // Take whole lines until the budget is spent. The first line is always taken
  // even if it alone exceeds the budget — otherwise a file written as one long
  // paragraph per line would return nothing at all.
  let taken = 0;
  let chars = 0;
  for (let i = from - 1; i < lines.length; i++) {
    const cost = lines[i].length + 1;
    if (taken > 0 && chars + cost > READ_MAX_CHARS) break;
    chars += cost;
    taken++;
  }
  const to = from + taken - 1;

  let content = lines.slice(from - 1, to).join("\n");
  const cutMidLine = content.length > READ_MAX_CHARS;
  if (cutMidLine) content = content.slice(0, READ_MAX_CHARS);

  const isWholeFile = from === 1 && to === lines.length && !cutMidLine;
  if (isWholeFile) return { toolCallId, content };

  const notes = [`lines ${from}-${to} of ${lines.length} shown`];
  if (cutMidLine) {
    notes.push(
      `line ${from} is longer than the ${READ_MAX_CHARS}-character limit and was cut mid-line`,
    );
  }
  if (to < lines.length) notes.push(`call read_file again with start_line=${to + 1} to continue`);
  return { toolCallId, content: `${content}\n\n[... ${notes.join("; ")} ...]` };
}
