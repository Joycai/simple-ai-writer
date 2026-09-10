/**
 * 本轮取材条（设计稿 04c · TURN 2）。
 *
 * 回答一个问题：**这一轮，模型眼前有哪些条目和特征，为什么。**
 *
 * ## 同一根线，出血还是止笔
 *
 * 四种来源不靠四种颜色分开，靠**同一根线的不同终止方式**：
 *
 * - **常驻**：1px 单线，**上下出血**——线不在段内起笔也不在段内收笔，它从上一轮
 *   穿进来、往下一轮穿出去。这就是「一直都在」的字面画法，也是「本轮 +0」为什么
 *   不是失败的视觉解释。
 * - **知识库**：同粗同色，**两端有止笔**——闭合区间，这些是这一轮才来的。
 * - **记忆区**：断成点线 + 斜体 + 下沉一格底色。线断开＝不是实证，斜体＝这是他的
 *   口径（和稿面上的旁白同一个字形）。
 * - **引用**：作者轮那道 2px 赭石线。四段里唯一带强调色的装订，因为它唯一由作者负责。
 *
 * **3px 双线一次都不用**——本仓的规则是「分类用颜色，集合用装订」，而 3px 双线
 * 已经归集合所有。取材条这四段是上下文的四个块，不是分类也不是集合，所以它们只
 * 借「同一根线的不同终止方式」。颜色继续只承担两件事：赭石＝你能点的与你负责的，
 * 褪色＝没进去。
 *
 * ## 五句不能互相代替的话
 *
 * | | 意思 |
 * |---|---|
 * | 本轮 +0 | 常驻，一直在，这一轮没再装一遍 |
 * | 0 字 | 命中了，但正文已在常驻段里，去重后不重复装（`coreResident`） |
 * | 本轮 0 | 跑过了，一条都没命中 |
 * | 本轮未检索 | 这条路没跑（`null`，重试轮） |
 * | 无记录 | 重启前的轮次，无从查证 |
 *
 * 最后一句是整个组件里**唯一不可交互**的形态，所以它在版式上就要看起来点不动：
 * 没有三角、没有任何数字、起笔是破折号、上方一道虚线——页被撕掉的样子。
 * 而「本轮 0」和「本轮未检索」的区别落在段头：前者是通栏细线 + 数字，后者是**虚线**
 * + 「未检索」——同一段的两种不同缺席，版式上必须一眼分开。
 *
 * ## 单位
 *
 * 取材条**一律读「字」**（数据层给的就是 chars），只有上下文构成条读 tk。同一个
 * 面板里两种单位靠位置分：条上是 tk，条下的账目是字。**chars → tk 的换算只在构成
 * 条发生一次，取材条不做二次估算**——两处各说各的真实数据，比对齐成一个假数好。
 *
 * 取数与聚合在 `lib/roleplay/traceView`（纯函数，逐条钉在测试里）。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  budgetPressed, dropRows, foldHits, hitRows, keywordLine,
  residentRows, summarize, type DropRow, type FacetRow, type HitRow, type LayerChip,
  type ResidentRow,
} from "../../lib/roleplay/traceView";
import type { LoreActivationReport } from "../../lib/context/loreSelect";
import type { TurnContextTrace } from "../../lib/roleplay/trace";
import styles from "./TurnTrace.module.css";

/** 「2,480」——千位分隔，单位「字」由调用处决定加不加（窄档先掉单位）。 */
const num = (n: number) => n.toLocaleString();

// ─── 收起行 ──────────────────────────────────────────────────────────────────

export function TraceToggle({ trace, open, onToggle }: {
  /** `undefined` = 本次运行之前的轮次，没有记录。 */
  trace: TurnContextTrace | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  // 无记录：唯一不可交互的形态。不是 button，没有三角，没有任何数字——包括没有 0。
  if (!trace) {
    return (
      <div className={styles.noRecord}>
        {t("roleplay.trace.noRecord", { defaultValue: "— 取材 · 本次运行前无记录" })}
      </div>
    );
  }

  const s = summarize(trace);
  // 两条检索都没跑过 = 重试轮。它和「跑过了、0 条」是两句话。
  const notRun = trace.lore === null && trace.area === null;

  return (
    <button type="button" className={styles.toggle} onClick={onToggle} aria-expanded={open}>
      <ChevronRight
        size={8}
        strokeWidth={2.6}
        className={styles.caret}
        style={{ transform: open ? "rotate(90deg)" : undefined }}
      />
      <span>
        {t("roleplay.trace.lineResident", {
          n: s.residentCount, defaultValue: `取材 常驻 ${s.residentCount}`,
        })}
        {notRun ? (
          <span className={styles.midSeg}>
            {` · ${t("roleplay.trace.notRun", { defaultValue: "本轮未检索" })}`}
          </span>
        ) : s.turnCount === 0 ? (
          // 字数段整段省掉：0 条的 0 字是一句废话。
          <span className={styles.midSeg}>
            {` · ${t("roleplay.trace.turnZero", { defaultValue: "本轮 0" })}`}
          </span>
        ) : (
          <>
            {` · ${t("roleplay.trace.lineTurn", { n: s.turnCount, defaultValue: `本轮 ${s.turnCount}` })}`}
            <span className={styles.tkSeg}>
              {` · ${num(s.turnChars)}`}<span className={styles.tkUnit}> 字</span>
            </span>
          </>
        )}
        {s.droppedCount > 0 && (
          <span className={styles.dimSeg}>
            {` · ${t("roleplay.trace.droppedBrief", {
              n: s.droppedCount, defaultValue: `${s.droppedCount} 没进去`,
            })}`}
          </span>
        )}
        {/* 警示只染这半句，不染整行——失效是一条的事，不是整轮的事。 */}
        {s.staleCount > 0 && (
          <span className={styles.warnSeg}>
            {` · ${t("roleplay.trace.staleBrief", {
              n: s.staleCount, defaultValue: `${s.staleCount} 条绑定失效`,
            })}`}
          </span>
        )}
        {/* 作者最容易误判的一种：清单里明明有它，角色却对它一无所知。必须报到这一行。 */}
        {s.unexpandedCount > 0 && (
          <span className={styles.warnSeg}>
            {` · ${t("roleplay.trace.unexpandedBrief", {
              n: s.unexpandedCount, defaultValue: `${s.unexpandedCount} 条只进了标题`,
            })}`}
          </span>
        )}
      </span>
    </button>
  );
}

// ─── 段头 ────────────────────────────────────────────────────────────────────

/**
 * `notRun` 时通栏细线换成**虚线**、右端读「未检索」而不是数字。
 *
 * 「没跑过」和「跑了、0 条」在版式上必须一眼分开——它们是同一段的两种不同缺席，
 * 而一个 0 会把前者说成后者。
 */
function SectionHead({ label, right, notRun }: {
  label: string; right?: string; notRun?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.head}>
      <span className={styles.headLabel}>{label}</span>
      <span className={`${styles.headRule} ${notRun ? styles.headRuleDashed : ""}`} />
      {notRun ? (
        <span className={styles.headRight}>
          {t("roleplay.trace.notRun", { defaultValue: "本轮未检索" })}
        </span>
      ) : right ? (
        <span className={styles.headRight}>{right}</span>
      ) : null}
    </div>
  );
}

/** 段头右端的「已用 / 预算 字」。知识库和记忆区各读各的预算，两段互不相干。 */
function budgetRight(report: LoreActivationReport | null): string | undefined {
  if (!report) return undefined;
  return `${num(report.usedChars)} / ${num(report.budgetChars)} 字`;
}

// ─── 关键字那一行 ────────────────────────────────────────────────────────────

/**
 * 「由「铁鳞」「甲片」+2 命中」。
 *
 * 它是一行正文，不是 `title` 悬停——关键字是作者调特征的唯一反馈回路，藏进悬停
 * 等于没做：作者不会去悬停一个他不知道存在的东西。
 *
 * `lead` 分「由」和「另由」：条目那行已经写了「由「铁鳞」命中」，特征这行用
 * 「另由」，同一个词不读两遍。
 */
function Keywords({ keys, lead, tail }: {
  keys: readonly string[]; lead: "by" | "also"; tail?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const line = keywordLine(keys, expanded);
  if (!keys.length) return null;
  return (
    <div className={styles.keys}>
      {lead === "also"
        ? t("roleplay.trace.alsoBy", { defaultValue: "另由" })
        : t("roleplay.trace.by", { defaultValue: "由" })}
      {line.shown.map((k) => (
        <span key={k} className={styles.key}>{`「${k}」`}</span>
      ))}
      {line.rest > 0 && (
        // 行内展开，不是浮层——点开就地续写，行高只增一行。
        <button type="button" className={styles.keyMore} onClick={() => setExpanded(true)}>
          {`+${line.rest}`}
        </button>
      )}
      {t("roleplay.trace.hit", { defaultValue: "命中" })}
      {tail}
    </div>
  );
}

// ─── 层芯片 ──────────────────────────────────────────────────────────────────

function Chips({ chips, facetCount }: { chips: LayerChip[]; facetCount: number }) {
  const { t } = useTranslation();
  const label = (c: LayerChip) => {
    if (c.kind === "summary") {
      return `${t("roleplay.trace.layerSummary", { defaultValue: "摘要" })} ${num(c.chars)}`;
    }
    if (c.kind === "gallery") {
      return `${t("roleplay.trace.layerGallery", { defaultValue: "配图" })} ${c.count ?? 0} · ${num(c.chars)}`;
    }
    const core = `${t("roleplay.trace.layerCore", { defaultValue: "正文" })} ${num(c.chars)}`;
    return c.truncated
      ? `${core} · ${t("roleplay.trace.truncated", { defaultValue: "截断" })}`
      : core;
  };
  const cut = chips.find((c) => c.kind === "core" && c.truncated && c.sourceChars);
  return (
    <>
      <div className={styles.chipRow}>
        {chips.map((c, i) => (
          <span
            key={`${c.kind}-${i}`}
            className={`${styles.chip} ${c.kind === "core" && c.truncated ? styles.chipTruncated : ""}`}
          >
            {label(c)}
          </span>
        ))}
        {facetCount > 0 && (
          <span className={styles.chip}>
            {`${t("roleplay.trace.layerFacet", { defaultValue: "特征" })} ${facetCount}`}
          </span>
        )}
      </div>
      {/* 「截断」是个耸肩，「2,840 → 1,200 字」是个能动手的数。 */}
      {cut && (
        <div className={styles.note}>
          {t("roleplay.trace.truncNote", {
            from: num(cut.sourceChars!), to: num(cut.chars),
            defaultValue: `正文 ${num(cut.sourceChars!)} → ${num(cut.chars)} 字 · 预算截断`,
          })}
        </div>
      )}
    </>
  );
}

function FacetLine({ facet }: { facet: FacetRow }) {
  const { t } = useTranslation();
  return (
    <div className={styles.facet}>
      <div className={styles.rowTop}>
        <span className={styles.facetName}>{facet.title}</span>
        <span className={styles.chipSm}>
          {t("roleplay.trace.layerFacet", { defaultValue: "特征" })}
        </span>
        <span className={styles.spacer} />
        {/* 特征行不带单位（设计稿 04c 屏 2c）：段头是段合计、条目行是条合计、特征行
            只留数——三级靠右成一列，能比大小又不挡条目名。 */}
        <span className={styles.facetTk}>{num(facet.chars)}</span>
      </div>
      {facet.ridesAlong ? (
        // 这一行必须存在：留空会被读成「不知道为什么进来的」，而它恰恰是最确定的一类。
        <div className={styles.keysFlat}>
          {t("roleplay.trace.ridesAlong", { defaultValue: "随条目进入 · 不看关键字" })}
        </div>
      ) : (
        <Keywords keys={facet.matchedKeys} lead="also" />
      )}
    </div>
  );
}

function HitBlock({ row }: { row: HitRow }) {
  const { t } = useTranslation();

  // 0 字 ≠ 没读到。它的正文就在上面那段常驻里，去重后不重复装。
  if (row.coreResident && row.chars === 0) {
    return (
      <div className={styles.hit}>
        <div className={styles.rowTop}>
          <span className={styles.hitName}>{row.name}</span>
          <span className={styles.chipSm}>
            {t("roleplay.trace.seeResident", { defaultValue: "已在常驻 · 见上" })}
          </span>
          <span className={styles.spacer} />
          <span className={styles.hitTkZero}>
            0<span className={styles.tkUnit}> 字</span>
          </span>
        </div>
        <Keywords
          keys={row.matchedTerms}
          lead="by"
          tail={t("roleplay.trace.dedup", { defaultValue: " · 去重后不重复装" })}
        />
      </div>
    );
  }

  return (
    <div className={styles.hit}>
      <div className={styles.rowTop}>
        <span className={styles.hitName}>{row.name}</span>
        {row.aliases && (
          <span className={styles.alias}>
            {t("roleplay.trace.alias", { s: row.aliases, defaultValue: `别名 ${row.aliases}` })}
          </span>
        )}
        <span className={styles.spacer} />
        <span className={styles.hitTk}>
          {num(row.chars)}<span className={styles.tkUnit}> 字</span>
        </span>
      </div>
      {row.pinned ? (
        <div className={styles.keysFlat}>
          {t("roleplay.trace.pinnedIn", { defaultValue: "绑定进入 · 不看关键字" })}
        </div>
      ) : (
        <Keywords keys={row.matchedTerms} lead="by" />
      )}
      <Chips chips={row.chips} facetCount={row.facets.length} />
      {row.facets.length > 0 && (
        <div className={styles.facets}>
          {row.facets.map((f) => <FacetLine key={f.title} facet={f} />)}
        </div>
      )}
    </div>
  );
}

// ─── 常驻的一行 ──────────────────────────────────────────────────────────────

/** 三种 kind 用**位置**分——它住在哪，不是又一种色标。 */
function whereLabel(t: ReturnType<typeof useTranslation>["t"], kind: ResidentRow["kind"]): string {
  return kind === "primary"
    ? t("roleplay.trace.whereSystem", { defaultValue: "系统提示" })
    : kind === "bound-facet"
      ? t("roleplay.trace.whereBoundFacet", { defaultValue: "绑定块 · 特征" })
      : t("roleplay.trace.whereBound", { defaultValue: "绑定块" });
}

/** `lore/地理/雪原三月`——引用的落点，只留知识库之内的那一段。 */
function lorePathTail(dirPath: string): string {
  const i = dirPath.lastIndexOf("/lore/");
  return i >= 0 ? dirPath.slice(i + 1) : dirPath;
}

function ResidentLine({ row, onEditBindings }: { row: ResidentRow; onEditBindings?: () => void }) {
  const { t } = useTranslation();
  const where = whereLabel(t, row.kind);
  return (
    <div className={styles.residentRow}>
      <div className={styles.rowTop}>
        <span className={styles.residentName}>{row.label}</span>
        <span className={styles.chipSm}>{where}</span>
        {row.unexpanded && (
          <span className={`${styles.chipSm} ${styles.chipWarn}`}>
            {t("roleplay.trace.unexpanded", { defaultValue: "只进了标题" })}
          </span>
        )}
        <span className={styles.spacer} />
        <span className={styles.residentTk}>
          {num(row.chars)}<span className={styles.tkUnit}> 字</span>
        </span>
      </div>
      {/* 清单里有它、正文却不在上下文里——不说出来，作者永远查不到这件事。 */}
      {row.unexpanded && (
        <>
          <div className={styles.note}>
            {t("roleplay.trace.unexpandedNote", {
              defaultValue: "正文不在上下文里 · 超出绑定块预算",
            })}
          </div>
          {/* 稿上（设计稿 04c 屏 2b）还有一枚「提高绑定块预算」：绑定块的上限是常量
              BOUND_BLOCK_CHAR_CAP，没有一个设置可以开，所以只给能兑现的那一枚——
              改成只绑那一条特征，它落在编辑抽屉里。 */}
          {onEditBindings && (
            <div className={styles.actRow}>
              <button type="button" className={styles.actLink} onClick={onEditBindings}>
                {t("roleplay.trace.rebindFacet", { defaultValue: "改成绑定某条特征" })}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── 没进去 ──────────────────────────────────────────────────────────────────

/**
 * 一行落选。原因芯片之外，行尾写的是**去处**（设计稿 04c 屏 2f）：「没命中」列它
 * 现有的关键字（作者最常改的就是这一条）、「同组挤掉」写出是哪一组、谁赢了、
 * 「超预算」写差多少字、没装下的配图写清单里装下了几张。
 */
function DropLine({ row }: { row: DropRow }) {
  const { t } = useTranslation();
  const reasonText = {
    "no-key": t("roleplay.trace.dropNoKey", { defaultValue: "没命中" }),
    "group-lost": t("roleplay.trace.dropGroup", { defaultValue: "同组挤掉" }),
    budget: t("roleplay.trace.dropBudget", { defaultValue: "超预算" }),
    "manual-only": t("roleplay.trace.dropManual", { defaultValue: "只能手动" }),
    resident: "",
  }[row.reason];

  const label = row.kind === "images"
    ? t("roleplay.trace.dropImages", {
        name: row.label, n: row.imageCount ?? 0,
        defaultValue: `${row.label} · 配图 ${row.imageCount ?? 0} 张`,
      })
    : row.label;

  const detail =
    row.kind === "images"
      ? t("roleplay.trace.dropImagesDetail", {
          k: row.imagesKept ?? 0, defaultValue: `配图清单只装下 ${row.imagesKept ?? 0} 张`,
        })
      : row.reason === "group-lost" && row.winner
        ? row.group
          ? t("roleplay.trace.dropGroupDetailFull", {
              group: row.group, winner: row.winner,
              defaultValue: `互斥组 ${row.group} ·「${row.winner}」优先`,
            })
          : t("roleplay.trace.dropGroupDetail", {
              winner: row.winner, defaultValue: `「${row.winner}」优先`,
            })
        : row.reason === "budget" && row.neededChars
          ? t("roleplay.trace.dropBudgetDetail", {
              n: num(row.neededChars), defaultValue: `差 ${num(row.neededChars)} 字`,
            })
          : row.reason === "manual-only"
            ? t("roleplay.trace.dropManualDetail", { defaultValue: "不参与自动命中" })
            : row.reason === "no-key" && row.keys.length > 0
              ? t("roleplay.trace.dropNoKeyDetail", {
                  keys: row.keys.join("、"), defaultValue: `关键字：${row.keys.join("、")}`,
                })
              : "";

  return (
    <div className={styles.drop}>
      {/* 四种失败里只有原因芯片带边框，条目名反而降一档——落选组里「为什么」比「谁」重要。 */}
      <span className={`${styles.reasonChip} ${row.reason === "budget" ? styles.reasonWarn : ""}`}>
        {reasonText}
      </span>
      <span className={styles.dropName}>{label}</span>
      {detail && <span className={styles.dropDetail}>{detail}</span>}
    </div>
  );
}

/**
 * `resident` 那一种**没有芯片**。
 *
 * 它不是失败——画成芯片就成了第五种失败。改成一句带点线下划的话，颜色比上面四行
 * **亮**一档，并且单独排在组内一道细线之下。
 */
function ResidentDropLine({ row }: { row: DropRow }) {
  const { t } = useTranslation();
  return (
    <div className={styles.dropResident}>
      <span className={styles.dropResidentName}>{row.label}</span>
      <span className={styles.dropResidentNote}>
        {t("roleplay.trace.dropResidentDetail", { defaultValue: "已在绑定块 · 见上" })}
      </span>
    </div>
  );
}

// ─── 展开态 ──────────────────────────────────────────────────────────────────

export function TraceBody({ trace, onRaiseBudget, onOpenArea, onUnbind, onEditBindings }: {
  trace: TurnContextTrace;
  /** 「提高预算」——只在有 `budget` 落选时出现。 */
  onRaiseBudget?: () => void;
  onOpenArea?: () => void;
  /** 失效绑定那一行的「解除绑定」：摘掉这一条路径。 */
  onUnbind?: (path: string) => void;
  /** 「另选条目」/「改成绑定某条特征」：打开这个角色的编辑抽屉。 */
  onEditBindings?: () => void;
}) {
  const { t } = useTranslation();
  const resident = residentRows(trace);
  const lore = hitRows(trace.lore);
  const area = hitRows(trace.area);
  const drops = [...dropRows(trace.lore), ...dropRows(trace.area)];
  const fails = drops.filter((d) => d.reason !== "resident");
  const residents = drops.filter((d) => d.reason === "resident");
  const budgetCount = fails.filter((d) => d.reason === "budget").length;
  const otherCount = fails.length - budgetCount;
  const folded = foldHits(lore);
  const [showRest, setShowRest] = useState(false);
  // 窄档「没进去」先给数，点「看原因」才逐条展开（设计稿 04c 屏 2i）。
  const [showReasons, setShowReasons] = useState(false);
  const shown = showRest ? lore : folded.shown;
  const residentTotal = resident.reduce((n, r) => n + r.chars, 0);

  return (
    <div className={styles.body}>
      {/* ── 常驻 · 单线，上下出血 ── */}
      <section className={styles.resident}>
        {resident.length > 0 && <span className={styles.bindResident} aria-hidden />}
        <SectionHead
          label={t("roleplay.trace.resident", {
            n: resident.length, defaultValue: `常驻 · ${resident.length}`,
          })}
          right={t("roleplay.trace.residentRight", {
            total: num(residentTotal),
            defaultValue: `合计 ${num(residentTotal)} 字 · 本轮 +0`,
          })}
        />
        <div className={styles.marginNote}>
          {t("roleplay.trace.residentNote", {
            defaultValue:
              "「本轮 +0」和「没进去」是两件事。这几条一直在上下文里，装订线因此上下都不收笔——这一轮只是没有再装一遍。",
          })}
        </div>
        {resident.length === 0 ? (
          <div className={styles.emptyLine}>
            {t("roleplay.trace.residentNone", { defaultValue: "这个角色没有绑定任何条目" })}
          </div>
        ) : (
          <>
            <div className={styles.residentRows}>
              {resident.map((r) => (
                <ResidentLine key={`${r.dirPath}-${r.facetTitle ?? ""}`} row={r} onEditBindings={onEditBindings} />
              ))}
            </div>
            {/* 窄档收成名单（设计稿 04c 屏 2i）：用「／」连成一段正文，kind 降成行内小字；
                「只进了标题」的标记留着——它是这一段唯一会害人的东西。两份都渲染，
                显隐交给容器查询，和阅读模式的边注同一手法。 */}
            <div className={styles.residentList} aria-hidden>
              {resident.map((r, i) => (
                <span key={`${r.dirPath}-${r.facetTitle ?? ""}`}>
                  {i > 0 && <span className={styles.residentListSep}>／</span>}
                  <span className={styles.residentName}>{r.label}</span>
                  <span className={styles.residentListKind}>{whereLabel(t, r.kind)}</span>
                  {r.unexpanded && (
                    <span className={`${styles.chipSm} ${styles.chipWarn}`}>
                      {t("roleplay.trace.unexpanded", { defaultValue: "只进了标题" })}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </>
        )}
        {trace.stalePaths.length > 0 && (
          <div className={styles.staleGroup}>
            {trace.stalePaths.map((p) => (
              <div key={p} className={styles.staleRow}>
                <div className={styles.rowTop}>
                  <span className={styles.staleName}>{p.split("/").pop()}</span>
                  <span className={styles.staleChip}>
                    {t("roleplay.trace.staleChip", { defaultValue: "已被删除" })}
                  </span>
                </div>
                {/* 失效的绑定留在原位、留着删除线，不悄悄抹掉——你得看见你绑过它。 */}
                <div className={styles.stalePath}>{p}</div>
                {(onUnbind || onEditBindings) && (
                  <div className={styles.actRow}>
                    {onUnbind && (
                      <button type="button" className={styles.actLink} onClick={() => onUnbind(p)}>
                        {t("roleplay.trace.unbind", { defaultValue: "解除绑定" })}
                      </button>
                    )}
                    {onEditBindings && (
                      <button type="button" className={styles.actLink} onClick={onEditBindings}>
                        {t("roleplay.trace.rebind", { defaultValue: "另选条目" })}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 知识库 · 同一根线，两端有止笔 ── */}
      <section className={styles.hits}>
        {lore.length > 0 && <span className={styles.bindHit} aria-hidden />}
        <SectionHead
          label={t("roleplay.trace.hits", { n: lore.length, defaultValue: `知识库 · 本轮 ${lore.length}` })}
          right={budgetRight(trace.lore)}
          notRun={trace.lore === null}
        />
        {trace.lore === null ? (
          <div className={styles.emptyLine}>
            {t("roleplay.trace.notRunNote", {
              defaultValue: "这一轮是重试，沿用上一次的检索结果，所以这条路没有再跑。",
            })}
          </div>
        ) : lore.length === 0 ? (
          <div className={styles.emptyLine}>
            {t("roleplay.trace.hitsNone", { defaultValue: "这一句话没碰到任何关键字" })}
          </div>
        ) : (
          <>
            {shown.map((r) => <HitBlock key={r.dirPath} row={r} />)}
            {!showRest && folded.restCount > 0 && (
              <button type="button" className={styles.more} onClick={() => setShowRest(true)}>
                <ChevronRight size={7} strokeWidth={2.6} />
                {t("roleplay.trace.moreHits", {
                  n: folded.restCount, chars: num(folded.restChars),
                  defaultValue: `还有 ${folded.restCount} 条 · ${num(folded.restChars)} 字`,
                })}
              </button>
            )}
          </>
        )}
      </section>

      {/* ── 记忆区 · 点线 + 斜体 + 下沉一格底色 ──
          永不与知识库合栏，即使各只有一条：那一栏是世界的事实，这一栏是他**以为**
          的事，两者可以互相矛盾。预算也是独立的一份，段头单独读。 */}
      <section className={styles.area}>
        {area.length > 0 && <span className={styles.bindArea} aria-hidden />}
        <SectionHead
          label={t("roleplay.trace.area", { n: area.length, defaultValue: `记忆区 · 他以为的 · ${area.length}` })}
          right={budgetRight(trace.area)}
          notRun={trace.area === null}
        />
        {trace.area === null ? null : area.length === 0 ? (
          <div className={styles.emptyLine}>
            {t("roleplay.trace.areaNone", { defaultValue: "这一轮没想起旧事" })}
          </div>
        ) : (
          <>
            {area.map((r) => (
              <div key={r.dirPath} className={styles.areaRow}>
                <div className={styles.rowTop}>
                  <button type="button" className={styles.areaName} onClick={onOpenArea}>
                    {r.name}
                  </button>
                  <span className={styles.spacer} />
                  <span className={styles.facetTk}>
                    {num(r.chars)}<span className={styles.tkUnit}> 字</span>
                  </span>
                </div>
                <Keywords keys={r.matchedTerms} lead="by" />
              </div>
            ))}
            <div className={styles.marginNote}>
              {t("roleplay.trace.areaNote", {
                defaultValue:
                  "这一段写的是他以为的事，可以和知识库里的条目相反。取材条只报谁在场，不裁决谁对。",
              })}
            </div>
          </>
        )}
      </section>

      {/* ── 引用 · 作者轮那道 2px 赭石线 ──
          refs 只有 name 与 dirPath，所以这一段不出现字数。 */}
      {trace.refs.length > 0 && (
        <section className={styles.refs}>
          <span className={styles.bindRef} aria-hidden />
          <SectionHead
            label={t("roleplay.trace.refs", { n: trace.refs.length, defaultValue: `引用 · 你 @ 的 · ${trace.refs.length}` })}
          />
          {trace.refs.map((r) => (
            <div key={r.dirPath} className={styles.refRow}>
              <div className={styles.rowTop}>
                <span className={styles.residentName}>{r.name}</span>
                <span className={styles.chipSm}>
                  {t("roleplay.trace.refInline", { defaultValue: "已内联在问句里" })}
                </span>
              </div>
              <div className={styles.refPath}>{lorePathTail(r.dirPath)}</div>
            </div>
          ))}
          <div className={styles.marginNote}>
            {t("roleplay.trace.refsNote", {
              defaultValue: "正文已经写进你这句话里，不单独占块，也不算进本轮字数",
            })}
          </div>
        </section>
      )}

      {/* ── 没进去 · 不装订 ──
          它不是第五种来源，是一种状态，而装订线在这一稿里只表示「进了上下文」。 */}
      {drops.length > 0 && (
        <section className={`${styles.drops} ${showReasons ? styles.dropsForced : ""}`}>
          {/* 段头右端不读数（TURN 2 屏 2b）：被挡下多少字写在段底的预算条里，只在有解时出现。 */}
          <SectionHead
            label={t("roleplay.trace.dropped", { n: drops.length, defaultValue: `没进去 · ${drops.length}` })}
          />
          {/* 窄档先给数（设计稿 04c 屏 2i）：只列原因计数芯片加一个「看原因」。超预算
              单独成芯片（唯一带动作的一类）；「已在上下文」也单独出现且不带框——它不是
              失败，不该被折进「其它」。 */}
          <div className={styles.dropsCompact}>
            {budgetCount > 0 && (
              <span className={`${styles.reasonChip} ${styles.reasonWarn}`}>
                {t("roleplay.trace.compactBudget", { n: budgetCount, defaultValue: `超预算 ${budgetCount}` })}
              </span>
            )}
            {otherCount > 0 && (
              <span className={styles.reasonChip}>
                {t("roleplay.trace.compactOther", { n: otherCount, defaultValue: `其它 ${otherCount}` })}
              </span>
            )}
            {residents.length > 0 && (
              <span className={styles.compactResident}>
                {t("roleplay.trace.compactResident", { n: residents.length, defaultValue: `已在上下文 ${residents.length}` })}
              </span>
            )}
            <button type="button" className={styles.actLink} onClick={() => setShowReasons(true)}>
              {t("roleplay.trace.seeReasons", { defaultValue: "看原因" })}
            </button>
          </div>
          <div className={styles.dropsFull}>
            {fails.map((d, i) => <DropLine key={`${d.label}-${i}`} row={d} />)}
            {/* resident 单独排在一道细线之下：它不是失败。 */}
            {residents.length > 0 && (
              <div className={styles.dropResidentGroup}>
                {residents.map((d, i) => <ResidentDropLine key={`${d.label}-${i}`} row={d} />)}
              </div>
            )}
            {/* 预算条只在有 `budget` 落选时带按钮——预算没满却摆个亮按钮劝你调它，
                是在制造焦虑。 */}
            {budgetPressed(fails) && trace.lore && (
              <div className={styles.budget}>
                <div className={styles.budgetText}>
                  <div className={styles.budgetLine}>
                    {t("roleplay.trace.budgetFull", {
                      used: num(trace.lore.usedChars), cap: num(trace.lore.budgetChars),
                      defaultValue: `检索预算 ${num(trace.lore.usedChars)} / ${num(trace.lore.budgetChars)} 字 已满`,
                    })}
                  </div>
                  <div className={styles.budgetSub}>
                    {t("roleplay.trace.budgetBlocked", {
                      n: budgetCount, defaultValue: `${budgetCount} 项因此被挡在外面`,
                    })}
                  </div>
                </div>
                {onRaiseBudget && (
                  <button type="button" className={styles.budgetBtn} onClick={onRaiseBudget}>
                    {t("roleplay.trace.raiseBudget", { defaultValue: "提高预算" })}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
