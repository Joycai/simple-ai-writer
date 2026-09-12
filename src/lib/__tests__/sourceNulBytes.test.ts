import { describe, expect, it } from "vitest";

/**
 * 源码里不许出现裸 NUL 字节（`\u0000`）。
 *
 * 2026-09-12 在 `lib/lore/collections.ts` 第 155 行抓到一个：那行注释想说
 * 「`UNGROUPED`（内含 `\u0000`）」，写的人把哨兵里那个字符**原样粘了进去**，而不是
 * 写成转义。常量本身没问题（`const UNGROUPED = "\u0000ungrouped"`），坏的只是注释。
 *
 * 为什么值得一条测试守着：**git 看见 NUL 就把整个文件当二进制**。那之后这个文件
 * 的每一次改动在 `git diff` / PR 里都只显示一行 `Binary files differ`——改了什么
 * 没有人看得见，评审等于没做；`grep` / `ripgrep` 也会默认跳过它，搜不到就以为
 * 没有。两件事都是静默的，坏得毫无征兆，而代价是一个字符。
 *
 * 按 cssKeyframeNames.test.ts / docSourceRefs.test.ts 的先例就地声明 fs：本项目
 * tsconfig 没有 `@types/node`，裸 `import "node:fs"` 在 vitest 里能跑、到 CI 的
 * `tsc --noEmit` 会挂。
 */
declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const ROOT = process.cwd();

/** 扫描面：会被人读、会被 review 的源码。 */
const SCAN: readonly { dir: string; exts: readonly string[] }[] = [
  { dir: "src", exts: [".ts", ".tsx", ".css", ".json"] },
  { dir: "src-tauri/src", exts: [".rs"] },
  { dir: "server/src", exts: [".rs"] },
  { dir: "scripts", exts: [".ts"] },
  { dir: "docs", exts: [".md", ".html"] },
  { dir: "plans", exts: [".md"] },
];

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

describe("源码里没有裸 NUL 字节", () => {
  it("每个源文件都不含 \u0000", () => {
    const offenders: string[] = [];
    for (const { dir, exts } of SCAN) {
      for (const file of walk(`${ROOT}/${dir}`, exts)) {
        const text: string = fs.readFileSync(file, "utf8");
        const at = text.indexOf("\u0000");
        if (at === -1) continue;
        const line = text.slice(0, at).split("\n").length;
        offenders.push(`${file.slice(ROOT.length + 1)}:${line}`);
      }
    }
    // 一旦失败：想表达那个字符就写 `\u0000` 这个转义，别粘真的字节。
    expect(offenders).toEqual([]);
  });
});
