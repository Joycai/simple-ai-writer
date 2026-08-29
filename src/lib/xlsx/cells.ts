/**
 * 一个 markdown 表格单元格 → 一个**有类型**的 Excel 单元格。
 *
 * 这是整个功能的实质。一份所有格子都是文本的 .xlsx 不是电子表格，是表格的
 * 截图：求和不出数、排序按字典序、日期筛选整个不存在——作者要 .xlsx 而不是
 * 要一张表，要的就是这些。
 *
 * 纯函数，测试全在这里。判定顺序不能换（见 `classifyCell`），而**判不出来就
 * 留成文本**是这一层唯一的兜底方向：把文本错判成数字是静默的数据损坏（`007`
 * 变 7，18 位单号丢末尾三位），把数字留成文本作者一眼就看见。
 */

export type Cell =
  | { t: "s"; v: string }
  | { t: "n"; v: number; fmt?: string }
  | { t: "d"; v: string; fmt?: string }
  | { t: "b"; v: boolean }
  | { t: "f"; v: string };

export type CellKind = "text" | "number" | "date" | "formula" | "bool";

export function cellKind(cell: Cell): CellKind {
  switch (cell.t) {
    case "n": return "number";
    case "d": return "date";
    case "f": return "formula";
    case "b": return "bool";
    default: return "text";
  }
}

/**
 * 撤销导入侧 `escape_cell`（src-tauri/src/xlsx.rs）做的转义。
 *
 * 两边必须互为逆运算：一份 .xlsx 导进来再导出去，`A|B` 不能变成 `A\|B`，多行
 * 备注不能变成字面的 `<br>`。往那边加一条转义，就要往这里加一条。
 */
export function unescapeCell(raw: string): string {
  return raw.replace(/<br\s*\/?>/gi, "\n").replace(/\\([\\|])/g, "$1");
}

/** 千分位、可选小数：`1234` / `1,234.50` / `-12`。 */
const PLAIN_NUMBER = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** 货币符号只认前缀。`12000元` 是文本——单位跟在后面时它是一句话，不是一个数。 */
const CURRENCY = /^([¥￥$＄€£])\s*/;
const PERCENT = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)%$/;
/** `2026-08-06` / `2026/8/6`，可带 ` 13:45` 或 `T13:45:00`。 */
const DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * f64 能无损表示的十进制有效位数。身份证（18 位）、长订单号、银行卡号超过它，
 * 转成数字**末尾会变成 0**——而且文件打开时看起来完全正常。
 */
const MAX_SIGNIFICANT_DIGITS = 15;

/**
 * 一个格子的最终判定。
 *
 * 顺序是设计的一部分：公式最先（`=` 开头在 Excel 里本来就不是文本），百分数
 * 在数字之前（否则 `12%` 的 `%` 会让它落进文本），日期在数字之前（`2026-08-06`
 * 不是减法），纯数字最后，剩下的全是文本。
 */
export function classifyCell(raw: string): Cell {
  const text = unescapeCell(raw).trim();
  if (!text) return { t: "s", v: "" };

  // Excel 自己的输入规则就是这一条，模型写 `=SUM(B2:B9)` 时要的也正是它。
  if (text.length > 1 && text.startsWith("=")) return { t: "f", v: text };

  if (/^true$/i.test(text)) return { t: "b", v: true };
  if (/^false$/i.test(text)) return { t: "b", v: false };

  const percent = PERCENT.exec(text);
  if (percent) {
    const digits = percent[1];
    if (isSafeNumber(digits)) {
      // 12% 存成 0.12 而不是 12：存 12 的话，同一列求和会错整整一个数量级，
      // 而单元格显示出来还是「12%」——错得看不见。
      const decimals = decimalsOf(digits);
      return {
        t: "n",
        v: toNumber(digits) / 100,
        fmt: decimals > 0 ? `0.${"0".repeat(decimals)}%` : "0%",
      };
    }
    return { t: "s", v: text };
  }

  const date = DATE.exec(text);
  if (date) {
    const iso = isoDate(date);
    if (iso) return iso;
    return { t: "s", v: text };
  }

  const currency = CURRENCY.exec(text);
  const body = currency ? text.slice(currency[0].length) : text;
  if (PLAIN_NUMBER.test(body) && isSafeNumber(body)) {
    return { t: "n", v: toNumber(body), fmt: numberFormat(body, currency?.[1]) };
  }

  return { t: "s", v: text };
}

/**
 * 「这串数字可以安全地当数字」吗。
 *
 * 两条，都是真实的数据损坏而不是洁癖：
 *  - **前导零有意义**。`007`、`0512`（区号）、`00123`（工号）转成数字就少了几
 *    个字符，而作者是照着原样核对的。
 *  - **超过 15 位有效数字会被 f64 截断**。18 位身份证进 Excel 变成
 *    `1.10101E+17`，展开后末三位是 000——这是电子表格最经典的那个坑。
 */
function isSafeNumber(body: string): boolean {
  const digits = body.replace(/[^0-9]/g, "");
  if (digits.length > MAX_SIGNIFICANT_DIGITS) return false;
  const intPart = body.replace(/^[+-]/, "").split(".")[0].replace(/,/g, "");
  if (intPart.length > 1 && intPart.startsWith("0")) return false;
  return true;
}

function toNumber(body: string): number {
  return Number(body.replace(/,/g, ""));
}

function decimalsOf(body: string): number {
  const dot = body.indexOf(".");
  return dot < 0 ? 0 : body.length - dot - 1;
}

/**
 * 数字格式串，只在源文本自己表达了格式时才给：写了千分位就保留千分位，写了
 * 两位小数就固定两位，货币符号原样留在前面。没写就不给——Excel 的常规格式比
 * 我们猜得准。
 */
function numberFormat(body: string, currency?: string): string | undefined {
  const grouped = body.includes(",");
  const decimals = decimalsOf(body);
  if (!grouped && !decimals && !currency) return undefined;
  const int = grouped ? "#,##0" : "0";
  const tail = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
  return `${currency ?? ""}${int}${tail}`;
}

/** 真实存在的日期才算日期——`2026-02-30` 是文本，不是二月三十号。 */
function isoDate(m: RegExpExecArray): Cell | null {
  const [, y, mo, d, hh, mi, ss] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;

  const date = `${y}-${pad(month)}-${pad(day)}`;
  if (hh === undefined) return { t: "d", v: date, fmt: "yyyy-mm-dd" };

  const hour = Number(hh);
  const minute = Number(mi);
  const second = ss === undefined ? 0 : Number(ss);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    t: "d",
    v: `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
    fmt: "yyyy-mm-dd hh:mm",
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
