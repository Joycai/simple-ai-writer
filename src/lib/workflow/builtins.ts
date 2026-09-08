/**
 * 内置工作流卡 —— 开箱即用的那部分。
 *
 * 覆盖模型（docs/feature/agent/workflow-cards-plan.md §2）：内置卡随 app 发布，
 * 项目里同 id 的 `.ai-writer/workflows/<id>.md` **整张替换**它（`disabled: true`
 * 则是隐藏它），不同 id 是项目新增。整张而不是逐字段合并——半张来自文件半张
 * 来自内置的卡没法讲清楚是谁的。
 *
 * 正文不走 i18n：读者是模型，不是 UI。也不在这里写死行为保证——工作流卡是
 * best-effort 的流程指引，必须保证的事（词典强制落实、审批弹卡）都在工具内部。
 */

import { isPptxExportEnabled } from "../pptx/flag";

export interface BuiltinWorkflow {
  id: string;
  name: string;
  /** 一行。模型判断"该不该加载这张卡"的唯一依据，写给模型看。 */
  description: string;
  body: string;
  /**
   * 这张卡此刻该不该在——缺省在。只给**指着某个 Beta 工具**的卡用：那个工具不在
   * 的时候卡也不在（工具在场性契约：关掉时是缺席，不是拒绝），而不是留一张
   * 教模型调一个不存在的工具的卡。判据读的是和 `routeTools` 同一个开关。
   */
  available?: () => boolean;
}

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  {
    id: "translate-output",
    name: "翻译输出格式",
    description: "作者要翻译日文文档时，先确认输出格式（纯译文/对照）再动手",
    body: [
      "1. 先问作者要哪种输出：**纯译文**，还是**日中对照**。要对照的话再问一句：译文在前还是原文在前。",
      "",
      "2. 对照格式的样例（原文行用引用块框起，译文行紧随其后；原文在前的版本把两行对调）：",
      "",
      "   > 吾輩は猫である。名前はまだ無い。",
      "   >",
      "   吾辈是猫。名字还没有。",
      "",
      "3. 翻译一律用 translate 工具（整份文档传 path），不要自己翻。术语表/词典已经在工具",
      "   内部**强制落实**到译文上了——不要重读译文做校对，也不要再做任何词典替换。",
      "",
      "4. 作者要对照输出时：原文和工具产出的译文各读**一次**，按第 2 步的格式逐行交错拼装",
      "   成新文件。拼装是机械工作，不要改动任何一行译文；空行和链接保持原位。",
      "",
      "5. 工具结果里出现「词典没有解析出任何词对」（zero term pairs）的警告时：那说明作者的",
      "   翻译词典条目正文是解析不了的格式（表格、散文等）。读出那个条目，把正文**规整成",
      "   一行一条 `原文->译文 #备注`**，用知识库编辑工具提交（会走方案审批，作者会看到",
      "   改动）；批准后重新翻译。只改格式，**一个译名都不许改**——你在搬运作者的词表，",
      "   不是在造词表。不要另建临时文件绕过条目：词典的家就是那个条目。",
    ].join("\n"),
  },
  {
    // 生成端契约的第三层（docs/feature/pptx-plan.md §7 D20）：完整的写法契约和
    // 骨架，只在模型**开始写 deck**时进上下文。export_pptx 的描述里只有五条规则，
    // inspect_html 的预检只在写错之后点名；这张卡是写之前的那份。
    //
    // 随 PPTX 导出的 Beta 开关出现：这些规矩全是为了导出，作者没开导出时它们只
    // 是无谓的束缚（::before 的圆点在网页里好好的），而卡里指名的 export_pptx
    // 那时也不存在。
    id: "pptx-deck",
    name: "幻灯片 deck（可导出 PPTX）",
    description: "作者要演示文稿 / 幻灯片 / PPT 时，先按这张卡的骨架和写法写 .html，再导出",
    available: isPptxExportEnabled,
    body: [
      "目标是一份 .html 的 deck，导出成 .pptx 后**版式一样、文字仍可编辑**。转换不经过模型：页面在浏览器里排好，量到的每个盒子写成 PowerPoint 形状。所以写法决定保真度——转换器只认它量得到、pptx 装得下的东西。",
      "",
      "1. **骨架（照抄，一页一个 `<section class=\"slide\">`，尺寸固定 1280×720）**：",
      "",
      "   ```html",
      "   <!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>…</title>",
      "   <style>",
      "     html,body{margin:0;background:#1a1a1a}",
      "     .slide{position:relative;width:1280px;height:720px;overflow:hidden;margin:0 auto 24px;",
      "            background:#fff;font-family:\"PingFang SC\",\"Microsoft YaHei\",Arial,Helvetica,sans-serif}",
      "   </style></head><body>",
      "   <section class=\"slide\">…</section>",
      "   <section class=\"slide\">…</section>",
      "   </body></html>",
      "   ```",
      "",
      "   页内布局随意——absolute、flex、grid 都行，只有量出来的位置算数。四周留约 6% 边距；正文不超过六行、标题一行：PowerPoint 的换行引擎和浏览器不同，太满会溢出。",
      "",
      "2. **字体只用系统字体**（PingFang SC / Microsoft YaHei / Arial / Helvetica / Georgia）。不写 `@font-face`、不外链字体：字体进不了 .pptx，替换后文字回流、整版位移。",
      "",
      "3. **装饰用真元素画**：圆点、色条、徽章、编号用 `<span>` / `<div>`，**不用 `::before` / `::after`**——伪元素没有盒子可量，导出后整个消失。列表圆点用原生 `list-style`。",
      "",
      "4. **不写入场动画**，元素不从 `opacity: 0` 起步——那会被当成隐藏，整块不导。`transition` 也一样。",
      "",
      "5. **文字放在 HTML 里**。SVG 只画图形；`<svg>` 里的 `<text>` 会变成图片的一部分。",
      "",
      "6. **背景**：纯色、半透明色、单个 `linear-gradient` 都能保真；径向 / 圆锥 / 图片背景会变成一个平均色，照片用 `<img>`。玻璃感用半透明底色 + 1px 边框，不用 `backdrop-filter`。",
      "",
      "7. **阴影与变换**：`box-shadow` 可以，`text-shadow` 会丢；`filter`、`mix-blend-mode` 会丢。变换只用 `rotate()`，位移用 `left` / `top`，带 `translate` / `scale` / `skew` 的复合变换只剩外接矩形。竖排文字用横排 + `rotate(90deg)`。",
      "",
      "8. 纯装饰、不该变成形状的东西加 `data-pptx-skip`。图形用内联 SVG（会变成一张图，图示类内容这样正好）。",
      "",
      "9. **写完先调 inspect_html**：它报三件事——盒子有没有掉出页面、哪一页什么都没画、以及**源码里导不出的写法**（点名到行）。改到干净再往下走。长页面按 htmlArtifact 的办法先骨架后逐节 append。",
      "",
      "10. **导出**：调 export_pptx（作者会在卡片上批准；工具里没有它而有 run_pack 时，交给导出 pack）。结果里的降级清单原样转告作者——那是事实，不是错误。改版时用 read_slides 按页读回行区间，rewrite_lines 改某一页。",
    ].join("\n"),
  },
];
