/**
 * 文档和源码注释里不写 `文件:行号` —— 行号指不住。
 *
 * 2026-09-12 机械核对过一次：`docs/` 里 346 处 `文件.ts:行号` 引用，只有 80 处
 * 还落在原位；147 处符号还在同一文件、位置已经漂走，18 处连符号都没了
 * （`DEFAULT_GEMINI_BASE` 迁去了 `urls.ts`、`defaultHighlightStyle` 换成了
 * `manuscriptHighlight`、`betaSection` 整段搬成了 `LabPane`）。三个月不到就烂了
 * 一半以上，而每一处都像还能用——这是比断链更坏的一种坏：读者按坐标翻到一段
 * 无关代码，以为文档说的就是它。
 *
 * 修法不是把行号刷新一遍（下一个 PR 就又漂了），是换成**指得住的名字**：
 * 文件 + 符号（`configDb.ts` 的 `defaultImageCaps`）、文件 + 小节
 * （错误探测那一步）、或者只留文件名——让 grep 而不是坐标去定位。
 *
 * 例外由 `design/` 与 `plans/` 不在扫描面内体现：那两处是一次性的历史记录
 * （原始 PRD、29 份动效执行记录），里面的坐标是当时的现场，改它没有收益。
 */
import { describe, expect, it } from "vitest";

/** 按 cssKeyframeNames.test.ts 的先例就地声明（本项目 tsconfig 没有 @types/node）。 */
declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const ROOT = process.cwd();

/** 扫描面：今天的文档 + 会被人照抄的源码注释。不含 design/ 与 plans/。 */
const SCAN: readonly { dir: string; exts: readonly string[] }[] = [
  { dir: "docs", exts: [".md", ".html"] },
  { dir: "src", exts: [".ts", ".tsx", ".css"] },
  { dir: "src-tauri/src", exts: [".rs"] },
  { dir: "server/src", exts: [".rs"] },
  { dir: "scripts", exts: [".ts"] },
];

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/**
 * 一个带源码后缀的路径，后面紧跟 `:行号`（或 `:行号-行号`，或 `,行号` 续列）。
 *
 * 后缀是必须的：没有它就会连 `localhost:11434` 和 `--space-2: 8px` 一起抓。
 *
 * `.md` 也在里面：文档引文档同样烂，而且那边有更好的锚——小节标题
 * （`architecture.md → 读 .pptx`），标题改名时 grep 找得到，行号找不到。
 */
const REF = /[A-Za-z0-9_/.-]+\.(?:ts|tsx|rs|css|json|js|py|html|md)[:,]\d+/g;

describe("docs 与源码注释里的源码引用", () => {
  it("不带行号", () => {
    const offenders: string[] = [];
    for (const { dir, exts } of SCAN) {
      for (const file of walk(`${ROOT}/${dir}`, exts)) {
        const lines = fs.readFileSync(file, "utf-8").split("\n");
        lines.forEach((line, i) => {
          const hits = line.match(REF);
          if (hits) {
            const rel = file.slice(ROOT.length + 1);
            offenders.push(`${rel}:${i + 1}  ${hits.join(" · ")}`);
          }
        });
      }
    }
    expect(
      offenders,
      `引用要指得住：把 \`文件.ts:123\` 换成文件 + 符号名（\`configDb.ts\` 的 \`defaultImageCaps\`）` +
        `或只留文件名。行号三个月漂掉一半以上，而漂掉的引用看起来仍然有效。\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
