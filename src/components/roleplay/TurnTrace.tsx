/**
 * 本轮取材条（设计稿 13）。
 *
 * 回答一个问题：**这一轮，模型眼前有哪些条目和特征，为什么。**
 *
 * ## 这一稿的一句话：四种来源用四种装订分开，不用四种颜色
 *
 * 常驻是骑缝双线并且上下出血（它从上一场穿进来、往下一轮穿出去，这就是「不随
 * 轮次变」的字面画法）；本轮命中是一条两端带止笔的单线（闭合区间：这些是这一
 * 轮才来的）；记忆区是点线 + 斜体 + 下沉一格底色（线断开＝不是实证）；你 @ 的
 * 用作者轮那道 2px 赭石线——它是四段里唯一带强调色的装订，因为它唯一由作者负责。
 *
 * 仓库既有规则是「分类用颜色，集合用装订」，而四种来源是四个**集合**（同一个
 * 条目可以既常驻又被 @），所以它们只能用装订区分。颜色继续只承担两件事：赭石
 * ＝你能点的与你负责的，褪色＝没进去。第三套彩色编码会立刻和知识库墙、上下文
 * 构成条打架。
 *
 * ## 三句不能混的话
 *
 * - **本轮 +0 tk** —— 常驻早就在里面了，不必重复计。
 * - **本轮 0** —— 查过了，这一句话没碰到任何触发词。
 * - **无记录** —— 重启前的轮次，无从查证。取材事实只存在内存里。
 *
 * 第三句是整个组件里唯一不可交互的形态，所以它在版式上就要看起来点不动：没有
 * 三角、没有任何数字、起笔是破折号、上方一道虚线——页被撕掉的样子。
 *
 * ## 「没进去」不是第五种来源
 *
 * 它是一种**状态**，所以它没有装订线，只用一条通栏细线隔开、整组降到最淡一档。
 * 装订线在这一稿里只表示「进了上下文」。
 *
 * 取数与聚合在 `lib/roleplay/traceView`（纯函数，逐条钉在测试里）——这里只负责
 * 把它们摆出来。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  blockedChars, budgetPressed, dropRows, foldHits, hitRows, keywordLine,
  residentRows, summarize, type DropRow, type FacetRow, type HitRow, type LayerChip,
} from "../../lib/roleplay/traceView";
import type { TurnContextTrace } from "../../lib/roleplay/trace";
import styles from "./TurnTrace.module.css";

/** 「3.8k」「0.4k」「0.02k」——设计稿的写法：至多两位小数，去掉拖尾的零。 */
function tk(chars: number, charsPerToken: number): string {
  const n = Math.round(chars / Math.max(charsPerToken, 0.1));
  const k = n / 1000;
  if (k >= 10) return `${Math.round(k)}k`;
  const s = k.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${s || "0"}k`;
}

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
        {t("roleplay.trace.noRecord", { defaultValue: "— 取材 · 本次运行前的轮次无记录" })}
      </div>
    );
  }

  const s = summarize(trace);
  return (
    <button type="button" className={styles.toggle} onClick={onToggle} aria-expanded={open}>
      <ChevronRight
        size={8}
        strokeWidth={2.6}
        className={styles.caret}
        style={{ transform: open ? "rotate(90deg)" : undefined }}
      />
      <span>
        {t("roleplay.trace.line", {
          resident: s.residentCount,
          n: s.turnCount,
          defaultValue: `取材 常驻 ${s.residentCount} · 本轮 ${s.turnCount}`,
        })}
        {/* 本轮 0 时 tk 段整段省掉——0 条的 0 tk 是一句废话。 */}
        {s.turnCount > 0 && (
          <span className={styles.tkSeg}>{` · ${tk(s.turnChars, trace.charsPerToken)}`}
            <span className={styles.tkUnit}> tk</span>
          </span>
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
              n: s.staleCount, defaultValue: `${s.staleCount} 条失效`,
            })}`}
          </span>
        )}
      </span>
    </button>
  );
}

// ─── 段头 ────────────────────────────────────────────────────────────────────

function SectionHead({ label, right }: { label: string; right?: string }) {
  return (
    <div className={styles.head}>
      <span className={styles.headLabel}>{label}</span>
      <span className={styles.headRule} />
      {right && <span className={styles.headRight}>{right}</span>}
    </div>
  );
}

// ─── 激活词那一行 ────────────────────────────────────────────────────────────

/**
 * 「由「铁鳞」「甲片」+2 命中」。
 *
 * 它是一行正文，不是悬停提示——激活词是作者调关键词的唯一反馈回路，藏进 `title`
 * 等于没做：作者不会去悬停一个他不知道存在的东西。
 *
 * `lead` 分「由」和「另由」：条目已经由某个词命中时，特征自己多命中一个词要用
 * 「另由」，避免把同一个词读两遍。
 */
function Keywords({ keys, lead }: { keys: readonly string[]; lead: "by" | "also" }) {
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
        // 行内展开，不是浮层——点开就地续写，行高不跳。
        <button type="button" className={styles.keyMore} onClick={() => setExpanded(true)}>
          {`+${line.rest}`}
        </button>
      )}
      {t("roleplay.trace.hit", { defaultValue: "命中" })}
    </div>
  );
}

// ─── 本轮命中 / 记忆区里的一条 ───────────────────────────────────────────────

function Chips({ chips, facetCount, charsPerToken }: {
  chips: LayerChip[]; facetCount: number; charsPerToken: number;
}) {
  const { t } = useTranslation();
  const label = (c: LayerChip) => {
    if (c.kind === "summary") return t("roleplay.trace.layerSummary", { defaultValue: "摘要" });
    if (c.kind === "gallery") {
      return `${t("roleplay.trace.layerGallery", { defaultValue: "配图" })} ${c.count ?? 0}`;
    }
    const core = t("roleplay.trace.layerCore", { defaultValue: "正文" });
    return c.truncated
      ? `${core} · ${t("roleplay.trace.truncated", { defaultValue: "截断" })}`
      : core;
  };
  const cut = chips.find((c) => c.kind === "core" && c.truncated && c.sourceChars);
  return (
    <>
      <div className={styles.chipRow}>
        {chips.map((c, i) => (
          <span key={`${c.kind}-${i}`} className={styles.chip}>{label(c)}</span>
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
            from: cut.sourceChars!.toLocaleString(),
            to: cut.chars.toLocaleString(),
            defaultValue: `正文 ${cut.sourceChars!.toLocaleString()} → ${cut.chars.toLocaleString()} 字 · 预算截断`,
          })}
          <span className={styles.tkUnit}>{` · ${tk(cut.sourceChars! - cut.chars, charsPerToken)}`}</span>
        </div>
      )}
    </>
  );
}

function FacetLine({ facet, charsPerToken }: { facet: FacetRow; charsPerToken: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.facet}>
      <div className={styles.rowTop}>
        <span className={styles.facetName}>{facet.title}</span>
        <span className={styles.spacer} />
        <span className={styles.facetTk}>{tk(facet.chars, charsPerToken)}</span>
      </div>
      {facet.ridesAlong ? (
        // 这一行必须存在：留空会被读成「不知道为什么进来的」，而它恰恰是设定里
        // 最确定的一类。
        <div className={styles.keysFlat}>
          {t("roleplay.trace.ridesAlong", { defaultValue: "随条目进入 · 不看关键词" })}
        </div>
      ) : (
        <Keywords keys={facet.matchedKeys} lead="also" />
      )}
    </div>
  );
}

function HitBlock({ row, charsPerToken }: { row: HitRow; charsPerToken: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.hit}>
      <div className={styles.rowTop}>
        <span className={styles.hitName}>{row.name}</span>
        {row.aliases && <span className={styles.alias}>{row.aliases}</span>}
        <span className={styles.spacer} />
        <span className={styles.hitTk}>
          {tk(row.chars, charsPerToken)}<span className={styles.tkUnit}> tk</span>
        </span>
      </div>
      {row.pinned ? (
        <div className={styles.keysFlat}>
          {t("roleplay.trace.pinnedIn", { defaultValue: "绑定进入 · 不看关键词" })}
        </div>
      ) : (
        <Keywords keys={row.matchedTerms} lead="by" />
      )}
      <Chips chips={row.chips} facetCount={row.facets.length} charsPerToken={charsPerToken} />
      {row.facets.length > 0 && (
        <div className={styles.facets}>
          {row.facets.map((f) => (
            <FacetLine key={f.title} facet={f} charsPerToken={charsPerToken} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 没进去 ──────────────────────────────────────────────────────────────────

function DropLine({ row, charsPerToken }: { row: DropRow; charsPerToken: number }) {
  const { t } = useTranslation();
  const reasonText = {
    "no-key": t("roleplay.trace.dropNoKey", { defaultValue: "没命中" }),
    "group-lost": t("roleplay.trace.dropGroup", { defaultValue: "同组挤掉" }),
    budget: t("roleplay.trace.dropBudget", { defaultValue: "超预算" }),
    "manual-only": t("roleplay.trace.dropManual", { defaultValue: "仅手动" }),
    resident: t("roleplay.trace.dropResident", { defaultValue: "已常驻" }),
  }[row.reason];

  // 每一种的行尾说的都是「那然后呢」。「同组挤掉」不点名等于没说。
  const detail =
    row.reason === "group-lost" && row.winner
      ? t("roleplay.trace.dropGroupDetail", {
          winner: row.winner, defaultValue: `「${row.winner}」优先`,
        })
      : row.reason === "budget" && row.neededChars
        ? t("roleplay.trace.dropBudgetDetail", {
            n: tk(row.neededChars, charsPerToken),
            defaultValue: `差 ${tk(row.neededChars, charsPerToken)} tk`,
          })
        : row.reason === "manual-only"
          ? t("roleplay.trace.dropManualDetail", { defaultValue: "没 @ 就不进" })
          : row.reason === "resident"
            ? t("roleplay.trace.dropResidentDetail", { defaultValue: "见上「常驻」" })
            : "";

  return (
    <div className={styles.drop}>
      {/* 整组只有原因芯片是有边框的，条目名反而降一档——落选组里「为什么」比「谁」重要。 */}
      <span className={`${styles.reasonChip} ${row.reason === "budget" ? styles.reasonWarn : ""}`}>
        {reasonText}
      </span>
      <span className={styles.dropName}>{row.label}</span>
      {detail && <span className={styles.dropDetail}>{detail}</span>}
    </div>
  );
}

// ─── 展开态 ──────────────────────────────────────────────────────────────────

export function TraceBody({ trace, onRaiseBudget, onOpenArea }: {
  trace: TurnContextTrace;
  /** 「提高预算」——只在有「超预算」那一类时出现。 */
  onRaiseBudget?: () => void;
  onOpenArea?: () => void;
}) {
  const { t } = useTranslation();
  const cpt = trace.charsPerToken;
  const resident = residentRows(trace);
  const lore = hitRows(trace.lore);
  const area = hitRows(trace.area);
  const drops = [...dropRows(trace.lore), ...dropRows(trace.area)];
  const folded = foldHits(lore);
  const [showRest, setShowRest] = useState(false);
  const shown = showRest ? lore : folded.shown;

  return (
    <div className={styles.body}>
      {/* ── 常驻 · 骑缝双线，上下出血 ── */}
      <section className={styles.resident}>
        <span className={styles.bindResident} aria-hidden />
        <SectionHead
          label={t("roleplay.trace.resident", {
            n: resident.length, defaultValue: `常驻 · ${resident.length}`,
          })}
          right={t("roleplay.trace.residentPlus", { defaultValue: "本轮 +0 tk" })}
        />
        {/* 这句页边注是这个组件存在的理由之一，窄栏下也不许省。 */}
        <div className={styles.marginNote}>
          {t("roleplay.trace.residentNote", {
            defaultValue: "+0 不是没进去。它们上一场就装订好了，这一轮不必重复计。",
          })}
        </div>
        {resident.length === 0 ? (
          <div className={styles.emptyLine}>
            {t("roleplay.trace.residentNone", { defaultValue: "这个角色没有绑定任何条目" })}
          </div>
        ) : (
          resident.map((r) => (
            <div key={`${r.dirPath}-${r.facetTitle ?? ""}`} className={styles.residentRow}>
              <span className={styles.residentName}>{r.label}</span>
              <span className={styles.chip}>
                {r.kind === "primary"
                  ? t("roleplay.trace.kindPrimary", { defaultValue: "人设" })
                  : r.kind === "bound-facet"
                    ? t("roleplay.trace.layerFacet", { defaultValue: "特征" })
                    : t("roleplay.trace.layerCore", { defaultValue: "正文" })}
              </span>
              {/* 「清单里有它，但正文没进去」——这一条正是它要说出来的话。 */}
              {r.unexpanded && (
                <span className={`${styles.chip} ${styles.chipGhost}`}>
                  {t("roleplay.trace.unexpanded", { defaultValue: "只放进了条目名" })}
                </span>
              )}
              <span className={styles.spacer} />
              <span className={styles.residentTk}>{tk(r.chars, cpt)}</span>
            </div>
          ))
        )}
        {trace.stalePaths.length > 0 && (
          <div className={styles.staleRow}>
            <span className={styles.staleName}>
              {t("roleplay.trace.stale", {
                n: trace.stalePaths.length,
                defaultValue: `${trace.stalePaths.length} 条绑定已失效`,
              })}
            </span>
            <span className={styles.staleChip}>
              {t("roleplay.trace.staleChip", { defaultValue: "条目已删除" })}
            </span>
          </div>
        )}
      </section>

      {/* ── 本轮命中 · 单线，两端有止笔 ── */}
      <section className={styles.hits}>
        <span className={styles.bindHit} aria-hidden />
        <SectionHead
          label={t("roleplay.trace.hits", { n: lore.length, defaultValue: `本轮命中 · ${lore.length}` })}
          right={lore.length ? `${tk(trace.lore?.usedChars ?? 0, cpt)} tk` : undefined}
        />
        {lore.length === 0 ? (
          <div className={styles.emptyLine}>
            {trace.lore
              ? t("roleplay.trace.hitsNone", { defaultValue: "这一句话没碰到任何触发词" })
              : t("roleplay.trace.hitsSkipped", { defaultValue: "这一轮没有跑检索" })}
          </div>
        ) : (
          <>
            {shown.map((r) => <HitBlock key={r.dirPath} row={r} charsPerToken={cpt} />)}
            {!showRest && folded.restCount > 0 && (
              <button type="button" className={styles.more} onClick={() => setShowRest(true)}>
                <ChevronRight size={7} strokeWidth={2.6} />
                {t("roleplay.trace.moreHits", {
                  n: folded.restCount, tk: tk(folded.restChars, cpt),
                  defaultValue: `还有 ${folded.restCount} 条 · ${tk(folded.restChars, cpt)}`,
                })}
              </button>
            )}
          </>
        )}
      </section>

      {/* ── 记忆区 · 点线 + 斜体 + 下沉一格底色 ──
          永不与「本轮命中」合栏，即使各只有一条：那一栏是世界的事实，这一栏是
          他**以为**的事，两者可以互相矛盾。 */}
      <section className={styles.area}>
        <span className={styles.bindArea} aria-hidden />
        <SectionHead
          label={t("roleplay.trace.area", { n: area.length, defaultValue: `记忆区 · 他以为的 · ${area.length}` })}
          right={area.length ? `${tk(trace.area?.usedChars ?? 0, cpt)} tk` : undefined}
        />
        {area.length === 0 ? (
          <div className={styles.emptyLine}>
            {t("roleplay.trace.areaNone", { defaultValue: "这一轮没想起旧事" })}
          </div>
        ) : (
          <>
            {area.map((r) => (
              <div key={r.dirPath} className={styles.areaRow}>
                <div className={styles.rowTop}>
                  <button
                    type="button"
                    className={styles.areaName}
                    onClick={onOpenArea}
                  >
                    {r.name}
                  </button>
                  <span className={styles.spacer} />
                  <span className={styles.facetTk}>{tk(r.chars, cpt)}</span>
                </div>
                <Keywords keys={r.matchedTerms} lead="by" />
              </div>
            ))}
            <div className={styles.marginNote}>
              {t("roleplay.trace.areaNote", {
                defaultValue: "记忆区写的是他以为的事，可能和知识库正文相反。取材条只报谁在场，不裁决谁对。",
              })}
            </div>
          </>
        )}
      </section>

      {/* ── 你 @ 的 · 作者轮那道 2px 赭石线 ── */}
      {trace.refs.length > 0 && (
        <section className={styles.refs}>
          <span className={styles.bindRef} aria-hidden />
          <SectionHead
            label={t("roleplay.trace.refs", { n: trace.refs.length, defaultValue: `你 @ 的 · ${trace.refs.length}` })}
          />
          {trace.refs.map((r) => (
            <div key={r.dirPath} className={styles.refRow}>
              <span className={styles.residentName}>{r.name}</span>
              <span className={styles.chip}>
                {t("roleplay.trace.refWhole", { defaultValue: "全文" })}
              </span>
            </div>
          ))}
          <div className={styles.marginNote}>
            {t("roleplay.trace.refsNote", {
              defaultValue: "你在输入里写的 @ · 不看关键词，也不被同组挤掉",
            })}
          </div>
        </section>
      )}

      {/* ── 没进去 · 不装订 ──
          它不是第五种来源，是一种状态，所以没有装订线，只用一条通栏细线隔开。 */}
      {drops.length > 0 && (
        <section className={styles.drops}>
          <SectionHead
            label={t("roleplay.trace.dropped", { n: drops.length, defaultValue: `没进去 · ${drops.length}` })}
            right={blockedChars(drops)
              ? t("roleplay.trace.blocked", {
                  tk: tk(blockedChars(drops), cpt),
                  defaultValue: `${tk(blockedChars(drops), cpt)} tk 被挡下`,
                })
              : undefined}
          />
          {drops.map((d, i) => (
            <DropLine key={`${d.label}-${i}`} row={d} charsPerToken={cpt} />
          ))}
          {/* 预算条只在有「超预算」时出现——预算没满就不该有个亮按钮劝你调它。 */}
          {budgetPressed(drops) && trace.lore && (
            <div className={styles.budget}>
              <div className={styles.budgetText}>
                <div className={styles.budgetLine}>
                  {t("roleplay.trace.budgetFull", {
                    used: tk(trace.lore.usedChars, cpt),
                    cap: tk(trace.lore.budgetChars, cpt),
                    defaultValue: `取材预算 ${tk(trace.lore.usedChars, cpt)} / ${tk(trace.lore.budgetChars, cpt)} 已满`,
                  })}
                </div>
                <div className={styles.budgetSub}>
                  {t("roleplay.trace.budgetBlocked", {
                    n: drops.filter((d) => d.reason === "budget").length,
                    defaultValue: `${drops.filter((d) => d.reason === "budget").length} 条因此被挡在外面`,
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
        </section>
      )}
    </div>
  );
}
