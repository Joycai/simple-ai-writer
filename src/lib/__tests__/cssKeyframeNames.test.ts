/**
 * 模块内 @keyframes 与 global.css 共用一个全局命名空间——重名会静默覆盖。
 *
 * 这条不变量是修 docs/issues/css-modules-global-keyframes.md 的副产品：那次
 * 缺陷是「模块引用全局 keyframes 会被哈希成悬空引用，动画一帧没播过」，修法是
 * vite.config.ts 切 LightningCSS + `cssModules: { animation: false }`（关掉动画
 * 名哈希）。代价是模块内自己声明的 @keyframes 也不再作用域化，于是
 * `SnippetSaveMenu.module.css` 里写一个 `@keyframes fadeIn`，就会覆盖
 * global.css 那个被 11 处引用的 fadeIn——不报错、不告警，只是某些入场动画悄悄
 * 变了个样子。和原缺陷一样，唯一的证据是肉眼。
 *
 * 修复当时全库只有 3 个模块内 keyframes，注释里就把「保持名字唯一」写成了一句
 * 约定。约定不会自己执行：到 93eb7de 已经是 10 个，而 vite.config.ts 和 issue
 * 文档都还写着 3 个。所以把它变成测试。
 *
 * 第二条断言是原缺陷本身的回归测试：引用的名字必须找得到定义。
 */
import { describe, expect, it } from "vitest";

/**
 * 样式表从磁盘读，不 import。
 *
 * `import.meta.glob(..., {query:"?raw"})`（profileSystemPrompt.test.ts 对 `.ts`
 * 用的那招）对 `.css` 返回**空**：vitest 把 CSS 管线打了桩，`?raw` 逃不出去。
 * 而本项目 tsconfig 没有 `@types/node`，裸 `import "node:fs"` 在 vitest 里能跑、
 * 到 CI 的 `tsc --noEmit` 会挂。所以按 themeTokenParity.test.ts 的先例就地声明。
 */
declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const ROOT = `${process.cwd()}/src`;

/** 全部 .css（含 .module.css）。 */
function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) cssFiles(p, out);
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const files = cssFiles(ROOT).map((p) => ({
  path: p.slice(process.cwd().length + 1),
  text: fs.readFileSync(p, "utf8") as string,
}));

/** `@keyframes foo {` / `@-webkit-keyframes foo {` 的名字。 */
function definitions(text: string): string[] {
  return [...text.matchAll(/@(?:-\w+-)?keyframes\s+([\w-]+)/g)].map((m) => m[1]);
}

/**
 * `animation:` / `animation-name:` 值里的动画名。
 *
 * 简写里名字的位置不固定（`animation: fadeIn .2s var(--ease-out)` 和
 * `animation: .8s linear infinite spin` 都合法），所以做法是**排除**而不是定位：
 * 去掉 var(...) 与函数调用，再把剩下的标识符交给调用方与已知定义集合比对。
 * 时长、`linear`、`infinite` 这类关键字因此天然落选（它们不是定义过的名字），
 * 代价是拼错的名字也落选——正好由 dangling 那条断言接住。
 */
function references(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    const value = m[1].replace(/var\([^)]*\)/g, " ").replace(/[\w-]+\([^)]*\)/g, " ");
    for (const tok of value.split(/[\s,]+/)) if (/^[a-zA-Z][\w-]*$/.test(tok)) out.push(tok);
  }
  return out;
}

/**
 * `animation` 简写里合法的非名字关键字。名字不可能是它们（CSS 规定动画名不得
 * 与关键字冲突），所以从候选里剔掉——剩下的要么是真名字，要么是拼错的名字。
 */
const KEYWORDS = new Set([
  "none", "inherit", "initial", "unset", "revert", "revert-layer",
  "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end",
  "infinite", "normal", "reverse", "alternate", "alternate-reverse",
  "forwards", "backwards", "both", "running", "paused",
]);

/** `@keyframes name { … }` 的名字与花括号体（逐字符配平，关键帧里有嵌套的 from/to 块）。 */
function keyframeBodies(text: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of text.matchAll(/@(?:-\w+-)?keyframes\s+([\w-]+)\s*\{/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    out.push({ name: m[1], body: text.slice(start, i - 1) });
  }
  return out;
}

/**
 * 不靠乘数的例外。`shimmer` 是加载占位的扫光：减动效下由 AgentChat.module.css 的
 * `animation: none` 整个关掉，不是「保留淡入去位移」那一类。
 */
const SHIFT_EXEMPT = new Set(["shimmer"]);

describe("CSS @keyframes 的全局命名空间", () => {
  it("每个名字全库只定义一次", () => {
    const seen = new Map<string, string[]>();
    for (const f of files) {
      for (const name of definitions(f.text)) {
        seen.set(name, [...(seen.get(name) ?? []), f.path]);
      }
    }
    const dupes = [...seen.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([name, where]) => `${name} — ${where.join(" / ")}`)
      .sort();
    // 重名会静默覆盖：LightningCSS 把两条同名规则合进一份产物，后出现的赢。
    expect(dupes).toEqual([]);
  });

  it("每个 animation 引用都能找到定义", () => {
    const defined = new Set(files.flatMap((f) => definitions(f.text)));
    const dangling = new Set<string>();
    for (const f of files) {
      for (const name of references(f.text)) {
        if (!KEYWORDS.has(name) && !defined.has(name)) dangling.add(`${name} — ${f.path}`);
      }
    }
    // 这条是 docs/issues/css-modules-global-keyframes.md 的回归测试。
    expect([...dangling].sort()).toEqual([]);
  });

  it("会位移的关键帧都乘了 --motion-shift", () => {
    // reduced-motion 下全局只把 --motion-shift 置 0（global.css，方案 047）：关键帧照播
    // opacity、位移归零。写死偏移量的关键帧会在减动效下照样滑动，而且不报任何错。
    const offenders = files
      .flatMap((f) =>
        keyframeBodies(f.text)
          .filter((k) => !SHIFT_EXEMPT.has(k.name))
          .filter((k) => /translate|scale\(/.test(k.body) && !k.body.includes("var(--motion-shift)"))
          .map((k) => `${k.name} — ${f.path}`),
      )
      .sort();
    expect(offenders).toEqual([]);
  });
});
