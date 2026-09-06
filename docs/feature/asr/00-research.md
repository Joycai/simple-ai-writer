# 音频转写（语音转文字）——千问 / DashScope 录音文件识别

> 状态：`research` · 2026-09-06 · 四条 wire 路径已用作者的测试 key 实机走通（§2）。执行方案在 [`01-execution-plan.md`](01-execution-plan.md)，UI 任务书在 [`02-ui-brief.md`](02-ui-brief.md)；§7 的五个问题在 01 §0 里按建议默认落定，作者改哪条就改哪条。
> 需求：项目里的音频（以及视频容器）文件能转成文字稿——**文件树右键**一步到位，或者**由助手在对话里调用**；整体藏在一个 Beta 开关后面。
> 文档来源：[上传文件获取临时 URL](https://platform.qianwenai.com/docs/api-reference/more/upload-file-get-temporary-url) · [Qwen-ASR 同步](https://platform.qianwenai.com/docs/api-reference/speech-recognition/qwen-asr/dashscope) · [Qwen-ASR 异步](https://platform.qianwenai.com/docs/api-reference/speech-recognition/qwen-asr/dashscope-async) · [查询结果](https://platform.qianwenai.com/docs/api-reference/speech-recognition/qwen-asr/query-result) · [Fun-ASR / Qwen-Audio-3.0 录音文件识别 REST](https://platform.qianwenai.com/docs/api-reference/speech-recognition/fun-asr-recording/restful-api) · [语音识别模型选型](https://platform.qianwenai.com/docs/developer-guides/speech/speech-to-text-models)。平台文档在 URL 后加 `.md` 可直接 curl。

---

## 0. 一句话结论

**能做，而且大部分地基已经有了。** 千问平台的录音文件识别是「提交任务 → 轮询 → 下载结果 JSON」的异步协议，和 `lib/ai/image.ts` 里 qwen-image / 万相的 `dashscopeAsyncImage` 是同一套（同一个 `/api/v1/tasks/{id}` 查询接口、同一个 `X-DashScope-Async: enable` 头）。唯一全新的部件是**把本地文件送上去**：平台提供免费的 48 小时临时存储（getPolicy → OSS 表单上传 → `oss://` URL + `X-DashScope-OssResourceResolve: enable`），实测 2.4MB 的 WAV 上传 0.5s、一分钟音频从提交到拿到结果 3 秒。落点照抄翻译 Beta 的形状：一个只会转写、**绝不进对话候选**的专用模型行，绑在一个不可委托的子代理档位上，右键菜单和 L2 工具各走一个入口。

---

## 1. 协议事实（文档 + 实测核对过的）

### 1.1 三个模型，两代

| 模型 id | 接口 | 时长 / 大小 | 说话人分离 | 热词 / 上下文 | 情绪 / 语种标注 | 价格 |
|---|---|---|---|---|---|---|
| `qwen-audio-3.0-asr-flash-filetrans` | 异步 `/services/audio/asr/transcription` | 12 小时 / 2GB | ✓ `diarization_enabled` + `speaker_count` | ✓ `vocabulary`（即时热词，权重 1–5）· `vocabulary_id` · `context[]`（≤400 字） | ✗ | ¥0.00022 / 秒（≈ ¥0.79 / 小时） |
| `qwen3-asr-flash-filetrans` | 同上 | 12 小时 / 2GB | ✗ | `text`（≤10k token，实测无效，见 §2.5） | ✓ 每句 `language` + `emotion` | 未在模型页核对 |
| `qwen3-asr-flash` | 同步 `/services/aigc/multimodal-generation/generation`（也有 OpenAI 兼容形态） | **5 分钟 / 10MB** | ✗ | `system` 消息文本 | ✓ | 按 token（25 token / 秒） |

**同一个异步端点，两代模型的请求和响应形状不同**——这是实现里最容易踩的坑，两种都实测过：

| | `qwen3-asr-flash-filetrans` | `qwen-audio-3.0-asr-flash-filetrans` |
|---|---|---|
| 请求 `input` | `{ file_url: "…" }`——**只读单数**：只发 `file_urls` 数组时提交 200，任务 `FAILED · InvalidParameter.MalformedURL: A valid file URL is required`（真机 2026-09-06，PR #514 只发了数组） | `{ file_urls: ["…"] }`（单次仍只能 1 个；`file_url` 单数也被接受）。**两个字段一起发两代都成功**，各自忽略不读的那个——`client.ts` 就这么发 |
| 请求 `parameters` | `language` · `enable_itn` · `enable_words` · `text` · `channel_id` | `language_hints[]`（≤4） · `diarization_enabled` · `speaker_count` · `vocabulary` · `vocabulary_id` · `context[]` · `special_word_filter` · `channel_id` |
| 轮询成功时结果 URL 在 | `output.result.transcription_url` | `output.output.transcription_url`（同时 `output.output.results[0].transcription_url`，带 `subtask_status`） |
| `usage` | `{ seconds }` | `{ duration }` |
| 结果 JSON 头 | `audio_info: { format, sample_rate }` | `properties: { audio_format, channels, original_sampling_rate, original_duration_in_milliseconds }` |
| 句对象 | `sentence_id` 从 0 起 · `begin_time/end_time`（ms）· `language` · `emotion` · `words[]`（仅 `enable_words`） | `sentence_id` 从 1 起 · `begin_time/end_time` · `speaker_id`（仅分离开启）· `words[]`（恒有，带 `confidence`） |
| 词对象 | 单字：`{ begin_time, end_time, text, punctuation }` | 词：`{ …, confidence }` |

结果 JSON 的下载链接 **24 小时有效**，过期后连任务都查不到——所以拿到就要落盘（§4.4）。

### 1.2 临时上传（本地文件唯一的入口）

平台的 filetrans 接口**只收公网 URL**，不收 base64、不收本地路径（Fun-ASR REST 文档 §限制条件 明说）。于是：

1. `GET /api/v1/uploads?action=getPolicy&model=<模型 id>` → `{ upload_host, upload_dir, policy, signature, oss_access_key_id, x_oss_object_acl, x_oss_forbid_overwrite, expire_in_seconds: 300, max_file_size_mb: 1024 }`。**凭证和模型名绑定**：拿哪个模型的凭证，就只能用哪个模型识别；限流 100 QPS（按账号 + 模型）。
2. `POST {upload_host}`，`multipart/form-data`，字段顺序 `OSSAccessKeyId / Signature / policy / x-oss-object-acl / x-oss-forbid-overwrite / key / success_action_status=200 / file`（`file` 必须最后）。`key = upload_dir + "/" + 文件名`。成功 HTTP 200 空 body。
3. 提交任务时 `file_url(s)` 填 `oss://<key>`，**并加头 `X-DashScope-OssResourceResolve: enable`**。漏这个头**提交照样 200**，任务在轮询里以 `FILE_DOWNLOAD_FAILED`（qwen3）或跑 45 秒后 `SERVER_ERROR`（qwen-audio-3.0）收场——错误只在轮询阶段出现，提交阶段无感。
4. 文件 48 小时后自动清理；上传后不可查、不可删。凭证里 `max_file_size_mb` 是 1024，模型页说 2GB——以**凭证返回的数字**为准。
5. **凭证对任何模型名都发**（`qwen3.8-flash`、`deepseek-v4-flash` 都拿得到并传得上），绑定关系不在这一步校验。真正的校验在提交：`model` 不是 `*-filetrans`——对话模型、甚至同步版的 `qwen3-asr-flash` / `qwen-audio-3.0-asr-flash`——一律 400 `InvalidParameter: url error, please check url！`，平台错误码文档把它列为「模型名称与 API 端点不匹配」（2026-09-06 真机第一次跑就撞上：作者绑的是 `qwen3-asr-flash-2026-02-10`）。这句话会把人引去检查一个没错的文件路径，所以 `client.ts` 把它改口成「模型 id 不是 filetrans」，`conn.ts` / 子代理面板 / 模型抽屉三处在上传之前就按 id 提示。

平台文档反复说临时存储「请勿用于生产环境」——指的是 100 QPS 限流和 48 小时有效期。对一个单作者桌面应用，一次转写一个上传，这两条都碰不到；但要**写进设置页的说明**，而且以后若做「一键转写整个目录」要串行。

### 1.3 同步接口值不值得做

`qwen3-asr-flash` 同步接口接受 `data:audio/wav;base64,…`，2.4MB 的 WAV 一次请求 2 秒回文本，不用上传。但它 5 分钟 / 10MB 的上限意味着**要维护两条路径**，而异步 + 上传那条实测同样只要 3 秒。**建议只做异步一条**（§7 问题 1）。

---

## 2. 实机实测记录（2026-09-06，作者提供的测试 key）

样例：文档自带的 `welcome.mp3`（1.7s，27KB）+ Windows TTS 合成的 48 秒中文小说段落 `long.wav`（2.4MB，16-bit PCM）。探测脚本在本目录：`asr_probe.py`（四条路径）、`asr_long.py`（真实长度 + 分离 + 上下文），key 从 `DASHSCOPE_API_KEY` 环境变量读；两份真实结果 JSON（`file_url` 已抹去）作为解析测试的夹具放在 `src/lib/asr/__tests__/fixtures/`。

| # | 路径 | 结果 |
|---|---|---|
| 2.1 | 同步 `qwen3-asr-flash`，公网 URL / base64 data URL | 均 200，0.3–0.4s；48 秒音频 base64（3.2MB 请求体）2.0s，`audio_tokens: 1381` |
| 2.2 | 异步 `qwen3-asr-flash-filetrans`，公网 URL | 提交 0.18s，PENDING → RUNNING → SUCCEEDED 共 2 次轮询（~2.3s） |
| 2.3 | 异步 `qwen-audio-3.0-asr-flash-filetrans`，`file_urls` 与 `file_url` 两种拼法 | 都 200 且成功；响应形状见 §1.1 |
| 2.4 | getPolicy → OSS 表单上传 → `oss://` + resolve 头 → 异步，两个模型各一遍 | 上传 0.15–0.5s，全程 3.1–5.2s；结果 JSON 里 `file_url` 被换成了带签名的 http 链接 |
| 2.4b | 同上但**不加** resolve 头 | 提交仍 200；qwen3 轮询 2.2s 后 `FAILED / FILE_DOWNLOAD_FAILED`；qwen-audio-3.0 跑到 47s 才 `FAILED / SERVER_ERROR` |
| 2.5 | 48 秒段落的识别质量 | 两代都把「一九九八年」在 `enable_itn` 下写成 1998；qwen3 把「陈伯」认成一次「陈博」、「打量她」认成「他」，给 `text` 上下文「人物：林小满（女）、陈伯……」**没有纠正**；qwen-audio-3.0 不给任何上下文两处都对，分句多一处合并（「雨夜林小满…」） |
| 2.6 | qwen-audio-3.0 `diarization_enabled: true, speaker_count: 2` + `context[]` | 成功，多 2 秒；单说话人 TTS 全标 `speaker_id: 0`（合理） |

**没测的**：2GB / 小时级文件的轮询时长；视频容器（mp4 / mkv）；`vocabulary` 即时热词的纠错效果；`dashscope-intl` 国际站是否也有 `/uploads`；任务能否取消（文档没有取消接口）。

---

## 3. 现状盘点（可以直接复用的）

| 已有能力 | 位置 | 对本方案的意义 |
|---|---|---|
| DashScope 原生协议：`dashscopeNativeBase` / `dashscopeHeaders` / 提交-轮询-超时-连续 3 次失败才抛 | `src/lib/ai/image.ts:992–1211` | 轮询循环**原样抽出来共用**，ASR 只换端点、请求体和结果解析 |
| 请求走 Rust reqwest，`FormData` + `Blob` 上传先例（**不要手设 Content-Type**） | `src/lib/http.ts` · `image.ts:658, 1300` | OSS 表单上传没有 CORS 问题；capability `http:default` 已是 `https://**` 通配，CSP `connect-src` 已放行 `https:` |
| 读二进制文件 | `src/lib/fs/fileio.ts:30` `readBinaryFile` | 音频进 Blob 不需要新的 Rust 命令 |
| 「专用模型不是小号 LLM」的全套先例：`translateFormat` 标记 → `isTranslateOnly` → `conversationalModels` 过滤 → 子代理档位 `translate`（进 `SUBAGENT_KINDS` 不进 `DELEGATE_KINDS`）→ `resolveTranslateConn` | `src/lib/ai/configDb.ts:305–320` · `src/lib/agent/subagent.ts:27–72, 206–235` · `src/lib/translate/tool.ts:41–60` | ASR 模型的身份、候选过滤、绑定方式全部照抄 |
| Beta 开关的形状（10 行 flag + `PREF_KEYS` 一项 + LabPane 一行 + `goNext("subagents")` 脚注） | `src/lib/translate/flag.ts` · `src/lib/prefs.ts:64–76` · `LabPane.tsx:130–143` | |
| 右键菜单的 Beta 门（**关着时不存在，不是禁用**）+ `flushIfOpen` + 懒加载模块 | `FileTree.tsx:1413–1424, 1053, 1073` | 转写入口同款 |
| L2 提案工具的最干净模板：`convert_document` → `ConvertProposal` → `ApprovalCard` → `agentStore` apply → `materialize` | `src/lib/agent/convertTools.ts` · `registry.ts:473, 2743` · `ApprovalCard.tsx:86/144/779` · `agentStore.ts:774–793` | 新提案种类要改的五处已经数清（§5.3） |
| 内容哈希缓存 `.ai-writer/tmp/convert/<key>/` + 原子落盘 + 扫盘清理 | `src/lib/import/cache.ts` · `cachedConvert.ts` | 转写结果 JSON 用同一套（§4.4） |
| 路由里「Beta 开 **且** 模型已绑」才追加工具 | `src/lib/agent/routing.ts:189` | `transcribe_audio` 同款；追加的工具要在 routed-set 测试里单独断言 |

**缺的部件**：① 音频 / 视频文件种类（`ProjectFileKind` 只有 image / text，`ModelType` 没有 audio）；② OSS 临时上传；③ 两代模型的请求 / 结果解析；④ 结果 JSON → markdown 的渲染；⑤ 一个新的提案种类。

---

## 4. 设计

### 4.1 模型行：一个标记，不是一个新 `ModelType`

给 `Model` 加 `asrFormat?: "dashscope-filetrans"`（照 `translateFormat` 的先例：**是联合类型不是布尔，因为格式就是身份**），`isAsrOnly(m) = m.asrFormat !== undefined`，并入 `conversationalModels` 的排除条件。不新增 `ModelType = "audio"`——那要动 `modelUpsert` / `rowToModel` / 抽屉的类型选择器和每一处 `type !== "image"` 过滤，而 ASR 模型除了「不能对话」以外和 text 行没有任何共同行为需要区分。

模型抽屉里选了这个格式，就折叠掉和它无关的分节（思考、结构化输出、上下文探测……都不适用），只留：模型 id（默认 `qwen-audio-3.0-asr-flash-filetrans`）、每秒单价（进 `token_usage` 的成本列）。供应商仍是现有的 DashScope `openai_compat` 行，`dashscopeNativeBase` 把 `/compatible-mode/v1` 换回 `/api/v1`——**一行供应商、一份钥匙串条目，文本 / 生图 / 转写共用**。

### 4.2 子代理档位 `asr`

进 `SUBAGENT_KINDS`，不进 `DELEGATE_KINDS`（`subagent.ts:35–68` 那段注释说的就是这种模型：不能对话的模型得到的是**工具**不是子对话）。`subAgentModel` 加一行 `if (kind === "asr" && !isAsrOnly(model)) return null`；`SubAgentsPane` 加候选列表 `asrCandidates = models.filter(m => m.enabled && isAsrOnly(m))` 和相应的 warning。每次运行通过 `resolveAsrConn()`（克隆 `resolveTranslateConn`）拿到 `{ provider, model, apiKey }`。

### 4.3 核心模块 `src/lib/asr/`

```
flag.ts        app:asrBeta（默认关）· ai:asr:useLore（热词，默认关，见 §7 问题 3）· ai:asr:diarization（默认关）
client.ts      getPolicy → uploadTemp(bytes, name) → submit(model, ossUrl, params) → poll(taskId) → fetchResult(url)
               轮询循环从 image.ts 抽成 lib/ai/dashscopeTask.ts 共用（3s × 10 然后 5s，连续 3 次网络失败才抛，一个 wall-clock deadline）
result.ts      纯函数：parseTaskOutput(json) 同时认两代的结果 URL 位置；parseTranscript(json) 归一成
               { durationMs, format, sentences: [{ beginMs, endMs, text, speaker?, language?, emotion? }] }
render.ts      纯函数：Transcript → markdown（§4.5）
cost.ts        纯函数：秒数 × 每秒单价；上传前用文件头估时长（wav 直接算，mp3/m4a 估不准就不显示，只显示大小）
run.ts         transcribeFile(path, opts, { onProgress, signal }) —— 唯一碰盘 + 碰网的编排；结果进缓存（§4.4）
```

`client.ts` 的三条不变量：
1. **getPolicy 的 `model` 和 submit 的 `model` 是同一个变量**，不是两处各写一遍——凭证和模型绑定，写错的症状是轮询阶段的 `FILE_DOWNLOAD_FAILED`，和漏头一模一样，排查不出来。
2. **`X-DashScope-OssResourceResolve: enable` 只在 `file_url` 以 `oss://` 开头时加**，并且是提交请求的头，不是 getPolicy 的。
3. 提交返回 200 但 body 顶层带 `code` 是错误（`image.ts:1110` 的规矩）；轮询 `FAILED` 时把 `output.code` + `output.message` 原样带进错误——`SERVER_ERROR` 这种没有 message 的，就把「可能是 oss:// 没解析」作为提示附上，因为 §2.4b 证明它就是这么表现的。

### 4.4 结果缓存：转写一次，落盘一次

一个小时的音频要 ¥0.79，而结果链接 24 小时就失效。所以 `run.ts` 拿到结果 JSON 后**先写进** `.ai-writer/tmp/asr/<sha256 前 16 位>/result.json` + `meta.json`（源路径、模型、参数、时长、时间戳），键是**文件内容的哈希 + 参数**（开不开分离、热词表哈希），和 `lib/import/cache.ts` 一样的目录约定、原子改名落盘、7 天清扫。第二次对同一文件转写（助手重问、作者换一种输出格式）直接命中，不再付费；`list_files` / `read_file` / 备份都看不见这个目录，和转换缓存同一条规矩。

### 4.5 输出：源文件旁边一份 `.md`

`<同目录>/<stem>.md`，冲突走 `uniqueImportPath` 编号（和转换产物一致）。内容：

```markdown
---
source: 采访-第三次.m4a
transcribed: 2026-09-06T19:57:18+08:00
model: qwen-audio-3.0-asr-flash-filetrans
duration: 00:48
---

[00:00] 第一章 雨夜。林小满推开旧书店的门，铃铛在头顶叮当作响。
[00:08] 店主陈伯从柜台后抬起头，眯着眼睛打量她。
…
```

- 一句一段，前缀 `[mm:ss]`（超过一小时自动 `h:mm:ss`）；时间戳是**可关的**（设置项，默认开——引用采访录音时时间戳是回去核对的唯一线索）。
- 开了说话人分离就在时间戳后加 `说话人 1：`；`speaker_id` 从 0 起，展示时 +1。
- 不写 `emotion` / `language`（只有 qwen3 一代给，而且对写作没用）；词级时间戳不进 markdown，留在缓存 JSON 里。
- 原文是 `.mp4` 这类视频容器时一样处理——filetrans 接口直接吃视频（§1.1 格式表有 mp4 / mkv / mov / avi / flv / webm / wmv）。

### 4.6 入口一：文件树右键 「转写为文字」

- `lib/fs/images.ts` 加 `AUDIO_EXTS`（aac amr flac m4a mp3 ogg opus wav wma）和 `VIDEO_EXTS`（avi flv mkv mov mp4 mpeg webm wmv），`ProjectFileKind` **不**扩——它的含义是「能发给助手当附件」，音频发不了。单独导出 `isTranscribable(name)`。
- `buildMenuItems` 文件分支：`isTranscribable(node.name) && isAsrEnabled()` 才有这一项（Beta 关着 = 不存在）；Beta 开着但没绑模型 → **禁用 + 提示去子代理绑定**（`插入图片` 那条「作者能自己修好就用禁用」的先例）。
- 点击：`flushIfOpen` 不需要（源文件不是编辑器里的）；`setBusy(node.path)` → 懒加载 `lib/asr` → `transcribeFile` → `refreshFileTree` → `setActiveFilePath(结果)` → `setNotice("已转写 · 48 秒 · ¥0.01")`。进度用现有的 busy 态，标签随 `onProgress` 变（上传中 / 排队中 / 识别中 · 第 N 次查询）。
- 付费动作**要不要先确认**：见 §7 问题 2。我的建议是转写前弹一次确认（文件大小 + 单价 + 若能算出时长则给估价），因为一个 3 小时的采访 ¥2.4 不是「点错了撤销」能收回的。

### 4.7 入口二：L2 工具 `transcribe_audio`

参数 `{ path, diarization?: boolean, language_hints?: string[] }`。流程照 `convertTools.ts`：没有 `requestApproval` 的界面直接拒绝；路径包含检查；扩展名检查（不是音视频就点名让它用 `read_file` / `read_document`）；**然后先出卡再花钱**——和 `convert_document`「提案时就把活干了」相反，和生图「批准 → 生成 → 落盘」相同，因为这一步是计费的。卡片给：文件名、大小、估算时长与费用、会写到哪、开没开分离。批准后在 apply 阶段跑 `transcribeFile`，进度走 `requestApproval` 已有的 `onApplyProgress`；结果写盘后回给模型「已写入 `<path>`，48 秒，N 句」，模型接着 `read_file` 就行——**不再单独做 `read_transcript`**。

`read_file` 对音视频扩展名的拒绝文案要点名 `transcribe_audio`（`read_file` / `read_slides` / `read_document` 互相点名的那条规矩）；Beta 关着或没绑模型时工具不在 `allowedTools` 里，那句拒绝就要改成「这个文件是音频，当前没有转写能力」——**按 `allowedTools` 判，不按标志位**（`docs/reference/tool-presence.md`）。

`ToolId` 加 `"transcribe_audio"`；`TranscribeProposal` 加进 `Proposal` 联合；`ApprovalCard` 三个 switch 各一臂；`agentStore` apply 一臂；`autoApprove.ts` 里**不可自动批准**（它花钱）。路由：`isAsrEnabled() && live("asr")` 才追加，追加不进 raw preset 所以 `agentToolBudget.test.ts` 看不见，要在 routed-set 测试里断言。

### 4.8 知识库热词（可选，§7 问题 3）

`qwen-audio-3.0` 的 `vocabulary` 是即时热词字典 `{ 词: 权重 }`，不用预建词表。从 `loreIndex` 取**条目名 + 别名**（同翻译的 glossary 来源），权重 3。实测里 qwen3 的 `text` 上下文没纠正「陈博」，但 `vocabulary` 是另一个机制、另一代模型，没测——这一片要**先测后做**：拿 §2 那段 TTS 换个把「陈伯」念错的声音，对比开关热词的差异，有效才留。

---

## 5. 分片

| PR | 交付 | 结束时能做什么 | 能否独立合并 |
|---|---|---|---|
| 1 | `lib/asr/` 全部纯逻辑 + client + 缓存；`asrFormat` 标记与候选过滤；`asr` 子代理档位 + 设置页；Beta 开关 + LabPane；`lib/ai/dashscopeTask.ts` 抽出共用（image.ts 改为调它，行为不变） | 设置里能配一个转写模型；没有任何入口 | ✓（纯地基） |
| 2 | 文件种类 + 右键「转写为文字」+ 确认框 + busy/进度/通知 | 作者右键一个 mp3 → 旁边出 `.md` | ✓ |
| 3 | `transcribe_audio` L2 工具 + 提案卡 + apply + 路由 + `read_file` 拒绝文案 + tool-presence 文档更新 | 助手在对话里能转写并接着读 | ✓ |
| 4 | 热词注入（先实测） | 人名认对 | 可不做 |

每片的门：`pnpm tsc --noEmit` + `pnpm test` + `pnpm build`，加作者真机跑一次（PR 2 / 3 各要一段真实录音）。纯函数测试：两代结果 JSON 的解析（拿 §2 存下的两份真实结果当夹具（已在 `src/lib/asr/__tests__/fixtures/`））、markdown 渲染（时间戳格式、说话人、超一小时）、缓存键、费用估算、`buildMultipart` 字段顺序（`file` 在最后）。

---

## 6. 风险与边界

- **临时存储的定位**：平台明说不给生产用（100 QPS、48h）。单作者桌面应用一次一个文件碰不到，但设置页要写明「文件会上传到阿里云临时存储 48 小时」——**这是隐私事实，不是技术细节**，录音里可能是采访对象。
- **超时**：12 小时的音频轮询要多久没测。deadline 不能沿用生图的 10 分钟；建议 max(10 分钟, 时长 × 2)，时长未知时 60 分钟，并且 abort 只停轮询（平台没有取消接口，任务照样计费）。
- **国际站**：`dashscope-intl.aliyuncs.com` 是否有 `/uploads` 和这两个模型没测；供应商 base 是 intl 时提示「未验证」。
- **两代形状**：`parseTaskOutput` 两处都找；哪天平台把 qwen3 也改成 `output.output` 也不会坏。
- **同名冲突**：`采访.mp3` 和 `采访.md` 已经并存时用编号，不覆盖——同转换产物。
- **成本入账**：`token_usage` 表按 token 记，ASR 按秒计费；进 `usage.ts` 的 rollup 需要一行「按秒 × 单价」的换算，否则设置 → 用量 看不到这笔钱。

---

## 7. 待作者拍板

1. **只做异步一条路径**，短文件不走同步 base64——少一条路径，代价是最短的文件也要多一次上传（实测 0.15s）。
2. **右键转写前要不要确认框**：我倾向要（付费 + 上传到第三方两件事都值得一次点头），但它让「一步到位」变成两步。
3. **热词从知识库注入**默认开还是关、要不要做——先测再定。
4. **默认模型**：`qwen-audio-3.0-asr-flash-filetrans`（现役、有分离和热词、实测认得更准）；qwen3 一代只是解析上兼容，不推荐。
5. 输出里**时间戳默认开**、说话人分离默认关——都可在设置里改。
