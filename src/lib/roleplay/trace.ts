/**
 * 「这一轮，模型眼前有哪些条目，为什么？」——取材事实的**数据**一侧。
 *
 * ## 为什么需要这个模块
 *
 * 命中事实其实一直在被算出来：`selectLore` 每次调用都产出完整的
 * `LoreActivationReport`（哪一层进去了、特征被哪几个 key 激活、哪些命中了却没
 * 进去以及为什么），而 `buildBoundContent` 知道绑定块里到底装了什么。问题是
 * **它们在半路被丢掉**：播种分支只把 `contributingEntities(...).length` 塞进一
 * 条日志事件，续跑分支的报告在 `prepareContinuedHistory` 内部就没了。作者于是
 * 反复问同一个问题——「我改的那段设定它到底读到没有」——而应用其实知道答案。
 *
 * ## 两个时间点，一个模块
 *
 * - {@link TurnContextTrace}：**这一轮带了什么**（事后，实测）。
 * - {@link PreflightEstimate}：**下一次发送会带什么**（事前，预估）。
 *
 * 放在一起不是为了省文件，是因为它们说的是同一件事的两头，而作者是同一个人在
 * 问同一个问题。首轮之前 `session.history` 是 `null`，实测拿不到任何东西——上下文
 * 构成条那时只画得出工具 schema，而首次请求真正会带上的 system 层、绑定块、
 * 记忆块一样都还没装配。预估补的正是这一段。
 *
 * ## 三条落在类型里的判断
 *
 * 1. **常驻与本轮分开**（`resident` vs `lore`）。`coreDone` 机制会让主角条目和
 *    绑定条目在报告里显示成「匹配了、贡献 0 字」。合成一栏，作者会看到
 *    「沈砚 · 0 tk」并以为角色的人设根本没进上下文——而它永久驻在 system 层。
 *    `LoreEntityReport.coreResident` 这个字段就是为这件事存在的。
 * 2. **记忆区自成一段**（`area`，绝不并进 `lore`）。【知识库】是世界的事实，
 *    【记忆】是这个角色**以为**的事，两者可以互相矛盾（06 §4.2）。上下文里分块
 *    的理由在界面上一模一样：合成一栏，作者会把角色的猜测读成公认设定。
 * 3. **只记住「真的装了正文」的**（`unexpanded`）。超预算而只写了一行标题的
 *    绑定项，正文并不在上下文里——把它显示成常驻，作者就再也不会去查为什么
 *    角色不知道那件事。
 *
 * 纯数据 + 纯装配，不碰盘、不碰 store，也**不 import `./context`**：方向是
 * `context.ts → trace.ts`，反过来会绕成一个循环。
 */

import type { LoreActivationReport } from "../context/loreSelect";
import type { LoreEntity, LoreIndex } from "../lore/model";

/** 常驻层的一项：一段永久待在上下文里的正文。 */
export interface ResidentPiece {
  /**
   * 它住在哪一层。
   *
   * `primary` 在 system 消息的「## 你是谁」里，另外两种在绑定块里——分开不是
   * 分类癖：「刷新设定」清的是绑定块那一版的账，system 里的那份不跟着失效
   * （见 `context.ts` 的 `recordPrimaryCore`）。
   */
  kind: "primary" | "bound-core" | "bound-facet";
  name: string;
  dirPath: string;
  /** `bound-facet` 的段标题；其余为 null。 */
  facetTitle: string | null;
  /** 这一段在上下文里实际占了多少字符。`unexpanded` 时只是那行标题的长度。 */
  chars: number;
  /**
   * 超出绑定块预算，块里只有一行标题，**正文不在上下文里**。
   *
   * 这种项同时也不进注入账本，所以自动检索会把它补上——界面必须能说出这个
   * 区别，否则作者看到的是一条「常驻」而角色对它一无所知。
   */
  unexpanded: boolean;
}

/** 一轮的取材事实。按轮号存在会话里，和执行日志同构。 */
export interface TurnContextTrace {
  /** 永久层：主角条目 + 绑定的条目/特征。每轮都一样，直到作者刷新绑定。 */
  resident: ResidentPiece[];
  /** 失效的绑定（条目或特征已被删除）。 */
  stalePaths: string[];
  /** 本轮知识库自动检索。null = 这条路没跑（重试轮）。 */
  lore: LoreActivationReport | null;
  /** 本轮记忆区检索。**永不与 `lore` 合并**，见模块注释第 2 条。 */
  area: LoreActivationReport | null;
  /** 作者 `@` 引用、正文被内联进问句的条目。已常驻的不在这里（send 会滤掉）。 */
  refs: { name: string; dirPath: string }[];
  /**
   * 这一轮估算预算时用的字符/token 比。
   *
   * 存下来而不是显示时现算：取材条上每个 tk 数都该用**当时那一轮**规划预算所用
   * 的同一个比值。事后按别的文本重算一遍，条上的「6.4k / 6.4k 已满」就会和真正
   * 把那一条挡在外面的那次判断对不上——而那正是作者点「提高预算」的依据。
   */
  charsPerToken: number;
}

/**
 * 首次发送之前的预估。
 *
 * **不猜检索**：那取决于作者还没打出来的那句话。少一段已知的未知，好过多一段
 * 编出来的确定。
 */
export interface PreflightEstimate {
  /** system 层（扮演指令 + 主角正文 + 人设卡 + 身份行）的字符数。 */
  systemChars: number;
  /** 绑定块正文的字符数。 */
  boundChars: number;
  /** 记忆注入块正文的字符数。 */
  memoryChars: number;
  resident: ResidentPiece[];
  stalePaths: string[];
}

export function emptyTrace(charsPerToken = 1): TurnContextTrace {
  return { resident: [], stalePaths: [], lore: null, area: null, refs: [], charsPerToken };
}

/** `dirPath → 条目` 的一张表。索引是按分类分桶的，这里要的是按目录找。 */
export function indexByDir(loreIndex: LoreIndex): Map<string, LoreEntity> {
  const byDir = new Map<string, LoreEntity>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) byDir.set(e.dirPath, e);
  }
  return byDir;
}

/**
 * 主角条目那一项——它的正文住在 system 层，不在绑定块里，所以
 * `buildBoundContent` 看不见它。
 *
 * `primaryText` 为空就没有这一项：条目读不出来时 system 层里根本没有它，报一个
 * 不存在的常驻项，等于把「这个角色没有人设」这件事藏起来。
 */
export function primaryPiece(
  loreIndex: LoreIndex,
  primaryDirPath: string | null,
  primaryText: string,
): ResidentPiece | null {
  if (!primaryDirPath || !primaryText.trim()) return null;
  const entity = indexByDir(loreIndex).get(primaryDirPath);
  if (!entity) return null;
  return {
    kind: "primary",
    name: entity.name,
    dirPath: entity.dirPath,
    facetTitle: null,
    chars: primaryText.trim().length,
    unexpanded: false,
  };
}

/**
 * 稿面那道「想起了…」痕迹要的几个名字，从记忆区的检索报告里取。
 *
 * 取 `report.entities` 而不是 `contributingEntities(...)`：这条痕迹说的是
 * 「角色想起了这几件事」，而记忆区的检索不传 `coreDone`，被选中就等于被送进去
 * 了。用贡献过滤会在这里悄悄少报，且和它替换掉的那份行为不一致。
 */
export function recalledNames(
  report: LoreActivationReport | null,
): { name: string; dirPath: string }[] {
  return (report?.entities ?? []).map((e) => ({ name: e.name, dirPath: e.dirPath }));
}

/** 条目名（`@` 痕迹用）。索引里找不到就退回目录名，不吞掉这一项。 */
export function namedRefs(
  loreIndex: LoreIndex,
  dirPaths: readonly string[] | undefined,
): { name: string; dirPath: string }[] {
  if (!dirPaths?.length) return [];
  const byDir = indexByDir(loreIndex);
  return dirPaths.map((dirPath) => ({
    dirPath,
    name: byDir.get(dirPath)?.name ?? dirPath,
  }));
}

/**
 * 常驻层的完整清单：system 层那一份排在绑定块之前。
 *
 * 顺序即上下文里的顺序，而不是按字数排——作者读这张清单是在核对「模型眼前
 * 有什么」，那就该按模型看到的先后来读。
 */
export function residentPieces(
  primary: ResidentPiece | null,
  bound: readonly ResidentPiece[],
): ResidentPiece[] {
  return primary ? [primary, ...bound] : [...bound];
}
