/**
 * Downloadable font packs — 鸿蒙黑体 (HarmonyOS Sans SC) and MiSans
 * (docs/feature/downloadable-fonts-plan.md).
 *
 * The app doesn't ship these fonts. A pack is downloaded the first time the
 * author picks it, into `<appData>/fonts/<id>/<version>/`, and from then on it
 * is served to the webviews by the `ai-writer-font:` scheme
 * (src-tauri/src/fontproto.rs). The family names are known at build time, so
 * the two font *stacks* live in tokens.css like every other scheme; this module
 * only supplies the bytes and the `@font-face` rules that point at them. Until
 * a pack is here, its family simply isn't found and the stack falls through to
 * the 黑 fallbacks — "not downloaded" degrades with no code of its own.
 *
 * Trust: `fontPackData.ts` pins every file (size + sha256) at dev time. A
 * source only delivers bytes; bytes that don't match are refused and the next
 * source is tried. The sheet's own `unicode-range` split is kept, so the
 * browser fetches only the chunks a page uses.
 *
 * Completion is a marker written **last** (`installed.json`). Without it a
 * pack counts as absent, however many chunks are already on disk — and those
 * chunks are kept, so the retry only fetches what is missing.
 *
 * Lib layer: no store imports. appStore drives this and holds the state.
 */
import { fetch } from "../http";
import {
  fileExists, readDir, readFile, removeDir, removeFile, renamePath, statPath, writeBinaryFile, writeFile,
} from "../fs/fileio";
import { joinPath, toPosixPath } from "../paths";
import { IS_WINDOWS } from "../platform";

export type FontPackId = "harmonyos" | "misans";
export const FONT_PACK_IDS: readonly FontPackId[] = ["harmonyos", "misans"];

export function isFontPackId(value: string): value is FontPackId {
  return (FONT_PACK_IDS as readonly string[]).includes(value);
}

/** `[path, size, sha256 hex]` — the sheet's path is package-relative, a chunk's is relative to its sheet. */
type FileSpec = [path: string, size: number, sha256: string];

export interface FontPackData {
  id: FontPackId;
  pkg: string;
  version: string;
  family: string;
  weights: { weight: number; sheet: FileSpec; chunks: FileSpec[] }[];
}

/** Where each pack's license is published — linked from the settings page. */
export const FONT_PACK_LICENSE: Record<FontPackId, string> = {
  harmonyos: "https://developer.huawei.com/consumer/cn/doc/design-guides/font-0000001828772001",
  misans: "https://hyperos.mi.com/font/",
};

type SourceUrl = (pkg: string, version: string, path: string) => string;
const npmmirror: SourceUrl = (pkg, v, path) => `https://registry.npmmirror.com/${pkg}/${v}/files/${path}`;
const jsdelivr = (host: string): SourceUrl => (pkg, v, path) => `https://${host}/npm/${pkg}@${v}/${path}`;
const unpkg: SourceUrl = (pkg, v, path) => `https://unpkg.com/${pkg}@${v}/${path}`;
const JSDELIVR = ["cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net"].map(jsdelivr);

/**
 * Tried in order, per file. npmmirror first where it serves the package (it is
 * the one reliably fast in mainland China); it refuses the HarmonyOS package
 * outright (403 — not on its unpkg allowlist), so that pack starts at jsDelivr.
 */
export const FONT_PACK_SOURCES: Record<FontPackId, SourceUrl[]> = {
  harmonyos: [...JSDELIVR, unpkg],
  misans: [npmmirror, ...JSDELIVR, unpkg],
};

export type FontPackErrorCode = "network" | "integrity" | "disk";

export class FontPackError extends Error {
  constructor(readonly code: FontPackErrorCode, message: string) {
    super(message);
    this.name = "FontPackError";
  }
}

/** The pinned table, loaded on demand — ~45 KB of hashes the first paint doesn't need. */
export async function fontPackData(id: FontPackId): Promise<FontPackData> {
  const { FONT_PACK_DATA } = await import("./fontPackData");
  const pack = FONT_PACK_DATA.find((p) => p.id === id);
  if (!pack) throw new Error(`unknown font pack ${id}`);
  return pack;
}

/** Everything a pack downloads, in bytes — the progress total and the size on the card. */
export function packBytes(pack: FontPackData): number {
  return pack.weights.reduce((n, w) => n + w.sheet[1] + w.chunks.reduce((m, c) => m + c[1], 0), 0);
}

// ─── Paths ────────────────────────────────────────────────────────────────────

let cachedRoot: string | null = null;

export async function fontsRoot(): Promise<string> {
  if (cachedRoot) return cachedRoot;
  const { appDataDir } = await import("@tauri-apps/api/path");
  cachedRoot = joinPath(await appDataDir(), "fonts");
  return cachedRoot;
}

async function packRoot(id: FontPackId): Promise<string> {
  return joinPath(await fontsRoot(), id);
}

const MARKER = "installed.json";
const FACES = "faces.css";

/**
 * The `ai-writer-font:` URL for a file on disk. Two shapes, as for every
 * custom scheme here: `ai-writer-font://localhost/<path>` on macOS / Linux,
 * `http://ai-writer-font.localhost/<path>` on Windows, where a drive-lettered
 * path gets the synthetic leading slash the Rust parser strips again.
 * Segments are percent-encoded (`Application Support` has a space); the drive
 * colon is left as it is.
 */
export function fontUrl(absPath: string, windows = IS_WINDOWS): string {
  const posix = toPosixPath(absPath);
  const withSlash = posix.startsWith("/") ? posix : `/${posix}`;
  const encoded = withSlash
    .split("/")
    .map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return windows ? `http://ai-writer-font.localhost${encoded}` : `ai-writer-font://localhost${encoded}`;
}

// ─── The face rules ───────────────────────────────────────────────────────────

/**
 * Turn one package sheet into the rules the app injects: every `url()` goes
 * through `urlFor`, the family is the pack's own name and the weight the one
 * pinned for this sheet (the HarmonyOS sheets already agree; normalising means
 * a future package that names its weights differently can't split the family).
 * Comments and everything outside `@font-face` blocks are dropped, and so are
 * `local()` sources: the bytes are on this machine anyway, and the HarmonyOS
 * sheets' family-only `local("HarmonyOS Sans SC")` on the 500 / 700 faces would
 * resolve to an installed Regular and draw bold text in the regular cut.
 */
export function rewriteFaces(css: string, family: string, weight: number, urlFor: (name: string) => string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const faces = clean.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  return faces
    .map((face) =>
      face
        .replace(/\s+/g, " ")
        .replace(/font-family\s*:[^;}]*/, `font-family:"${family}"`)
        .replace(/font-weight\s*:[^;}]*/, `font-weight:${weight}`)
        .replace(/local\([^)]*\)\s*,\s*/g, "")
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_m, _q, name: string) => `url("${urlFor(name.replace(/^\.\//, ""))}")`),
    )
    .join("\n");
}

/**
 * `faces.css` stores bare chunk names, not paths: the app-data folder can
 * move (a roaming profile, an account migration), and URLs baked in at install
 * time would then point at nothing — the scheme refuses them and the font
 * silently falls back. The URL is made here, from where the pack is *now*.
 */
function resolveFaces(stored: string, dir: string): string {
  return stored.replace(/url\("([^"/\\]+)"\)/g, (_m, name: string) => `url("${fontUrl(joinPath(dir, name))}")`);
}

// ─── Install state ────────────────────────────────────────────────────────────

/** True when the pack's marker is on disk and names the pinned version. */
export async function readInstalled(id: FontPackId): Promise<boolean> {
  const marker = joinPath(await packRoot(id), MARKER);
  try {
    if (!(await fileExists(marker))) return false;
    const { version } = JSON.parse(await readFile(marker)) as { version?: string };
    return version === (await fontPackData(id)).version;
  } catch {
    return false;
  }
}

const facesCache = new Map<FontPackId, string>();

/**
 * The injected rules for the given (installed) packs. Read once per pack and
 * kept: the file only changes by a reinstall, which calls {@link forgetFaces}.
 */
export async function packFacesCss(ids: FontPackId[]): Promise<string> {
  const parts: string[] = [];
  for (const id of ids) {
    let css = facesCache.get(id);
    if (css === undefined) {
      const pack = await fontPackData(id);
      const dir = joinPath(await packRoot(id), pack.version);
      css = resolveFaces(await readFile(joinPath(dir, FACES)), dir);
      facesCache.set(id, css);
    }
    parts.push(css);
  }
  return parts.join("\n");
}

function forgetFaces(id: FontPackId): void {
  facesCache.delete(id);
}

// ─── Download ─────────────────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A source that accepts the connection and then stalls must not hold a download forever. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Per file. The largest chunk is ~110 KB — a minute is generous even on a throttled line. */
const FILE_TIMEOUT_MS = 60_000;

/**
 * One pinned file, from the first source whose bytes match, trying sources
 * from `order.start` (the last one that worked this install — a source that
 * is black-holed shouldn't cost its connect timeout on every one of ~250
 * files). A source that errors, times out or answers non-2xx counts as
 * unreachable; one that answers with other bytes counts as a mismatch. Only
 * when *every* source served wrong bytes is it an integrity failure — one
 * unreachable source among them makes the likelier story a network one.
 */
async function fetchPinned(pack: FontPackData, path: string, spec: FileSpec, order: { start: number }): Promise<Uint8Array> {
  const sources = FONT_PACK_SOURCES[pack.id];
  let unreachable = 0;
  let mismatched = 0;
  for (let k = 0; k < sources.length; k++) {
    const i = (order.start + k) % sources.length;
    let bytes: Uint8Array;
    try {
      const init = { signal: AbortSignal.timeout(FILE_TIMEOUT_MS), connectTimeout: CONNECT_TIMEOUT_MS };
      const res = await fetch(sources[i](pack.pkg, pack.version, path), init as RequestInit);
      if (!res.ok) {
        unreachable++;
        continue;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      unreachable++;
      continue;
    }
    if (bytes.length === spec[1] && (await sha256Hex(bytes)) === spec[2]) {
      order.start = i;
      return bytes;
    }
    mismatched++;
  }
  if (mismatched > 0 && unreachable === 0) {
    throw new FontPackError("integrity", `${path}: no source served the pinned bytes`);
  }
  throw new FontPackError("network", `${path}: no source reachable`);
}

async function onDisk<T>(what: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw new FontPackError("disk", `${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** How many chunks download at once — enough to hide per-request latency, few enough to be polite to a CDN. */
const CONCURRENCY = 6;

interface InstallOptions {
  /** Bytes done / bytes total; `done` only grows, and ends at `total`. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Download, verify and install a pack. Idempotent and resumable: a chunk
 * already on disk at its pinned size is kept. Throws {@link FontPackError};
 * on failure nothing is marked installed.
 */
export async function installFontPack(id: FontPackId, opts: InstallOptions = {}): Promise<void> {
  const pack = await fontPackData(id);
  const root = await packRoot(id);
  const dir = joinPath(root, pack.version);
  const total = packBytes(pack);
  let done = 0;
  const advance = (n: number) => {
    done += n;
    opts.onProgress?.(done, total);
  };
  opts.onProgress?.(0, total);
  const order = { start: 0 };

  // Sheets first: they're small, and a sheet naming a chunk the table doesn't
  // pin means the table and the package disagree — stop before any chunk.
  const faces: string[] = [];
  for (const w of pack.weights) {
    const [path] = w.sheet;
    const css = new TextDecoder().decode(await fetchPinned(pack, path, w.sheet, order));
    const pinned = new Set(w.chunks.map((c) => c[0]));
    const named = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2].replace(/^\.\//, ""));
    const stray = named.find((n) => !pinned.has(n));
    if (stray) throw new FontPackError("integrity", `${path} names an unpinned file: ${stray}`);
    faces.push(rewriteFaces(css, pack.family, w.weight, (name) => name));
    advance(w.sheet[1]);
  }

  const jobs = pack.weights.flatMap((w) => {
    const sheetDir = w.sheet[0].slice(0, w.sheet[0].lastIndexOf("/") + 1);
    return w.chunks.map((spec) => ({ spec, remote: sheetDir + spec[0], local: joinPath(dir, spec[0]) }));
  });
  // The first failure stops the queue, and the install only rejects once
  // every worker has come back: a worker still writing after the caller saw
  // the error would race a retry started from that error.
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && next < jobs.length) {
      const { spec, remote, local } = jobs[next++];
      try {
        const existing = await statPath(local).catch(() => null);
        if (existing && !existing.isDir && existing.size === spec[1]) {
          advance(spec[1]);
          continue;
        }
        const bytes = await fetchPinned(pack, remote, spec, order);
        await onDisk(local, () => writeAside(local, (tmp) => writeBinaryFile(tmp, bytes)));
        advance(spec[1]);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  if (failure !== null) throw failure;

  // Every chunk still where it was put, at its size, before the marker says so.
  // Another window may have deleted the pack while this download ran; its
  // writes then recreate the folder around a hole, and a marker over a hole
  // would draw those characters in the fallback face for good.
  const missing = await firstMissing(jobs.map((j) => ({ path: j.local, size: j.spec[1] })));
  if (missing) throw new FontPackError("disk", `${missing}: gone before the install finished`);

  const facesPath = joinPath(dir, FACES);
  await onDisk(FACES, () => writeAside(facesPath, (tmp) => writeFile(tmp, faces.join("\n") + "\n")));
  forgetFaces(id);
  // The marker last: from here on the pack counts as installed.
  const marker = joinPath(root, MARKER);
  const record = JSON.stringify({ version: pack.version, files: jobs.length }) + "\n";
  await onDisk(MARKER, () => writeAside(marker, (tmp) => writeFile(tmp, record)));
  await pruneOtherVersions(id);
}

/**
 * Write through a temporary name and rename into place, so a file at its
 * final name is always a whole file — a torn write (a power cut, or a second
 * window installing the same pack at the same moment) never passes the
 * resume check or leaves half a `faces.css` behind. The temporary name is
 * this write's own: two windows writing the same chunk each rename a complete
 * copy of the same bytes, rather than one renaming the other's half-written one.
 */
async function writeAside(path: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.part`;
  await write(tmp);
  await renamePath(tmp, path);
}

async function firstMissing(files: { path: string; size: number }[]): Promise<string | null> {
  for (const f of files) {
    const st = await statPath(f.path).catch(() => null);
    if (!st || st.isDir || st.size !== f.size) return f.path;
  }
  return null;
}

/** A temporary write this old belongs to no live install — the largest chunk takes seconds. */
const STALE_PART_MS = 10 * 60_000;

/**
 * Remove a pack's folders for versions other than the pinned one. A version
 * bump leaves the previous one behind — swept after an install, and at startup
 * for a pack nobody picks again. Best effort: a leftover folder costs disk,
 * not correctness.
 */
export async function pruneOtherVersions(id: FontPackId): Promise<void> {
  try {
    const { version } = await fontPackData(id);
    const root = await packRoot(id);
    if (!(await fileExists(root))) return;
    for (const entry of await readDir(root)) {
      if (entry.isDirectory && entry.name !== version) await removeDir(entry.path);
    }
    // And the temporary files an interrupted write left in the current one
    // (the app closed mid-download, a full disk) — their names are random, so
    // nothing would ever overwrite them. Only stale ones: a fresh `.part` may
    // be another window's install in flight.
    const dir = joinPath(root, version);
    if (!(await fileExists(dir))) return;
    for (const entry of await readDir(dir)) {
      if (entry.isDirectory || !entry.name.endsWith(".part")) continue;
      const st = await statPath(entry.path).catch(() => null);
      if (st?.modifiedMs != null && Date.now() - st.modifiedMs > STALE_PART_MS) await removeFile(entry.path);
    }
  } catch {
    /* keep going */
  }
}

/** Delete a pack from this machine. Missing already = done. */
export async function removeFontPack(id: FontPackId): Promise<void> {
  forgetFaces(id);
  const root = await packRoot(id);
  if (!(await fileExists(root))) return;
  await onDisk(root, () => removeDir(root));
}
