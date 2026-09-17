# search_tools A/B（2026-09-17）

> 状态：`research`。一次台架跑分，不是一份契约——数字随模型和机器走。[`agent-tool-context-lld.md`](../agent-tool-context-lld.md) §6.1 的原始输出。

台架 `scripts/prompt-ab.ts`，模型 `spark-x2.5-4b`（LM Studio 形态的 OpenAI 兼容端点，思考模型），
每格 10 次、每次至多 6 轮，喂假工具结果。三组：

- **A 常驻**（`AB_BASELINE=1`）：`file_ops` / `image` 照旧常驻，39 个工具 ≈ 10,780 tok（台架按 4 字符/token 粗算）。
- **B 第一版**：两组延迟 + `search_tools`，31 个工具 ≈ 7,686 tok。
- **C 第二版**：B + 两处修正——查知识库写入时改口指向 `propose_lore_plan`；briefing 点名哪几类事要先搜、「改名不是改正文」。

A 与 B 同时跑，用的是 B 那一版 briefing（点名 `search_tools` 的那句在 A 里指向一个不在场的工具，
对 A 的五格影响可以忽略：A 里没有一次调用去碰它）。`✓/✗` 是判据，`!unloaded` 是点名了一个还没装的工具
（三组里一次都没出现）。

## A 常驻

```
model=spark-x2.5-4b runs=10 variant=(locale ai.instructions.agent) baseline=true
system prompt: 4644 chars · tools: 39 defs ≈ 10780 tok


[plan-first] 动知识库之前必须提 propose_lore_plan
  ✓ 21s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 8s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✗ 22s  list_lore_entities → read_lore_entity
  ✓ 6s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 21s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 13s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✗ 22s  list_lore_entities → read_lore_entity
  ✓ 27s  list_lore_entities → read_lore_entity → list_files → propose_lore_plan
  ✓ 20s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✗ 26s  list_lore_entities → read_lore_entity
  = 7/10

[search-before-read] 用 search_text 定位，而不是逐个 read_file 翻
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  = 10/10

[rename-file] 改名要用到 file_ops 组里的 move_chapter
  ✓ 3s  search_text → read_file → move_chapter
  ✗ 3s  list_files → read_file → propose_edit
  ✓ 11s  list_files → read_file → move_chapter
  ✗ 3s  search_text → read_file → propose_edit
  ✗ 3s  search_text → read_file → propose_edit
  ✓ 6s  list_files → search_text → read_file → move_chapter
  ✗ 3s  search_text → read_file → propose_edit
  ✓ 3s  search_text → list_files → read_file → move_chapter
  ✓ 2s  list_files → move_chapter
  ✓ 3s  search_text → read_file → move_chapter
  = 6/10

[delete-folder] 删文件夹要用到 file_ops 组里的 delete_directory
  ✗ 12s  list_files → search_text → list_files → search_text → search_text → list_files
  ✓ 3s  list_files → delete_directory
  ✓ 4s  list_files → delete_directory
  ✓ 4s  list_files → delete_directory
  ✓ 13s  list_files → search_text → search_text → list_files → list_files → delete_directory
  ✓ 3s  list_files → delete_directory
  ✗ 33s  list_files → list_files → search_text → read_file → read_file → search_text
  ✓ 3s  list_files → delete_directory
  ✗ 6s  list_files → search_text
  ✗ 10s  list_files → search_text → search_text → search_text
  = 6/10

[draw] 画图要用到 image 组里的 generate_image
  ✓ 12s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 8s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 7s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 9s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 7s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 6s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 9s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 9s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 16s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  ✓ 11s  list_lore_entities → read_lore_entity → read_lore_entity → generate_image
  = 10/10

总计 39/50
```

## B 第一版

```
model=spark-x2.5-4b runs=10 variant=(locale ai.instructions.agent) baseline=false
system prompt: 4644 chars · tools: 31 defs ≈ 7686 tok


[plan-first] 动知识库之前必须提 propose_lore_plan
  ✗ 27s  list_lore_entities → read_lore_entity → search_tools(update lore meta alias)
  ✗ 16s  list_lore_entities → read_lore_entity → search_text → list_files → list_files → list_files
  ✓ 27s  list_lore_entities → read_lore_entity → search_tools(lore update alias) → propose_lore_plan
  ✓ 8s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✗ 30s  list_lore_entities → read_lore_entity → search_tools(lore meta alias update)
  ✓ 10s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✗ 26s  list_lore_entities → read_lore_entity → search_tools(修改知识库别名 update_lore_meta)
  ✓ 9s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✗ 22s  list_lore_entities → read_lore_entity
  ✓ 13s  list_lore_entities → read_lore_entity → search_tools(更新别名 update_lore_meta) → propose_lore_plan
  = 5/10

[search-before-read] 用 search_text 定位，而不是逐个 read_file 翻
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  = 10/10

[rename-file] 改名要用到 file_ops 组里的 move_chapter
  ✗ 3s  search_text → read_file → propose_edit
  ✗ 3s  search_text → list_files → read_file → propose_edit
  ✓ 7s  search_text → read_file → search_tools(rename file) → move_chapter
  ✗ 3s  search_text → list_files → read_file → propose_edit
  ✗ 3s  search_text → read_file → propose_edit
  ✗ 17s  search_text → read_file → propose_edit
  ✗ 20s  search_text → read_file → list_lore_entities → propose_edit
  ✓ 5s  search_text → read_file → search_tools(rename move file) → move_chapter
  ✗ 3s  search_text → read_file → propose_edit
  ✗ 4s  search_text → read_file → propose_edit
  = 2/10

[delete-folder] 删文件夹要用到 file_ops 组里的 delete_directory
  ✓ 11s  list_files → search_text → search_tools(删除文件夹) → delete_directory
  ✗ 6s  list_files → search_text
  ✓ 5s  list_files → search_tools(删除文件夹 文件操作) → delete_directory
  ✓ 4s  list_files → search_tools(删除文件夹) → delete_directory
  ✓ 4s  list_files → search_tools(删除文件夹) → delete_directory
  ✗ 7s  list_files → search_text → search_text
  ✓ 9s  list_files → search_text → search_text → search_text → search_text → search_tools(删除文件夹) → delete_directory
  ✗ 8s  list_files → search_text → search_text
  ✗ 28s  list_files → search_text → read_file → read_file → task_progress → search_tools(删除文件夹)
  ✓ 7s  list_files → search_tools(删除文件夹 delete directory) → delete_directory
  = 6/10

[draw] 画图要用到 image 组里的 generate_image
  ✓ 14s  list_lore_entities → read_lore_entity → list_files → read_lore_entity → search_tools(generate image) → generate_image
  ✗ 11s  list_lore_entities → read_lore_entity → list_files → read_file → search_text → list_files → search_text
  ✓ 14s  list_lore_entities → read_lore_entity → list_files → read_file → read_file → read_file → search_tools(生成图片 generate_image) → generate_image
  ✓ 16s  list_lore_entities → read_lore_entity → search_tools(生成图片) → generate_image
  ✗ 14s  list_lore_entities → read_lore_entity → search_tools(生成图片 generate_image) → search_text → read_file → list_files → search_text
  ✓ 16s  list_lore_entities → read_lore_entity → search_tools(generate image avatar) → read_lore_entity → generate_image
  ✗ 6s  list_lore_entities → read_lore_entity → read_lore_entity → list_files → search_text → read_file
  ✓ 10s  list_lore_entities → read_lore_entity → search_tools(生成头像 画图) → list_files → generate_image
  ✓ 18s  list_lore_entities → read_lore_entity → read_lore_entity → search_tools(生图 generate image) → generate_image
  ✓ 12s  list_lore_entities → read_lore_entity → read_lore_entity → search_tools(generate image) → generate_image
  = 7/10

总计 30/50
```

## C 第二版（落地的版本）

```
model=spark-x2.5-4b runs=10 variant=(locale ai.instructions.agent) baseline=false
system prompt: 4707 chars · tools: 31 defs ≈ 7686 tok


[plan-first] 动知识库之前必须提 propose_lore_plan
  ✗ 23s  list_lore_entities → read_lore_entity
  ✗ 22s  list_lore_entities → read_lore_entity
  ✓ 4s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 12s  list_lore_entities → read_lore_entity → search_tools(update lore meta aliases) → propose_lore_plan
  ✓ 7s  list_lore_entities → read_lore_entity → read_lore_entity → propose_lore_plan
  ✗ 22s  list_lore_entities → read_lore_entity
  ✗ 22s  list_lore_entities → read_lore_entity
  ✓ 18s  list_lore_entities → read_lore_entity → search_tools(update lore meta aliases) → propose_lore_plan
  ✓ 13s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 19s  list_lore_entities → read_lore_entity → search_tools(lore meta update alias) → propose_lore_plan
  = 6/10

[search-before-read] 用 search_text 定位，而不是逐个 read_file 翻
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  ✓ 1s  search_text
  = 10/10

[rename-file] 改名要用到 file_ops 组里的 move_chapter
  ✗ 4s  search_text → list_files → read_file → propose_edit
  ✓ 10s  search_text → list_files → read_file → search_tools(rename file) → move_chapter
  ✗ 3s  search_text → read_file → propose_edit
  ✗ 4s  search_text → read_file → propose_edit
  ✓ 5s  search_text → list_files → read_file → search_tools(rename file) → move_chapter
  ✗ 4s  search_text → list_files → read_file → propose_edit
  ✗ 3s  search_text → list_files → read_file → propose_edit
  ✗ 3s  search_text → read_file → propose_edit
  ✓ 5s  search_text → list_files → search_tools(rename file) → move_chapter
  ✓ 7s  list_files → search_tools(rename file) → move_chapter
  = 4/10

[delete-folder] 删文件夹要用到 file_ops 组里的 delete_directory
  ✗ 25s  list_files → search_text → read_file
  ✓ 3s  list_files → search_tools(删除文件夹) → delete_directory
  ✗ 26s  list_files → search_text → list_files → search_tools(删除文件夹 旧稿)
  ✓ 4s  list_files → search_tools(删除文件夹) → delete_directory
  ✗ 9s  list_files → search_text → search_text → search_text
  ✗ 24s  list_files → search_text → search_text → list_files
  ✓ 3s  list_files → search_tools(删除文件夹) → delete_directory
  ✗ 7s  list_files → search_text → search_text → search_text
  ✗ 12s  list_files → search_text → search_text
  ✓ 11s  list_files → search_text → search_tools(删除文件夹) → delete_directory
  = 4/10

[draw] 画图要用到 image 组里的 generate_image
  ✓ 27s  list_lore_entities → read_lore_entity → read_lore_entity → list_files → search_tools(画图 头像 generate image) → generate_image
  ✓ 15s  list_lore_entities → read_lore_entity → list_files → read_file → read_file → read_file → search_tools(generate image avatar) → generate_image
  ✗ 16s  list_lore_entities → read_lore_entity → read_lore_entity → list_files → read_file → read_file → search_tools(生成图片 generate_image)
  ✓ 12s  list_lore_entities → read_lore_entity → list_files → search_text → search_tools(生成图片 头像) → generate_image
  ✓ 13s  list_lore_entities → read_lore_entity → search_tools(生成图片 generate_image) → read_lore_entity → generate_image
  ✓ 22s  list_lore_entities → read_lore_entity → read_lore_entity → search_tools(生成图像 绘制头像 generate_image) → generate_image
  ✓ 11s  list_lore_entities → read_lore_entity → search_tools(生成图片 画头像 generate_image) → generate_image
  ✓ 10s  list_lore_entities → read_lore_entity → search_tools(生成图片 generate_image) → generate_image
  ✓ 14s  list_lore_entities → search_tools(画图 生成图片 generate image) → read_lore_entity → read_lore_entity → generate_image
  ✓ 12s  list_lore_entities → search_tools(画图 生成图片) → read_lore_entity → read_lore_entity → generate_image
  = 9/10

总计 33/50
```
