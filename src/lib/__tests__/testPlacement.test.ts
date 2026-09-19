/**
 * 测试住在被测模块最近的 `__tests__/` 里。
 *
 * 「最近的那个 `__tests__/`」一直是本项目的约定（CLAUDE.md · Testing & Type
 * Safety），但没人守着，于是 `src/lib/__tests__/` 变成了唯一的测试目录：到
 * 2026-09-16 它装着 236 个文件，覆盖 25 个子系统，而同期只有 9 个子系统自己开了
 * `__tests__/`。代价不是好看不好看——是「`lib/lore/` 有哪些测试」这个问题没有
 * 答案：唯一的索引是文件名前缀，而前缀是巧合不是契约（`loreSelect.test.ts` 测的
 * 是 `context/loreSelect.ts`，`comfyProbe.test.ts` 测的是 `ai/providerProbe.ts`，
 * `imageClient.test.ts` 测的是 `ai/image.ts`）。改一个模块要跑哪些测试靠记性；
 * `vitest --changed` 也帮不上忙，它按依赖图算，而平铺目录里的测试彼此无关、
 * 又都离被测模块一层远。
 *
 * 那天把 211 个搬回了各自的子系统（另有 24 个被测对象是 store，搬去了
 * `src/stores/__tests__/`；1 个是组件，搬去了 `src/components/lore/__tests__/`），
 * 只留下 22 个。这条测试就是那道闸门：留下的之所以能留，是因为它们的被测对象
 * **不在任何一个子系统里**——要么测 `src/lib/*.ts` 的根模块，要么是全库扫描的
 * 闸门（`exportReach` 那一类，被测对象是整个 `src/`）。
 *
 * **判据。** 平铺目录里的测试，被测对象不能是 `src/lib/<子系统>/` 下的模块。
 * **打桩不算被测对象**：根模块会在运行时伸手进子系统（`resetApp` 要知道每个子
 * 系统各有哪些表，`staleRefs` 要遍历 `fs` 与 `agent` 存下的引用），测试必须能
 * 挡住那些手，所以 `vi.mock("../ai/configDb")` 是正当的；被测对象只能有一个，
 * 而它住在哪，测试就住在哪。
 *
 * **被它拦下来时，两条出路**：
 *   1. 新测试测的是某个子系统 —— 放进 `src/lib/<子系统>/__tests__/`，别放这里；
 *   2. 新测试测的是根模块或全库 —— 在下面两张表里加一行，**并写清楚被测对象是
 *      谁**。要写理由是故意的：这两张表就是平铺目录的存在理由，它一旦说不清楚，
 *      这个目录就该清空。
 */
import { describe, expect, it } from "vitest";

/** 按 cssKeyframeNames.test.ts 的先例就地声明：本项目 tsconfig 没有 @types/node。 */
declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string): string[];
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  existsSync(p: string): boolean;
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const ROOT = process.cwd();
const LIB = `${ROOT}/src/lib`;
const FLAT = `${LIB}/__tests__`;

/** 根模块的测试：被测对象是 `src/lib/*.ts` 自己。值是那个模块名。 */
const ROOT_MODULE_TESTS: Readonly<Record<string, string>> = {
  "appReset.test.ts": "appReset",
  "closeDocShortcut.test.ts": "shortcuts",
  "httpLocalUrl.test.ts": "http",
  "ime.test.ts": "ime",
  "keyStore.test.ts": "keyStore",
  "notify.test.ts": "notify",
  "paths.test.ts": "paths",
  "pinnedProjects.test.ts": "recentProjects",
  "prefs.test.ts": "prefs",
  "projectDbCache.test.ts": "project",
  "recentProjects.test.ts": "recentProjects",
  "screenShortcuts.test.ts": "shortcuts",
  "staleRefs.test.ts": "staleRefs",
  "webviewCaps.test.ts": "webviewCaps",
};

/** 全库扫描的闸门：没有单一被测模块，被测对象是整个仓库。值是它扫什么。 */
const REPO_WIDE_TESTS: Readonly<Record<string, string>> = {
  "agentsMdSync.test.ts": "扫仓库根的 CLAUDE.md 与 AGENTS.md——后者是前者换头生成的镜像，不许漂开",
  "capabilityFamilyRatchet.test.ts": "扫 src/ 全部源码——能力有无不许在调用点按协议族判断（棘轮）",
  "cssKeyframeNames.test.ts": "扫 src/ 全部 .css——@keyframes 的命名空间是全局的",
  "docSourceRefs.test.ts": "扫 docs/ 与源码注释——不许写 `文件:行号`",
  "exportReach.test.ts": "扫 src/ 全部导出——每个 export 得有第二个文件用它",
  "focusRing.test.ts": "扫 src/styles/——焦点环只能由 token 画",
  "localeParity.test.ts": "扫 i18n 两个语言包——键集必须一致",
  "localeTerms.test.ts": "扫 src/ 全部作者可见文案——退役词不许复活",
  "sourceNulBytes.test.ts": "扫全部源码——不许有裸 NUL 字节",
  "storeSelectorFreshObjects.test.ts": "扫 src/ 全部 store selector——不许返回 providerFor 之类现造的对象（React #185）",
  "testPlacement.test.ts": "扫 src/lib/ 的测试位置——就是本文件",
};

const LISTED = [...Object.keys(ROOT_MODULE_TESTS), ...Object.keys(REPO_WIDE_TESTS)];

/** `src/lib/` 的直接子目录（子系统），`__tests__` 自己不算。 */
const SUBDIRS = fs
  .readdirSync(LIB, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "__tests__")
  .map((e) => e.name);

/** 根模块清单：`src/lib/*.ts`。 */
const ROOT_MODULES = fs.readdirSync(LIB).filter((n) => n.endsWith(".ts")).map((n) => n.replace(/\.ts$/, ""));

const EXTS = ["", ".ts", ".tsx", ".js", ".json", ".css"];

/** 手写的 `..` 折叠：不能用 node:path（同上，没有 @types/node）。 */
function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `${p.startsWith("/") ? "/" : ""}${out.join("/")}`;
}

/** 说明符指向的真实文件；指不到东西的字符串是测试数据，不是路径。 */
function realTarget(fromDir: string, spec: string): string | null {
  const abs = normalize(spec.startsWith(".") ? `${fromDir}/${spec}` : spec);
  for (const e of EXTS) if (fs.existsSync(abs + e)) return abs + e;
  return null;
}

/** 一个文件里，某个位置上的全部相对说明符 → 真实文件。 */
function resolveAll(file: string, re: RegExp): string[] {
  const text = fs.readFileSync(file, "utf8") as string;
  const dir = file.replace(/\/[^/]*$/, "");
  const found = new Set<string>();
  for (const m of text.matchAll(re)) {
    const real = realTarget(dir, m[1]);
    if (real) found.add(real);
  }
  return [...found];
}

/** 模块位置：`from "x"` / `import "x"` / `import("x")` / `require("x")`。 */
const MODULE_POSITION = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.[^"'`\n]*)["']/g;

/** 打桩位置：`vi.mock("x")` 一族。 */
const STUB_POSITION = /\bvi\.(?:mock|unmock|doMock)\s*\(\s*["'](\.[^"'`\n]*)["']/g;

const inSubdir = (real: string): boolean => {
  if (!real.startsWith(`${LIB}/`)) return false;
  return SUBDIRS.includes(real.slice(LIB.length + 1).split("/")[0]);
};

const rel = (p: string): string => p.slice(ROOT.length + 1);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const flatFiles = fs.readdirSync(FLAT).filter((n) => n.endsWith(".test.ts")).sort();

describe("测试位置", () => {
  it("平铺目录里只有登记过的那两类", () => {
    const unlisted = flatFiles.filter((f) => !LISTED.includes(f));
    const stale = LISTED.filter((f) => !flatFiles.includes(f));
    expect(
      [
        unlisted.length ? `没登记的（测子系统的请搬去 src/lib/<子系统>/__tests__/）：${unlisted.join("、")}` : "",
        stale.length ? `登记了但文件已不在：${stale.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ).toBe("");
  });

  it("平铺目录里的测试不以子系统模块为被测对象", () => {
    const offenders = flatFiles
      .map((f) => {
        const file = `${FLAT}/${f}`;
        const stubs = new Set(resolveAll(file, new RegExp(STUB_POSITION.source, "g")));
        const subjects = resolveAll(file, new RegExp(MODULE_POSITION.source, "g")).filter(
          (r) => inSubdir(r) && !stubs.has(r),
        );
        return { f, subjects };
      })
      .filter((o) => o.subjects.length > 0);
    expect(offenders.map((o) => `${o.f} → ${o.subjects.map(rel).join("、")}`).join("\n")).toBe("");
  });

  it("根模块测试确实测它登记的那个模块", () => {
    const wrong = Object.entries(ROOT_MODULE_TESTS)
      .filter(([file, mod]) => {
        if (!ROOT_MODULES.includes(mod)) return true;
        const subjects = resolveAll(`${FLAT}/${file}`, new RegExp(MODULE_POSITION.source, "g"));
        return !subjects.includes(`${LIB}/${mod}.ts`);
      })
      .map(([file, mod]) => `${file} 登记的是 ${mod}.ts，但它没把它当被测对象`);
    expect(wrong.join("\n")).toBe("");
  });

  it("测试文件只住在 __tests__ 里", () => {
    const stray = walk(`${ROOT}/src`)
      .filter((p) => !p.split("/").includes("__tests__"))
      .map(rel);
    expect(stray.join("\n")).toBe("");
  });
});
