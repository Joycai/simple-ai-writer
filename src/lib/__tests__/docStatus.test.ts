/**
 * 每份文档的状态是一个**词表里的词**，写在标题下的引用块里——`docs/README.md`
 * 开头那张表就是全部词表。
 *
 * 2026-09 整理时数过一次：`api/` `feature/` `issues/` 的 140 来份文档里，约 45
 * 份的状态行要么没有，要么是一句散文（「六刀全部实现」「已澄清（非缺陷）」），
 * 要么是词表外的词（`implemented`、`deferred`）。散文读者查不到它是哪一档；
 * 词表外的词看起来像一个状态，其实什么也没说。所以这里只管一件事：状态行
 * **以一个词表里的词开头**，后面的细节（哪几期、哪几个 PR、还差什么）随便写。
 *
 * 同时核对 `docs/README.md` 的汇总表：状态栏里的词都在词表内，且第一个词与
 * 它链接的文档自己写的第一个词一致——汇总表和文档各写一份，不对账就会漂。
 */
import { describe, expect, it } from "vitest";

/** 按 docSourceRefs.test.ts 的先例就地声明（本项目 tsconfig 没有 @types/node）。 */
declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const ROOT = process.cwd();

/** `docs/README.md` 的词表，一字不差。 */
const VOCAB = new Set([
  "living", "shipped", "partial", "planned", "proposal", "research",
  "open", "fixed", "clarified", "unverified", "stale",
]);
/** 只在 `issues/` 里用的三个词——反过来，`issues/` 里的文档也只用这三个开头。 */
const ISSUE_ONLY = new Set(["open", "fixed", "clarified"]);

const DIRS = ["docs/reference", "docs/api", "docs/feature", "docs/issues"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(`${ROOT}/${dir}`, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** 标题下前 15 行里的第一条状态行：`> 状态：` / `> **Status**:` / `- **状态**：`。 */
const STATUS_LINE = /^(?:>|-)\s*\**\s*(?:状态|Status)\s*\**\s*[:：]\s*\**\s*(.*)$/i;

/** 状态行开头的那个词；没有、或开头不是反引号词，返回 null。 */
function leadToken(path: string): string | null {
  const lines = fs.readFileSync(`${ROOT}/${path}`, "utf8").split("\n").slice(0, 15);
  for (const l of lines) {
    const m = STATUS_LINE.exec(l);
    if (!m) continue;
    const t = /^`([a-z]+)`/.exec(m[1]);
    return t ? t[1] : null;
  }
  return null;
}

const DOCS = DIRS.flatMap((d) => walk(d));

describe("doc status vocabulary", () => {
  it("every doc opens its status line with a vocabulary token", () => {
    const bad = DOCS.map((p) => [p, leadToken(p)] as const)
      .filter(([, t]) => t === null || !VOCAB.has(t))
      .map(([p, t]) => `${p}: ${t ?? "no `token` at the start of a 状态/Status line"}`);
    expect(bad).toEqual([]);
  });

  it("open / fixed / clarified belong to issues/, and issues/ uses only them", () => {
    const bad = DOCS.flatMap((p) => {
      const t = leadToken(p);
      if (t === null) return [];
      const inIssues = p.startsWith("docs/issues/");
      return inIssues === ISSUE_ONLY.has(t) ? [] : [`${p}: ${t}`];
    });
    expect(bad).toEqual([]);
  });

  it("docs/README.md's status column agrees with the docs it links", () => {
    const readme = fs.readFileSync(`${ROOT}/docs/README.md`, "utf8");
    const bad: string[] = [];
    for (const row of readme.split("\n")) {
      const cells = row.split("|").map((c) => c.trim());
      // | [doc](path) · [doc](path) | status | what it settles |
      if (cells.length < 4 || !cells[1].startsWith("[")) continue;
      const tokens = [...cells[2].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
      for (const t of tokens) if (!VOCAB.has(t)) bad.push(`README row ${cells[1]}: \`${t}\` is not in the vocabulary`);
      if (tokens.length === 0) continue;
      for (const m of cells[1].matchAll(/\]\(([^)]+\.md)\)/g)) {
        const path = `docs/${m[1]}`;
        if (!DIRS.some((d) => path.startsWith(`${d}/`))) continue;
        const t = leadToken(path);
        if (t !== tokens[0]) bad.push(`${path}: doc says ${t}, README row says ${tokens[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
