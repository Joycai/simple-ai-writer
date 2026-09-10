# 「文件」面板 · 图片文件夹标记 —— 设计

> 状态：`shipped`。§10 的两点作者已确认，一片 PR 落地；实现与本文一致，无出入，
> 落点见 §7 那张表。代码实况截止 2026-09-08。
>
> 起因：作者问「为什么有些目录右边写着『插图』、文件夹图标还变成了图片」——答案是
> `assets/<文档名>/`（§2）。随后提出：像 `image` / `images` / `img` / `photo` 这类名字的
> 目录，也应该看出来是图片。本文回答**怎么认**、**认出来之后长什么样**、以及
> **为什么不能顺手复用现成的那一种**。

## 1. 现状（代码实况）

| 面 | 落点 |
|---|---|
| 六种行 | [`rowMeta.ts:16`](../../src/lib/fs/rowMeta.ts:16) `RowKind = folder \| assets \| doc \| deliverable \| image \| original` |
| 种类判定 | [`rowMeta.ts:47`](../../src/lib/fs/rowMeta.ts:47) `rowKind(name, isDir, parentName)` —— 目录只看**父级叫不叫 `assets`**，不看自己叫什么 |
| 两级灰 | [`rowMeta.ts:60`](../../src/lib/fs/rowMeta.ts:60) `isSecondary`：`original` / `image` / `assets` 退一档 |
| 右列文字 | [`rowMeta.ts:73`](../../src/lib/fs/rowMeta.ts:73) `extLabel` —— 目录一律 `null`，让位给篇数或固定词 |
| 失配判定 | [`rowMeta.ts:118`](../../src/lib/fs/rowMeta.ts:118) `orphanedAssetGroups`：`assets/<组>` 旁边没有同名文档 = 图片链接已断 |
| 修复候选 | [`rowMeta.ts:148`](../../src/lib/fs/rowMeta.ts:148) `relinkCandidates` |
| 图标 | [`FileTree.tsx:196`](../../src/components/layout/FileTree.tsx:196) `assets` → `Images`，失配 → `Link2` |
| 右列渲染 | [`FileTree.tsx:451`](../../src/components/layout/FileTree.tsx:451) `assets` → `fileTree.assetsLabel` |
| 一次走查 | [`FileTree.tsx:691`](../../src/components/layout/FileTree.tsx:691) `docCounts`、[:706](../../src/components/layout/FileTree.tsx:706) `orphanAssets` —— 整棵树各走一遍，不是每行查一次 |
| 右键「重新关联到…」 | [`FileTree.tsx:1563`](../../src/components/layout/FileTree.tsx:1563) |
| 目录常量 | [`image/assets.ts:21`](../../src/lib/image/assets.ts:21) `ASSETS_DIR = "assets"` |
| 文案 | [`zh-CN.json:3264`](../../src/i18n/locales/zh-CN.json:3264) `插图` / [`en.json:3271`](../../src/i18n/locales/en.json:3271) `Images` |
| 视觉规范 | [`design-system.md:262`](../reference/design-system.md:262) 设计稿 01b「右列一列两义」那一段 |

树是**一次性整棵读完**的（[`commands.rs:399`](../../src-tauri/src/commands.rs:399)，深度上限 12，跳过点开头），
所以渲染时每个目录的子树都已经在内存里 —— 按内容判定不需要读磁盘，也不需要多一次 IPC。

## 2. 「插图」这个标记现在是什么意思

一个目录被判成 `assets` 组，**只因为它的父目录叫 `assets`**，与它自己叫什么无关。
这不只是外观，它背后挂着三件有后果的事：

1. 组名必须等于旁边某份 `.md` 的名字，否则判为失配，图标换成断链、右列换成警告三角；
2. 右键给出「重新关联到…」，点下去会**给目录改名，并改写那份文档正文里的图片链接**；
3. 文档改名 / 复制 / 删除时，这个目录跟着改名 / 复制 / 清理（`lib/image/assets.ts`）。

## 3. 为什么不能直接复用 `assets` 种类

作者自己建的 `images/` 旁边不会有一份叫 `images.md` 的文档。若把它判成 `assets` 组：

- 它会**立刻显示成失配**（断链图标 + 「图片链接可能已断」），而根本没有链接坏掉；
- 右键会给出「重新关联到…」，一旦点下去，目录被改名，**另一份无关文档的正文被改写**。

这是误伤，不是优化。所以新增**第七种** `pictures`：**只管外观，不带任何行为**。

## 4. 判据：内容优先，名字兜底

### 4.1 规则

一个目录是 `pictures`，当且仅当它不是 `assets` 目录本身、也不是 `assets/<组>`，并且：

- **情况 A —— 子树里有文件**：子树里至少有一张图片，且**每一个**文件都是图片；
- **情况 B —— 子树里一个文件都没有**（空目录，或只套着空目录）：名字命中 §4.2 的名单。

### 4.2 名单（仅情况 B 生效，大小写不敏感）

```
image  images  img  imgs  pic  pics  picture  pictures
photo  photos  screenshot  screenshots  gallery  media
图片  图  配图  插图  插画  截图  图集  素材
```

### 4.3 为什么内容优先

- **名单永远不全。** 作者可能叫它 `截图`、`素材`、`第三章配图`、`pics_v2`；穷举是输的一方。
- **名字会撞车。** 一个叫 `images` 的目录里放的是章节，按名字判就标错了，而错标比漏标更糟——
  作者会以为那里面没有正文。
- **和这个文件现有的精神一致。** `assets` 由**位置**决定而不由名字决定，正是为了不猜。
  内容判定是同一种做法的延伸：看事实，不看叫什么。

### 4.4 这条推翻了一句旧注释（需要作者点头）

[`rowMeta.ts:43`](../../src/lib/fs/rowMeta.ts:43) 写着「作者尽可以有一个叫插图的普通分组」。
按 §4.1，一个**空的**、叫「插图」的目录会被标成图片目录。推翻的范围仅限外观，且只在
目录里一个文件都没有时发生——里面一旦有章节，它立刻变回普通分组。

### 4.5 一处让步：混进一个 pdf 就不标了

取「全是图片」而不是「主要是图片」，因为后者要**数数**，而 `rowMeta` 的文件头写明
「不读文件、不测量」。代价是：截图目录里躺着一份 `合同.pdf`，整个目录退回普通分组。
可以接受——**宁可漏标，不可错标**。

## 5. 长什么样

| 面 | `assets`（现有） | `pictures`（新） |
|---|---|---|
| 图标 | `Images`（描边） | `Images`（描边，同一枚） |
| 灰度 | 退一档 | 退一档 |
| 右列 | 「插图」/ `Images` | 「图片」/ `Pictures` |
| 失配态 | 断链图标 + 警告三角 | **无** |

**两者共用一枚图标**：它们说的是同一件事——「这里面是图片」。区别落在右列那个词上，
而那个区别是有后果的：**插图＝绑定着某份文档，有修复动作；图片＝就是个目录**。

**不显示图片张数。** 右列现在一列两义（分组＝篇数、文档＝后缀），`assets` 属于
「这一列被一个固定词占掉」的第三种情况，`pictures` 与它并列，不新增含义；改成数张数才是
真的加第三义。顺带：按 §4.1，`pictures` 目录里不会有 `.md`，`docCount` 恒为 0，两者不打架。

## 6. 明确不做的事

- **不进失配检查**，不进右键「重新关联到…」。
- **`lib/image/assets.ts` 一行不动**：改名 / 复制 / 删除都不跟随，作者的目录归作者管。
- **`context/outline.ts` 不动**：`pictures` 目录里没有 `.md`，本来就不进卷分组。
- **`LibraryView.tsx` 不动。**
- **`CommandPalette.tsx` 不动**：它只对文件调 `rowKind(name, false, null)`（[:442](../../src/components/command/CommandPalette.tsx:442)），
  拿不到目录种类；`KindIcon`（[:114](../../src/components/command/CommandPalette.tsx:114)）有 `default` 分支，加一种不会漏。

## 7. 落点

| 文件 | 改动 |
|---|---|
| `src/lib/fs/rowMeta.ts` | `RowKind` 加 `pictures`；`isSecondary` 加一项；`extLabel` 对 `pictures` 返回 `null`；新增 `pictureFolders(nodes)` 与 `resolveRowKind(node, parentName, pictureDirs)`；更新文件头与 §4.4 那句注释 |
| `src/components/layout/FileTree.tsx` | `useMemo` 加一次 `pictureFolders(fileTree)`；`TreeCtx` 加一个 `ReadonlySet<string>`；[:411](../../src/components/layout/FileTree.tsx:411) 改调 `resolveRowKind`；`RowIcon` 加一个 case；`rightCol` 加一个分支 |
| `src/i18n/locales/{zh-CN,en}.json` | 新增 `fileTree.picturesLabel` = 「图片」/ `Pictures` |
| `docs/reference/design-system.md` | §01b 右列那段补一句 `pictures` |
| `docs/reference/codemap.md` | `lib/fs` 一节补一句判据 |
| `src/lib/__tests__/rowMeta.test.ts` | §8 |

### 7.1 种类从哪里来

`rowKind(name, isDir, parentName)` 看不见子树，所以 `pictures` **不能长在它里面**。
照 `orphanAssets` 的样子做成一次树遍历的 `Set<path>`，再在 `rowMeta` 里给一个
`resolveRowKind(node, parentName, pictureDirs)` 把两半合起来——组件只调这一个，
判据不散进 `FileTree.tsx`。`rowKind` 本身签名不动，它另外两个调用点（判 `deliverable`）不受影响。

### 7.2 一次走查，不是每行查一次

`pictureFolders(nodes)` 自底向上走一遍：每个目录回报 `{ hasFile, hasImage, allImages }`，
父级由子级的回报合并，**不重复走子树**。和 `docCounts` / `orphanedAssetGroups` 同一处
`useMemo`、同一条依赖 `[fileTree]`。整体仍是 O(节点数)。

## 8. 测试（`rowMeta.test.ts` 追加一个 `describe`）

- 内容说了算：`images/` 里放章节 → `folder`；`素材/` 里全是图 → `pictures`
- 名字只在**空目录**上说话：空的 `img/` → `pictures`；空的 `第三卷/` → `folder`
- 混进一份 pdf → 退回 `folder`（§4.5 的让步，明写成断言免得下次被「顺手放宽」）
- 嵌套：目录下只有子目录、子目录里全是图 → 父级也是 `pictures`
- `assets/<组>` **不被抢走**：即便里面全是图，仍然是 `assets`（否则失配提示会消失）
- `assets` 目录本身仍是 `folder`

## 9. 分片

一个 PR 够了：判据 + 渲染 + 文案 + 测试 + 两处文档，互相之间没有可独立验证的中间态。

## 10. 作者确认的两点（已确认，2026-09-08）

1. **§4.4**：一个空的、叫「插图」的目录会被标成图片目录，这推翻了原先「不按名字猜」的一句注释。
2. **§5**：右列用「图片」与现有的「插图」并列，两者共用同一枚图标。
