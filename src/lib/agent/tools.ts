/**
 * Tool implementations for the agent runtime.
 *
 * This module owns the *handlers* — reading lore, listing/reading project
 * files. Wire definitions and dispatch live in registry.ts; the loop that
 * drives calls lives in runtime.ts; the path-containment helpers that keep
 * model-controlled path arguments inside the project live in lib/paths.ts,
 * shared with the file-mutation actions in stores/projectStore.
 */

import { isChapterFile, naturalCompare } from "../context/outline";
import { isHtmlPath } from "../fs/images";
import { isPptxPath, readPptxSlides, type SlideRange } from "../fs/pptx";
import { readHtmlSlideRange, splitHtmlSlides } from "../pptx/htmlSlides";
import { fileExists, readFile } from "../fs/fileio";
import { IMAGE_EXT_LIST, MAX_IMAGE_BYTES, isImagePath } from "../fs/images";
import { downscaleNote, imageForModel, type Downscaled } from "../image/normalize";
import { collectionViews, entityCollections, imageSlotChecklistText, outOfScopeCount, readEntityFile, scopeLoreIndex, slotChecklistText, type LoreEntity, type LoreIndex } from "../lore";
import { findCategory, loreCategories } from "../profile/active";
import { categoryRef } from "../profile/model";
import {
  baseName,
  decodeLinkSegments,
  isPathWithin,
  resolveRelativePath,
  resolveWorkspacePath,
} from "../paths";
import { readDirRecursive, type FileNode } from "../project";
import { numberLines } from "./lineEcho";

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

/**
 * The lore index as the model sees it, narrowed to the author's 取材范围 when
 * one is set (see lib/lore/collections).
 *
 * The out-of-scope count is reported rather than hidden. A silently shortened
 * list reads as "this project has six entries", and the model then confidently
 * tells the author their character does not exist; the honest version lets it
 * say "there are others outside the current collection — name one and I can
 * still read it", which is exactly what the fence allows.
 */
export function formatLoreIndex(
  loreIndex: LoreIndex,
  scope?: string | null,
  declared?: readonly string[],
  isZh = false,
): string {
  const scoped = scopeLoreIndex(loreIndex, scope ?? null);
  const hidden = outOfScopeCount(loreIndex, scope ?? null);
  const fence = scope
    ? `\n\n(The author has narrowed the working set to the collection "${scope}". ` +
      `${hidden} further ${hidden === 1 ? "entry is" : "entries are"} filed elsewhere and left out of this list — ` +
      `you can still read one by name if the author asks for it, but do not go looking through them on your own.)`
    : "";
  // 集合：先报有哪些，再在每条后面标它归在哪。没有集合的项目一个字都不多花。
  //
  // 这一段是**结果文本**、不是 schema——只在模型真的调用时计费，不吃每轮常驻的
  // 工具预算。而少了它，模型要归档就得先把条目一条条读一遍才知道现有的归档长什么
  // 样，那才是真的贵。
  const views = collectionViews(loreIndex, [...(declared ?? [])]);
  const filed = views.length > 0;
  const catalogue = filed
    ? `Collections: ${views.map((v) => `${v.name} (${v.count})`).join(" · ")}` +
      `\nAn entry belongs to any number of them, or none. They are the author's own filing scheme — file into an existing one rather than inventing a name.\n`
    : "";

  const lines: string[] = [];
  for (const [category, entities] of Object.entries(scoped)) {
    if (!entities.length) continue;
    // An orphan category — no enabled pack declares it (see lib/lore/categories).
    // Its entries read and edit like any other, but `create_lore_entity` and
    // `move_lore_entity` refuse it, so say so here rather than letting the model
    // discover it by having a call rejected. A declared category is rendered
    // through `categoryRef` — the author speaks the label, the tools take the
    // id, and this listing is the one place the model learns they are the same
    // thing (an id-only listing is how "characters" and a new 「人物」 end up
    // coexisting as duplicates).
    const cat = findCategory(category);
    const orphan = cat
      ? ""
      : "  (no enabled capability pack declares this category — you can read and edit these entries, but you cannot create or move entries into it)";
    lines.push(`[${cat ? categoryRef(cat, isZh) : category}]${orphan}`);
    for (const e of entities) {
      // 归属跟在名字后面，未归集的什么都不写——「没有方括号」就是未归集，比写一个
      // "(unfiled)" 便宜，而且让一眼扫下去哪些还没分家变得显眼。
      const cols = filed ? entityCollections(e) : [];
      const tag = cols.length > 0 ? ` [${cols.join(", ")}]` : "";
      lines.push(`  - ${e.name}${tag}: ${e.summary || "(no summary)"}`);
    }
  }

  // Declared-but-empty categories, rendered as one line rather than one header
  // each. Without it, a project whose entries have not reached the pack's
  // categories yet reads as "this project has no 人物 category" — which is
  // exactly the misread that makes the model propose creating a duplicate.
  // Suppressed under a 取材范围: a category emptied by the fence is not empty,
  // and the fence note already explains the narrowing.
  const empty = scope
    ? []
    : loreCategories().filter((c) => !(scoped[c.id]?.length));
  const emptyNote = empty.length
    ? `\n\nCategories with no entries yet (valid targets for create_lore_entity / move_lore_entity): ${empty.map((c) => categoryRef(c, isZh)).join(", ")}.`
    : "";
  // Only worth a sentence when at least one id(label) pair actually rendered.
  const hasLabels =
    loreCategories().some((c) => categoryRef(c, isZh) !== c.id) &&
    (lines.length > 0 || empty.length > 0);
  const labelHint = hasLabels
    ? "\n(Categories read id(author-facing label) — category parameters take the id, never the label.)"
    : "";

  if (lines.length === 0) {
    if (scope) return `No lore entities in the collection "${scope}".${fence}`;
    return `No lore entities found in this project.${emptyNote}${labelHint}`;
  }
  return catalogue + lines.join("\n") + emptyNote + labelHint + fence;
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

  // Mutual-exclusion groups, from the scan. The injection path enforces them
  // (lib/context/loreSelect picks one member per group); this path cannot,
  // because reading an entity means reading all of it. So say so: without the
  // note the model gets both of a character's outfits with equal standing and
  // writes a scene that mixes them — which reads as a model failure and is
  // actually a missing sentence. Result text, not schema: it costs nothing
  // until the tool is actually called.
  const groupOf = new Map<string, string>();
  for (const f of found.facets ?? []) {
    if (f.group) groupOf.set(f.file, f.group);
  }

  const filenames = found.mdFiles?.length ? found.mdFiles : ["index.md"];
  const parts: string[] = [];
  for (const filename of filenames) {
    if (filename === "images.md") continue; // surfaced separately as the gallery block
    try {
      const content = await readEntityFile(found.dirPath, filename);
      const group = groupOf.get(filename);
      const note = group
        ? ` [group: ${group} — mutually exclusive with the other facets in this group; use only one of them in any single scene]`
        : "";
      parts.push(`=== ${filename} ===${note}\n${content}`);
    } catch {
      // skip unreadable files silently
    }
  }

  const galleryLines: string[] = [];
  if (found.avatarPath) {
    const fname = baseName(found.avatarPath) || "avatar";
    galleryLines.push(`- ${fname}: (avatar)`);
  }
  for (const img of found.images) {
    const slot = img.slot ? ` [slot: ${img.slot}]` : "";
    galleryLines.push(`- ${img.file}: ${img.desc || "(no description)"}${slot}`);
  }
  if (galleryLines.length) {
    // The folder comes with the listing, because the listing is filenames and
    // a filename is not enough to *show* one of these to the author: the chat
    // resolves a picture link against the project root and inlines it only if
    // it lands inside the project (lib/agent/chatImages), so a bare filename
    // resolves to nothing and renders as an empty box. Once in the header, not
    // once per line — they are all files in the same directory.
    const where = `they are files in ${found.dirPath}, and embedding one in a reply needs that full path`;
    const header = multimodal
      ? `=== images === (descriptions; call read_lore_image(entity: "${name}", file: ...) to view one; ${where})`
      : `=== images === (text descriptions only — current model is text-only; ${where})`;
    parts.push(`${header}\n${galleryLines.join("\n")}`);
  }

  // The category's type schema, with what currently covers each slot. The facet
  // files above already show their own `slot:` frontmatter; what they cannot show
  // is which slots exist and which are still empty — and that is exactly what
  // `update_facet_meta`'s `slot` argument needs. Empty for a category with no
  // schema, which is a normal state and prints nothing at all. Image slots get
  // the same treatment: they are what `update_lore_image` / `generate_image`'s
  // `slot` argument names.
  const checklist = slotChecklistText(found);
  if (checklist) parts.push(`=== facet slots ===\n${checklist}`);
  const imageChecklist = imageSlotChecklistText(found);
  if (imageChecklist) parts.push(`=== image slots ===\n${imageChecklist}`);

  return { toolCallId, content: parts.join("\n\n") || "(no content)" };
}

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

  const avatarName = found.avatarPath ? baseName(found.avatarPath) : undefined;
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
    const { dataUrl, bytes, downscaled } = await imageForModel(path);
    if (bytes.length > MAX_IMAGE_BYTES) return { toolCallId, content: tooLargeError(file, bytes.length) };
    return {
      toolCallId,
      content: `Image "${file}" from ${name}.${shrunkNote(downscaled)}`,
      imageDataUrls: [dataUrl],
    };
  } catch (e) {
    return { toolCallId, content: `Error reading "${file}": ${String(e)}` };
  }
}

function tooLargeError(label: string, bytes: number): string {
  return `Error: "${label}" is too large to attach (${(bytes / 1024 / 1024).toFixed(1)}MB, limit ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`;
}

/**
 * Told to the model, not just to the author: a picture that arrived downscaled
 * is one whose fine print may no longer be legible, and a model that reads a
 * blurred label confidently is worse than one that says it cannot.
 */
function shrunkNote(downscaled: Downscaled | undefined): string {
  return downscaled ? ` Downscaled to fit the size limit (${downscaleNote(downscaled)}).` : "";
}

/**
 * A markdown link's path, percent-decoding each segment.
 *
 * `imageMarkdown` (lib/image/assets) writes illustration links encoded, so the
 * link the model reads out of a chapter is `assets/%E7%AC%AC%E4%B8%89%E7%AB%A0/img-1.png`
 * — which names no file on disk. Tried *after* the path as given, since a
 * filename may legitimately contain a `%`.
 */
const decodeLinkPath = decodeLinkSegments;

/**
 * View any image in the project as visual input — the counterpart to
 * `read_lore_image`, for pictures that don't belong to a lore entity: a
 * chapter's illustrations under its sibling `assets/`, and whatever reference
 * art the author keeps in the project folder.
 *
 * Containment is against the whole **project**, `.ai-writer` included — wider
 * than `read_file`. That tool excludes `.ai-writer` because a model tricked
 * into calling it could read `profile.json` or the lore's text back to
 * whoever planted the instruction; an image tool can't — it decodes one file,
 * by extension, into pixels the model looks at, and lore gallery images live
 * under `.ai-writer/lore/` where this tool must still reach them. Traversal
 * outside the project is still refused.
 */
export async function readProjectImage(
  toolCallId: string,
  rawPath: string,
  projectPath: string,
  multimodal: boolean,
): Promise<ToolResult> {
  if (!multimodal) {
    return { toolCallId, content: "Error: the active model is text-only and cannot accept images." };
  }
  // Containment is a prefix test, and every absolute path is inside the empty
  // prefix — so a surface that runs the loop without a project (the lore
  // generator passes "") would turn this into "read any image on the disk".
  if (!projectPath) {
    return { toolCallId, content: "Error: no project is open — do not call this tool here." };
  }
  const wanted = rawPath.trim();
  if (!wanted) return { toolCallId, content: "Error: 'path' argument is required." };

  // Relative paths resolve against the project root — `resolveRelativePath`
  // returns an absolute one unchanged, so both spellings go through one call.
  const candidates = [...new Set([wanted, decodeLinkPath(wanted)])]
    .map((p) => resolveRelativePath(projectPath, p));

  if (!candidates.some(isImagePath)) {
    return {
      toolCallId,
      content: `Error: "${wanted}" is not an image (expected one of: ${IMAGE_EXT_LIST}). Text files are read with read_file.`,
    };
  }
  const inside = candidates.filter((p) => isPathWithin(projectPath, p));
  if (!inside.length) {
    return { toolCallId, content: "Error: Path is outside the project folder." };
  }

  let path: string | null = null;
  for (const p of inside) {
    if (await fileExists(p)) { path = p; break; }
  }
  if (!path) {
    return {
      toolCallId,
      // Says how to build a correct path rather than just refusing: the two
      // ways to reach an image differ, and a bare "not found" leaves the model
      // retrying the same wrong spelling.
      content: `Error: no image at "${inside[0]}". Absolute paths come from list_files (its folder line + "/" + the filename); a link written inside a document — ![](assets/…) — is relative to that document's own folder, so join the two.`,
    };
  }

  try {
    const { dataUrl, bytes, downscaled } = await imageForModel(path);
    const name = baseName(path) || path;
    if (bytes.length > MAX_IMAGE_BYTES) return { toolCallId, content: tooLargeError(name, bytes.length) };
    return {
      toolCallId,
      content: `Image "${name}" from ${path}.${shrunkNote(downscaled)}`,
      imageDataUrls: [dataUrl],
    };
  } catch (e) {
    return { toolCallId, content: `Error reading "${path}": ${String(e)}` };
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
 * List the project's document tree, recursively.
 *
 * Grouped as `ls -R` does — absolute directory path, then its filenames
 * indented — rather than one absolute path per line: repeating a long project
 * prefix on every one of several hundred chapters costs more context than the
 * listing itself is worth.
 *
 * `.ai-writer/` never appears: the tree comes from `readDirRecursive`, whose
 * Rust side skips dotfiles, and the model-controlled `folder` argument is
 * refused by `isWorkspacePath` if it points inside it.
 */
export async function listWritingFiles(
  toolCallId: string,
  projectPath: string,
  folder?: string,
): Promise<ToolResult> {
  // The folder argument is model-controlled — reject `../` escapes and the
  // app's own .ai-writer data; relative and absolute spellings both resolve,
  // and the empty-projectPath guard lives in the check.
  const target = folder ? resolveWorkspacePath(projectPath, folder) : projectPath || null;
  if (!target) {
    return { toolCallId, content: "Error: Folder is outside the project (the app's .ai-writer data is off-limits)." };
  }

  const scope = folder || "the project folder";
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

/**
 * What full-text search scans: manuscript files plus .html deliverables.
 * A separate predicate rather than widening `isChapterFile` — that one also
 * decides what enters the outline/spine, and an HTML artifact is a deliverable,
 * not a chapter (docs/feature/html-artifact-plan.md §3 三期).
 */
function isSearchableFile(name: string): boolean {
  return isChapterFile(name) || isHtmlPath(name);
}

/** Searchable files under a recursively-listed tree, depth-first. */
function collectChapterFiles(nodes: FileNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.is_dir) collectChapterFiles(n.children ?? [], out);
    else if (isSearchableFile(n.name)) out.push(n.path);
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

  // The folder argument is model-controlled — reject `../` escapes and the
  // app's own .ai-writer data; relative and absolute spellings both resolve,
  // and the empty-projectPath guard lives in the check.
  const target = folder ? resolveWorkspacePath(projectPath, folder) : projectPath || null;
  if (!target) {
    return { toolCallId, content: "Error: Folder is outside the project (the app's .ai-writer data is off-limits)." };
  }

  const files: string[] = [];
  try {
    collectChapterFiles(await readDirRecursive(target), files);
  } catch (e) {
    return { toolCallId, content: `Error searching: ${String(e)}` };
  }
  files.sort(naturalCompare);

  const scope = folder || "the project folder";
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
  rawPath: string,
  projectPath: string,
  startLine?: number,
): Promise<ToolResult> {
  // The path argument is model-controlled. A plain startsWith check would
  // accept `../` traversal (`/project/../etc/x`) and prefix siblings
  // (`/project-evil/x`), so compare lexically normalized paths on whole
  // component boundaries. Scoped to the project root minus `.ai-writer/` —
  // lore, memory, and profile.json have their own tools with their own
  // approval protocols, so a prompt-injected model can't read them here.
  const path = resolveWorkspacePath(projectPath, rawPath);
  if (!path) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }

  // A presentation is a zip: reading it as text returns noise. Say which tool
  // does read it rather than letting the model spend a round on the noise.
  if (isPptxPath(path)) {
    return {
      toolCallId,
      content: `Error: "${path}" is a PowerPoint presentation, not a text file. Use read_slides to read it.`,
    };
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
  // The gutter note rides on every read, whole file included: it is the only
  // place the "these digits are not in the file" rule is stated, and stating it
  // here — in the same result the numbers arrive in — is both free and better
  // placed than a sentence in four tool descriptions would be (plan §D1).
  const notes = [
    isWholeFile
      ? `whole file, ${lines.length} line${lines.length === 1 ? "" : "s"}`
      : `lines ${from}-${to} of ${lines.length} shown`,
    "the number before each tab is the line number, not file content — never copy it into an edit",
  ];
  if (cutMidLine) {
    notes.push(
      `line ${from} is longer than the ${READ_MAX_CHARS}-character limit and was cut mid-line`,
    );
  }
  if (to < lines.length) notes.push(`call read_file again with start_line=${to + 1} to continue`);
  return { toolCallId, content: `${numberLines(content, from)}\n\n[... ${notes.join("; ")} ...]` };
}

/** Characters one read_slides call may return, before it pages. */
const SLIDES_MAX_CHARS = 4000;

/**
 * A slide range, plus the note telling the model where it is in the deck.
 *
 * Pure and exported so the paging protocol is testable without Tauri. It
 * deliberately reads like `read_file`'s trailer: the two tools page through
 * different things, but a model that has learned one should not have to learn
 * the other.
 */
export function formatSlideRange(range: SlideRange): string {
  if (range.total_slides === 0) return range.markdown;

  const whole = range.from_slide === 1 && range.next_slide === null;
  if (whole) return range.markdown;

  const notes = [
    `slides ${range.from_slide}-${range.to_slide} of ${range.total_slides} shown`,
  ];
  if (range.next_slide !== null) {
    notes.push(`call read_slides again with start_slide=${range.next_slide} to continue`);
  }
  return `${range.markdown}\n\n[... ${notes.join("; ")} ...]`;
}

/**
 * Read a .pptx presentation, a range of slides at a time.
 *
 * Separate from `read_file` rather than folded into it: a presentation is not
 * text on disk (it is a zip of XML, so `read_file` returns binary noise for
 * it), its natural paging unit is the slide rather than the line, and the two
 * tools' arguments would otherwise mean different things depending on the
 * file's extension. Containment is `read_file`'s — the workspace minus the
 * app's own `.ai-writer/` data.
 */
export async function readSlidesFile(
  toolCallId: string,
  rawPath: string,
  projectPath: string,
  startSlide?: number,
): Promise<ToolResult> {
  const path = resolveWorkspacePath(projectPath, rawPath);
  if (!path) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }

  // An .html deck pages by slide too. Same tool rather than a second one: the
  // model's question is "show me slide 7", and which of the two file kinds the
  // deck happens to be saved as is not part of that question. The source comes
  // back verbatim, because the next thing the model does with it is quote a
  // piece of it into propose_edit.
  if (isHtmlPath(path)) {
    let html: string;
    try {
      html = await readFile(path);
    } catch (e) {
      return { toolCallId, content: `Error reading file: ${String(e)}` };
    }
    const slides = splitHtmlSlides(html);
    const from = startSlide === undefined ? 1 : Math.max(1, Math.floor(startSlide));
    if (from > slides.length) {
      return {
        toolCallId,
        content: `Error: start_slide ${from} is past the end — this page has ${slides.length} slide(s).`,
      };
    }
    return { toolCallId, content: formatSlideRange(readHtmlSlideRange(html, from, SLIDES_MAX_CHARS)) };
  }

  if (!isPptxPath(path)) {
    return {
      toolCallId,
      content:
        `Error: "${path}" is neither a .pptx nor an .html file. read_slides reads presentations only — ` +
        "use read_file for text documents. Legacy .ppt (PowerPoint 97-2003) cannot be " +
        "read at all; it has to be saved as .pptx first.",
    };
  }

  const from = startSlide === undefined ? undefined : Math.max(1, Math.floor(startSlide));
  let range: SlideRange;
  try {
    range = await readPptxSlides(path, from, SLIDES_MAX_CHARS);
  } catch (e) {
    return { toolCallId, content: `Error reading presentation: ${String(e)}` };
  }
  return { toolCallId, content: formatSlideRange(range) };
}
