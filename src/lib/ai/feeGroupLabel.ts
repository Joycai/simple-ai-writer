/**
 * 计费组在界面上的说法——**价格只有一种写法**。
 *
 * 组列表的价格标签、抽屉脚的摘要、模型抽屉「计费」那一节折起来的那行、
 * 模型抽屉下拉里的每一项，全部出自这里的两个函数。界面上同一份价有两种
 * 写法，作者就会以为它们是两回事，然后去改其中一处。
 *
 * 纯的：不碰 store、不碰库、不碰 i18n 实例——措辞由调用方把 `t` 传进来
 * （`FeeLabelWords`），所以这个模块在 node 环境的测试里直接可用。
 */

import {
  chargesInputImages, feeConfigOf, otherSpecsAtZero, specificity,
  type FeeGroup, type OutputUnit,
} from "./feeGroup";

/**
 * 价格的写法。剪掉尾零，但至少留 `min` 位。
 *
 * 上限是 6 位小数而不是 4：千问转写是 ¥0.00022 / 秒，按 4 位剪会把它印成
 * `0.0002`——界面上少一个数量级的价，作者看不出来。
 */
export function formatPrice(n: number, min = 2): string {
  if (!Number.isFinite(n)) return "0";
  const trimmed = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const decimals = (trimmed.split(".")[1] ?? "").length;
  return decimals < min ? n.toFixed(min) : trimmed;
}

/** 档位表里真正有价的那些档。没填价的行整行按 0 计，不算一档。 */
export function ratePrices(g: FeeGroup): number[] {
  return g.outputRates.map((r) => r.price).filter((p) => Number.isFinite(p) && p > 0);
}

/** `$0.04` 或 `$0.04–0.10`；一档都没有时为空。 */
export function rateSpan(g: FeeGroup): string {
  const ps = ratePrices(g);
  if (!ps.length) return "";
  const lo = Math.min(...ps), hi = Math.max(...ps);
  return lo === hi ? `$${formatPrice(lo)}` : `$${formatPrice(lo)}–${formatPrice(hi)}`;
}

/** 组真的会收钱吗。全 0 的组（本机 Ollama）读作「不收」，行首方块画成虚线。 */
export function isPriced(g: FeeGroup): boolean {
  if (g.billingMode === "token") return g.inputPrice > 0 || g.outputPrice > 0;
  if (g.billingMode === "request") return g.requestPrice > 0;
  return ratePrices(g).length > 0;
}

/** 调用方把措辞递进来；这个模块不认识 i18n 实例。 */
export interface FeeLabelWords {
  token: string;
  request: string;
  perUnit: Record<OutputUnit, string>;
  /** `/M`、`/次`、`张`。 */
  perMillion: string;
  perRequest: string;
  input: string;
  cached: string;
  output: string;
  tiers: (n: number) => string;
  noRates: string;
  otherSpecsZero: string;
  inputImage: (price: string) => string;
  inputFree: (n: number) => string;
  unbound: string;
}

/** 组的一行摘要：列表、下拉、抽屉脚、模型抽屉的折行共用。 */
export function feeSummary(g: FeeGroup | null, w: FeeLabelWords): string {
  if (!g) return w.unbound;
  if (g.billingMode === "token") {
    // 缓存价留空 ＝ 同输入价。摘要里写出继承来的那个数，而不是留白：
    // 「没写」和「不收」在这一格上长得一样，钱却差着一整笔。
    const cache = g.cacheInputPrice ?? g.inputPrice;
    return `${w.token} · ${formatPrice(g.inputPrice)} / ${formatPrice(cache)} / ${formatPrice(g.outputPrice)}`;
  }
  if (g.billingMode === "request") return `${w.request} · $${formatPrice(g.requestPrice)}${w.perRequest}`;
  const span = rateSpan(g) || w.noRates;
  return `${w.perUnit[g.outputUnit]} · ${w.tiers(ratePrices(g).length)} · ${span}`;
}

export interface FeeTag {
  text: string;
  /** 推出来的、不是作者填的（继承的缓存价、「其他规格按 0 计」）。 */
  derived?: boolean;
}

/**
 * 列表第三列的价格标签。**每种模式同一种写法**，所以一眼扫得出哪一行是
 * 哪种计价，而不必先读模式再读数。
 */
export function feeTags(g: FeeGroup, w: FeeLabelWords): FeeTag[] {
  const out: FeeTag[] = [];
  if (g.billingMode === "token") {
    out.push({ text: `${w.input} $${formatPrice(g.inputPrice)}${w.perMillion}` });
    const inherited = g.cacheInputPrice === null;
    out.push({
      text: `${w.cached} $${formatPrice(g.cacheInputPrice ?? g.inputPrice)}${w.perMillion}`,
      derived: inherited,
    });
    out.push({ text: `${w.output} $${formatPrice(g.outputPrice)}${w.perMillion}` });
  } else if (g.billingMode === "request") {
    out.push({ text: `${w.request} $${formatPrice(g.requestPrice)}${w.perRequest}` });
  } else {
    out.push({ text: `${w.perUnit[g.outputUnit]} · ${w.tiers(ratePrices(g).length)}` });
    const span = rateSpan(g);
    if (span) out.push({ text: span });
    // 没有全空条件的行 ⇒ 没命中的规格按 0 计。这件事得写出来：它不是错误，
    // 但它是一笔不会被记下的钱。
    if (!g.outputRates.some((r) => specificity(r) === 0)) {
      out.push({ text: w.otherSpecsZero, derived: true });
    }
  }
  // 不收的费不出现：按 token 的组根本没有输入图这一说（它的图在 token 里）。
  if (chargesInputImages(feeConfigOf(g))) {
    const tail = g.inputFreeUnits > 0 ? ` · ${w.inputFree(g.inputFreeUnits)}` : "";
    out.push({ text: w.inputImage(formatPrice(g.inputUnitPrice)) + tail });
  }
  return out;
}

/** 按规格的组没写兜底行时界面要补一句。导出给抽屉的提示语复用。 */
export function hasCatchAllRate(g: FeeGroup): boolean {
  return !otherSpecsAtZero(feeConfigOf(g));
}
