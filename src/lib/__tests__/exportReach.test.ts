/**
 * 一个 `export` 必须有第二个文件用它。
 *
 * 三轮清理（#594 删零引用的导出与一个没人 import 的桶文件、#595 收 125 个值、
 * #596 收 291 个类型）之后 `src/` 归零，但没有任何闸门拦着它重新长回来——
 * 这条就是那道闸门。
 *
 * **为什么值得守。** `export` 是一句关于作用域的声明：它告诉下一个读代码的人
 * 「别处要用它」，于是改它的时候要按对外接口的谨慎程度对待。当这句话不成立，
 * 代价是双份的：读者高估了改动半径，而 `noUnusedLocals` 因为名字被导出了就
 * 不再管它——最后一处用法删掉的那天，编译器一声不吭。三轮里那 437 个名字
 * 没有一个是被报出来的，全是专门去扫才找到的。
 *
 * **判据。** 一个导出的声明，如果它的名字在**别的任何文件**里一次都没出现过，
 * 就是违规。判据是「名字出现过」而不是「真的被引用」——故意放宽：同名的局部
 * 变量会让一个本该报的名字蒙混过去，但绝不会冤枉一个真在用的名字。这条测试
 * 的用途是防回潮，不是做静态分析，宁可漏报。
 *
 * **扫描面与故意不扫的东西。**
 *   - 扫 `src/` 下的 `.ts` / `.tsx`，跳过 `.d.ts`（环境声明本来就没有引用方）。
 *   - **测试文件算引用方**：只给测试用的接缝是正当的导出，不该被这条拦下。
 *   - `export default` 不查：它没有名字可查，且默认导出天然是对外的。
 *   - `export { a } from "./x"` 这类**转出**不算一条声明（`a` 的声明在别处），
 *     但算 `a` 的一次引用。于是「桶文件本身没人 import」这种情况这条测试
 *     **看不出来**——#594 里 `lib/cli/index.ts` 就是那样，靠人翻出来的。
 *     已知的洞，写在这里免得下次有人以为它管了。
 *   - **本文件不进语料**。否则下面 `ALLOW` 里写的名字会因为在这里出现过一次，
 *     就被自己判成「有别的文件用」——那样豁免名单会变成一张悄悄生效的白名单，
 *     而不是一份要说明理由的清单。
 *
 * **被它拦下来时，三条出路**（按优先级）：
 *   1. 这个名字没人用了 —— 删掉它；
 *   2. 只有自己文件在用 —— 去掉 `export`，让 `noUnusedLocals` 接手；
 *   3. 确实要它留着导出 —— 往 `ALLOW` 里加一条，**并写清楚理由**。
 *      要写理由是故意的：把「先导出、消费方下个 PR 才接上」这种正当情况，
 *      和「忘了删」区分开，靠的是有人肯写那句话。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/** 本文件的名字——它自己不进语料，理由见文首。 */
const SELF = "exportReach.test.ts";

interface Allowed {
  /** 文件名（basename 即可）。 */
  file: string;
  /** 导出的名字。 */
  name: string;
  /** 为什么它该留着导出。没有理由就不是豁免，是忘了删。 */
  why: string;
}

/**
 * 空的。三轮清理之后 `src/` 里一条都不需要——这正是它现在该有的样子。
 * 第一条进来的时候，请连同 `why` 一起写清楚。
 */
const ALLOW: Allowed[] = [];

const ROOT = "src";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 一条具名的导出声明。`export default` 与 `export { … }` 转出都不算。 */
const DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;

/** 文件里出现过的标识符。够粗，但只会让判据更宽松（见文首）。 */
const IDENT = /[A-Za-z_$][\w$]*/g;

describe("导出必须有第二个文件用", () => {
  it("src/ 里没有只有自己在用的 export", () => {
    const files = walk(ROOT);
    const text = new Map<string, string>();
    for (const f of files) text.set(f, readFileSync(f, "utf8"));

    // 标识符 → 出现过它的文件集合。本文件不计入。
    const seenIn = new Map<string, Set<string>>();
    for (const [f, t] of text) {
      if (f.endsWith(SELF)) continue;
      for (const m of t.matchAll(IDENT)) {
        let set = seenIn.get(m[0]);
        if (!set) seenIn.set(m[0], (set = new Set()));
        set.add(f);
      }
    }

    const allowed = new Set(ALLOW.map((a) => `${a.file}::${a.name}`));
    const offenders: string[] = [];
    for (const [f, t] of text) {
      if (f.includes("__tests__") || f.endsWith(SELF)) continue;
      DECL.lastIndex = 0;
      for (const m of t.matchAll(DECL)) {
        const name = m[1];
        const base = f.slice(f.lastIndexOf("/") + 1);
        if (allowed.has(`${base}::${name}`)) continue;
        const where = seenIn.get(name);
        const elsewhere = where && [...where].some((g) => g !== f);
        if (!elsewhere) offenders.push(`${f} :: ${name}`);
      }
    }

    // 失败时的三条出路写在文首：删掉 / 去掉 export / 进 ALLOW 并写理由。
    expect(offenders).toEqual([]);
  });
});
