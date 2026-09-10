/**
 * The conversion cache's one module that touches the disk: read the source,
 * key it by content, hand back the cached markdown or convert and store it.
 *
 * Layout of one entry (docs/feature/agent/document-read-plan.md D2):
 *
 *   .ai-writer/tmp/convert/<key>/
 *     document.md   ← `convertToMarkdown`'s markdown, byte-for-byte what an
 *                     import would have written beside the source
 *     assets/…      ← the pictures it links to (relative links, D8)
 *     meta.json     ← ConvertCacheMeta
 *
 * An entry is written to `<key>.tmp-<random>/` and renamed into place once
 * complete (D12), so a reader never sees a half-written one and two parallel
 * conversions of the same file cannot corrupt each other — the loser simply
 * discards its copy. A sweep runs once per project per launch, on the first
 * call (D10): not at project open, which is already the busiest moment.
 */

import {
  fileExists,
  makeDir,
  readBinaryFile,
  readDir,
  readFile,
  removeDir,
  renamePath,
  writeBinaryFile,
  writeFile,
} from "../fs/fileio";
import { convertToMarkdown, MAX_IMPORT_BYTES, type ConvertExt } from "./index";
import {
  CACHE_ASSET_DIR,
  CACHE_DOCUMENT_NAME,
  CACHE_META_NAME,
  CONVERT_CACHE_VERSION,
  cacheDirFor,
  cacheKeyOf,
  cacheRootFor,
  isCurrentMeta,
  parseCacheMeta,
  planSweep,
  sha256Hex,
  type ConvertCacheMeta,
  type SweepEntry,
} from "./cache";

export interface CachedDocument {
  markdown: string;
  /** Absolute entry directory; pictures are under `<dir>/assets`. */
  dir: string;
  pictures: number;
  /** True when the entry already existed and no conversion ran. */
  hit: boolean;
}

/** Projects swept this launch. Module state on purpose: one sweep per launch is the contract. */
const swept = new Set<string>();

/** Test seam: forget which projects were swept. */
export function __resetConvertCacheSweep(): void {
  swept.clear();
}

async function readMeta(dir: string): Promise<ConvertCacheMeta | null> {
  try {
    return parseCacheMeta(await readFile(`${dir}/${CACHE_META_NAME}`));
  } catch {
    return null;
  }
}

async function sweepOnce(projectPath: string, keep: string): Promise<void> {
  if (swept.has(projectPath)) return;
  swept.add(projectPath);
  try {
    const root = cacheRootFor(projectPath);
    if (!(await fileExists(root))) return;
    const entries: SweepEntry[] = [];
    for (const entry of await readDir(root)) {
      if (!entry.isDirectory) continue;
      entries.push({ name: entry.name, meta: await readMeta(entry.path) });
    }
    for (const name of planSweep(entries, Date.now(), keep)) {
      try {
        await removeDir(`${root}/${name}`);
      } catch {
        // Next launch's sweep gets it.
      }
    }
  } catch {
    // A sweep that cannot run is not a reason to refuse the read.
  }
}

/**
 * Convert `sourcePath` (already known to be a `ConvertExt` document inside
 * the workspace) through the cache. Throws with a readable message on a file
 * over the conversion cap or a converter failure; the tool turns that into
 * its error result.
 */
export async function convertCached(
  projectPath: string,
  sourcePath: string,
  ext: ConvertExt,
): Promise<CachedDocument> {
  const bytes = await readBinaryFile(sourcePath);
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(
      `file is ${(bytes.byteLength / 1024 / 1024).toFixed(0)}MB — over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB conversion limit`,
    );
  }
  const key = cacheKeyOf(await sha256Hex(bytes));
  const dir = cacheDirFor(projectPath, key);
  await sweepOnce(projectPath, key);

  const existing = await readMeta(dir);
  if (isCurrentMeta(existing)) {
    try {
      const markdown = await readFile(`${dir}/${CACHE_DOCUMENT_NAME}`);
      // Best-effort: a sidecar that fails to update only means an earlier sweep.
      void writeMeta(dir, { ...existing, lastUsedAt: Date.now() }).catch(() => {});
      return { markdown, dir, pictures: existing.pictures, hit: true };
    } catch {
      // Sidecar without a document: fall through and rebuild the entry.
    }
  }

  const { markdown, assets } = await convertToMarkdown(ext, bytes, CACHE_ASSET_DIR);
  const body = markdown.length ? `${markdown}\n` : "";
  const now = Date.now();
  const meta: ConvertCacheMeta = {
    source: sourcePath,
    ext,
    bytes: bytes.byteLength,
    convertedAt: now,
    lastUsedAt: now,
    version: CONVERT_CACHE_VERSION,
    pictures: assets.length,
  };

  const tmp = `${dir}.tmp-${Math.random().toString(36).slice(2, 8)}`;
  await makeDir(tmp);
  await writeFile(`${tmp}/${CACHE_DOCUMENT_NAME}`, body);
  if (assets.length > 0) {
    await makeDir(`${tmp}/${CACHE_ASSET_DIR}`);
    for (const asset of assets) {
      await writeBinaryFile(`${tmp}/${CACHE_ASSET_DIR}/${asset.name}`, asset.bytes);
    }
  }
  await writeMeta(tmp, meta);

  if (await fileExists(dir)) {
    // Lost the race to a parallel conversion of the same bytes: theirs is
    // identical, keep it and drop ours.
    await removeDir(tmp).catch(() => {});
  } else {
    try {
      await renamePath(tmp, dir);
    } catch (e) {
      // The rename races the same check above; if the entry appeared in
      // between, that is fine. Anything else is a real failure.
      await removeDir(tmp).catch(() => {});
      if (!(await fileExists(dir))) throw e;
    }
  }
  return { markdown: body, dir, pictures: assets.length, hit: false };
}

async function writeMeta(dir: string, meta: ConvertCacheMeta): Promise<void> {
  await writeFile(`${dir}/${CACHE_META_NAME}`, JSON.stringify(meta, null, 2));
}
