# 火山方舟按量线路：Files API / `file_id` 未支持，整条线路未实测

> **状态：open。** 2026-09-23 对照厂商四页文档（流式输出 · 深度思考 · 结构化输出(beta) · 文档理解）调研时记下。
> 行为今天不出错——PDF 走 base64 内联，在 50MB 以内都能用；缺的是大文件与跨轮复用的那条路，以及按量 key 的实测。
> 实测与上下文见 [`../api/landscape.md`](../api/landscape.md) §7 第十二个样本（含 2026-09-23 补测）。

## 现象

1. **只有 base64 内联一种 PDF 输入。** 本项目的 `file` 片段只有 `{file_data, filename}`（`src/lib/ai/types.ts`），
   ① 发 `{type:"file", file:{…}}`、② 发 `input_file`。厂商文档另有两条路：
   - **Files API**（推荐）：`POST /api/v3/files`（multipart，`purpose=user_data`），≤512MB，默认存 7 天（1–30），
     状态变 `active` 后 ①② 都用 `file_id` 引用；
   - **`file_url`**：仅 ②，公网 URL，≤50MB。

   base64 的上限是文件 <50MB、请求体 ≤64MB；同一文档每轮都重新上传一次。
2. **套餐 key 用不了它**：`GET /api/plan/v3/files` 404。所以这条路只对按量 key（平台 `volcengine`，`/api/v3`）有意义。
3. **按量线路本身从未实测。** 手头只有套餐 key；`volcengine` 画像的请求形状是照文档与套餐实测「假设」出来的
   （`platforms.ts` 的 `source` 写明 *pay-as-you-go wire unmeasured*），能力表对它一个格也没写。
   这次改动（① 回传 `encrypted_content`、json_schema 自动挡）也只在套餐线路测过：前者是协议级改动，两条线路一样生效；
   后者只点了套餐画像，按量仍是 `unknown`。

## 为什么不现在做

- 写作场景的 PDF 多数远小于 50MB，导入流程（`src/lib/import/`）已会把 PDF 转成 markdown 再用；
  直接喂 PDF 的只有 PDF 子代理（`src/lib/agent/subagent.ts`）。收益只在超大文件或同一文档多轮复用时出现。
- 代价是一个独立功能：multipart 上传（Rust 侧或 http 插件）、轮询 `active`、过期与清理、`ContentPart` 新形状、
  按平台的能力门禁，外加没 key 就无法验证。

## 做法（拿到按量 key 之后）

1. 先跑一遍 `live.volcengine.test.ts` 的按量版（同一组用例指向 `/api/v3`），把 `volcengine` 画像的格子按实测补齐——
   尤其 `jsonSchema`、Responses 的 `web_search`（按量 key 上可能落到另开通、按次计费的「联网内容插件」）。
2. 若仍要 Files API：`file` 片段加 `file_id` 变体，只在 `volcengine` 画像点名的能力下产出；上传与状态轮询放在 PDF
   子代理读入文件的那一步，失败回落 base64。
