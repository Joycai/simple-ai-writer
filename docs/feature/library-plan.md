# 文库（Library）——「大纲」模块完成计划

> 状态：三期全部实施完毕（本文档随实现推进更新）。
> 背景：原「大纲 · 全图」是设计稿阶段的半成品，本计划把它定型为「文库」并补齐作者真正要的能力。

## 1. 现状与问题

「大纲」这个词此前挂着两个互不相干的功能：

| 旧名 | 实体 | 实际内容 |
|---|---|---|
| 大纲（侧栏 tab） | `components/editor/OutlinePanel.tsx` | 当前文档的 markdown 标题层级，点击跳转 |
| 大纲 · 全图（主视图） | `components/outline/OutlineFullView.tsx` | 卷/章排序（book spine）、逐章前情提要、批量移动 |

问题：

- 同名不同物，作者难以建立心智模型；全图的头部标题还错用了 `sidebar.outline`（显示成「大纲」）。
- 全图里有一批**没接线的设计稿残留**：视图切换三连 tab（章卡/时间线/看板）、「AI 建议下一章」按钮、空卷卡的 `cursor: pointer`、约 11 个从未引用的 CSS 类。
- 全图只认章节文件（md/markdown/txt），工作区里的图片、PDF 等资源完全不可见。

## 2. 定位与命名（已定）

- **「大纲」（侧栏 tab）保持原样**：就是当前文档的标题层级，最简单的逻辑，不做扩展。
- **「大纲 · 全图」更名为「文库」（en: Library）**：定位从"章节排序器"扩展为**工作区资源的组织视图**——每个文件夹是一个"集合"（沿用既有 pack 术语 `terms.group`：小说语境即"卷"），把文字、图片等资源组织到一起，像现实中的文件夹一样；再由 AI 为每个集合产出摘要与 lore 引用（第二期）。
- 备选名（弃用理由）：「书架」过于小说专属，与多领域 pack 定位冲突；「合集/集合」指单个分组而非整个视图；「文库」与「知识库」都带"库"字但一个装文稿一个装设定，语义正交。
- 内部命名同步：`MainView` id `outline-full` → `library`（该字段不持久化，改名无迁移成本）、组件 `components/library/LibraryView.tsx`、i18n 命名空间 `outline.*` → `library.*`、navStore location kind `outline` → `library`。
- **book spine 的数据层（`lib/context/outline.ts`、`.ai-writer/outline.json`）不改名**：它是"章节顺序"这个领域概念的家，续写记忆（bookContext）靠它工作，文件格式也已落在用户项目里。

## 3. 分期

### 第一期（本 PR）：改名 + 清理 + 资源展示

1. **改名**：上表全部内部命名 + `sidebar.outlineFull` → `sidebar.library`（文库/Library），IconRail 图标 `GitBranch` → `Library`，视图头部标题改用正确的 key。
2. **清理死 UI**：删除视图切换三连 tab、「AI 建议下一章」按钮及其 i18n key；删除从未引用的 CSS 类（`.aiCard*`、`.chapterDesc`、`.chapterWords`、`.chapterNum*`、`.chapterDraft`、`.chapterPlanned`、`.colCountPending` 等）。时间线/看板若未来要做，按需求重新设计，不留死按钮。
3. **资源展示**：`Volume` 新增 `resources`（该文件夹直属的非章节文件）。每列在章节卡下方渲染紧凑的资源区：图片带缩略图（`imageToDataUrl`，与 ImagePreview 同路），其他文件用图标 + 文件名；单击在编辑区打开（与 FileTree 行为一致）。仅有资源、没有章节的文件夹（含根目录）也成列。`assets/` 仍整体跳过——它是文档的插图目录，归属各文档自己的预览。
4. **测试**：`outline.test.ts` 补 `groupVolumes` 的资源分组用例。

### 第二期（已实施）：集合摘要 + lore 引用

1. **lore 引用（本地扫描，无 AI 成本）**：`lib/lore/match.ts` 的 `matchEntitiesInText`（与 `loreSelect` 自动匹配同语义：大小写不敏感的名称/别名子串），对集合内全部章节正文聚合成 lore chips；点击经 `loreStore.openDetail` 跳转条目。视图打开时按需计算，不持久化——始终新鲜。
2. **AI 集合摘要**：`lib/context/collectionDigest.ts`。
   - 持久化：`.ai-writer/collections/<集合 relPath>/digest.md`（根集合直接落在 `collections/digest.md`；目录式路径天然不与相邻集合冲突），头部 `<!-- ai-writer-digest {json} -->` 元数据（章节 relPath+hash 有序列表 + updatedAt），正文为可编辑的摘要文本——与 `memory.ts` 同一格式哲学。
   - 生成（`stores/digestStore.ts`，单飞行）：逐章取正文（打开中的文件用编辑器实时内容，摘要与 hash 都基于作者所见），前情提要全段新鲜时用其摘要代替正文，超预算时按均分份额截断（下限 400 字符）；单次 `streamCompletion`，走摘要模型（`memoryModelId ?? activeModelId`），用量记入 `token_usage`（task `digest`，用量页有对应文案）。
   - 新鲜度：章节增删、**重排**（摘要叙述的是有序的弧线）或任一章 hash 失配 → 「需更新」；集合卡上生成/更新/取消，复用 MemoBadge 的交互语言。
3. **UI**：集合列头下方的摘要卡（正文默认 5 行截断，点击展开）+ 「引用条目」chips 行。

### 第三期（已实施）：管理操作补全

1. **新建章节**：空集合的占位卡即创建入口（`projectStore.createEntry`，拒绝覆盖同名文件），建完直接在编辑器打开。
2. **章节重命名/删除**（右键菜单）：重命名裸名保留原扩展名（.txt 不会悄悄变 .md），并把 spine 位置、在写状态、前情提要一起迁到新 relPath；删除走 `deleteEntry({backup: true})`（与文件树相同，先快照进 `.ai-writer/backups/`），并清掉 status 残留。
3. **卷排序与重命名**：`BookSpine.volumes`（可选字段，overlay 语义，旧文件缺省即遍历序）持久化列顺序，列头 ◀▶ 调整；重命名走 `moveEntry` 文件夹后，`.ai-writer/memory/` 与 `.ai-writer/collections/` 的镜像子树随之搬迁，spine 用 `renameVolumeInSpine` 做**路径段感知**的前缀改写（嵌套子卷键一并处理）。根集合不可重命名/删除。
4. **跨卷拖拽**：拖到任意章节卡即插入该位置（同卷=排序，跨卷=文件移动 + 记忆 + spine 位置 + 在写状态），拖到列空白处追加到末尾；拖拽状态在 dragstart 捕获（路径/relPath），不依赖拖动中可能刷新的 volumes 索引。
5. 顺带把多选移动从裸 `renamePath` 换成 `moveEntry` —— 从此批量移动也会带走文档的 `assets/` 插图并正确处理打开中的文件。

## 4. 不变式

- spine 仍是 overlay：文件系统是存在性唯一真相，`outline.json` 只记顺序。
- 资源是**展示层概念**：不进 spine、不进 bookContext、不影响续写上下文。
- 术语走 `useTerms()`/pack 机制，组件内不硬编码「卷/章」。
