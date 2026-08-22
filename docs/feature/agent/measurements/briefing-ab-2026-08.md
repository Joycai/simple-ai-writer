# briefing A/B — gemma4:12b-mlx, 2026-08-21

台架 scripts/prompt-ab.ts。判据与第三格为什么记为失效见 docs/feature/agent/agent-tool-context-lld.md §4.3。

## 现行 briefing（3,763 字符 system）
```

[plan-first] 动知识库之前必须提 propose_lore_plan
  ✓ 11s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 35s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 77s  list_lore_entities → read_lore_entity → propose_lore_plan
  = 3/3

[search-before-read] 用 search_text 定位，而不是逐个 read_file 翻
  ✓ 6s  search_text
  ✓ 4s  search_text
  ✓ 6s  search_text
  = 3/3

[segmented-write] create_file 写骨架 + append_file 分段补，而不是一次性灌完
  ! 301s  ERROR TypeError: fetch failed
  ✗ 53s  list_files → list_files → read_file → list_lore_entities
  ! 301s  ERROR TypeError: fetch failed
  = 0/3

总计 6/9

[segmented-write] create_file 写骨架 + append_file 分段补，而不是一次性灌完
  ✗ 60s  list_files → list_files → list_files
  ✗ 184s  create_file
  ✗ 131s  list_files → create_file
  = 0/3

总计 0/3
```
## 精简版（2,346 字符）
```

[plan-first] 动知识库之前必须提 propose_lore_plan
  ✓ 98s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 24s  list_lore_entities → read_lore_entity → propose_lore_plan
  ✓ 121s  list_lore_entities → read_lore_entity → list_files → propose_lore_plan
  = 3/3

[search-before-read] 用 search_text 定位，而不是逐个 read_file 翻
  ✓ 77s  search_text
  ✓ 4s  search_text
  ✓ 4s  search_text
  = 3/3

[segmented-write] create_file 写骨架 + append_file 分段补，而不是一次性灌完
  ! 301s  ERROR TypeError: fetch failed
  ✗ 77s  list_files → read_file → list_lore_entities → task_plan
  ✗ 31s  (无工具调用)
  = 0/3

总计 6/9

[segmented-write] create_file 写骨架 + append_file 分段补，而不是一次性灌完
  ✗ 140s  list_files → search_text → read_file
  ✗ 83s  list_files → search_text → list_files
  ✗ 190s  create_file
  = 0/3

总计 0/3
```
