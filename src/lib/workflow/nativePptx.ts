/** On-demand authoring contract; intentionally absent from the resident tool schema. */
export const NATIVE_PPTX_WORKFLOW = `Create a project *.slides.json file with create_file, then call export_pptx(source_path).
The code owns layout; do not generate coordinates, CSS, JS or Python. Text and tables stay editable.
Read or revise the JSON with read_file / propose_edit / rewrite_lines. Do not use inspect_html for this format.
If export_pptx is absent but run_pack is available, pass the source path to the export pack.

Contract (closed schema: extra fields are errors):
- Root: version: 1, language: "zh-CN" or "en-US", theme: "paper" or "midnight", assets: [], slides: []. All required.
- Assets: {id, path}; path is relative to PROJECT ROOT, not the source directory. Only local PNG/JPEG; no URLs, traversal, or hidden app data. Verify the image exists before referencing it. Omit unused assets.
- All slides: unique id, layout, nonempty title; optional notes (speaker notes). IDs start with an ASCII letter, then letters/digits/_/-, max 64 chars.
- title: optional subtitle.
- bullets: bullets string array; use at most six short items.
- comparison: left/right each {heading, bullets}; at most four bullets per column.
- image-text: body, image {assetId, alt, fit: "contain" | "cover", anchor: {x, y}}; x/y in [0,1], 0.5 centers the crop.
- metrics: metrics array of {label, value, detail?}, 1–6 entries; strings, including numeric values. For 4–6 metrics keep detail to one short line.
- table: columns string array, rows string[][]; 1–6 columns, 1–7 body rows. Row widths must match. Blank cells allowed. Keep identifiers like "007" as strings.

Limits: source 2 MiB, up to 100 slides/assets; each image <=10 MiB, all images <=50 MiB, each <=40 million pixels.
These safety limits DO NOT mean text fits. Preflight reports stable error codes, slide ids and JSON pointers.
On text_overflow, shorten that field or split the content into another slide; never drop data or shrink fonts.
Text preserves explicit newlines. No arbitrary formatting fields, animations, template import or charts.
Fonts: Latin Arial then Aptos; CJK Microsoft YaHei then Noto Sans CJK SC then Arial Unicode MS.
Missing fonts block export. Fonts are not embedded; local preflight is not Office rendering verification.

Approval: export prepares exact PPTX bytes before showing a card; rejection writes no export.
Changed source/images/destination or a restarted app require a new preflight and review. An overwrite is backed up.
Pass the result's font requirements and layout risks to the author.

Six-layout example: replace assets/logo.png with a real project image, or remove BOTH that asset and the image-text slide.
\`\`\`json
{
  "version": 1,
  "language": "zh-CN",
  "theme": "paper",
  "assets": [{ "id": "logo", "path": "assets/logo.png" }],
  "slides": [
    { "id": "intro", "layout": "title", "title": "原生演示 / Native slides", "subtitle": "内容与排版分离", "notes": "示例内容；图片路径相对于项目根目录。" },
    { "id": "outline", "layout": "bullets", "title": "目标 / Goals", "bullets": ["可编辑文字", "明确的字体要求", "可定位的校验错误"] },
    { "id": "compare", "layout": "comparison", "title": "两种路线", "left": { "heading": "HTML", "bullets": ["浏览器布局", "转换 CSS"] }, "right": { "heading": "Native", "bullets": ["语义内容", "确定性排版"] } },
    { "id": "picture", "layout": "image-text", "title": "图片与说明", "body": "保留原始比例，显式选择裁剪位置。", "image": { "assetId": "logo", "alt": "应用标志", "fit": "cover", "anchor": { "x": 0.5, "y": 0.5 } } },
    { "id": "numbers", "layout": "metrics", "title": "范围 / Scope", "metrics": [{ "label": "布局", "value": "6", "detail": "首版目标" }, { "label": "画幅", "value": "16:9" }] },
    { "id": "schedule", "layout": "table", "title": "实施阶段", "columns": ["阶段", "结果"], "rows": [["P1", "数据契约"], ["P2", "最小原生导出"], ["P3", "六种布局"]] }
  ]
}
\`\`\`
`;
