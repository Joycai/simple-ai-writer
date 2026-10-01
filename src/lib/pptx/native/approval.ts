/** Ephemeral, bounded approval artifacts. Only receipts enter chat JSON; restart requires a fresh proposal. */
import { copyPath, fileExists, fromBase64, makeDir, readFileHead, readFileRange, removeFile, renamePath, writeBinaryFile } from '../../fs/fileio';
import { resolveWorkspacePath } from '../../paths';
import { DECK_LIMITS } from './model';
import { parseDeckSpec } from './validate';
import { resolveDeck } from './resolve';
import { nativeEnvironment } from './environment';
import { nativeDeckToPptx } from './write';
import { DECK_THEMES, type ThemeId } from './theme';
import type { DeckDiagnostic, DeckDiagnosticCode } from './diagnostics';

export interface NativePptxReceipt {
  artifactId: string;
  sourceHash: string;
  themeHash: string;
  imageHashes: { path: string; hash: string }[];
  outputHash: string;
  targetHash: string | null;
  theme: ThemeId;
  fonts: { latin: string; cjk: string };
  slides: number;
}
interface Artifact {
  project: string;
  source: string;
  target: string;
  receipt: string;
  bytes: Uint8Array;
}
const artifacts = new Map<string, Artifact>();
// Pending cards must not retain unbounded media in the renderer.
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PENDING = 8;
const applying = new Set<string>();

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
const digestJson = (value: unknown) => digest(new TextEncoder().encode(JSON.stringify(value)));

async function boundedRead(project: string, path: string, limit: number): Promise<Uint8Array> {
  const { size } = await readFileHead(path, 0, project);
  if (size > limit) throw new Error('File exceeds the native PPTX approval size limit.');
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    const count = Math.min(1024 * 1024, size - offset);
    const part = await readFileRange(path, offset, count, project);
    if (part.length !== count) throw new Error('File changed during preflight; export again.');
    bytes.set(part, offset);
  }
  if ((await readFileHead(path, 0, project)).size !== size) throw new Error('File changed during preflight; export again.');
  return bytes;
}
const targetHash = async (project: string, path: string) => await fileExists(path)
  ? digest(await boundedRead(project, path, MAX_BYTES)) : null;

const fixes: Record<DeckDiagnosticCode, string> = {
  invalid_json: 'Use valid JSON without markdown fences.', source_limit: 'Split the source into smaller decks.',
  unsupported_version: 'Use version 1.', invalid_type: 'Use the field type in the native PPTX workflow.',
  unknown_field: 'Remove this unsupported field.', invalid_value: 'Use an allowed value from the workflow.',
  limit_exceeded: 'Reduce this field or split the content across slides.', duplicate_id: 'Give each item a unique id.',
  unsafe_path: 'Use a project-relative PNG/JPEG path without traversal.', missing_asset: 'Declare the referenced asset.',
  table_width: 'Give every row exactly as many cells as columns.', invalid_image: 'Use a readable local PNG/JPEG.',
  image_limit: 'Reduce image dimensions or bytes.', unsupported_layout: 'Choose one of the six supported layouts.',
  text_overflow: 'Shorten this text or split the slide; tables allow six columns and seven body rows.',
  measurement_failed: 'Retry after fonts load; simplify text if it persists.', missing_font: 'Install a theme font before exporting.',
};
export function formatNativeDiagnostics(diagnostics: DeckDiagnostic[]): string {
  return diagnostics.slice(0, 20).map(d => `${d.code} ${d.slideId ? `slide=${d.slideId} ` : ''}${d.path || '/'}: ${fixes[d.code]}`).join('\n')
    + (diagnostics.length > 20 ? `\n${diagnostics.length - 20} more diagnostic(s).` : '');
}

export async function prepareNativePptx(project: string, source: string, target: string, expectedSource?: string): Promise<
  { ok: true; receipt: NativePptxReceipt } | { ok: false; diagnostics: DeckDiagnostic[] }
> {
  if (resolveWorkspacePath(project, source) !== source || resolveWorkspacePath(project, target) !== target)
    throw new Error('PPTX paths must be inside the project.');
  if ((await readFileHead(source, 0, project)).size > DECK_LIMITS.sourceBytes)
    return { ok: false, diagnostics: [{ code: 'source_limit', path: '' }] };
  const sourceBytes = await boundedRead(project, source, DECK_LIMITS.sourceBytes);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  if (expectedSource !== undefined && text !== expectedSource)
    throw new Error('PPTX source changed on disk. Reload the source and review again.');
  const parsed = parseDeckSpec(text);
  if (!parsed.ok) return parsed;
  const unsafe = parsed.value.assets.flatMap((asset, i) => resolveWorkspacePath(project, asset.path)
    ? [] : [{ code: 'unsafe_path' as const, path: `/assets/${i}/path` }]);
  if (unsafe.length) return { ok: false, diagnostics: unsafe };
  const resolved = await resolveDeck(parsed.value, nativeEnvironment(project));
  if (!resolved.ok) return resolved;
  const imageHashes = await Promise.all(resolved.value.images.map(async image => ({
    path: parsed.value.assets.find(a => a.id === image.assetId)!.path,
    hash: await digest(fromBase64(image.data.slice(image.data.indexOf(',') + 1))),
  })));
  const bytes = await nativeDeckToPptx(resolved.value);
  const receipt: NativePptxReceipt = {
    artifactId: crypto.randomUUID(), sourceHash: await digest(sourceBytes),
    themeHash: await digestJson(resolved.value.theme), imageHashes,
    outputHash: await digest(bytes), targetHash: await targetHash(project, target),
    theme: parsed.value.theme, fonts: { ...resolved.value.fonts }, slides: resolved.value.slides.length,
  };
  if (artifacts.size >= MAX_PENDING || bytes.length + [...artifacts.values()].reduce((n, a) => n + a.bytes.length, 0) > MAX_BYTES)
    throw new Error('Too many pending PPTX exports. Finish a pending approval and export again.');
  artifacts.set(receipt.artifactId, { project, source, target, receipt: JSON.stringify(receipt), bytes: bytes.slice() });
  return { ok: true, receipt };
}

export function releaseNativePptx(artifactId: string): void { artifacts.delete(artifactId); }

/** No regeneration here: stale inputs, lost cache, changed destination all require a new card. */
export async function applyNativePptx(project: string, source: string, target: string, receipt: NativePptxReceipt, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const artifact = artifacts.get(receipt.artifactId);
  if (!artifact || artifact.project !== project || artifact.source !== source || artifact.target !== target || artifact.receipt !== JSON.stringify(receipt))
    throw new Error('PPTX approval expired or changed. Run export_pptx again for a fresh review.');
  if (applying.has(target)) throw new Error('Another PPTX export is writing this destination. Export again.');
  applying.add(target);
  try {
    if (await digest(await boundedRead(project, source, DECK_LIMITS.sourceBytes)) !== receipt.sourceHash ||
        await digestJson(DECK_THEMES[receipt.theme]) !== receipt.themeHash)
      throw new Error('PPTX source or theme changed. Run export_pptx again for a fresh review.');
    for (const image of receipt.imageHashes) {
      if (await digest(await boundedRead(project, `${project}/${image.path}`, DECK_LIMITS.imageBytes)) !== image.hash)
        throw new Error('PPTX image changed. Run export_pptx again for a fresh review.');
    }
    if (await targetHash(project, target) !== receipt.targetHash)
      throw new Error('PPTX destination changed. Run export_pptx again to review the overwrite.');
    signal?.throwIfAborted();
    let backup: string | null = null;
    if (receipt.targetHash !== null) {
      const dir = `${project}/.ai-writer/backups`;
      await makeDir(dir);
      backup = `${dir}/pptx-${crypto.randomUUID()}.pptx`;
      await copyPath(target, backup);
      // Copy bytes, never decode an existing Office file as text.
      if (await targetHash(project, backup) !== receipt.targetHash || await targetHash(project, target) !== receipt.targetHash)
        throw new Error('PPTX destination changed during backup. Export again.');
    }
    signal?.throwIfAborted();
    // Stage beside the destination, then replace its directory entry. This also
    // avoids following a destination symlink/hard link and overwriting an input.
    const staged = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeBinaryFile(staged, artifact.bytes);
      signal?.throwIfAborted();
      if (await targetHash(project, target) !== receipt.targetHash)
        throw new Error('PPTX destination changed while preparing the write. Export again.');
      await renamePath(staged, target);
    } finally {
      await removeFile(staged).catch(() => {});
    }
    releaseNativePptx(receipt.artifactId);
    return backup;
  } finally { applying.delete(target); }
}
