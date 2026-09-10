/**
 * 设置 → 排版格式（Beta）。
 *
 * 这一页的性质是**规格核对表，不是主题选择器**（设计稿 1a 的第一句话）。作者
 * 手上有一份甲方给的格式要求，他要做的是逐条核对，所以数字排第一：每一处字号
 * 同时写号数与磅、行距同时写模式与数值、中西文字体是两个字段、数字列一律等宽。
 *
 * 两个**正交**的状态，都要能同时成立（设计稿 1d）：
 * - 「以后自动用哪一个」＝ 默认，一枚全列唯一的实心圆点 + 一枚「默认」标签；
 * - 「我现在在看哪一个」＝ 选中，一片淡染 + 左侧一条竖线。
 * 把选中也画成强调色实心，作者就会以为自己刚刚改了默认。
 *
 * 「从 Word 文件读取格式」和「+ 新建预设」**只在页头有一份**。它们是这一页的两个
 * 入口，页头常驻、任何宽度下都在；自建分组的空态只写字，不再摆一份同样的按钮。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FileDown, MoreHorizontal, Plus } from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "../../common/ContextMenu";
import { Pane, PaneHeader } from "./bits";
import { PaperPreview } from "./PaperPreview";
import { DocFormatDrawer } from "./DocFormatDrawer";
import { DocxImportModal } from "./DocxImportModal";
import { imitatedIdFor, nextCustomId, useDocFormatStore } from "../../../stores/docFormatStore";
import {
  BUILTIN_FORMATS,
  bodyRegionMm,
  eastAsiaFontsOf,
  formatLineSpacing,
  formatOneLineFull,
  formatSize,
  paperMm,
  type DocFormatPreset,
} from "../../../lib/docx/format";
import { missingFonts } from "../../../lib/docx/fontCheck";
import ui from "../settingsUi.module.css";
import styles from "./DocFormat.module.css";

const MM_PER_PT = 25.4 / 72;

export function DocFormatPane({
  onEscapeInterceptChange,
}: {
  onEscapeInterceptChange?: (handler: (() => void) | null) => void;
}) {
  const { t } = useTranslation();
  const presets = useDocFormatStore((s) => s.presets);
  const defaultId = useDocFormatStore((s) => s.defaultId);
  const selectedId = useDocFormatStore((s) => s.selectedId);
  const setDefault = useDocFormatStore((s) => s.setDefault);
  const select = useDocFormatStore((s) => s.select);
  const hydrate = useDocFormatStore((s) => s.hydrate);
  const saveFormat = useDocFormatStore((s) => s.saveFormat);
  const removeFormat = useDocFormatStore((s) => s.removeFormat);
  const duplicate = useDocFormatStore((s) => s.duplicate);
  const [editing, setEditing] = useState<DocFormatPreset | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<DocFormatPreset | null>(null);
  // ≤720 纸样收成一行可展开的条（设计稿 05f 屏 1m）；宽屏下这个值不起作用。
  const [previewOpen, setPreviewOpen] = useState(false);
  const addImitated = useDocFormatStore((s) => s.addImitated);

  // 自建预设住在 config.db，第一次进这一页才读——设置页多数时候根本不会被打开。
  useEffect(() => { void hydrate(); }, [hydrate]);

  // 抽屉自己接管 Esc（它可能要先问「放弃改动吗」），所以设置页这一层要让开。
  useEffect(() => {
    const layered = editing || importing || deleting;
    onEscapeInterceptChange?.(layered ? () => { setImporting(false); setDeleting(null); } : null);
    return () => onEscapeInterceptChange?.(null);
  }, [editing, importing, deleting, onEscapeInterceptChange]);

  const selected = presets.find((p) => p.id === selectedId) ?? presets[0];
  const builtin = presets.filter((p) => p.builtin);
  const custom = presets.filter((p) => !p.builtin);

  const create = () => {
    // 新预设从「素雅」起步而不是一张空表：三十个字段的空白表单没有人填得完，
    // 而从一套能用的格式改两处是作者真正会做的事。
    const base = BUILTIN_FORMATS.find((p) => p.id === "clean") ?? BUILTIN_FORMATS[0];
    setEditing({
      id: nextCustomId(presets),
      label: t("docxFormat.newName"),
      builtin: false,
      format: structuredClone(base.format),
    });
  };

  return (
    <Pane
      width="wide"
      drawer={
        <>
          {editing && (
            <DocFormatDrawer
              preset={editing}
              onClose={() => setEditing(null)}
              onSave={async (next) => { await saveFormat(next); setEditing(null); }}
            />
          )}
          {importing && (
            <DocxImportModal
              onClose={() => setImporting(false)}
              onAdopt={async ({ file, path, result, name, save, makeDefault }) => {
                // 存成预设＝落盘、进列表；「这次就用它」只挂进本次会话，和
                // read_doc_format 从模型那边读来的走同一条路。
                const preset: DocFormatPreset = save
                  ? { id: nextCustomId(presets), label: name, builtin: false, imitatedFrom: file, format: result.format }
                  : {
                      id: imitatedIdFor(path),
                      label: file,
                      builtin: false,
                      imitatedFrom: file,
                      // 审批卡③底下那行括注要的数——只跟着会话里这一套走，存下来的没有。
                      filledDefaults: result.rows.filter((r) => r.source === "default" || r.source === "absent").length,
                      format: result.format,
                    };
                if (save) await saveFormat(preset);
                else addImitated(preset);
                if (makeDefault) setDefault(preset.id);
                setImporting(false);
                select(preset.id);
              }}
              // 读到的全是 Word 出厂值时的出路（屏 1i）：不建预设，改用那套内置的。
              onUseBuiltin={(id) => { select(id); setImporting(false); }}
            />
          )}
          {deleting && (
            <DeleteFormatModal
              preset={deleting}
              isDefault={deleting.id === defaultId}
              candidates={presets.filter((p) => p.id !== deleting.id)}
              onCancel={() => setDeleting(null)}
              onConfirm={async (handoffTo) => {
                await removeFormat(deleting.id, handoffTo);
                setDeleting(null);
              }}
            />
          )}
        </>
      }
    >
      <PaneHeader
        title={t("docxFormat.title")}
        sub={t("docxFormat.sub")}
        action={
          <div className={styles.headActions}>
            <span className={styles.betaTag}>BETA</span>
            <button className={styles.outlineBtn} onClick={() => setImporting(true)}>
              <FileDown size={13} />
              {t("docxFormat.readDocx")}
            </button>
            <button className={styles.primaryBtn} onClick={create}>
              <Plus size={13} />
              {t("docxFormat.newPreset")}
            </button>
          </div>
        }
      />

      <div className={styles.split}>
        <div className={styles.listCol}>
          <div className={styles.listHead}>
            <span className={styles.radioCol}>{t("docxFormat.defaultCol")}</span>
            <span className={styles.listHint}>{t("docxFormat.listHint", { count: presets.length })}</span>
          </div>

          <div className={styles.list}>
            <div className={styles.groupLabel}>{t("docxFormat.groupBuiltin")}</div>
            {builtin.map((p) => (
              <PresetRow
                key={p.id}
                preset={p}
                isDefault={p.id === defaultId}
                isSelected={p.id === selected?.id}
                onSelect={() => select(p.id)}
                onMakeDefault={() => setDefault(p.id)}
                onDuplicate={() => void duplicate(p.id)}
              />
            ))}

            <div className={styles.groupLabel}>{t("docxFormat.groupCustom")}</div>
            {custom.length === 0 ? (
              // 空态放在「自建」分组里而不是整页居中（设计稿 05f 屏 1l）：内置的五套一直在，
              // 页面从来不是空的，空的只是这一段。
              //
              // **不在这里重复那两个按钮。** 稿上 1l 是列表区的裁切，没有画页头，所以稿里
              // 那一对和页头那一对从来没有同屏出现过；照着叠上去，一台新机器上「从 Word 文件
              // 读取格式」「+ 新建预设」就一屏两份。留下的是这两行字——它说的正是那两个按钮
              // 该怎么用，而按钮本身在页头常驻，任何宽度下都在。
              <div className={styles.emptyCustom}>
                {/* 两行，不是一句：第一行陈述状态，第二行才是出路。挤成一段时
                    「这里还空着」会被读成那句长解释的开头（设计稿 05f 屏 1l）。 */}
                <div className={styles.emptyCustomTitle}>{t("docxFormat.customEmptyTitle")}</div>
                <div>{t("docxFormat.customEmpty")}</div>
              </div>
            ) : (
              custom.map((p) => (
                <PresetRow
                  key={p.id}
                  preset={p}
                  isDefault={p.id === defaultId}
                  isSelected={p.id === selected?.id}
                  onSelect={() => select(p.id)}
                  onMakeDefault={() => setDefault(p.id)}
                  onEdit={() => setEditing(p)}
                  onDuplicate={() => void duplicate(p.id)}
                  onDelete={() => setDeleting(p)}
                />
              ))
            )}
          </div>
        </div>

        {selected && (
          <div className={`${styles.previewCol} ${previewOpen ? "" : styles.previewCollapsed}`}>
            <div className={styles.previewHead}>
              <span className={styles.previewTitle}>{t("docxFormat.previewTitle", { name: selected.label })}</span>
              <span className={ui.spacer} />
              <span className={styles.schematicTag}>{t("docxFormat.schematicTag")}</span>
              {/* ≤720 才出现（设计稿 05f 屏 1m）：这个宽度下要滚的是列表，图按需要出现，
                  不该先占掉半屏。 */}
              <button
                className={styles.previewToggle}
                onClick={() => setPreviewOpen((v) => !v)}
                aria-expanded={previewOpen}
              >
                {previewOpen ? t("docxFormat.previewCollapse") : t("docxFormat.previewExpand")}
                <ChevronDown size={12} className={previewOpen ? styles.previewChevronOpen : undefined} />
              </button>
            </div>
            <div className={styles.previewBar}>{pageLine(selected.format)}</div>
            <div className={styles.previewBody}>
              <PaperPreview format={selected.format} />
              <PageSpec preset={selected} />
            </div>
          </div>
        )}
      </div>
    </Pane>
  );
}

function PresetRow({
  preset,
  isDefault,
  isSelected,
  onSelect,
  onMakeDefault,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  preset: DocFormatPreset;
  isDefault: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onMakeDefault: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  // 每次渲染都问一遍不值当，但预设列表短、字体探测是同步的一次 check——放
  // memo 里是为了别在滚动时重复问，不是为了性能悬崖。
  const missing = useMemo(() => missingFonts(eastAsiaFontsOf(preset.format)), [preset]);
  // ≤720 那个点按钮弹出来的菜单（设计稿 05f 屏 1m）。宽屏下这个按钮根本不显示，
  // 所以这段状态在那边永远是 null。
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menuItems: ContextMenuEntry[] = [
    ...(onEdit ? [{ kind: "item" as const, label: t("docxFormat.edit"), action: onEdit }] : []),
    ...(onDuplicate ? [{ kind: "item" as const, label: t("docxFormat.duplicate"), action: onDuplicate }] : []),
    ...(onDelete
      ? [{ kind: "divider" as const }, { kind: "item" as const, label: t("docxFormat.delete"), danger: true, action: onDelete }]
      : []),
  ];

  return (
    <div
      className={`${styles.row} ${isSelected ? styles.rowSelected : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
      }}
    >
      <div className={styles.radioCol}>
        <button
          className={`${styles.radio} ${isDefault ? styles.radioOn : ""}`}
          role="radio"
          aria-checked={isDefault}
          aria-label={t("docxFormat.makeDefault", { name: preset.label })}
          title={t("docxFormat.makeDefault", { name: preset.label })}
          onClick={(e) => { e.stopPropagation(); onMakeDefault(); }}
        />
      </div>
      <div className={styles.rowMain}>
        <div className={styles.rowTop}>
          <span className={styles.rowName}>{preset.label}</span>
          {isDefault && <span className={styles.defaultChip}>{t("docxFormat.defaultChip")}</span>}
          {preset.imitatedFrom && (
            <span className={styles.fromChip}>{t("docxFormat.readFrom", { file: preset.imitatedFrom })}</span>
          )}
          {/* 字体没装不是错误：文件仍然是对的，只是本机预览会替换。所以是一枚
              中性描边标签，绝不用红色。 */}
          {missing.length > 0 && (
            <span className={styles.missingChip}>{t("docxFormat.fontMissing", { font: missing[0] })}</span>
          )}
        </div>
        {/* 摘要在 ≤720 折成两行——中西文字体一行，字号行距缩进一行（设计稿 05f 屏 1m）。
            不省略号：这些数字是要读的，读不全等于没有。 */}
        <div className={styles.rowSummary}>
          <span>{summaryParts(preset).fonts}</span>
          <span className={styles.rowSummaryRest}>{summaryParts(preset).rest}</span>
        </div>
      </div>
      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
        {onEdit && (
          <button className={`${styles.rowAction} ${styles.rowActionStrong}`} onClick={onEdit}>
            {t("docxFormat.edit")}
          </button>
        )}
        {onDuplicate && (
          <button className={styles.rowAction} onClick={onDuplicate}>{t("docxFormat.duplicate")}</button>
        )}
        {/* 内置的没有删除按钮——不是禁用，是不出现。禁用的按钮只会让人一直
            想弄明白怎么才能点。删除本身在一张确认框里（DeleteFormatModal）。 */}
        {onDelete && (
          <button className={styles.rowAction} onClick={onDelete}>
            {t("docxFormat.delete")}
          </button>
        )}
      </div>
      {/* ≤720 换成这一个点按钮，上面那排收起来（设计稿 05f 屏 1m）：那个宽度多半是
          触屏，而触屏没有悬停——一排靠 hover 才出现的动作在那里等于不存在。 */}
      {menuItems.length > 0 && (
        // 菜单和它的按钮共用这一层的 stopPropagation：portal 出去的菜单项在 React
        // 树上仍然是这里的孩子，点一项会一路冒到行的 onClick 上。
        <div className={styles.rowMenu} onClick={(e) => e.stopPropagation()}>
          <button
            className={styles.rowMenuBtn}
            aria-label={t("docxFormat.rowActions", { name: preset.label })}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAt({ x: r.right - 180, y: r.bottom + 4 });
            }}
          >
            <MoreHorizontal size={15} />
          </button>
          {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} items={menuItems} onClose={() => setMenuAt(null)} />}
        </div>
      )}
    </div>
  );
}

/** 预览下面那张四行小表：纸张 / 页边距 / 版心 / 网格。 */
function PageSpec({ preset }: { preset: DocFormatPreset }) {
  const { t } = useTranslation();
  const f = preset.format;
  const size = paperMm(f.page);
  const region = bodyRegionMm(f.page);
  const m = f.page.margins;

  // 网格和行距是两处独立声明的同一件事，对不上就是一个真问题——所以这里核一次。
  let gridNote: { ok: boolean; text: string } | null = null;
  if (f.page.grid) {
    const pitchPt = region.heightMm / f.page.grid.linesPerPage / MM_PER_PT;
    const declared = f.body.line;
    if (declared && declared.rule !== "auto") {
      const ok = Math.abs(pitchPt - declared.value) < 0.75;
      gridNote = {
        ok,
        text: ok
          ? t("docxFormat.gridAgrees", { size: formatSize(f.body.sizePt), line: formatLineSpacing(declared) })
          : t("docxFormat.gridDiffers", { pitch: pitchPt.toFixed(1), line: formatLineSpacing(declared) }),
      };
    }
  }

  return (
    <div className={styles.spec}>
      <span className={styles.specLabel}>{t("docxFormat.specPaper")}</span>
      <span className={styles.specValue}>
        {`${f.page.size} · ${round1(size.widthMm)} × ${round1(size.heightMm)} mm`}
        {f.page.landscape ? ` · ${t("docxFormat.drawer.landscape")}` : ""}
      </span>
      <span className={styles.specLabel}>{t("docxFormat.specMargins")}</span>
      <span className={styles.specValue}>{`上 ${m.top} · 右 ${m.right} · 下 ${m.bottom} · 左 ${m.left} mm`}</span>
      <span className={styles.specLabel}>{t("docxFormat.specRegion")}</span>
      <span className={styles.specValue}>{`${round1(region.widthMm)} × ${round1(region.heightMm)} mm`}</span>
      <span className={styles.specLabel}>{t("docxFormat.specGrid")}</span>
      <span className={styles.specValue}>
        {f.page.grid
          ? t("docxFormat.gridValue", { lines: f.page.grid.linesPerPage, chars: f.page.grid.charsPerLine })
          : t("docxFormat.gridOff")}
        {gridNote && (
          <span className={gridNote.ok ? styles.gridOk : styles.gridWarn}> {gridNote.ok ? "✓" : "·"} {gridNote.text}</span>
        )}
      </span>
    </div>
  );
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 列表摘要的两半：中西文字体 / 其余三项——窄屏各占一行，宽屏用「 · 」接回一行。 */
function summaryParts(preset: DocFormatPreset): { fonts: string; rest: string } {
  const [fonts, ...rest] = formatOneLineFull(preset.format).split(" · ");
  return { fonts, rest: rest.join(" · ") };
}

/** 收起的纸样条下那一行等宽摘要：`A4 · 上37 右26 下35 左28 · 22 行 × 28 字`。 */
function pageLine(f: DocFormatPreset["format"]): string {
  const m = f.page.margins;
  const grid = f.page.grid ? ` · ${f.page.grid.linesPerPage} 行 × ${f.page.grid.charsPerLine} 字` : "";
  return `${f.page.size} · 上${m.top} 右${m.right} 下${m.bottom} 左${m.left}${grid}`;
}

/**
 * 删除确认（设计稿 05f 屏 1l）。删的正好是默认那套时不禁止，而是把转交并进同一个对话：
 * 下拉预填内置的第一套，作者不改也能直接确认——禁止的做法是「先去把默认改到别处，再回来
 * 删」，两趟操作、一个死角。确认键用深中性填色：赭石是「这是你要的那个」，不能用来确认
 * 删除；红这套语言里没有。
 */
function DeleteFormatModal({
  preset,
  isDefault,
  candidates,
  onCancel,
  onConfirm,
}: {
  preset: DocFormatPreset;
  isDefault: boolean;
  /** 能接手默认的那些（不含正在删的这套），内置在前。 */
  candidates: DocFormatPreset[];
  onCancel: () => void;
  onConfirm: (handoffTo?: string) => void;
}) {
  const { t } = useTranslation();
  const [handoff, setHandoff] = useState(candidates[0]?.id ?? "");
  return (
    <>
      <div className={styles.scrim} onClick={onCancel} />
      <div
        className={`${styles.modal} ${styles.modalNarrow}`}
        role="dialog"
        aria-label={t("docxFormat.deleteTitle", { name: preset.label })}
      >
        <div className={styles.modalHead}>
          <div>
            <div className={styles.modalTitle}>{t("docxFormat.deleteTitle", { name: preset.label })}</div>
            <div className={styles.modalSub}>
              {isDefault ? t("docxFormat.deleteDefaultBody") : t("docxFormat.deleteBody")}
            </div>
          </div>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.rowSummary}>{formatOneLineFull(preset.format)}</div>
          {isDefault && (
            <div className={styles.handoff}>
              <span className={styles.handoffLabel}>{t("docxFormat.handoffLabel")}</span>
              <select className={styles.select} value={handoff} onChange={(e) => setHandoff(e.target.value)}>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}{c.builtin ? ` · ${t("docxFormat.builtinTag")}` : ""}
                  </option>
                ))}
              </select>
              <span className={styles.echo}>{t("docxFormat.handoffHint")}</span>
            </div>
          )}
          <div className={styles.modalFoot}>
            <span className={styles.grow} />
            <button className={styles.ghostBtn} onClick={onCancel}>{t("common.cancel", { defaultValue: "取消" })}</button>
            <button className={styles.neutralBtn} onClick={() => onConfirm(isDefault ? handoff : undefined)}>
              {isDefault ? t("docxFormat.deleteAndHandoff") : t("docxFormat.deleteConfirm")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
