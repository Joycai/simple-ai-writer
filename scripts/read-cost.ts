/**
 * What `search_text` and a paged `read_file` actually cost, on a project the
 * size of a real one.
 *
 * Why measure before changing anything: `searchWritingFiles` reads every
 * document in the workspace serially, in JS, through one IPC call each, and
 * pages of one file are re-read whole on every `read_file` call. Both look
 * wasteful on paper — but a Rust-side `fs_grep` means a second search
 * implementation whose case folding, caps, ordering and encoding detection
 * have to stay in step with the JS one forever, and that is a bad trade
 * against a few hundred milliseconds that one model round dwarfs. So: numbers
 * first (docs/feature/agent/html-read-edit-plan.md §8 / D7).
 *
 *   pnpm exec vitest run --config scripts/cost.vitest.config.ts
 *
 * Knobs are environment variables (vitest owns argv): `COST_OUT` for the
 * report path, `COST_CHAPTERS` / `COST_PAGES` to resize the fixture.
 *
 * **What this harness can and cannot see.** The fixture is in memory, so the
 * file reads here are a `Map.get` — everything Rust and the webview bridge do
 * is absent. What it measures exactly is the half that is ours: how many
 * reads, how many bytes, and how much synchronous JS runs between them (the
 * part that blocks the UI thread). The transport is bounded separately by the
 * JSON round-trip column, which is the floor for what `invoke` pays to
 * serialize a file into the bridge and parse it back. The real multiplier on
 * top of that is a one-off measurement in the running app — the instrumentation
 * to do it is written down in §8 of the plan, not here.
 */

import { describe, expect, it, vi } from "vitest";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = process.env.COST_OUT ?? "read-cost-report.txt";
const CHAPTERS = Number(process.env.COST_CHAPTERS ?? "300");
const PROJECT = "/proj";

// ── The fixture, in memory and deterministic ────────────────────────────────

/** Seeded so two runs are comparable; the content only has to be realistic. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const fs = new Map<string, string>();
/** Bytes read and reads made since the last reset, plus the sync gaps between them. */
const meter = { reads: 0, bytes: 0, gaps: [] as number[], last: 0 };

vi.mock("../src/lib/fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    // The gap since the previous read is the synchronous work the caller did
    // on the last file — for a search that is the scan, and it runs on the UI
    // thread. Sampling it here needs no instrumentation inside the tool.
    const now = performance.now();
    if (meter.last) meter.gaps.push(now - meter.last);
    const text = fs.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    meter.reads++;
    meter.bytes += text.length;
    meter.last = performance.now();
    return text;
  }),
  writeFile: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async (p: string) => fs.has(p)),
}));

vi.mock("../src/lib/project", () => ({
  readDirRecursive: vi.fn(async (dir: string) => {
    interface Node { name: string; path: string; is_dir: boolean; children?: Node[] }
    const roots: Node[] = [];
    const dirs = new Map<string, Node>();
    for (const path of fs.keys()) {
      if (!path.startsWith(dir + "/")) continue;
      const segments = path.slice(dir.length + 1).split("/");
      if (segments.some((s) => s.startsWith("."))) continue;
      let parent: Node[] = roots;
      let prefix = dir;
      for (let i = 0; i < segments.length; i++) {
        prefix += "/" + segments[i];
        if (i === segments.length - 1) {
          parent.push({ name: segments[i], path: prefix, is_dir: false });
        } else {
          let node = dirs.get(prefix);
          if (!node) {
            node = { name: segments[i], path: prefix, is_dir: true, children: [] };
            dirs.set(prefix, node);
            parent.push(node);
          }
          parent = node.children!;
        }
      }
    }
    return roots;
  }),
}));

const { searchWritingFiles, readWritingFile } = await import("../src/lib/agent/tools");

/** ~6,000 characters of plausible Chinese prose, in ~40-character lines. */
function chapter(n: number, rand: () => number): string {
  const words = ["断剑", "长廊", "灯火", "旧盟", "北境", "石阶", "手信", "残卷", "初雪", "钟声"];
  const lines: string[] = [`# 第${n}章`, ""];
  for (let i = 0; i < 150; i++) {
    let line = "";
    while (line.length < 38) line += words[Math.floor(rand() * words.length)] + "，";
    lines.push(line + "。");
  }
  // One distinctive phrase, in one chapter only — the "rare" query below.
  if (n === 137) lines.splice(60, 0, "他把青铜匣子交给了守夜人。");
  return lines.join("\n");
}

/** A deliverable page of roughly `kb` kilobytes, pretty-printed. */
function htmlPage(kb: number): string {
  const rows: string[] = ["<!DOCTYPE html>", "<html>", "<head><style>", "body{margin:0}", "</style></head>", "<body>"];
  const per = 60;
  for (let i = 0; rows.join("\n").length < kb * 1024; i++) {
    rows.push(`<section class="slide" id="s${i}">`, `  <h2>第 ${i + 1} 页</h2>`, `  <p>${"内容".repeat(per)}</p>`, "</section>");
  }
  rows.push("</body>", "</html>");
  return rows.join("\n");
}

function build(): void {
  const rand = lcg(20260907);
  for (let i = 1; i <= CHAPTERS; i++) {
    const volume = Math.ceil(i / 50);
    fs.set(`${PROJECT}/卷${volume}/第${i}章.md`, chapter(i, rand));
  }
  fs.set(`${PROJECT}/图示/大.html`, htmlPage(200));
  fs.set(`${PROJECT}/图示/中.html`, htmlPage(120));
  fs.set(`${PROJECT}/图示/小.html`, htmlPage(60));
  // The shape read_file's paging is worst on: one line, no boundaries.
  fs.set(`${PROJECT}/图示/压缩.html`, htmlPage(200).replace(/\n/g, ""));
}

// ── Reporting ───────────────────────────────────────────────────────────────

const say = (line: string) => appendFileSync(OUT, line + "\n");
const ms = (n: number) => `${n.toFixed(1)}ms`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)}MB`;

function reset(): void {
  meter.reads = 0;
  meter.bytes = 0;
  meter.gaps = [];
  meter.last = 0;
}

function row(label: string, t: number): string {
  const worst = meter.gaps.length ? Math.max(...meter.gaps) : 0;
  return (
    `${label.padEnd(30)} ${ms(t).padStart(9)}  ${String(meter.reads).padStart(5)} reads  ` +
    `${mb(meter.bytes).padStart(8)}  worst sync block ${ms(worst)}`
  );
}

describe("read + search cost", () => {
  it("measures", async () => {
    writeFileSync(OUT, "");
    build();

    const totalBytes = [...fs.values()].reduce((n, t) => n + t.length, 0);
    say(`fixture: ${fs.size} files, ${mb(totalBytes)} (${CHAPTERS} chapters + 4 .html deliverables)`);
    say(`node ${process.version} · ${new Date().toISOString().slice(0, 10)}`);
    say("");
    say("── search_text ─────────────────────────────────────────────────────────");

    for (const [label, query] of [
      ["common word (断剑)", "断剑"],
      ["rare phrase (青铜匣子)", "青铜匣子"],
      ["a miss (никогда)", "никогда"],
    ] as const) {
      reset();
      const t0 = performance.now();
      await searchWritingFiles("c1", PROJECT, query);
      say(row(label, performance.now() - t0));
    }

    say("");
    say("── read_file paging ────────────────────────────────────────────────────");

    // Sequentially, the way a model that treats page N+1 as waiting on page N
    // would do it — every call re-reads the whole file.
    for (const name of ["大.html", "压缩.html"] as const) {
      reset();
      const t0 = performance.now();
      let cursor: number | undefined;
      let calls = 0;
      for (;;) {
        const out = await readWritingFile("c1", `${PROJECT}/图示/${name}`, PROJECT, cursor);
        calls++;
        const next = out.content.match(/pass start_line=([\d.]+)/);
        if (!next || calls > 400) break;
        cursor = Number(next[1]);
      }
      say(row(`${name} to the end (${calls} calls)`, performance.now() - t0));
    }

    // The shape that actually happens: the trailer tells the model the pages
    // do not wait on each other, so a round asks for many at once — and every
    // one of them reads the whole file again, within milliseconds.
    reset();
    const t1 = performance.now();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        readWritingFile("c1", `${PROJECT}/图示/大.html`, PROJECT, i * 20 + 1),
      ),
    );
    say(row("大.html, 40 pages in one round", performance.now() - t1));

    say("");
    say("── how the paged read scales ───────────────────────────────────────────");

    // Every page re-reads the whole file, and the number of pages is the file
    // size over the page budget — so the bytes moved to deliver one file are
    // quadratic in its size. At today's sizes that is cheap; the point of
    // measuring it is to find the size at which it stops being cheap.
    for (const kb of [200, 500, 1000]) {
      const path = `${PROJECT}/图示/scale-${kb}.html`;
      fs.set(path, htmlPage(kb));
      reset();
      const t0 = performance.now();
      let cursor: number | undefined;
      let calls = 0;
      for (;;) {
        const out = await readWritingFile("c1", path, PROJECT, cursor);
        calls++;
        const next = out.content.match(/pass start_line=([\d.]+)/);
        if (!next || calls > 2000) break;
        cursor = Number(next[1]);
      }
      say(row(`${kb}KB page, ${calls} calls`, performance.now() - t0));
      fs.delete(path);
    }

    say("");
    say("── the transport floor (what invoke pays on top) ───────────────────────");

    // A lower bound on serialize + parse for one file crossing the bridge.
    // Not added to anything above: it is the part this harness cannot see, and
    // adding an estimate to a measurement makes both unreadable.
    const big = fs.get(`${PROJECT}/图示/大.html`)!;
    const t2 = performance.now();
    for (let i = 0; i < 40; i++) JSON.parse(JSON.stringify({ v: big }));
    const per = (performance.now() - t2) / 40;
    say(`JSON round-trip of one 200KB file      ${ms(per).padStart(9)}  × the read counts above`);

    const allChapters = [...fs.keys()].filter((p) => p.endsWith(".md")).map((p) => fs.get(p)!);
    const t3 = performance.now();
    for (const text of allChapters) JSON.parse(JSON.stringify({ v: text }));
    say(`JSON round-trip of one whole search    ${ms(performance.now() - t3).padStart(9)}  (${allChapters.length} chapters)`);

    say("");
    say("Thresholds (plan §8): search > 1.5s end-to-end, or any sync block > 100ms,");
    say("or > 5MB crossing per search → build fs_grep. Under 500ms and < 1ms per file → leave it.");

    // The harness is a benchmark, not a gate — the only thing asserted is that
    // it actually ran the fixture it claims to have run.
    expect(fs.size).toBeGreaterThan(CHAPTERS);
  });
});
