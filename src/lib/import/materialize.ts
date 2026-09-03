/**
 * Turn a cached conversion (lib/import/cachedConvert) into a real document in
 * the project — the apply step of the agent's `convert_document` proposal.
 *
 * Why it copies out of the cache instead of converting again: what the author
 * approved on the card was measured from the cached entry (characters,
 * pictures, whether a PDF had a text layer). Re-running the converter at apply
 * time would put a *different* conversion on disk if the source file moved on
 * in between — the exact drift `export_xlsx` builds its workbook at proposal
 * time to rule out. Here the conversion already exists; landing it is a copy
 * plus one link rewrite.
 *
 * The rewrite: the cache links pictures as `assets/<name>` (the entry owns its
 * own `assets/` folder), while a project document's illustrations live in
 * `assets/<文档名>/` beside it (`lib/image/assets`). Same rule the importer
 * follows, so a converted document is byte-for-byte what an import would have
 * produced. Design: docs/feature/agent/document-read-plan.md §10.
 */

import { copyPath, fileExists, makeDir, readDir, readFile, writeFile } from "../fs/fileio";
import { assetRelDirFor } from "../image/assets";
import { baseName, dirName } from "../paths";
import { CACHE_ASSET_DIR, CACHE_DOCUMENT_NAME } from "./cache";
import { markdownName, uniqueImportPath } from "./index";

/** `assets/<文档名>` → `assets/%E6%96%87%E6%A1%A3` — how the converters spell a link. */
export function encodeRelDir(relDir: string): string {
  return relDir.split("/").map(encodeURIComponent).join("/");
}

/**
 * Point every picture link at the document's own asset folder. Only link
 * targets are touched — `](assets/…)` — and only ones under `fromRelDir`, so
 * prose that happens to mention a path is left alone. Pure, for the tests.
 */
export function relinkAssets(markdown: string, fromRelDir: string, toRelDir: string): string {
  const from = `](${encodeRelDir(fromRelDir)}/`;
  const to = `](${encodeRelDir(toRelDir)}/`;
  return markdown.split(from).join(to);
}

/** The intended landing path, before collision numbering: `<same folder>/<stem>.md`. */
export function conversionTargetFor(sourcePath: string): string {
  return `${dirName(sourcePath)}/${markdownName(baseName(sourcePath))}`;
}

/**
 * Write the cached conversion at `cacheDir` beside `sourcePath` as a markdown
 * document, and resolve to where it landed. The source is never touched; a
 * name collision numbers the new file (`报价表-2.md`) exactly as the importer
 * does, and for the same reason — the likeliest collision is an earlier
 * conversion the author has since edited.
 */
export async function materializeConversion(sourcePath: string, cacheDir: string): Promise<string> {
  const docPath = `${cacheDir}/${CACHE_DOCUMENT_NAME}`;
  if (!(await fileExists(docPath))) {
    throw new Error(
      "the approved conversion is no longer in the cache (it may have been swept) — call convert_document again",
    );
  }
  const cached = await readFile(docPath);
  const target = await uniqueImportPath(dirName(sourcePath), markdownName(baseName(sourcePath)));
  const relDir = assetRelDirFor(target);
  await writeFile(target, relinkAssets(cached, CACHE_ASSET_DIR, relDir));

  const assetsDir = `${cacheDir}/${CACHE_ASSET_DIR}`;
  if (await fileExists(assetsDir)) {
    const entries = (await readDir(assetsDir)).filter((e) => !e.isDirectory);
    if (entries.length > 0) {
      const dest = `${dirName(target)}/${relDir}`;
      await makeDir(dest);
      for (const entry of entries) {
        await copyPath(entry.path, `${dest}/${entry.name}`);
      }
    }
  }
  return target;
}
