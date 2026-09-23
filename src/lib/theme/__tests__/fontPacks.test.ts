import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 可下载字体包的下载器：锁定表是唯一的信任来源，源只负责送字节。
 * 这里用一个两字重、三个分片的小包代替真表，所以哈希是现算的。
 */
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash: hash } = require("node:crypto") as typeof import("node:crypto");
  const sha = (s: string) => hash("sha256").update(s).digest("hex");
  const sheet400 =
    "/* generated */@font-face{font-family:MiSans;font-weight:400;src:local(\"MiSans\"),url('a.0.woff2') format('woff2');unicode-range:U+4e00-4e10}" +
    "@font-face{font-family:MiSans;font-weight:400;src:url('./b.1.woff2') format('woff2');unicode-range:U+20-7e}";
  const sheet700 = "@font-face{font-family:\"MiSans Bold\";font-weight:bold;src:url(c.2.woff2) format('woff2')}";
  const bytes: Record<string, string> = {
    "lib/N/r.css": sheet400,
    "lib/N/b.css": sheet700,
    "lib/N/a.0.woff2": "AAAA",
    "lib/N/b.1.woff2": "BBBBBB",
    "lib/N/c.2.woff2": "CC",
  };
  const spec = (path: string, name = path): [string, number, string] => [name, bytes[path].length, sha(bytes[path])];
  const pack = {
    id: "misans",
    pkg: "misans",
    version: "5.0.0",
    family: "MiSans",
    weights: [
      { weight: 400, sheet: spec("lib/N/r.css"), chunks: [spec("lib/N/a.0.woff2", "a.0.woff2"), spec("lib/N/b.1.woff2", "b.1.woff2")] },
      { weight: 700, sheet: spec("lib/N/b.css"), chunks: [spec("lib/N/c.2.woff2", "c.2.woff2")] },
    ],
  };
  return { bytes, pack, files: new Map<string, Uint8Array | string>(), writes: [] as string[], mtime: new Map<string, number>() };
});

vi.mock("../fontPackData", () => ({ FONT_PACK_DATA: [h.pack] }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "/data" }));
vi.mock("../../platform", () => ({ IS_WINDOWS: false }));
vi.mock("../../http", () => ({ fetch: vi.fn() }));
vi.mock("../../fs/fileio", () => ({
  fileExists: vi.fn(async (p: string) => [...h.files.keys()].some((k) => k === p || k.startsWith(p + "/"))),
  readFile: vi.fn(async (p: string) => {
    const v = h.files.get(p);
    if (typeof v !== "string") throw new Error(`no ${p}`);
    return v;
  }),
  writeFile: vi.fn(async (p: string, s: string) => {
    h.writes.push(p);
    h.files.set(p, s);
  }),
  writeBinaryFile: vi.fn(async (p: string, b: Uint8Array) => {
    h.writes.push(p);
    h.files.set(p, b);
  }),
  statPath: vi.fn(async (p: string) => {
    const v = h.files.get(p);
    if (v === undefined) return null;
    return { isDir: false, size: typeof v === "string" ? v.length : v.length, modifiedMs: h.mtime.get(p) ?? null };
  }),
  removeFile: vi.fn(async (p: string) => void h.files.delete(p)),
  readDir: vi.fn(async (p: string) => {
    const names = new Set<string>();
    for (const k of h.files.keys()) if (k.startsWith(p + "/")) names.add(k.slice(p.length + 1).split("/")[0]);
    return [...names].map((name) => ({ name, path: `${p}/${name}`, isDirectory: ![...h.files.keys()].includes(`${p}/${name}`) }));
  }),
  renamePath: vi.fn(async (from: string, to: string) => {
    h.writes.push(to);
    const v = h.files.get(from);
    if (v === undefined) throw new Error(`no ${from}`);
    h.files.delete(from);
    h.files.set(to, v);
  }),
  removeDir: vi.fn(async (p: string) => {
    for (const k of [...h.files.keys()]) if (k === p || k.startsWith(p + "/")) h.files.delete(k);
  }),
}));

import { fetch } from "../../http";
import { joinPath } from "../../paths";
import {
  FONT_PACK_SOURCES,
  FontPackError,
  pruneOtherVersions,
  fontUrl,
  installFontPack,
  leftoverBytes,
  packFacesCss,
  readInstalled,
  removeFontPack,
  rewriteFaces,
} from "../fontPacks";

const fetchMock = vi.mocked(fetch);
const DIR = "/data/fonts/misans/5.0.0";

/** A source table: `(path) → body | status`. The first matching `serve` wins per URL host. */
function serve(byHost: Record<string, (path: string) => string | number>, delay: (path: string) => number = () => 0) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    const host = new URL(url).host;
    const rule = byHost[host];
    if (!rule) throw new TypeError("network down");
    const path = url.replace(/^https:\/\/[^/]+\/(npm\/misans@5\.0\.0|misans\/5\.0\.0\/files|misans@5\.0\.0)\//, "");
    const wait = delay(path);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const out = rule(path);
    if (typeof out === "number") return new Response("", { status: out });
    return new Response(out, { status: 200 });
  });
}
const honest = (path: string) => h.bytes[path] ?? 404;

beforeEach(() => {
  h.files.clear();
  h.mtime.clear();
  h.writes.length = 0;
  fetchMock.mockReset();
});

describe("installFontPack", () => {
  it("downloads every pinned file, writes the face rules, and the marker last", async () => {
    serve({ "registry.npmmirror.com": honest });
    const seen: [number, number][] = [];
    await installFontPack("misans", { onProgress: (d, t) => seen.push([d, t]) });

    expect(new TextDecoder().decode(h.files.get(`${DIR}/a.0.woff2`) as Uint8Array)).toBe("AAAA");
    expect(h.files.has(`${DIR}/b.1.woff2`)).toBe(true);
    expect(h.files.has(`${DIR}/c.2.woff2`)).toBe(true);
    expect(h.writes[h.writes.length - 1]).toBe("/data/fonts/misans/installed.json");
    expect(h.writes[h.writes.length - 3]).toBe(`${DIR}/faces.css`);
    expect(JSON.parse(h.files.get("/data/fonts/misans/installed.json") as string)).toEqual({ version: "5.0.0", files: 3 });
    // Chunks land through a `.part` + rename, so nothing half-written is ever left at a chunk's name.
    // …through a name of this write's own, so two windows never rename each other's half-written file.
    expect(h.writes.some((w) => /\/a\.0\.woff2\.[0-9a-f]{8}\.part$/.test(w))).toBe(true);
    expect([...h.files.keys()].some((k) => k.endsWith(".part"))).toBe(false);
    // faces.css keeps bare names — the URL is made when it's read, from where the folder is then.
    expect(h.files.get(`${DIR}/faces.css`)).toContain('url("a.0.woff2")');
    expect(h.files.get(`${DIR}/faces.css`)).not.toContain("/data/");
    // Every request is bounded: a connect timeout and an abort signal.
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { connectTimeout?: number }).connectTimeout).toBeGreaterThan(0);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }

    const total = Object.values(h.bytes).reduce((n, s) => n + s.length, 0);
    expect(seen[0]).toEqual([0, total]);
    expect(seen[seen.length - 1]).toEqual([total, total]);
    expect(seen.every(([d], i) => i === 0 || d >= seen[i - 1][0])).toBe(true);
    expect(await readInstalled("misans")).toBe(true);
  });

  it("refuses a source's wrong bytes and takes the next source's", async () => {
    serve({
      "registry.npmmirror.com": (p) => (p.endsWith(".woff2") ? "tampered" : honest(p)),
      "cdn.jsdelivr.net": honest,
    });
    await installFontPack("misans");
    expect(new TextDecoder().decode(h.files.get(`${DIR}/a.0.woff2`) as Uint8Array)).toBe("AAAA");
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("https://cdn.jsdelivr.net/npm/misans@5.0.0/lib/N/a.0.woff2"))).toBe(true);
  });

  it("falls through unreachable sources in order, then starts later files at the one that worked", async () => {
    serve({ "gcore.jsdelivr.net": honest });
    await installFontPack("misans");
    const hosts = fetchMock.mock.calls.map(([u]) => new URL(String(u)).host);
    expect(hosts.slice(0, 4)).toEqual(["registry.npmmirror.com", "cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net"]);
    // Five files, one dead-source walk: everything after the first goes straight to gcore.
    expect(hosts.slice(4)).toEqual(["gcore.jsdelivr.net", "gcore.jsdelivr.net", "gcore.jsdelivr.net", "gcore.jsdelivr.net"]);
    expect(await readInstalled("misans")).toBe(true);
  });

  it("is a network error when nothing answers, and leaves no marker", async () => {
    serve({});
    await expect(installFontPack("misans")).rejects.toMatchObject({ name: "FontPackError", code: "network" });
    expect(await readInstalled("misans")).toBe(false);
  });

  it("stops the queue on the first failure and rejects only once every worker is back", async () => {
    // Sheets and the first chunk come through — the chunk slowly; every other
    // chunk is unreachable at once. Rejecting before the slow worker is back
    // would let its write land after the caller already saw the error.
    serve(
      { "registry.npmmirror.com": (p) => (p.endsWith(".css") || p.endsWith("a.0.woff2") ? honest(p) : 503) },
      (p) => (p.endsWith("a.0.woff2") ? 15 : 0),
    );
    await expect(installFontPack("misans")).rejects.toMatchObject({ code: "network" });
    const settled = fetchMock.mock.calls.length;
    const written = h.writes.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.length).toBe(settled);
    expect(h.writes.length).toBe(written);
  });

  it("is an integrity error when every source serves wrong bytes", async () => {
    const liar = (p: string) => (p.endsWith(".woff2") ? "nope" : honest(p));
    serve(Object.fromEntries(["registry.npmmirror.com", "cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net", "unpkg.com"].map((k) => [k, liar])));
    const err = await installFontPack("misans").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FontPackError);
    expect((err as FontPackError).code).toBe("integrity");
    expect([...h.files.keys()].some((k) => k.endsWith(".woff2"))).toBe(false);
  });

  it("stops before any chunk when a sheet names a file the table doesn't pin", async () => {
    const pinned = h.pack.weights[0].sheet;
    const original = h.bytes["lib/N/r.css"];
    const evil = original.replace("b.1.woff2", "evil.woff2");
    // Pin the doctored sheet so it passes its own hash — the stray name is what must stop it.
    h.pack.weights[0].sheet = [pinned[0], evil.length, createHash("sha256").update(evil).digest("hex")];
    try {
      serve({ "registry.npmmirror.com": (p) => (p === "lib/N/r.css" ? evil : honest(p)) });
      await expect(installFontPack("misans")).rejects.toMatchObject({ code: "integrity" });
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith(".woff2"))).toBe(false);
    } finally {
      h.pack.weights[0].sheet = pinned;
    }
  });

  it("resumes: a chunk already on disk at its pinned size is not fetched again", async () => {
    h.files.set(`${DIR}/a.0.woff2`, new TextEncoder().encode("AAAA"));
    serve({ "registry.npmmirror.com": honest });
    await installFontPack("misans");
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("a.0.woff2"))).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("b.1.woff2"))).toBe(true);
  });

  it("re-fetches a chunk whose size on disk is wrong (a torn write)", async () => {
    h.files.set(`${DIR}/a.0.woff2`, new TextEncoder().encode("AA"));
    serve({ "registry.npmmirror.com": honest });
    await installFontPack("misans");
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("a.0.woff2"))).toBe(true);
  });

  it("sweeps an older version's folder after a successful install", async () => {
    h.files.set("/data/fonts/misans/4.0.0/old.woff2", "x");
    serve({ "registry.npmmirror.com": honest });
    await installFontPack("misans");
    expect(h.files.has("/data/fonts/misans/4.0.0/old.woff2")).toBe(false);
    expect(h.files.has(`${DIR}/a.0.woff2`)).toBe(true);
  });
});

describe("the folder under another window's hands", () => {
  it("won't mark a pack installed over a chunk that vanished mid-install", async () => {
    serve({ "registry.npmmirror.com": honest });
    // Another window deletes the pack's folder the moment the last chunk lands.
    const fileio = await import("../../fs/fileio");
    const rename = vi.mocked(fileio.renamePath);
    const real = rename.getMockImplementation()!;
    rename.mockImplementation(async (from, to) => {
      await real(from, to);
      if (to.endsWith("c.2.woff2")) h.files.delete(`${DIR}/a.0.woff2`);
    });
    try {
      await expect(installFontPack("misans")).rejects.toMatchObject({ code: "disk" });
      expect(await readInstalled("misans")).toBe(false);
    } finally {
      rename.mockImplementation(real);
    }
  });

  it("sweeps stale temporary files, and leaves a fresh one (another window's write) alone", async () => {
    h.files.set(`${DIR}/a.0.woff2.deadbeef.part`, "x");
    h.mtime.set(`${DIR}/a.0.woff2.deadbeef.part`, Date.now() - 60 * 60_000);
    h.files.set(`${DIR}/b.1.woff2.cafebabe.part`, "y");
    h.mtime.set(`${DIR}/b.1.woff2.cafebabe.part`, Date.now());
    await pruneOtherVersions("misans");
    expect(h.files.has(`${DIR}/a.0.woff2.deadbeef.part`)).toBe(false);
    expect(h.files.has(`${DIR}/b.1.woff2.cafebabe.part`)).toBe(true);
  });
});

describe("readInstalled / packFacesCss / removeFontPack", () => {
  it("treats a marker for another version as not installed", async () => {
    h.files.set("/data/fonts/misans/installed.json", JSON.stringify({ version: "4.0.0" }));
    expect(await readInstalled("misans")).toBe(false);
  });

  it("serves the installed rules, then forgets them on removal", async () => {
    serve({ "registry.npmmirror.com": honest });
    await installFontPack("misans");
    const css = await packFacesCss(["misans"]);
    expect(css).toContain('font-family:"MiSans"');
    expect(css).toContain(`url("ai-writer-font://localhost${DIR}/a.0.woff2")`);

    await removeFontPack("misans");
    expect(await readInstalled("misans")).toBe(false);
    await expect(packFacesCss(["misans"])).rejects.toThrow();
  });

  it("removing a pack that was never downloaded is a no-op", async () => {
    await expect(removeFontPack("misans")).resolves.toBeUndefined();
  });
});

describe("leftoverBytes", () => {
  it("is 0 when the pack has no folder", async () => {
    expect(await leftoverBytes("misans")).toBe(0);
  });

  it("counts what a failed download left — chunks, stray .part files, an older version — and 0 once removed", async () => {
    // b.1 never arrives: a.0 and the 700 chunk land, then the install fails.
    serve({ "registry.npmmirror.com": (path) => (path.endsWith("b.1.woff2") ? 404 : honest(path)) });
    await expect(installFontPack("misans")).rejects.toThrow();
    const landed = h.bytes["lib/N/a.0.woff2"].length + h.bytes["lib/N/c.2.woff2"].length;
    expect(await readInstalled("misans")).toBe(false);
    expect(await leftoverBytes("misans")).toBe(landed);

    h.files.set(`${DIR}/b.1.woff2.cafebabe.part`, "BBB");
    h.files.set("/data/fonts/misans/4.0.0/old.woff2", "OLD!");
    expect(await leftoverBytes("misans")).toBe(landed + 3 + 4);

    await removeFontPack("misans");
    expect(await leftoverBytes("misans")).toBe(0);
  });
});

describe("rewriteFaces", () => {
  it("routes every url through urlFor, pins family and weight, drops local() and everything else", () => {
    const out = rewriteFaces(h.bytes["lib/N/b.css"], "MiSans", 700, (n) => `u:${n}`);
    expect(out).toBe(`@font-face{font-family:"MiSans";font-weight:700;src:url("u:c.2.woff2") format('woff2')}`);
    const two = rewriteFaces(h.bytes["lib/N/r.css"], "MiSans", 400, (n) => n).split("\n");
    expect(two).toHaveLength(2);
    // A family-only local() would pick an installed Regular for the bold faces — gone.
    expect(two[0]).not.toContain("local(");
    expect(two[0]).toContain(`src:url("a.0.woff2")`);
    expect(two[0]).toContain("unicode-range:U+4e00-4e10");
    expect(two[1]).toContain('url("b.1.woff2")');
    expect(two.join("")).not.toContain("generated");
  });

  it("makes Windows URLs the Rust parser reads when given them", () => {
    const out = rewriteFaces(h.bytes["lib/N/b.css"], "MiSans", 700, (n) => fontUrl(joinPath("C:/Users/a b/fonts", n), true));
    expect(out).toContain('url("http://ai-writer-font.localhost/C:/Users/a%20b/fonts/c.2.woff2")');
  });
});

describe("fontUrl", () => {
  it("encodes segments and keeps the two platform shapes the Rust parser reads", () => {
    expect(fontUrl("/Users/a/Library/Application Support/w/fonts/x.woff2", false)).toBe(
      "ai-writer-font://localhost/Users/a/Library/Application%20Support/w/fonts/x.woff2",
    );
    expect(fontUrl("C:\\Users\\a b\\fonts\\x#1.woff2", true)).toBe(
      "http://ai-writer-font.localhost/C:/Users/a%20b/fonts/x%231.woff2",
    );
  });
});

describe("FONT_PACK_SOURCES", () => {
  it("never sends HarmonyOS to npmmirror (403: not on its allowlist)", () => {
    const urls = FONT_PACK_SOURCES.harmonyos.map((s) => s("p", "1", "x"));
    expect(urls.some((u) => u.includes("npmmirror"))).toBe(false);
    expect(FONT_PACK_SOURCES.misans[0]("misans", "5.0.0", "a/b")).toBe("https://registry.npmmirror.com/misans/5.0.0/files/a/b");
  });
});
