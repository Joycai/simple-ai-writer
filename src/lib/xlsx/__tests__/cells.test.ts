/**
 * 单元格类型判定。
 *
 * 这一层错了不会报错——它会写出一份看起来完全正常、求和却是 0 的表，或者一列
 * 末尾变成 000 的单号。所以「不该判成数字的」占的篇幅比「该判成数字的」多。
 */

import { describe, expect, it } from "vitest";
import { classifyCell, unescapeCell } from "../cells";

describe("classifyCell", () => {
  it("reads a plain number as a number", () => {
    expect(classifyCell("12000")).toEqual({ t: "n", v: 12000 });
    expect(classifyCell("-3.5")).toEqual({ t: "n", v: -3.5, fmt: "0.0" });
    expect(classifyCell("0")).toEqual({ t: "n", v: 0 });
  });

  it("keeps the thousands separators and the currency symbol as a format", () => {
    expect(classifyCell("1,200")).toEqual({ t: "n", v: 1200, fmt: "#,##0" });
    expect(classifyCell("¥12,000.00")).toEqual({ t: "n", v: 12000, fmt: "¥#,##0.00" });
  });

  it("stores a percentage as a fraction, which is what Excel means by one", () => {
    // 存 12 而不是 0.12 的话，这一列求和会错一个数量级，而单元格显示出来还是
    // 「12%」——错得完全看不见。
    expect(classifyCell("12%")).toEqual({ t: "n", v: 0.12, fmt: "0%" });
    expect(classifyCell("12.5%")).toEqual({ t: "n", v: 0.125, fmt: "0.0%" });
  });

  it("reads a real date and refuses an impossible one", () => {
    expect(classifyCell("2026-08-06")).toEqual({ t: "d", v: "2026-08-06", fmt: "yyyy-mm-dd" });
    expect(classifyCell("2026/8/6")).toEqual({ t: "d", v: "2026-08-06", fmt: "yyyy-mm-dd" });
    expect(classifyCell("2026-08-06 13:45")).toEqual({
      t: "d",
      v: "2026-08-06T13:45:00",
      fmt: "yyyy-mm-dd hh:mm",
    });
    // 二月三十号不是日期，是一段文字。
    expect(classifyCell("2026-02-30")).toEqual({ t: "s", v: "2026-02-30" });
  });

  it("does not turn a range into a date the way Excel would", () => {
    // Excel 自己会把 `1-2` 读成一月二日（著名的基因名事件就是这么来的）。这里
    // 只认写全了的年月日。
    expect(classifyCell("1-2")).toEqual({ t: "s", v: "1-2" });
    expect(classifyCell("3/4")).toEqual({ t: "s", v: "3/4" });
  });

  it("leaves a leading zero alone", () => {
    // 区号、工号、快递单号：少一个字符就对不上了，而作者是照原样核对的。
    expect(classifyCell("007")).toEqual({ t: "s", v: "007" });
    expect(classifyCell("0512")).toEqual({ t: "s", v: "0512" });
    // 小数点前面那个 0 不算前导零。
    expect(classifyCell("0.5")).toEqual({ t: "n", v: 0.5, fmt: "0.0" });
  });

  it("leaves a number too long for a float alone", () => {
    // 18 位身份证转成 f64 之后末三位是 000，而文件打开时看起来一切正常——
    // 电子表格最经典的那个坑。
    expect(classifyCell("110101199003078888")).toEqual({
      t: "s",
      v: "110101199003078888",
    });
    expect(classifyCell("123456789012345")).toEqual({ t: "n", v: 123456789012345 });
  });

  it("treats a number carrying a unit as text", () => {
    expect(classifyCell("12000元")).toEqual({ t: "s", v: "12000元" });
    expect(classifyCell("约 12,000")).toEqual({ t: "s", v: "约 12,000" });
  });

  it("reads a leading = as a formula, the way typing it into Excel would", () => {
    expect(classifyCell("=SUM(B2:B9)")).toEqual({ t: "f", v: "=SUM(B2:B9)" });
    // 单个等号是一个字符，不是公式。
    expect(classifyCell("=")).toEqual({ t: "s", v: "=" });
  });

  it("reads booleans, which is what the importer writes them as", () => {
    expect(classifyCell("true")).toEqual({ t: "b", v: true });
    expect(classifyCell("FALSE")).toEqual({ t: "b", v: false });
  });

  it("keeps an empty cell empty", () => {
    expect(classifyCell("   ")).toEqual({ t: "s", v: "" });
  });
});

describe("unescapeCell", () => {
  it("undoes exactly what the importer's escape_cell did", () => {
    // xlsx.rs 把 `|` 写成 `\|`、换行写成 `<br>`。一份工作簿导进来再导出去，
    // 不能多出反斜杠，也不能留下字面的 <br>。
    expect(unescapeCell("a\\|b")).toBe("a|b");
    expect(unescapeCell("line1<br>line2")).toBe("line1\nline2");
    expect(unescapeCell("C:\\\\dir")).toBe("C:\\dir");
  });

  it("survives a cell that only looks escaped", () => {
    expect(unescapeCell("100% \\o/")).toBe("100% \\o/");
  });
});
