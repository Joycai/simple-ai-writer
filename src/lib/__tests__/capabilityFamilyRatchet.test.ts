/**
 * 第三道闸（docs/api/capability-gating-plan.md §3、§8.5）：能力的有无只问能力表，不许在调用点按协议族再判一遍。
 *
 * 「这个模型在这条线路上能不能 X」曾经在四五个地方各算一遍，每处都拿协议族当答案——
 * 千问私有的 `vl_high_resolution_images` 就是这样漏到智谱上的：智谱也说 Chat Completions。
 * C0–C2 把这些判断收进了 `lib/ai/capabilities.ts`，这条测试防止它们长回来。
 *
 * **数的是什么。** 去掉注释后，`family === "…"` / `familyOf(…) !== "…"` / `x.family === "…"`
 * 这种「拿族和字面量比」的写法。`switch (family)` 不数——那几乎总是在选拼法。
 *
 * **两类文件。**
 *   - `WIRE_SHAPE`：按族决定**请求长什么样**的地方——拼法表、探测、URL（适配器按 `familyOf`
 *     分派，不拿族比字面量，本来就数不到）。
 *     在这里按族分支是对的，不数；每一条写明为什么。
 *   - 其余全部文件：计数不得超过 `CEILING` 里记的值，没记的就是 0。棘轮只许降：
 *     数少了也会失败，提示把上限改成新的数，免得下次有人悄悄用掉腾出来的名额。
 *
 * **被它拦下时。** 你写的多半是「这条线有没有 X」——去 `capabilities.ts` 加一行规则或一个平台格，
 * 调用点问 `hasCapability`。如果真是在选拼法或措辞（同一项能力，三族的说明文字不同），
 * 把上限加一，并在 `CEILING` 那一行的注释里说清楚是哪一处。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const FAMILY_TEST = /(?:\bfamily|familyOf\([^()]*\)|\.family)\s*[!=]==\s*["']/g;

/** 按族决定请求形状的文件：在这里按族分支本来就对。 */
const WIRE_SHAPE: Readonly<Record<string, string>> = {
  "lib/ai/capabilities.ts": "能力表本身——族是它的一个轴",
  "lib/ai/platforms.ts": "平台的地址与线路：每族一条路径约定",
  "lib/ai/routes.ts": "线路 ↔ ApiStandard 的换算",
  "lib/ai/urls.ts": "各族的 URL 拼法",
  "lib/ai/reasoning.ts": "思考参数的拼法（类目按族登记，§5 明确不并入）",
  "lib/ai/jsonMode.ts": "JSON 模式的拼法与强度（response_format / text.format / generationConfig）",
  "lib/ai/serverTools.ts": "服务端工具的拼法（有无在表里，怎么写在这里）",
  "lib/ai/endpointProbe.ts": "探测请求按族构造",
  "lib/ai/providerProbe.ts": "连通性探测按族构造",
  "lib/ai/image.ts": "图像区的方言与路由，§5 明确不动",
};

/**
 * 其余文件的上限：C2 合并时的实际计数（§3「起点 = C2 合并后的实际计数」）。
 * 每一条都是在选拼法或措辞，而不是在判有无。
 */
const CEILING: Readonly<Record<string, number>> = {
  // 结构化输出的说明文字三族不同（2）；图像模型 Gemini 方言的预填（1）。服务端工具「为什么」按族的
  // 措辞已改成查表（SEARCH_HINT_KEY 等），不再占名额。
  "components/settings/panes/ModelDrawer.tsx": 3,
  // 「将发送」按族拼字段名：thinking / max_tokens / 服务端工具的 body / 结构化输出的四种字段名。
  "lib/ai/modelSummary.ts": 6,
  // Gemini 线路的安全设置默认值与其面板（2）；ComfyUI 渠道走自己的保存分支（1）。
  "components/settings/panes/ProviderDrawer.tsx": 3,
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
 * 去掉注释、清空字符串与模板文字的内容，只留代码——按词法走一遍，而不是用正则删 `/* … *\/`：
 * 字符串里的 `/*`（`"image/*"`、`${id}/*.md`）会让正则一直吞到下一个 `*\/`，把中间的真代码一起删掉，
 * 棘轮就少数、放过违规；行尾的 `// family === "x"` 注释不删又会多数。
 * 字符串保留引号、清空内容，所以 `family === "openai"` 仍能被数到，字符串里写的同样文字不会。
 * 模板里的 `${…}` 是代码，照常扫。不认正则字面量——本仓库的正则里没有能骗过它的写法，测试钉着几种。
 */
function code(src: string): string {
  let out = "";
  let i = 0;
  // 模板嵌套：`tpl` = 在模板文字里；数字 = 在 `${` 里，记着未闭合的 `{` 数。
  const stack: ("tpl" | number)[] = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const top = stack[stack.length - 1];
    if (top === "tpl") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); out += c; i++; continue; }
      if (c === "$" && n === "{") { stack.push(0); out += "${"; i += 2; continue; }
      i++;
      continue;
    }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += c + c;
      i = j + 1;
      continue;
    }
    if (c === "`") { stack.push("tpl"); out += c; i++; continue; }
    if (typeof top === "number") {
      if (c === "{") stack[stack.length - 1] = top + 1;
      else if (c === "}") {
        if (top === 0) { stack.pop(); out += c; i++; continue; }
        stack[stack.length - 1] = top - 1;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const counts = new Map<string, number>();
for (const file of sources(SRC)) {
  const rel = relative(SRC, file).split("\\").join("/");
  const n = code(readFileSync(file, "utf8")).match(FAMILY_TEST)?.length ?? 0;
  if (n > 0) counts.set(rel, n);
}

describe("能力有无不在调用点按协议族判断", () => {
  it("只数代码：注释与字符串里的同样文字不算，字符串里的 /* 不吞代码", () => {
    const count = (src: string) => code(src).match(FAMILY_TEST)?.length ?? 0;
    expect(count('const a = `${id}/*.md`;\nif (family === "openai") x();\n/* tail */')).toBe(1);
    expect(count('const accept = "image/*";\nif (family === "gemini") x();\n// */')).toBe(1);
    expect(count('x(); // family === "openai"\n/* family === "gemini" */\n{/* family === "anthropic" */}')).toBe(0);
    expect(count('const s = \'family === "openai"\';')).toBe(0);
    expect(count('const t = `a ${family === "responses" ? 1 : 2} b`;')).toBe(1);
    expect(count('const u = "a\\"b"; if (x.family !== "gemini") y();')).toBe(1);
  });

  it("白名单与上限里的文件都还在", () => {
    for (const rel of [...Object.keys(WIRE_SHAPE), ...Object.keys(CEILING)]) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow();
    }
  });

  it("按族比字面量的次数不超过上限", () => {
    const over: string[] = [];
    for (const [rel, n] of counts) {
      if (rel in WIRE_SHAPE) continue;
      const max = CEILING[rel] ?? 0;
      if (n > max) over.push(`${rel}: ${n} 处，上限 ${max}——「有没有」去问 capabilities.ts；确实是选拼法，才把上限加一并写明哪一处`);
    }
    expect(over).toEqual([]);
  });

  it("上限跟着降：数少了就把上限改成新的数", () => {
    const slack: string[] = [];
    for (const [rel, max] of Object.entries(CEILING)) {
      const n = counts.get(rel) ?? 0;
      if (n < max) slack.push(`${rel}: 现在 ${n} 处，把 CEILING 改成 ${n}`);
    }
    expect(slack).toEqual([]);
  });
});
