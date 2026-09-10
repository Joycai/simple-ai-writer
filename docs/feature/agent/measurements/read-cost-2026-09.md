# 读与搜索的代价，2026-09-07

> 状态：`research`。一次测量，不是一份契约——数字随机器走。
> 复现：`pnpm exec vitest run --config scripts/cost.vitest.config.ts`（报告落在 `read-cost-report.txt`，已 gitignore）
> 由来：[`html-read-edit-plan.md`](../html-read-edit-plan.md) §8（片 E）。那一片的全部内容就是「先量后改」，所以本文只有数字和一个结论。

## 结论先说

| 问题 | 结论 |
|---|---|
| `search_text` 该不该搬去 Rust？ | **不该。** 304 个文件、2.32MB，最慢的一次查询 **17ms**，单次同步块最长 0.3ms。计划里我押的是「搜索是会撑得起这次改动的那一半」——**押错了**。 |
| 分页读该不该换部分读？ | **不该，但它是二次的**，而且真正的修法不是 Rust。 |
| 要不要写 `fs_grep`？ | **不要。** 一份第二套搜索实现（大小写折叠 / 上限 / 排序 / 编码探测都要永远对齐）换不到 17ms。 |

## 测的是什么，测不到什么

fixture 在内存里（种子固定，两次跑可比），所以这里的一次「读」是 `Map.get`——Rust 和 webview bridge 做的事**全都不在**。量到的正是我们自己那一半：读了几次、搬了多少字节、两次读之间跑了多少同步 JS（阻塞 UI 线程的那部分）。传输那一层由「JSON 往返」一列**单独**给下界，不加进上面任何一行——把估算加进测量会让两个都读不懂。真实的 bridge 倍率是运行中的应用里的一次性测量，见计划 §8。

## 数字

```
fixture: 304 files, 2.32MB (300 chapters + 4 .html deliverables)
node v24.15.0

── search_text ─────────────────────────────────────────────────────────
common word (断剑)                  16.8ms    304 reads    2.32MB  worst sync block 0.3ms
rare phrase (青铜匣子)                 4.9ms    304 reads    2.32MB  worst sync block 0.2ms
a miss (никогда)                   4.6ms    304 reads    2.32MB  worst sync block 0.2ms

── read_file paging ────────────────────────────────────────────────────
大.html to the end (53 calls)     104.1ms     53 reads   10.35MB  worst sync block 5.0ms
压缩.html to the end (51 calls)     88.7ms     51 reads    9.76MB  worst sync block 3.7ms
大.html, 40 pages in one round     65.6ms     40 reads    7.81MB  worst sync block 0.0ms

── how the paged read scales ───────────────────────────────────────────
200KB page, 53 calls              85.4ms     53 reads   10.35MB  worst sync block 4.9ms
500KB page, 132 calls            586.3ms    132 reads   64.48MB  worst sync block 8.3ms
1000KB page, 262 calls          2313.3ms    262 reads  255.89MB  worst sync block 18.1ms

── the transport floor (what invoke pays on top) ───────────────────────
JSON round-trip of one 200KB file          0.4ms  × the read counts above
JSON round-trip of one whole search        6.8ms  (300 chapters)
```

## 一、`search_text`：远在阈值之下

计划 §8 定的判据是「> 1.5s，或任一同步块 > 100ms，或单次搜索过 IPC > 5MB → 上 Rust」。实测：**17ms / 0.3ms / 2.32MB**，三条全不沾边。传输下界再加 6.8ms。就算真实 bridge 倍率是 10×，也落在 ~200ms，仍在「< 500ms 就别动」那条线以内。

而且它一次运行只调一两次，背后还有 150ms 节流的进度条。**结论：不动。** 这一条记下来是为了下次有人再想起 `fs_grep` 时，不必重新论证一遍。

（知识库那一半没进这次测量：它走 `readEntityFile` 而不是裸路径，mock 成本高。形状完全相同——`readEntityFile` 就是 `readFile` 拼一次路径——所以它加的是同一种、约 150 次的读。）

## 二、分页读：二次增长，但今天的尺寸下便宜

每一页都重读整个文件，而页数是文件大小除以页预算，所以**送达一个文件所搬的字节数是它大小的平方**：

| 文件 | 调用 | 搬运 | 放大 | 纯 JS |
|---|---|---|---|---|
| 200KB | 53 | 10.35MB | 52× | 85ms |
| 500KB | 132 | 64.5MB | 132× | 586ms |
| 1MB | 262 | 256MB | 262× | 2313ms |

2.5 倍的文件大小换来 25 倍的字节。今天这个 app 产出的 `.html` 在 60–200KB 量级，85ms 摊在 53 个模型轮里是看不见的——**所以今天也不动**。

值得记下来的是**拐点**：到 500KB 已经是 0.6 秒纯 JS，到 1MB 是 2.3 秒外加 256MB，而这还没算 bridge。判据因此不是「今天多快」，而是**文件大小**：

> 工作区里出现 **≥ 500KB 的单个文本文件**时，回来看这一页。

## 三、真要修的时候，修法不是 Rust

`fs_read_head` 那条路走不通，理由计划 §8 已经写了：`pageLines` 要全文的总行数才能写 "of N lines"，三个索引函数（`headingIndex` / `paragraphIndex` / `landmarkIndex`）要全文才能建地图。把这些搬进 Rust 就是把呈现逻辑搬进第二种语言，还离开了钉住它们的那些测试。

便宜得多的是**一个短寿命的读合并器**：`lib/fs/fileio.ts` 里 `readFile` 前面挂一个 `Map<path, {at, promise}>`，TTL 约 2 秒，在同模块的 `writeFile` / `appendFile` / `renamePath` / `removeFile` 上失效。上表「40 pages in one round」那一行——**7.81MB 塌成一次 200KB 的读**——就是它的全部收益，而同一轮里那 40 次调用本来就发生在几毫秒之内。零 Rust、零 schema、不动协议。

没有现在就做，是因为 65ms 不值得一个新的缓存不变量。拐点到了再做。

## 四、押错的那一条

计划 §8 里我写了一句「我的先验值得说出来，好让测量推翻它：搜索是**会**撑得起这次改动的那一半，而读的那一半不会」。**两半都反了**：搜索是完全不用管的那一半（17ms），而读的那一半虽然今天同样不用管，却是唯一有二次增长、将来真会撞墙的那一个。记在这里，因为下一次的直觉不会比这次准。
