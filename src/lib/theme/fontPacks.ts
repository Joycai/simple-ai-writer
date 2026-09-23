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
import { fileExists, readDir, readFile, removeDir, statPath, writeBinaryFile, writeFile } from "../fs/fileio";
import { joinPath, toPosixPath } from "../paths";
import { IS_WINDOWS } from "../platform";

type FontPackId = "harmonyos" | "misans";
export const FONT_PACK_IDS: readonly FontPackId[] = ["harmonyos", "misans"];

/** `[path, size, sha256 hex]` — the sheet's path is package-relative, a chunk's is relative to its sheet. */
type FileSpec = [path: string, size: number, sha256: string];

export interface FontPackData {
  id: FontPackId;
  pkg: string;
  version: string;
  family: string;
  weights: { weight: number; sheet: FileSpec; chunks: FileSpec[] }[];
}

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

type FontPackErrorCode = "network" | "integrity" | "disk";

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

async function fontsRoot(): Promise<string> {
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
 * Turn one package sheet into the rules the app injects: every `url()` points
 * at the local copy, the family is the pack's own name and the weight the one
 * pinned for this sheet (the HarmonyOS sheets already agree; normalising means
 * a future package that names its weights differently can't split the family).
 * `local()` sources stay — an author who has the font installed uses theirs.
 * Comments and everything outside `@font-face` blocks are dropped.
 */
export function rewriteFaces(css: string, family: string, weight: number, dir: string, windows = IS_WINDOWS): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const faces = clean.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  return faces
    .map((face) =>
      face
        .replace(/\s+/g, " ")
        .replace(/font-family\s*:[^;}]*/, `font-family:"${family}"`)
        .replace(/font-weight\s*:[^;}]*/, `font-weight:${weight}`)
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_m, _q, name: string) =>
          `url("${fontUrl(joinPath(dir, name.replace(/^\.\//, "")), windows)}")`),
    )
    .join("\n");
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
      css = await readFile(joinPath(await packRoot(id), pack.version, FACES));
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

/**
 * One pinned file, from the first source whose bytes match. A source that
 * errors or answers non-2xx counts as unreachable; one that answers with other
 * bytes counts as a mismatch. Only when *every* source served wrong bytes is
 * it an integrity failure — one unreachable source among them makes the
 * likelier story a network one.
 */
async function fetchPinned(pack: FontPackData, path: string, spec: FileSpec): Promise<Uint8Array> {
  let unreachable = 0;
  let mismatched = 0;
  for (const source of FONT_PACK_SOURCES[pack.id]) {
    let bytes: Uint8Array;
    try {
      const res = await fetch(source(pack.pkg, pack.version, path));
      if (!res.ok) {
        unreachable++;
        continue;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      unreachable++;
      continue;
    }
    if (bytes.length === spec[1] && (await sha256Hex(bytes)) === spec[2]) return bytes;
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

  // Sheets first: they're small, and a sheet naming a chunk the table doesn't
  // pin means the table and the package disagree — stop before any chunk.
  const faces: string[] = [];
  for (const w of pack.weights) {
    const [path] = w.sheet;
    const css = new TextDecoder().decode(await fetchPinned(pack, path, w.sheet));
    const pinned = new Set(w.chunks.map((c) => c[0]));
    const named = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2].replace(/^\.\//, ""));
    const stray = named.find((n) => !pinned.has(n));
    if (stray) throw new FontPackError("integrity", `${path} names an unpinned file: ${stray}`);
    faces.push(rewriteFaces(css, pack.family, w.weight, dir));
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
        const bytes = await fetchPinned(pack, remote, spec);
        await onDisk(local, () => writeBinaryFile(local, bytes));
        advance(spec[1]);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  if (failure !== null) throw failure;

  await onDisk(FACES, () => writeFile(joinPath(dir, FACES), faces.join("\n") + "\n"));
  forgetFaces(id);
  // The marker last: from here on the pack counts as installed.
  await onDisk(MARKER, () =>
    writeFile(joinPath(root, MARKER), JSON.stringify({ version: pack.version, files: jobs.length }) + "\n"),
  );
  // A version bump leaves the previous version's folder behind — sweep it.
  // Best effort: a leftover folder costs disk, not correctness.
  try {
    for (const entry of await readDir(root)) {
      if (entry.isDirectory && entry.name !== pack.version) await removeDir(entry.path);
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
