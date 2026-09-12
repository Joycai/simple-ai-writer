# 音频转写 · 执行方案

> 状态：`shipped`（Beta 开关后）· PR 1–3 合在 [#514](https://github.com/Joycai/simple-ai-writer/pull/514) 的三次提交里（地基 / 工具与审批卡 + 设置三处 / 文件树入口）· PR 4（热词）未做 · 前置阅读：[`00-research.md`](00-research.md)（协议事实 + 实测记录）· UI 任务书与实现出入：[`02-ui-brief.md`](02-ui-brief.md)
>
> 研究稿回答"能不能做、落在哪"，这一份回答"按什么顺序做、每片交付什么、怎么算做完"。

---

## 0. 已定的五件事

研究稿 §7 的五个开放问题，按建议默认落定；作者要改哪条，改这张表就够了，下面的分片跟着它走。

| # | 问题 | 决定 | 落地形态 |
|---|---|---|---|
| 1 | 短文件走不走同步 base64 | **只做异步一条** | `lib/asr/client.ts` 只有 上传 → 提交 → 轮询 → 取结果；同步接口的形状只留在 `docs/api/qianwen-compat-plan.md` §1.4 |
| 2 | 右键转写前要不要确认 | **要** | 一张确认卡：文件名、大小、能算出就给时长和估价、「会上传到阿里云临时存储，48 小时后自动清理」、说话人分离开关。确认才上传 |
| 3 | 知识库热词 | **先测再做，默认不做** | PR 4 前先用一段把人名念错的音频对比 `vocabulary` 开关；无效就不做。PR 1 的 `AsrOptions` 里**没有**热词字段 |
| 4 | 默认模型 | `qwen-audio-3.0-asr-flash-filetrans` | 模型抽屉选「转写模型格式」时预填它；qwen3 一代只在结果解析上兼容 |
| 5 | 输出默认 | **时间戳开、说话人分离关** | 两个偏好：`ai:asr:timestamps`（缺席＝开）、`ai:asr:diarization`（缺席＝关） |

### §1 修正：不抽 `dashscopeTask.ts`

研究稿 §4.3 说把轮询循环从 `lib/ai/image.ts` 抽成共用模块。**不抽**：那段代码属于已交付的生图路径，抽出来意味着 PR 1 同时改动出图的行为面，而两边要共享的只有 40 行（睡眠 + `polls < 10 ? 3s : 5s` + 连续 3 次失败才抛）。ASR 的轮询在 `lib/asr/client.ts` 里自己写一份，注释指回 `image.ts` 的 `dashscopeAsyncImage`。哪天第三个 DashScope 异步任务出现再抽。

---

## 1. 不变量

下面七条任何一条被破坏都算 bug，不算权衡。

1. **转写模型绝不进对话候选。** `isAsrOnly(m)` 是这条不变量的名字，`conversationalModels` 无条件排除它；`asr` 档位只收 `isAsrOnly` 的模型，`writer` 等其余档位拒收它。绑错的症状和翻译模型一样是**静默的**：它没有对话能力，`/services/audio/asr/transcription` 收到一段文字只会报错，但作为主模型它会让整个对话在第一轮就死掉。
2. **凭证的 `model` 和提交的 `model` 是同一个变量。** 临时文件与模型名绑定；写成两处字面量，错的症状是轮询阶段的 `FILE_DOWNLOAD_FAILED`，和漏头一模一样，排查不出来。
3. **`X-DashScope-OssResourceResolve: enable` 只跟着 `oss://` 走**，加在提交请求上，不加在 getPolicy 上。
4. **付费之前必须有人点头。** 右键路径是确认卡，助手路径是审批卡；`autoApprove` 永不放行 `transcribe_audio`。转写结果先进缓存再写产物，同一文件同一参数**同一模型**不付第二次——键里带模型（`cacheKeyOf`），换绑模型是换一份缓存而不是命中旧的：结果真的不一样，而产物的抬头写的是**这次**绑的那个模型名，拿回上一个模型的稿子等于把一份张冠李戴的文字稿写进项目。
5. **两代结果形状都认，且结果 JSON 拿到就落盘。** `transcriptionUrlOf` 同时找 `output.result` 和 `output.output`；链接 24 小时失效，缓存里存的是结果本体不是链接。
6. **Beta 关着＝入口不存在。** 菜单项不渲染、工具不装载（`allowedTools` 里没有），而不是渲染成禁用 / 调用被拒。Beta 开着但没绑模型，菜单项**禁用并指路**（作者能自己修好），工具仍不装载（`isAsrEnabled() && live("asr")`）。
7. **批准之前不读整个文件，也不越过大小上限。** 提案 / 确认卡要的只有两个数——大小和（WAV 的）时长，`readFileHead` 一次往返给回真实大小和前 64KB。`readBinaryFile` 会把一份 1.5GB 的录音整个搬过 IPC 进 webview 堆，而 `MAX_TRANSCRIBE_BYTES` 那道闸在 `transcribeFile` 里、也就是在**批准之后**才关：两个入口都要在读之前先拦。传给 `wavDurationSeconds` 的必须是**真实大小**而不是手里那段前缀——流式写出的 WAV 把 data 长度写成哨兵值，时长只能由「data 块一直到文件末尾」反推，拿前缀反推会把一小时的录音报成半秒，而那个数字随后就印在付费确认卡上。

---

## 2. 分片总览

| PR | 目标 | 结束时能做什么 | 能否独立合并 |
|---|---|---|---|
| **1** | 地基：`lib/asr/` 纯逻辑 + 客户端 + 缓存 + 编排；模型行 `asrFormat` / `pricePerSecond`；`asr` 子代理档位；Beta 开关与三个偏好；测试 | 设置里**还看不见**任何东西（UI 在 PR 2）；`transcribeFile()` 可从代码调用 | ✓，纯地基，零行为变化 |
| **2** | 设置 UI + 右键入口：实验室一行、子代理一行、模型抽屉的「转写模型格式」段、文件树菜单项 + 确认卡 + busy/进度/通知；文件种类 | 作者右键一个 mp3 → 旁边出 `.md` | ✓（依赖 PR 1） |
| **3** | 助手入口：`transcribe_audio` L2 工具 + `TranscribeProposal` 卡 + apply + 路由 + `read_file` 对音视频的拒绝文案 + tool-presence 文档 + routed-set 测试 | 对话里能转写并接着读 | ✓（依赖 PR 1；卡片样式依赖 02 的设计稿） |
| **4** | 热词（先测） | 人名认对 | 可不做 |

每片的门：`pnpm tsc --noEmit` + `pnpm test` + `pnpm build`，加作者真机跑一次（PR 2 / 3 各要一段真实录音，最好有一段带两个人说话的）。

---

## 3. PR 1 — 地基

### 3.1 `src/lib/asr/`

```
flag.ts       app:asrBeta（默认关）· ai:asr:timestamps（缺席＝开）· ai:asr:diarization（缺席＝关）
formats.ts    ASR_AUDIO_EXTENSIONS / ASR_VIDEO_EXTENSIONS（研究稿 §1.1 的 17 个）· transcribeExtOf(name)
client.ts     AsrHttpError · getUploadPolicy · uploadTemp（multipart 字段序，file 最后）· submitTranscription
              · pollTask（3s×10 → 5s，连续 3 次失败才抛，一个 wall-clock deadline）· fetchResultJson
result.ts     纯函数：transcriptionUrlOf(pollOutput) 两代都找 · parseTranscript(json) 两代归一成 Transcript
render.ts     纯函数：transcriptToMarkdown(transcript, {source, model, timestamps, speakers}) · formatClock(ms)
cost.ts       纯函数：wavDurationSeconds(header) · estimateCost(seconds, pricePerSecond) · formatDuration
cache.ts      纯函数：ASR_CACHE_DIR · cacheKeyOf(sha, options) · meta 解析 / 版本 / 清扫计划
run.ts        transcribeFile(...)：读文件 → 缓存命中？→ 上传 → 提交 → 轮询 → 取结果 → 落缓存 → 渲染
              writeTranscript(sourcePath, markdown)：uniqueImportPath 编号，绝不覆盖
conn.ts       resolveAsrConn()：subAgentModel("asr") → provider → loadApiKey（克隆 translate/tool.ts）
index.ts      对外只导出 UI 与工具需要的那几个名字
```

`client.ts` 的请求形状按默认模型（qwen-audio-3.0）：`input.file_urls: [oss]`，`parameters.channel_id: [0]` + 可选 `language_hints[]` / `diarization_enabled` / `speaker_count`。`AsrFormat` 目前只有一个值 `"dashscope-filetrans"`，所以没有按模型分支——两代模型都吃这个请求（实测 `file_url` 单复数两代都收；qwen3 会忽略 `diarization_enabled`），差别全在**结果**侧，由 `result.ts` 吸收。

`Transcript` 归一后的形状：

```ts
interface Transcript {
  format?: string;        // "mp3" / "wav"
  sampleRate?: number;
  durationMs: number;     // 有 original_duration 用它，否则取最后一句 end_time
  speakers: boolean;      // 任何一句带 speaker_id
  sentences: { beginMs: number; endMs: number; text: string; speaker?: number; language?: string; emotion?: string }[];
}
```

### 3.2 模型行

- `configDb.ts`：`export type AsrFormat = "dashscope-filetrans"`；`Model.asrFormat?`、`Model.pricePerSecond?`；列 `asr_format TEXT`、`price_per_second REAL`（`addColumn`，`modelUpsert` / `rowToModel` 各一处）；`ASR_FORMATS` + `parseAsrFormat`（未知值 → undefined，方向同 `parseTranslateFormat`：宁可把它当普通模型也不能把普通模型藏掉）；`isAsrOnly`；`conversationalModels` 改成 `!isTranslateOnly(m) && !isAsrOnly(m)`。
- `configTransfer.ts`：bundle 解析处两行（`parseAsrFormat` / number）。
- `modelSummary.declarationMarks` 的 `Pick` 加 `asrFormat`，标记 `"asr"`（标记的渲染在 PR 2）。

### 3.3 子代理档位

- `subagent.ts`：`SubAgentKind` + `SUBAGENT_KINDS` 加 `"asr"`；`DelegateKind` 排除它（理由同 `translate`，注释里补一段）；`subAgentModel`：`kind === "asr" && !isAsrOnly(model)` → null；`writer` 加 `isAsrOnly` 拒收。
- `prefs.ts`：`ai:subagent:asr:modelId` / `:enabled`、`app:asrBeta`、`ai:asr:timestamps`、`ai:asr:diarization`。
- `SubAgentChips.tsx`：`asr` 进 `OFF_CHIP`——它不是"本轮要不要用"的开关（转写是显式动作，不是模型自选的工具），和 `writer` 一样只住设置里。PR 2 若设计稿另有主张再挪。
- `SubAgentsPane.tsx` 的 `candidatesFor` / `warningFor` / `metaFor`：**PR 1 一行没动**——它们对未知档位回落到文本候选，类型检查过了。代价是 PR 1 合并后子代理页会多出一行「asr」、候选列表是错的（列的是对话模型）；这行在 PR 2 里按设计稿重做，**PR 1 单独发布前要么隐藏这一行，要么和 PR 2 一起合**。

### 3.5 PR 1 实际落地（2026-09-06）

- 上面 3.1–3.4 全部落地；`lib/asr/` 八个模块 + `index.ts`，七个测试文件 40 个用例；`tsc` / `vitest`（3729）/ `build` 三绿。
- 出入两处：① `modelSummary.declarationMarks` **没加** `"asr"` 标记——标记有一张渲染表，加了就是 UI 改动，归 PR 2；② `SubAgentsPane` 见上一条。
- 五个现成测试文件里手写的 `Record<SubAgentKind, SubAgentConfig>` 字面量各补了一行 `asr`（`routing.test.ts` 十处）——加一种档位就会撞上它们，这不是测试坏了。

### 3.4 测试（`src/lib/asr/__tests__/`）

| 文件 | 钉住什么 |
|---|---|
| `result.test.ts` | 两份真实夹具（`fixtures/`）各解析成同一形状；`transcriptionUrlOf` 两代位置；qwen-audio-3.0 的 `sentence_id` 从 1、qwen3 从 0 都不影响顺序；`speaker_id` 出现 → `speakers: true`；`FAILED` 的 code / message 进错误 |
| `render.test.ts` | 时间戳 `[mm:ss]` / 超一小时 `[h:mm:ss]`；说话人 `说话人 1：`（0 → 1）；关时间戳；frontmatter 四个键；空句跳过 |
| `cost.test.ts` | WAV 头算时长（44 字节标准头 + 非标准 `LIST` 块）；非 WAV 返 null；估价保留 4 位 |
| `client.test.ts` | multipart 字段序且 `file` 最后；`oss://` 才带 resolve 头、`https://` 不带；getPolicy 和 submit 用同一个 model；提交 200 带顶层 `code` 抛错；轮询 `FAILED` 抛 `AsrHttpError` 且携带 `output.code` |
| `cache.test.ts` | 同内容不同参数键不同；清扫计划（版本 / TTL / 无 sidecar） |
| `flag.test.ts` | 三个偏好的缺席默认值 |
| `configDb` 既有测试 | `conversationalModels` 排除 `asrFormat` 行；`parseAsrFormat` 未知值 → undefined |
| `subagent` 既有测试 | `asr` 档位拒收普通模型；`writer` 拒收 `asrFormat` 模型 |

---

## 4. PR 2 — 设置 UI + 右键入口（等 02 的设计稿）

- `LabPane`：`groupLocal` 加「音频转写」一行，`foot` 指向 `subagents`；说明里写明上传到阿里云临时存储。
- `SubAgentsPane`：`asr` 一行，候选＝`isAsrOnly`；行内两个开关（时间戳 / 说话人分离）——它们是**输出**偏好，住这里而不是实验室。
- `ModelDrawer`：「转写模型格式」段（和「翻译模型格式」并列）；选中后折叠掉思考 / 结构化输出 / 上下文探测 / 输出上限，只留模型 id（预填默认）与每秒单价；「将发送」行改说 `/services/audio/asr/transcription`。
- `lib/fs/images.ts`：**不动** `ProjectFileKind`；`FileTree.buildMenuItems` 用 `transcribeExtOf(node.name) && isAsrEnabled()` 决定存在，`live("asr")` 决定禁用与否。
- 确认卡（`components/ai/TranscribeConfirm.tsx` 或设计稿定的名字）→ `transcribeFile` → `writeTranscript` → `refreshFileTree` → 打开产物 → `setNotice`。进度：上传中 / 排队中 / 识别中 · 第 N 次查询。
- 用量：`persistUsage(projectPath, model.id, 0, 0, cost, "asr")`，cost = 秒 × `pricePerSecond`（**USD 还是 CNY**：`token_usage.cost_usd` 是美元列，而千问报价是人民币——沿用生图的处理，作者在单价里填折算后的美元；抽屉里的单位标签写 `$ / 秒`）。

## 5. PR 3 — `transcribe_audio`

照 `convertTools.ts` 的六步，但**第 3 步换位**：提案时不转写，只读文件头（大小、能算出的时长、估价），批准后在 apply 阶段调 `transcribeFile`，进度走 `requestApproval(proposal, onApplyProgress)`。`ToolId` / `Proposal` 联合 / `ApprovalCard` 三臂 / `agentStore` apply / `autoApprove` 拒绝，五处。路由 `routing.ts` 旁边同款一行；`agentToolBudget.test.ts` 看不见追加，routed-set 测试里单独断言。`read_file` 对 `transcribeExtOf(path)` 非空的文件：工具在 `allowedTools` 里 → 点名 `transcribe_audio`；不在 → 「这是音频/视频文件，当前没有转写能力，请作者在实验室开启并绑定模型」。

## 5.5 真机第一次跑之后的三处补（2026-09-06）

1. **绑错模型的失败形状**：作者绑的是 `qwen3-asr-flash-2026-02-10`（同步接口的模型），文件接口对它答 400「url error, please check url」——错误码文档里这是「模型名称与 API 端点不匹配」，但那句话把人引去查文件路径。三层拦：`client.ts` 把这个 400 改口成「模型 id 不是 filetrans」；`conn.ts` 在**上传之前**按 id 拒绝（`looksLikeFiletransModel`，纯函数在 `formats.ts`）；子代理面板与模型抽屉在绑定 / 编辑时就提示。研究稿 §1.2 第 5 条记了实测。
2. **导入收音视频**：`COPY_BINARY_EXTENSIONS` 加上 `lib/asr/formats` 的两张表，原样复制、不看 Beta——项目本来就可以放源录音。
3. **`@` 引音频**：`ProjectFileKind` 加 `media`（`classifyProjectFile` 认 17 个扩展名），`AttachedMedia` 是一个**只带路径**的附件：`attachProjectFile` 不读文件，`chatRefs` 把它列成「音频 / 视频文件 · 路径」并按本次运行有没有 `transcribe_audio` 决定是点名工具还是让作者去开开关（tool-presence 的规矩）；`@` 候选只在 Beta 开且绑了模型时列出；知识库那几个附件框过滤掉它（那里读不了也转不了）。
4. ASR 四步各进一行调试日志（`logAsrEvent`：policy / upload / submit / poll），下次再失败能看见是哪一步、哪个模型 id。
5. **第二次失败，日志抓到的**：作者换成 `qwen3-asr-flash-filetrans` 后，凭证 / 上传 / 提交全 200，任务 `FAILED · InvalidParameter.MalformedURL`。研究稿 §1.1 的表早写着这代读 `file_url` 单数、qwen-audio-3.0 读 `file_urls` 数组，PR #514 却只发了数组（实测时 qwen3 恰好只用单数试过）。修法：`submitBody` **两个字段一起发**，实测两代都成功、各自忽略不读的那个。教训记在研究稿 §1.1：形状差异表里的每一格都要在**同一份请求**上验过，不是各验各的。

## 6. PR 4 — 热词（先测）

用 §0 第 3 条的方法测；有效则 `AsrOptions.vocabulary` 从 `loreIndex` 取条目名 + 别名（权重 3），开关 `ai:asr:useLore` 默认关。
