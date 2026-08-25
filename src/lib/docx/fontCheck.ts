/**
 * 「这台机器上装了这个字体吗」。
 *
 * 为什么要问：作者在 mac 上大概率没有仿宋_GB2312。**导出的文件仍然是对的**
 * ——里面写的就是那个名字，拿到装了它的机器上打印一样合规——但作者本机预览
 * 时看到的是替换字体。所以这是一句提示，不是一个错误：设计稿里它是一枚中性
 * 描边的小标签，**不用红色**。
 *
 * 手段是量宽度，不是 `document.fonts.check`。后者看起来正是为这件事准备的，
 * 实际上不是：家族缺失时浏览器用后备字体照样能把字排出来，于是它对一个根本
 * 没装的字体也回答 true。可靠的做法是老办法——把同一串字用「候选字体, 后备」
 * 和「后备」各排一次，宽度不同就说明候选真的参与了排版。
 *
 * 三个后备各问一次：只用一个的话，万一候选字体的字形宽度恰好和它一致就会误
 * 判。三个都判「一样宽」才认定没装。
 */

/** 探测串故意混中西文：只用 ASCII 的话任何西文字体都能排，区分不出中文字体。 */
const PROBE = "汉字abcMW漢書0123";
/** 大字号放大差异——12px 下两个字体常常只差不到一个像素。 */
const PROBE_FONT_PX = 72;
const FALLBACKS = ["monospace", "serif", "sans-serif"] as const;

let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, boolean>();

function measure(spec: string): number {
  if (ctx === undefined) {
    ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!ctx) return NaN;
  ctx.font = `${PROBE_FONT_PX}px ${spec}`;
  return ctx.measureText(PROBE).width;
}

export function isFontInstalled(family: string): boolean {
  const name = family.trim();
  if (!name) return true;
  const hit = cache.get(name);
  if (hit !== undefined) return hit;

  const quoted = `"${name.replace(/["\\]/g, "")}"`;
  let installed = false;
  for (const fallback of FALLBACKS) {
    const base = measure(fallback);
    // 没有 canvas（测试环境、老 webview）就别猜——回答「装了」，宁可不提示也
    // 不要在一台其实装了字体的机器上到处挂警告。
    if (Number.isNaN(base)) return true;
    if (Math.abs(measure(`${quoted}, ${fallback}`) - base) > 0.5) {
      installed = true;
      break;
    }
  }
  cache.set(name, installed);
  return installed;
}

/** 这几个字体里本机没装的那些。 */
export function missingFonts(families: readonly string[]): string[] {
  return [...new Set(families)].filter((f) => !isFontInstalled(f));
}
