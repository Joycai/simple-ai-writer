/**
 * 分层与循环依赖的棘轮（docs/feature/code-structure-plan.md P0）。
 *
 * 顶层分层是 `components → stores → lib → Tauri`。这条测试管三件从里面侵蚀它的事：
 *
 *   1. **运行时循环**：值导入图的强连通分量。只有 `ALLOWED_CYCLES` 里记的组可以存在；
 *      出现新的组、已有的组吸进新文件，都失败。
 *   2. **`lib → stores`**：`src/lib/` 下的文件对 `src/stores/` 的值导入。按文件记上限，没记的就是 0。
 *   3. **store 之间的 `await import`**：多数是为了躲开第 1 条才写成动态的。按文件记上限。
 *
 * **数的是值导入。** `import type` 与花括号里全是 `type X` 的导入在编译后消失，不算；
 * `import("…")`（通常是 `await import`）**算**一条边——它躲得过打包器的环检测，躲不过运行时。
 *
 * **组而不是环路。** 环路有几条取决于遍历顺序，组的成员不取决于。所以棘轮记组。
 *
 * **只许降。** 组变小、消失，上限高于实际，也会失败，提示把清单改成新的实际值——
 * 免得下次有人悄悄用掉腾出来的名额。
 *
 * TypeScript 7 没有 JS 编译器 API，所以这里用正则解析 import，不引依赖；
 * 方案 §8 的 madge 命令用来交叉核对，不进 CI。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** 允许存在的循环组（成员按字母序），方案 §1.1。每组注明它会在哪个阶段被拆掉。 */
const ALLOWED_CYCLES: Readonly<Record<string, readonly string[]>> = {
  // B：lore/citations 读 loreStore（P3）。
  lore: [
    "lib/fs/markdown.ts",
    "lib/lore/citations.ts",
    "lib/lore/entity.ts",
    "lib/lore/index.ts",
    "lib/lore/transfer.ts",
    "stores/loreStore.ts",
  ],
  // C：切换 / 关闭项目时 projectStore 调 agentStore（P4）。
  project: [
    "stores/agentStore.ts",
    "stores/editorStore.ts",
    "stores/memoryStore.ts",
    "stores/projectStore.ts",
  ],
  // C：runTask 问 batchStore.running（P4）。
  batch: ["stores/aiTaskStore.ts", "stores/batchStore.ts"],
};

/** `lib/` 下对 `stores/` 有值依赖的文件及其导入条数上限，方案 §1.2。没记的就是 0。 */
const LIB_TO_STORES: Readonly<Record<string, number>> = {
  "lib/agent/imageTools.ts": 1, // aiStore 的 models / subAgents（P3）
  "lib/translate/tool.ts": 1, // aiStore（P3）
  "lib/asr/conn.ts": 1, // aiStore（P3）
  "lib/image/illustrate.ts": 1, // aiStore 的 models / providers（P3）
  "lib/lore/citations.ts": 2, // loreStore + appStore（P3）
  "lib/agent/docxTools.ts": 1, // docFormatStore（P3）
  "lib/editor/aiSelection.ts": 1, // editorStore.editorView（P3）
};

/** `stores/` 之间 `import("./xStore")` 的条数上限，方案 §1.3。没记的就是 0。 */
const STORE_DYNAMIC: Readonly<Record<string, number>> = {
  "stores/agentStore.ts": 34,
  "stores/roleplayStore.ts": 18,
  "stores/aiTaskStore.ts": 5,
  "stores/projectStore.ts": 4,
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sources(p, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * 去掉注释，字符串原样保留（模块路径就在字符串里）。
 * 注释里的 `import("./x")` 示例不该变成一条边。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface Edge { to: string; dynamic: boolean }

const STATIC_IMPORT = /^\s*(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** 一个文件的值导入说明符（未解析）。 */
function valueImports(src: string): { spec: string; dynamic: boolean }[] {
  const code = stripComments(src);
  const out: { spec: string; dynamic: boolean }[] = [];
  for (const m of code.matchAll(STATIC_IMPORT)) {
    if (m[1]) continue;
    const body = m[2].trim();
    if (body.startsWith("{")) {
      const names = body.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    out.push({ spec: m[3], dynamic: false });
  }
  for (const m of code.matchAll(BARE_IMPORT)) out.push({ spec: m[1], dynamic: false });
  for (const m of code.matchAll(DYNAMIC_IMPORT)) out.push({ spec: m[1], dynamic: true });
  return out;
}

const files = sources(SRC).map((f) => relative(SRC, f).split("\\").join("/"));
const fileSet = new Set(files);

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec).split("\\").join("/");
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

const graph = new Map<string, Edge[]>();
for (const f of files) {
  const edges: Edge[] = [];
  for (const { spec, dynamic } of valueImports(readFileSync(join(SRC, f), "utf8"))) {
    const to = resolve(f, spec);
    if (to && to !== f) edges.push({ to, dynamic });
  }
  graph.set(f, edges);
}

/** Tarjan：返回大小 > 1 的强连通分量，成员排序。 */
function stronglyConnected(g: ReadonlyMap<string, readonly Edge[]>): string[][] {
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const { to } of g.get(v) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(v, Math.min(low.get(v)!, low.get(to)!));
      } else if (onStack.has(to)) low.set(v, Math.min(low.get(v)!, index.get(to)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of g.keys()) if (!index.has(v)) visit(v);
  return out;
}

describe("分层与循环依赖", () => {
  it("import 解析：类型导入不算，动态导入算，注释里的不算", () => {
    const specs = (src: string) => valueImports(src).map((x) => `${x.spec}${x.dynamic ? "*" : ""}`);
    expect(specs('import type { A } from "./a";\nimport { type B, type C } from "./b";')).toEqual([]);
    expect(specs('import { type B, c } from "./b";\nexport { d } from "./d";')).toEqual(["./b", "./d"]);
    expect(specs('const { x } = await import("./x");\n// await import("./y")\n/* import("./z") */')).toEqual(["./x*"]);
    expect(specs('import "./side";\nconst s = "// not a comment"; import { q } from "./q";')).toEqual(["./q", "./side"]);
  });

  it("Tarjan 找得到组，也不把链当成组", () => {
    const g = (pairs: [string, string][]) => {
      const m = new Map<string, Edge[]>();
      for (const [a, b] of pairs) {
        m.set(a, [...(m.get(a) ?? []), { to: b, dynamic: false }]);
        if (!m.has(b)) m.set(b, []);
      }
      return m;
    };
    expect(stronglyConnected(g([["a", "b"], ["b", "c"]]))).toEqual([]);
    expect(stronglyConnected(g([["a", "b"], ["b", "a"], ["b", "c"], ["c", "d"], ["d", "c"]]))).toEqual([["c", "d"], ["a", "b"]]);
  });

  it("清单里的文件都还在", () => {
    for (const rel of [...Object.values(ALLOWED_CYCLES).flat(), ...Object.keys(LIB_TO_STORES), ...Object.keys(STORE_DYNAMIC)]) {
      expect(fileSet.has(rel), rel).toBe(true);
    }
  });

  it("循环组与 ALLOWED_CYCLES 一致（只许缩小，缩小了要改清单）", () => {
    const actual = stronglyConnected(graph);
    const problems: string[] = [];
    const matched = new Set<string>();
    for (const comp of actual) {
      const name = Object.entries(ALLOWED_CYCLES).find(([, members]) => comp.some((f) => members.includes(f)))?.[0];
      if (!name) {
        problems.push(`新的循环组：${comp.join(" · ")}`);
        continue;
      }
      matched.add(name);
      const allowed = ALLOWED_CYCLES[name];
      const extra = comp.filter((f) => !allowed.includes(f));
      const gone = allowed.filter((f) => !comp.includes(f));
      if (extra.length) problems.push(`组 ${name} 吸进了新文件：${extra.join(" · ")}`);
      if (gone.length) problems.push(`组 ${name} 缩小了——把这些从 ALLOWED_CYCLES 删掉：${gone.join(" · ")}`);
    }
    for (const name of Object.keys(ALLOWED_CYCLES)) {
      if (!matched.has(name)) problems.push(`组 ${name} 已经消失——把它从 ALLOWED_CYCLES 删掉`);
    }
    expect(
      problems,
      "循环依赖的棘轮（docs/feature/code-structure-plan.md）。新环：把共享的纯函数挪进不依赖对方的模块，" +
        "或者把依赖作参数注入（ToolContext 是现成的注入点），而不是写成 await import。\n" +
        problems.join("\n"),
    ).toEqual([]);
  });

  it("lib 不读 stores（上限只许降）", () => {
    const actual = new Map<string, number>();
    for (const [f, edges] of graph) {
      if (!f.startsWith("lib/")) continue;
      const n = edges.filter((e) => e.to.startsWith("stores/")).length;
      if (n > 0) actual.set(f, n);
    }
    const problems: string[] = [];
    for (const [f, n] of actual) {
      const cap = LIB_TO_STORES[f] ?? 0;
      if (n > cap) problems.push(`${f}：${n} 条 lib → stores 导入，上限 ${cap}`);
    }
    for (const [f, cap] of Object.entries(LIB_TO_STORES)) {
      const n = actual.get(f) ?? 0;
      if (n < cap) problems.push(`${f}：降到了 ${n}，把 LIB_TO_STORES 的上限改成 ${n}${n === 0 ? "（删掉这一行）" : ""}`);
    }
    expect(
      problems,
      "lib 是 stores 的下层。需要 store 里的东西，就让调用方作参数传进来（agent 工具经 ToolContext）。\n" +
        problems.join("\n"),
    ).toEqual([]);
  });

  it("store 之间的动态导入（上限只许降）", () => {
    const actual = new Map<string, number>();
    for (const [f, edges] of graph) {
      if (!f.startsWith("stores/")) continue;
      const n = edges.filter((e) => e.dynamic && e.to.startsWith("stores/")).length;
      if (n > 0) actual.set(f, n);
    }
    const problems: string[] = [];
    for (const [f, n] of actual) {
      const cap = STORE_DYNAMIC[f] ?? 0;
      if (n > cap) problems.push(`${f}：${n} 处 store 间 import()，上限 ${cap}`);
    }
    for (const [f, cap] of Object.entries(STORE_DYNAMIC)) {
      const n = actual.get(f) ?? 0;
      if (n < cap) problems.push(`${f}：降到了 ${n}，把 STORE_DYNAMIC 的上限改成 ${n}${n === 0 ? "（删掉这一行）" : ""}`);
    }
    expect(
      problems,
      "store 间的 await import 多半是在躲循环依赖。先看能不能拆掉环，再写成静态导入。\n" + problems.join("\n"),
    ).toEqual([]);
  });
});
