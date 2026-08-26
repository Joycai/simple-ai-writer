# 019 — 模块内 @keyframes 的全局唯一性守卫

- **Status**: TODO
- **Commit**: 93eb7de
- **Severity**: LOW（但防的是一类**静默**缺陷）
- **Category**: 内聚与令牌 / 工程
- **Estimated scope**: 1 个新测试文件（~60 行）+ 2 处注释更新

## Problem

`docs/issues/css-modules-global-keyframes.md` 记录的缺陷（模块 CSS 引用 global.css 的
keyframes 会悬空、动画一帧不播）已于 2026-08-23 修复：`vite.config.ts` 切到
LightningCSS 并关掉了动画名哈希。修复本身是对的，**但它把模块内的
`@keyframes` 并进了一个全局命名空间**，并因此引入了一条新的、无人守护的不变量。

两处文档都记着当时的名单，而两处**现在都已过期**：

```js
// vite.config.ts:31-33 — 现状
//   ... 消费：module-local @keyframes now share ONE global namespace
//   with global.css — keep their names unique (currently: shimmer,
//   transitionGrow).
```

```
docs/issues/css-modules-global-keyframes.md:67-71 — 现状
  落地时全库只有三个模块内 keyframes（AgentChat 的 `shimmer`、SceneTransition
  的 `transitionGrow`、ProvidersModels 的 `slideOutRight`），与 global.css 的
  12 个名字零冲突。**以后在模块里写 `@keyframes` 要起全局唯一的名字**
```

实际清点（基准 93eb7de）：

- `src/styles/global.css` 定义 **12** 个：`fadeIn` `scaleIn` `slideUp` `slideInRight`
  `blink` `pulse` `spin` `pulseDeep` `dropIn` `riseIn` `fadeOut` `scaleOut`
- 模块内定义 **10** 个：`drawerIn`（DocFormat）· `orderFlash` `slideOutRight`
  （ProvidersModels）· `traceIn` `snipRise`（SnippetPicker）· `writerPulse`
  （WriterTurn）· `nameIn`（SnippetSaveMenu）· `jumpLatestIn` `shimmer`
  （AgentChat）· `transitionGrow`（SceneTransition）

即：文档说 3 个，实际 10 个。**今天零冲突，不变量成立**——这个方案不是修 bug，
是给它上锁。一旦某个模块新写的 `@keyframes fadeIn` 与 global.css 重名，
LightningCSS 会把两条同名规则合进一份产物，后出现的那条**静默覆盖**全应用的
`fadeIn`——没有报错、没有告警，症状是「某些地方的入场动画忽然变了个样子」，
而这恰恰是原 issue 里那种「computed style 照样报得出名字」的无症状故障。

本仓库对同类跨文件不变量已有先例守卫：`src/lib/__tests__/pptxHarvesterCsp.test.ts`
（`tauri.conf.json` 的 CSP 哈希与 `harvester.js` 必须同步，漂移后唯一的证据也是静默超时）。

## Target

新增 `src/lib/__tests__/cssKeyframeNames.test.ts`，扫描 `src/**/*.css`，断言：

1. 全库任何一个 `@keyframes` 名字只被定义一次（跨文件、跨 module/global 边界）。
2. 每一处 `animation` / `animation-name` 引用的名字，都能在全库定义集合里找到
   （这是原 issue 那个「引用悬空」缺陷的直接回归测试）。

第 2 条会顺带保证：假如以后有人把 `vite.config.ts` 的
`cssModules: { animation: false }` 去掉，测试仍然通过——因为它测的是**源码层面**
名字对得上。所以第 2 条不能替代第 1 条，两条都要。

```ts
/* 目标断言的形状 */
it("每个 @keyframes 名字全库只定义一次", () => {
  expect(duplicates).toEqual([]);
});
it("每个 animation 引用都有对应定义", () => {
  expect(dangling).toEqual([]);
});
```

## Repo conventions to follow

- **测试位置**：`src/lib/__tests__/`，一个模块一个文件（见 CLAUDE.md → Testing）。
- **读 CSS 的方式必须照抄 `src/lib/__tests__/themeTokenParity.test.ts:23-38`**，
  它已经踩过并写下了两个坑：`import.meta.glob(..., {query:"?raw"})` 对 `.css`
  **返回空**（vitest 把 CSS 管线打了桩，`?raw` 逃不出去），而本项目 tsconfig
  没有 `@types/node`，所以裸 `import "node:fs"` 在 vitest 里能跑、到 CI 的
  `tsc --noEmit` 会挂。它的解法是就地声明：

```ts
declare const require: (m: string) => { readFileSync(p: string, enc: string): string };
declare const process: { cwd(): string };

const read = (rel: string): string =>
  require("node:fs").readFileSync(`${process.cwd()}/${rel}`, "utf8");
```

  本测试还需要遍历目录，用同一把 `require("node:fs")` 取 `readdirSync`，
  并把它加进上面的类型声明（见下面 Steps 第 2 步的完整写法）。
- **文件头注释写「这个测试为什么存在」**，照 `pptxHarvesterCsp.test.ts:1-19`
  的体例——本仓库的测试注释记录的是故障史，不是断言的复述。

## Steps

1. 新建 `src/lib/__tests__/cssKeyframeNames.test.ts`。

2. 写入以下内容（可整段照抄）：

```ts
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

declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const ROOT = `${process.cwd()}/src`;

/** 全部 .css（含 .module.css），路径相对仓库根。 */
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
 * 去掉 var(...) 与函数调用，再把每个 token 与已知定义集合比对——认得出的就是
 * 名字。关键字（linear/infinite/forwards…）和时长因此天然落选，代价是拼错的名字
 * 也落选，正好由 dangling 那条断言接住。
 */
function references(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    const value = m[1].replace(/var\([^)]*\)/g, " ").replace(/[\w-]+\([^)]*\)/g, " ");
    for (const tok of value.split(/[\s,]+/)) if (/^[a-zA-Z][\w-]*$/.test(tok)) out.push(tok);
  }
  return out;
}

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
        // `animation: none` 是取消，不是引用。
        if (name !== "none" && !defined.has(name)) dangling.add(`${name} — ${f.path}`);
      }
    }
    // 这条是 docs/issues/css-modules-global-keyframes.md 的回归测试。
    expect([...dangling].sort()).toEqual([]);
  });
});
```

3. 跑 `pnpm test src/lib/__tests__/cssKeyframeNames.test.ts`。**两条都必须通过**。
   若第二条报出误伤（某个关键字被当成了动画名），**不要放宽断言**——把该 token
   加进 `references()` 的排除逻辑并在注释里写明是哪个关键字，然后重跑。

4. 更新 `vite.config.ts` 第 31-33 行的注释，把 `(currently: shimmer,
   transitionGrow)` 换成指向守卫的说法：

```js
  // 消费：module-local @keyframes now share ONE global namespace with
  // global.css — keep their names unique. Enforced by
  // src/lib/__tests__/cssKeyframeNames.test.ts (a collision is silent: the
  // later rule simply wins). See docs/issues/css-modules-global-keyframes.md.
```

5. 更新 `docs/issues/css-modules-global-keyframes.md:67-71`：把「落地时全库只有
   三个模块内 keyframes（…）」改成当前事实 + 守卫指路，例如：

```
  哈希」——代价是**模块内 keyframes 与 global.css 共用一个全局命名空间**。
  落地时全库 3 个模块内 keyframes，到 93eb7de 已是 10 个（drawerIn ·
  orderFlash · slideOutRight · traceIn · snipRise · writerPulse · nameIn ·
  jumpLatestIn · shimmer · transitionGrow），与 global.css 的 12 个名字仍然
  零冲突。**以后在模块里写 `@keyframes` 要起全局唯一的名字**——这条现在由
  `src/lib/__tests__/cssKeyframeNames.test.ts` 守着，不再靠记性。
```

## Boundaries

- **不改任何 `.css` 文件。** 本方案只加测试和更新两处注释；今天没有重名要修。
- 不改 `vite.config.ts` 的 `css` 配置本身（只改它上面的注释）。
- 不引入新依赖——**不要**装 `fast-glob` / `globby`，用上面的 `readdirSync` 递归。
- 不把这个测试写成快照测试（`toMatchSnapshot`）：名单会变，不变量不变，断言的
  必须是不变量。
- 若 `themeTokenParity.test.ts:23-38` 的读文件写法与本方案摘录不符（相对 93eb7de
  有漂移），停下报告，**以那个文件的现状为准**再照抄。

## Verification

- **机械**：
  - `pnpm test src/lib/__tests__/cssKeyframeNames.test.ts` → 2 passed。
  - `pnpm tsc --noEmit` → 无错误（这一步是本方案的真正风险点：`declare const`
    写漏会在这里挂，而 vitest 不会）。
  - `pnpm test` → 全量通过，无新增失败。
- **反向验证（必做，否则等于没测）**：临时在
  `src/components/ai/SnippetSaveMenu.module.css` 末尾加一行
  `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`，重跑该测试，
  **必须**看到第一条断言失败并在消息里点名 `fadeIn — src/styles/global.css /
  src/components/ai/SnippetSaveMenu.module.css`。确认后**删掉这一行**。
- 再临时把某处 `animation: fadeIn …` 改成 `animation: fadeInn …`，重跑，
  **必须**看到第二条断言失败。确认后改回。
- **Done when**：两条断言在干净树上通过，两次反向验证都如实报错并已还原，
  `vite.config.ts` 与 issue 文档的计数不再与代码矛盾。

## 不做

不去修「模块内应不应该有自己的 keyframes」——`shimmer` / `transitionGrow` /
`writerPulse` 都是单点专用动画，放在自己的模块里是对的。方案 022 只合并其中
**语义上是 global.css 已有动画克隆**的那三个（`nameIn` `traceIn` `drawerIn`），
两份方案互不重叠。
