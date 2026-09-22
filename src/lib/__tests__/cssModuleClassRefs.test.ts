/**
 * `styles.foo` 里的 `foo` 必须在它指向的 `.module.css` 里真的有。
 *
 * CSS Module 的导入是一张普通的对象映射，取不存在的键返回 `undefined`，而
 * `className={`${styles.a} ${styles.b}`}` 会把它拼成字面量字符串 `"undefined"`
 * 当类名用。元素因此**一点样式都没有**，tsc / vitest / build 三道门禁一声不吭
 * ——和 docs/issues/css-modules-global-keyframes.md 记的那个缺陷同一个形状：
 * 唯一的证据是肉眼，而肉眼看的是「这里本来长什么样」，没人记得。
 *
 * 2026-09-22 全库扫出 11 处，理由见 docs/issues/css-module-dangling-class.md。
 *
 * **为什么敢做成门禁：判据只在能证明无误报的地方开口。**
 * 朴素的文本扫描在这个仓库里必然误报，两处来源都真实存在：
 *   1. 字符串里的同形文本 —— `t("aiConfig.hub.unknownProvider")` 长得就像
 *      `hub.unknownProvider`，而 `hub` 确实是 `ProvidersModels.module.css` 的
 *      导入名；
 *   2. 被局部绑定遮住的同名标识符 —— `ProvidersModelsPane.tsx` 里 `r` 既是
 *      `Routes.module.css` 的导入名，又是 `rows.filter((r) => r.visible)` 的形参，
 *      那里的 `r.top` / `r.visible` 跟 CSS 毫无关系。
 *
 * 所以这里不扫文本，扫 AST（`vite` 转出来的 `parseAst`，oxc，认 TS 与 JSX）：
 *   - 第 1 类天然消失：字符串字面量里的内容不是 `MemberExpression`，走不到检查点；
 *   - 第 2 类靠一条**保守到可以证明**的规矩挡掉：一个导入名，只有当它在整个文件里
 *     **除了 import 那一次之外，每一次出现都是 `名字.属性` 或 `名字["属性"]`** 时
 *     才检查。局部重新绑定同一个名字（形参、`const`、解构、函数名……）必然在某处
 *     留下一个不是属性访问的裸标识符，于是整个名字直接弃检。
 *     代价是漏报（`r` 那种文件不检查），而漏报是安全的方向——**会误报的守卫比没有
 *     守卫更糟**，这条测试宁可少管。
 *
 * 同样只往漏报一侧倒的还有两处：模板串下标（`styles[`marker_${state}`]`）拿不到
 * 静态名字，跳过不查；CSS 侧的类名用正则收，`:global(.foo)` 里的名字其实不出现在
 * 导出映射里，这里当它存在——都是「放过去」，不会冤枉谁。
 */
import { parseAst } from "vite";
import { describe, expect, it } from "vitest";

/** 按 cssKeyframeNames.test.ts 的先例就地声明：本项目 tsconfig 没有 @types/node。 */
declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  existsSync(p: string): boolean;
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const ROOT = process.cwd();

/**
 * 还没修的，连同修它的去处。**这张表要回到空的**——它不是豁免清单，是排队。
 *
 * `FeeGroupDrawer.tsx` 的 `hub.input` / `hub.unset` 指向
 * `ProvidersModels.module.css` 里没有的两个类，整个抽屉的输入框因此退回浏览器
 * 原生样式。发现于计费组那期，正在 `feat/fee-group-search-and-vendor` 上修，
 * 所以 2026-09-22 清理另外九处时没有一并动——那边落地后，删掉这两行。
 */
const PENDING: ReadonlySet<string> = new Set([
  "src/components/settings/panes/FeeGroupDrawer.tsx  hub.input",
  "src/components/settings/panes/FeeGroupDrawer.tsx  hub.unset",
]);

/** ESTree 节点，只用到通用形状：oxc 会给出 TS / JSX 专有的类型，这里不区分。 */
type Node = { type: string } & Record<string, unknown>;

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

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 整棵树的 `[节点, 父节点, 父节点上的字段名]`。 */
function* walk(root: Node): Generator<[Node, Node | null, string | null]> {
  const stack: [Node, Node | null, string | null][] = [[root, null, null]];
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) continue;
    const [n, parent, key] = entry;
    if (!n || typeof n !== "object" || typeof n.type !== "string") continue;
    yield [n, parent, key];
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (k === "type" || !v || typeof v !== "object") continue;
      if (Array.isArray(v)) for (const c of v) stack.push([c as Node, n, k]);
      else stack.push([v as Node, n, k]);
    }
  }
}

/**
 * 只可能是「字面的名字」的位置——永远不是引用，也永远不是绑定。
 *
 * 这些位置上的标识符不该算进「裸用了一次」的账：`hub.hub` 右边那个 `hub`、
 * `{ ui: n }` 的键、`import { x as y }` 的 `x`，都不可能是把名字遮住的绑定。
 * 少算它们不会放宽判据（判据是「裸用恰好一次」），只是让更多文件进得了检查。
 */
function isStaticName(parent: Node | null, key: string | null): boolean {
  if (!parent) return false;
  const computed = parent.computed === true;
  if ((parent.type === "MemberExpression" || parent.type === "JSXMemberExpression") && key === "property" && !computed) return true;
  if (key === "key" && !computed
    && ["Property", "PropertyDefinition", "MethodDefinition", "TSPropertySignature", "TSMethodSignature"].includes(parent.type)) return true;
  if (parent.type === "ImportSpecifier" && key === "imported") return true;
  if (parent.type === "ExportSpecifier") return true;
  if (parent.type === "TSQualifiedName" && key === "right") return true;
  if (["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type)) return true;
  return false;
}

/**
 * 一份 CSS 里出现过的类名。
 *
 * 宁可多收：`url(a.png)` 的 `png`、`.foo:hover` 都会进来，多收只会让检查放过
 * 更多东西。少收才会冤枉人，而任何类选择器都字面地写着 `.名字`。
 */
function classesOf(path: string): Set<string> {
  const out = new Set<string>();
  for (const m of (fs.readFileSync(path, "utf8") as string).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

/** 一个文件里所有「查得动」的引用，以及因为重名而整个弃检的导入名。 */
function scan(file: string): { dangling: string[]; skipped: string[] } {
  const src = fs.readFileSync(file, "utf8") as string;
  if (!src.includes(".module.css")) return { dangling: [], skipped: [] };
  const rel = file.slice(ROOT.length + 1);
  // `lang` 要显式给：只传 filename 的话 oxc 按扩展名猜，`.tsx` 会被当成 JSX 解析，
  // 于是 `(d: number) => …` 的类型标注就成了语法错误。
  const ast = parseAst(src, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }, file) as unknown as Node;

  const imports = new Map<string, string>();
  for (const [n] of walk(ast)) {
    if (n.type !== "ImportDeclaration") continue;
    const spec = (n.source as Node | undefined)?.value;
    if (typeof spec !== "string" || !spec.endsWith(".module.css")) continue;
    for (const s of (n.specifiers as Node[] | undefined) ?? []) {
      if (s.type === "ImportDefaultSpecifier") {
        imports.set((s.local as Node).name as string, normalize(`${file.replace(/\/[^/]*$/, "")}/${spec}`));
      }
    }
  }
  if (!imports.size) return { dangling: [], skipped: [] };

  const props = new Map<string, Set<string>>([...imports.keys()].map((k) => [k, new Set<string>()]));
  const bare = new Map<string, number>([...imports.keys()].map((k) => [k, 0]));
  const asObject = new Set<Node>();

  for (const [n] of walk(ast)) {
    if (n.type !== "MemberExpression") continue;
    const obj = n.object as Node | undefined;
    if (obj?.type !== "Identifier" || !props.has(obj.name as string)) continue;
    asObject.add(obj);
    const prop = n.property as Node | undefined;
    const seen = props.get(obj.name as string)!;
    if (n.computed !== true && prop?.type === "Identifier") seen.add(prop.name as string);
    else if (n.computed === true && prop?.type === "Literal" && typeof prop.value === "string") seen.add(prop.value);
    // 其余（模板串、变量下标）拿不到静态名字，跳过。
  }
  for (const [n, parent, key] of walk(ast)) {
    if (n.type !== "Identifier" && n.type !== "JSXIdentifier") continue;
    const name = n.name as string;
    if (!bare.has(name) || asObject.has(n) || isStaticName(parent, key)) continue;
    bare.set(name, bare.get(name)! + 1);
  }

  const dangling: string[] = [];
  const skipped: string[] = [];
  for (const [name, cssPath] of imports) {
    // import 那一次自己就是一个裸标识符；多于一次就说明这个名字在文件里还有别的身份。
    if (bare.get(name) !== 1) { skipped.push(`${rel}  ${name}`); continue; }
    if (!fs.existsSync(cssPath)) { dangling.push(`${rel}  ${name} → 找不到 ${cssPath.slice(ROOT.length + 1)}`); continue; }
    const have = classesOf(cssPath);
    for (const p of [...props.get(name)!].sort()) if (!have.has(p)) dangling.push(`${rel}  ${name}.${p}`);
  }
  return { dangling, skipped };
}

const results = sourceFiles(`${ROOT}/src`).map(scan);

describe("CSS Module 的类名引用", () => {
  it("每个 styles.foo 都能在对应的 .module.css 里找到 .foo", () => {
    const dangling = results.flatMap((r) => r.dangling).filter((d) => !PENDING.has(d)).sort();
    // 悬空的引用会变成字面量类名 "undefined"，元素一点样式都没有，且不报任何错。
    expect(dangling).toEqual([]);
  });

  it("弃检的导入名只剩下真正重名的那些", () => {
    // 这条不是不变量，是**覆盖率的账**：弃检是判据为了零误报付的代价，涨了要有人看见。
    // 新增一行之前先想想能不能把导入改个不重名的名字——那比弃检划算。
    const skipped = results.flatMap((r) => r.skipped).sort();
    expect(skipped).toEqual([
      // `r` 同时是 rows.filter((r) => r.visible) 的形参。
      "src/components/settings/panes/ProvidersModelsPane.tsx  r",
    ]);
  });
});
