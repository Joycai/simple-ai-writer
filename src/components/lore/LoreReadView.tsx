import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import {
  type LoreEntity,
  type LoreFacet,
  type FacetBlock,
  activationTags,
  buildFacetBlocks,
  entityCollections,
  entityReadStats,
  facetSections,
  imageSections,
  bindingLabel,
  categoryTypeName,
  readFacetBodies,
  splitDictBody,
} from "../../lib/lore";
import { categoryLabel, findCategory, slotLabel } from "../../lib/profile";
import { categoryColor } from "./catColor";
import { MarkdownPreview } from "../common/MarkdownPreview";
import s from "./LoreReadView.module.css";

interface Props {
  entity: LoreEntity;
  /** index.md body, frontmatter stripped (LoreDetail already reads it). */
  indexBody: string;
  indexLoaded: boolean;
  indexLoadFailed: boolean;
  /** Retry the index.md read (bumps LoreDetail's contentVersion). */
  onRetryIndex: () => void;
  avatarUrl: string | null;
  /** Thumbnail data URLs keyed by absPath — LoreDetail's cache, shared. */
  imageDataUrls: Record<string, string>;
  /** 编辑记号：概要 / 主条目 / 词表 → 条目编辑表单。 */
  onEditEntity: () => void;
  /** 编辑记号：特征节 → FacetEditModal。 */
  onEditFacet: (file: string) => void;
  /** Click on a gallery figure → LoreDetail's lightbox (index into entity.images). */
  onPreviewImage: (index: number) => void;
  /** 降级注 / 空条目的「去管理台」。 */
  onOpenManage: () => void;
  next: { name: string; open: () => void } | null;
  /** 1-based position in the wall's flat order, for the transition row. */
  position: { index: number; total: number } | null;
  /** Orphan category whose pack is disabled → neutral colours + one mono note. */
  degraded: boolean;
  /**
   * 「改完那节」的一次性淡染目标：`facet-<file>` 或 `index`（设计稿 16 屏 1d）。
   * 由 LoreDetail 在保存回调里点名，超时自清。
   */
  flashId?: string | null;
}

/** TOC anchor ids: fixed tops + one per 面 + one per facet (sub-items). */
type Anchor = { id: string; label: string; subs: { id: string; label: string }[] };

const SCROLL_MARGIN = 120;

/**
 * 阅读模式（设计稿 16）：格纸墙上摊开的一张纸——主条目 + 特征全文 + 配图一次
 * 排开，注入语义退到节头短线与 mono 边注。分组复用管理台那套
 * （facetSections / buildFacetBlocks / imageSections），只换渲染。
 *
 * 与设计稿的已知出入记录在 docs/feature/lore/lore-browse-mode-ui-brief.md 的
 * 实现记录一节（≥1400 的右页边注变体缓做、配图描述的编辑记号缓做等）。
 */
export function LoreReadView({
  entity,
  indexBody,
  indexLoaded,
  indexLoadFailed,
  onRetryIndex,
  avatarUrl,
  imageDataUrls,
  onEditEntity,
  onEditFacet,
  onPreviewImage,
  onOpenManage,
  next,
  position,
  degraded,
  flashId = null,
}: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");

  const cat = findCategory(entity.category);
  const catLabelText = cat ? categoryLabel(cat, isZh) : entity.category;
  const typeName = categoryTypeName(entity.category, isZh);
  const cols = entityCollections(entity);
  const tags = activationTags(entity);
  const stats = entityReadStats(entity, indexBody.length);
  const catColorValue = degraded ? "var(--lore-neutral-line)" : categoryColor(entity.category);

  const sections = useMemo(() => facetSections(entity), [entity]);
  const imgSections = useMemo(() => imageSections(entity), [entity]);
  const dict = entity.dict === true;
  const dictSplit = useMemo(() => (dict ? splitDictBody(indexBody) : null), [dict, indexBody]);

  // ── 特征正文（唯一要新读的数据；per-file 容错，坏文件只坏自己那节） ──
  const [bodies, setBodies] = useState<Map<string, string | null> | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readFacetBodies(entity).then((m) => { if (!cancelled) setBodies(m); });
    return () => { cancelled = true; };
  }, [entity, retryTick]);

  // ── 空条目：0 特征 + 0 配图 + 正文空。只要正文非空就按常规排。 ──
  const isEmpty =
    indexLoaded && !indexLoadFailed && !indexBody.trim() &&
    entity.facets.length === 0 && entity.images.length === 0;

  // ── 档案头大图：作者指定的 cover 优先（指向的文件不在图库＝按缺席处理）；
  //    缺省取第一个配图组的第一张；一张都没有则不画 ──
  const coverImg = useMemo(() => {
    if (entity.cover) {
      const hit = entity.images.find((i) => i.file === entity.cover);
      if (hit) return hit;
    }
    for (const sec of imgSections) if (sec.images.length > 0) return sec.images[0];
    return entity.images[0] ?? null;
  }, [entity.cover, imgSections, entity.images]);
  const coverUrl = coverImg ? imageDataUrls[coverImg.absPath] ?? null : null;

  // ── 页边目录的锚点列 ──
  const flatFacets = sections.length === 0 && entity.facets.length > 0;
  const anchors = useMemo<Anchor[]>(() => {
    if (isEmpty) return [];
    const list: Anchor[] = [];
    if (entity.summary) list.push({ id: "summary", label: t("lore.read.tocSummary", { defaultValue: "概要" }), subs: [] });
    if (indexBody.trim() || indexLoadFailed) {
      list.push({
        id: "index",
        label: dict
          ? t("lore.read.dictHead", { defaultValue: "词表" })
          : t("lore.read.indexHead", { defaultValue: "主条目" }),
        subs: [],
      });
    }
    if (flatFacets) {
      list.push({
        id: "face-flat",
        label: `${t("lore.read.facetsHead", { defaultValue: "特征" })} · ${entity.facets.length}`,
        subs: entity.facets.map((f) => ({ id: `facet-${f.file}`, label: f.title })),
      });
    } else {
      for (const sec of sections) {
        if (sec.facets.length === 0) continue; // 缺口不画——读物只读不催
        const id = `face-${sec.slot?.id ?? "unslotted"}`;
        const label = sec.slot
          ? `${slotLabel(sec.slot, isZh)} · ${sec.facets.length}`
          : `${t("lore.read.unslottedHead", { defaultValue: "未归类" })} · ${sec.facets.length}`;
        list.push({ id, label, subs: sec.facets.map((f) => ({ id: `facet-${f.file}`, label: f.title })) });
      }
    }
    if (entity.images.length > 0) {
      list.push({
        id: "images",
        label: `${t("lore.read.imagesHead", { defaultValue: "配图" })} · ${entity.images.length}`,
        subs: [],
      });
    }
    return list;
  }, [isEmpty, entity, sections, flatFacets, indexBody, indexLoadFailed, dict, isZh, t]);

  // ── 滚动定位：当前节 = 最后一个滚过顶线的锚点（rAF 节流） ──
  const wallRef = useRef<HTMLDivElement>(null);
  const anchorEls = useRef(new Map<string, HTMLElement>());
  const setAnchorEl = (id: string) => (el: HTMLElement | null) => {
    if (el) anchorEls.current.set(id, el);
    else anchorEls.current.delete(id);
  };
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const rafRef = useRef(0);
  const updateActive = () => {
    const wall = wallRef.current;
    if (!wall) return;
    const wallTop = wall.getBoundingClientRect().top;
    let current: string | null = null;
    for (const a of anchors) {
      const el = anchorEls.current.get(a.id);
      if (el && el.getBoundingClientRect().top - wallTop <= SCROLL_MARGIN) current = a.id;
    }
    setActiveAnchor(current ?? anchors[0]?.id ?? null);
  };
  const onScroll = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(updateActive);
  };
  useEffect(() => {
    updateActive();
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors]);

  const scrollToAnchor = (id: string, faceId?: string) => {
    const wall = wallRef.current;
    const el = anchorEls.current.get(id);
    if (!wall || !el) return;
    // 乐观置位：点击的目标就是要高亮的节，不等平滑滚动的事件流靠岸。
    setActiveAnchor(faceId ?? id);
    const top = el.getBoundingClientRect().top - wall.getBoundingClientRect().top + wall.scrollTop - 90;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    wall.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
  };

  // ── 渲染积木 ──

  const editMark = (onClick: () => void, title: string) => (
    <button className={s.editMark} onClick={onClick} title={title}>
      <Pencil size={12} strokeWidth={1.8} />
    </button>
  );
  const editFacetTitle = t("lore.read.editSection", { defaultValue: "编辑这一节" });

  /**
   * mono 边注的**顶层构件**：注入方式（触发词整段算一件）· 字数/失败注记
   * （· 无所属面）。行内态 join(" · ")；宽态真边注一件一行——按字符串里的 ·
   * 拆会把触发词「衣 · 装束 · 袖」从中间劈开。
   */
  const facetMetaParts = (f: LoreFacet, failed: boolean) => {
    const parts: string[] = [];
    if (f.mode === "always") {
      parts.push(t("lore.read.modeResident", { defaultValue: "常驻 · 每次都注入" }));
    } else if (f.mode === "manual") {
      parts.push(t("lore.read.modeManual", { defaultValue: "手动 · 你在 AI 面板点名才注入" }));
    } else if (f.keys.length > 0) {
      const keys = f.keys.join(" · ");
      parts.push(t("lore.read.modeAuto", { keys, defaultValue: `自动 · 触发词「${keys}」` }));
    } else {
      parts.push(t("lore.read.modeAutoNoKeys", { defaultValue: "自动 · 无触发词" }));
    }
    parts.push(
      failed
        ? t("lore.read.loadFailedShort", { defaultValue: "读取失败" })
        : t("lore.read.chars", {
            chars: f.charCount.toLocaleString("en-US"),
            defaultValue: `${f.charCount.toLocaleString("en-US")} 字`,
          }),
    );
    if (degraded && f.slot) parts.push(t("lore.read.noSlot", { defaultValue: "无所属面" }));
    return parts;
  };

  const MODE_MARK: Record<LoreFacet["mode"], string> = {
    always: s.markResident,
    auto: s.markAuto,
    manual: s.markManual,
  };

  /** One facet node: 节头短线 + 标题 + mono 边注 + 完整正文。 */
  const facetNode = (f: LoreFacet, opts?: { inGroup?: boolean; priorityTag?: "active" | "plain" }) => {
    const body = bodies?.get(f.file);
    const failed = bodies !== null && body === null;
    const metaParts = facetMetaParts(f, failed);
    return (
      <div
        key={f.file}
        className={`${s.sect} ${s.facetSect} ${flashId === `facet-${f.file}` ? s.flash : ""}`}
        ref={setAnchorEl(`facet-${f.file}`)}
      >
        {editMark(() => onEditFacet(f.file), editFacetTitle)}
        {/* ≥1400：同一串 mono 推到纸右页边成真边注（1c）——文字与常态完全一致，
            只按 · 拆行换位置；显隐全在 CSS，两份只画一份 */}
        <div className={s.metaSide} aria-hidden>
          {metaParts.map((part, i) => (
            <div key={i}>{part}</div>
          ))}
        </div>
        <div className={`${s.mark} ${opts?.inGroup ? s.markAuto : MODE_MARK[f.mode]}`} />
        <div className={s.facetTitleRow}>
          <span className={s.facetTitle}>{f.title}</span>
          {opts?.priorityTag === "active" && (
            <span className={s.prioActive}>
              {t("lore.read.prioActive", { p: f.priority, defaultValue: `优先级 ${f.priority} · 当前采用` })}
            </span>
          )}
          {opts?.priorityTag === "plain" && (
            <span className={s.prioPlain}>
              {t("lore.read.prio", { p: f.priority, defaultValue: `优先级 ${f.priority}` })}
            </span>
          )}
        </div>
        <div className={`${s.metaLine} ${s.metaInline}`}>{metaParts.join(" · ")}</div>
        {failed ? (
          <div className={s.failedRow}>
            <span className={s.emptyNote}>
              {t("lore.read.loadFailed", { file: f.file, defaultValue: `（读取失败 · ${f.file}）` })}
            </span>
            <button className={s.retryLink} onClick={() => setRetryTick((n) => n + 1)}>
              {t("lore.read.retry", { defaultValue: "重试" })}
            </button>
          </div>
        ) : body !== undefined && body !== null ? (
          body.trim() ? (
            <MarkdownPreview source={body} basePath={entity.dirPath} className={s.md} />
          ) : (
            <div className={s.emptyNote}>{t("lore.read.emptyBody", { defaultValue: "（这一节还没有正文）" })}</div>
          )
        ) : null}
      </div>
    );
  };

  /** 互斥组：骑缝组边 + 组头 mono 说明；组内按优先级降序，首条挂「当前采用」。 */
  const renderBlocks = (blocks: FacetBlock[]) =>
    blocks.map((block) =>
      block.kind === "facet" ? (
        facetNode(block.facet)
      ) : (
        <div key={`g:${block.group}`} className={s.groupWrap}>
          <div className={s.groupEdge} aria-hidden>
            <span className={s.groupEdgeCap} />
            <span className={s.groupEdgeLine} />
            <span className={s.groupEdgeCap} />
          </div>
          <div className={s.groupBody}>
            <div className={s.metaLine}>
              {t("lore.read.groupHead", {
                group: block.group,
                n: block.facets.length,
                defaultValue: `互斥组「${block.group}」· 以下 ${block.facets.length} 节，AI 每次只读其一 · 按优先级`,
              })}
            </div>
            {block.facets.map((f, i) =>
              facetNode(f, { inGroup: true, priorityTag: i === 0 ? "active" : "plain" }),
            )}
          </div>
        </div>
      ),
    );

  /** 面标题基线：名字 · mono 对侧语言标 + 计数 · 细线。 */
  const faceHead = (id: string, label: string, monoTag: string) => (
    <div className={s.faceHead} ref={setAnchorEl(id)}>
      <span className={s.faceName}>{label}</span>
      <span className={s.faceTag}>{monoTag}</span>
      <span className={s.hairline} />
    </div>
  );

  const galleryFigure = (img: (typeof entity.images)[number]) => (
    <figure
      key={img.file}
      className={s.figure}
      onClick={() => onPreviewImage(entity.images.indexOf(img))}
      title={t("lore.detail.previewImage", { defaultValue: "点击放大预览" })}
    >
      {imageDataUrls[img.absPath] ? (
        <img src={imageDataUrls[img.absPath]} alt={img.desc || img.file} className={s.figureImg} />
      ) : (
        <div className={`${s.figureImg} ${s.figurePh}`}>
          <span>{img.file}</span>
        </div>
      )}
      {img.desc ? (
        <figcaption className={s.figureCaption}>{img.desc}</figcaption>
      ) : (
        <figcaption className={s.figureCaptionMono}>{img.file}</figcaption>
      )}
    </figure>
  );

  const imagesFlat = imgSections.length === 0;

  return (
    <div className={s.wall} ref={wallRef} onScroll={onScroll}>
      <div className={s.stage}>
        <article className={s.paper}>
          {/* 装订边：卡片的 22px 放大成纸的左沿。未归集不写字——空着的边就是答案 */}
          <div className={s.bindEdge} aria-hidden>
            {cols.map((name, i) => (
              <span key={name} className={s.bindItem}>
                {i > 0 && <span className={s.bindSep} />}
                <span className={s.bindMark} title={name}>{bindingLabel(name)}</span>
              </span>
            ))}
          </div>

          <div className={s.pageCol}>
            <div className={s.catBand} style={{ background: catColorValue }} />
            <div className={s.inner}>

              {/* ===== 档案头 ===== */}
              <header className={s.hero}>
                {avatarUrl ? (
                  <img src={avatarUrl} alt={entity.name} className={s.avatar} />
                ) : (
                  <div className={s.avatarFallback} style={{ background: catColorValue }}>
                    {entity.name.charAt(0)}
                  </div>
                )}
                {coverUrl && (
                  <img
                    src={coverUrl}
                    alt={coverImg?.desc || coverImg?.file || ""}
                    className={s.cover}
                    onClick={() => coverImg && onPreviewImage(entity.images.indexOf(coverImg))}
                  />
                )}
                <div className={s.heroRight}>
                  <h1 className={s.name}>{entity.name}</h1>
                  <div className={s.hitNote}>
                    {t("lore.read.hitNote", { defaultValue: "命中任一 → 注入本条目" })}
                  </div>
                  <div className={s.hitChips}>
                    {tags.map((tag) => (
                      <span key={tag} className={s.hitChip}>{tag}</span>
                    ))}
                  </div>
                </div>
              </header>

              {/* ===== 元信息行 / 降级注 ===== */}
              {degraded ? (
                <div className={s.degradedRow}>
                  {t("lore.read.degraded", {
                    category: catLabelText,
                    defaultValue: `分类「${catLabelText}」所属能力包已停用 · 类型分面不再生效，正文照读`,
                  })}
                  {" · "}
                  <button className={s.inlineLink} onClick={onOpenManage}>
                    {t("lore.read.degradedAction", { defaultValue: "去管理台处理" })}
                  </button>
                </div>
              ) : (
                <div className={s.metaRow}>
                  <span className={s.metaCat}>
                    <span className={s.catDot} style={{ background: catColorValue }} />
                    {catLabelText}
                  </span>
                  {typeName && (
                    <>
                      <span className={s.metaDivider} />
                      <span className={s.metaMono}>
                        {t("lore.read.typeShort", { type: typeName, defaultValue: `类型 ${typeName}` })}
                      </span>
                    </>
                  )}
                  <span className={s.metaDivider} />
                  <span className={s.metaMono}>
                    {t("lore.read.metaCounts", {
                      facets: stats.facetCount,
                      images: stats.imageCount,
                      defaultValue: `${stats.facetCount} 特征 · ${stats.imageCount} 配图`,
                    })}
                  </span>
                  <span className={s.spacer} />
                  {cols.length > 0 && (
                    <span className={s.metaEdgeNote}>
                      {t("lore.read.collectionsEdge", { defaultValue: "集合见纸左沿" })}
                    </span>
                  )}
                </div>
              )}

              {/* ===== 概要 = 导语 ===== */}
              {entity.summary && (
                <div className={`${s.sect} ${s.lede}`} ref={setAnchorEl("summary")}>
                  {editMark(onEditEntity, editFacetTitle)}
                  <div className={s.ledeText}>{entity.summary}</div>
                  <div className={s.ledeNote}>
                    {t("lore.read.summaryNote", { defaultValue: "概要 · 常驻 · 命中即注入" })}
                  </div>
                </div>
              )}

              {/* ===== 空条目：一句邀请，纸短本身就是「还没写」 ===== */}
              {isEmpty ? (
                <div className={s.emptyBlock}>
                  <div className={s.emptyInvite}>
                    {t("lore.read.emptyInvite", {
                      defaultValue: "这一条目前只有这一句。去管理台写正文，或添一条特征。",
                    })}
                  </div>
                  <button className={s.emptyAction} onClick={onOpenManage}>
                    {t("lore.read.emptyAction", { defaultValue: "去管理台 →" })}
                  </button>
                </div>
              ) : (
                <>
                  {/* ===== 主条目 / 词表 ===== */}
                  {(indexBody.trim() || indexLoadFailed) && (
                    <section
                      className={`${s.sect} ${s.topSect} ${flashId === "index" ? s.flash : ""}`}
                      ref={setAnchorEl("index")}
                    >
                      {editMark(onEditEntity, editFacetTitle)}
                      <div className={s.faceHead}>
                        <span className={s.faceName}>
                          {dict
                            ? t("lore.read.dictHead", { defaultValue: "词表" })
                            : t("lore.read.indexHead", { defaultValue: "主条目" })}
                        </span>
                        {dict && <span className={s.faceTag}>{`GLOSSARY · ${dictSplit?.entries.length ?? 0}`}</span>}
                        <span className={s.hairline} />
                        {!dict && !indexLoadFailed && (
                          <span className={s.faceTag}>
                            {`index.md · ${t("lore.read.chars", {
                              chars: indexBody.length.toLocaleString("en-US"),
                              defaultValue: `${indexBody.length.toLocaleString("en-US")} 字`,
                            })}`}
                          </span>
                        )}
                      </div>
                      <div className={`${s.mark} ${s.markResident}`} />
                      {dict && (
                        <div className={s.metaLine}>
                          {t("lore.read.dictMeta", {
                            rows: dictSplit?.entries.length ?? 0,
                            chars: indexBody.length.toLocaleString("en-US"),
                            defaultValue: `常驻 · 每次都注入 · ${dictSplit?.entries.length ?? 0} 行 · ${indexBody.length.toLocaleString("en-US")} 字`,
                          })}
                        </div>
                      )}
                      {indexLoadFailed ? (
                        <div className={s.failedRow}>
                          <span className={s.emptyNote}>
                            {t("lore.read.loadFailed", { file: "index.md", defaultValue: "（读取失败 · index.md）" })}
                          </span>
                          <button className={s.retryLink} onClick={onRetryIndex}>
                            {t("lore.read.retry", { defaultValue: "重试" })}
                          </button>
                        </div>
                      ) : dict && dictSplit ? (
                        <>
                          {dictSplit.entries.length > 0 && (
                            <div className={s.dictTable}>
                              <div className={s.dictHeadRow}>
                                <span className={s.dictColSrc}>{t("lore.read.dictSource", { defaultValue: "原文 SOURCE" })}</span>
                                <span className={s.dictColDst}>{t("lore.read.dictTarget", { defaultValue: "译文 TARGET" })}</span>
                                <span className={s.dictColNote}>{t("lore.read.dictNote", { defaultValue: "备注 NOTE" })}</span>
                              </div>
                              {dictSplit.entries.map((e, i) => (
                                <div key={`${e.src}-${i}`} className={s.dictRow}>
                                  <span className={`${s.dictColSrc} ${s.dictSrc}`}>{e.src}</span>
                                  <span className={`${s.dictColDst} ${s.dictDst}`}>{e.dst}</span>
                                  <span className={`${s.dictColNote} ${s.dictNote}`}>{e.note ?? ""}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {dictSplit.rest.trim() && (
                            <MarkdownPreview source={dictSplit.rest} basePath={entity.dirPath} className={`${s.md} ${s.dictRest}`} />
                          )}
                        </>
                      ) : (
                        <>
                          <MarkdownPreview source={indexBody} basePath={entity.dirPath} className={s.md} />
                          <div className={s.metaLine}>
                            {t("lore.read.indexNote", { defaultValue: "常驻 · 命中即随概要一并注入" })}
                          </div>
                        </>
                      )}
                    </section>
                  )}

                  {/* ===== 特征 ===== */}
                  {flatFacets && (
                    <section>
                      {faceHead("face-flat", t("lore.read.facetsHead", { defaultValue: "特征" }), `FACETS · ${entity.facets.length}`)}
                      {renderBlocks(buildFacetBlocks(entity.facets))}
                    </section>
                  )}
                  {!flatFacets &&
                    sections.map((sec) => {
                      if (sec.facets.length === 0) return null; // 缺口不画
                      const id = `face-${sec.slot?.id ?? "unslotted"}`;
                      const label = sec.slot
                        ? slotLabel(sec.slot, isZh)
                        : t("lore.read.unslottedHead", { defaultValue: "未归类" });
                      const otherLabel = sec.slot ? (isZh ? sec.slot.labelEn : sec.slot.labelZh) : "";
                      const monoTag = `${otherLabel ? `${otherLabel.toUpperCase()} · ` : ""}${sec.facets.length}`;
                      return (
                        <section key={id}>
                          {faceHead(id, label, monoTag)}
                          {renderBlocks(buildFacetBlocks(sec.facets))}
                        </section>
                      );
                    })}

                  {/* ===== 配图 ===== */}
                  {entity.images.length > 0 && (
                    <section>
                      <div className={s.faceHead} ref={setAnchorEl("images")}>
                        <span className={s.faceName}>{t("lore.read.imagesHead", { defaultValue: "配图" })}</span>
                        <span className={s.faceTag}>{`IMAGES · ${entity.images.length} · images.md`}</span>
                        <span className={s.hairline} />
                      </div>
                      {imagesFlat ? (
                        <div className={s.imgGrid}>{entity.images.map(galleryFigure)}</div>
                      ) : (
                        imgSections.map((sec) => {
                          if (sec.images.length === 0) return null;
                          const label = sec.slot
                            ? slotLabel(sec.slot, isZh)
                            : t("lore.read.unslottedHead", { defaultValue: "未归类" });
                          const otherLabel = sec.slot ? (isZh ? sec.slot.labelEn : sec.slot.labelZh) : "";
                          return (
                            <div key={sec.slot?.id ?? "unslotted"}>
                              <div className={s.imgGroupHead}>
                                {`${label} ${otherLabel ? `${otherLabel.toUpperCase()} ` : ""}· ${sec.images.length}`}
                              </div>
                              <div className={s.imgGrid}>{sec.images.map(galleryFigure)}</div>
                            </div>
                          );
                        })
                      )}
                    </section>
                  )}

                  {/* ===== 落款 ===== */}
                  <footer className={s.colophon}>
                    {`lore/${entity.category}/${entity.id}/ · id: ${entity.id} · `}
                    {t("lore.read.colophon", {
                      facets: stats.facetCount,
                      images: stats.imageCount,
                      chars: stats.totalChars.toLocaleString("en-US"),
                      defaultValue: `${stats.facetCount} 特征 · ${stats.imageCount} 配图 · 正文合计 ${stats.totalChars.toLocaleString("en-US")} 字`,
                    })}
                  </footer>
                </>
              )}
            </div>

            {/* ===== 页底过渡行 ===== */}
            {next && (
              <div className={s.nextRow}>
                <span className={s.nextLabel}>{t("lore.read.nextLabel", { defaultValue: "下一条" })}</span>
                <button className={s.nextName} onClick={next.open}>{next.name}</button>
                <span className={s.nextArrow}>→</span>
                <span className={s.spacer} />
                {position && (
                  <span className={s.nextPos}>
                    {t("lore.read.position", {
                      i: position.index,
                      n: position.total,
                      defaultValue: `第 ${position.index} / ${position.total} 条`,
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        </article>

        {/* ===== 页边目录（≥1300 容器宽才显示，见 module.css） ===== */}
        {anchors.length > 1 && (
          <nav className={s.toc}>
            <div className={s.tocHead}>{t("lore.read.toc", { defaultValue: "目录 Contents" })}</div>
            {anchors.map((a) => (
              <div key={a.id}>
                <button
                  className={`${s.tocItem} ${activeAnchor === a.id ? s.tocItemActive : ""}`}
                  onClick={() => scrollToAnchor(a.id)}
                >
                  <span className={activeAnchor === a.id ? s.tocTickActive : s.tocTick} />
                  {a.label}
                </button>
                {activeAnchor === a.id &&
                  a.subs.map((sub) => (
                    <button key={sub.id} className={s.tocSub} onClick={() => scrollToAnchor(sub.id, a.id)}>
                      {sub.label}
                    </button>
                  ))}
              </div>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
