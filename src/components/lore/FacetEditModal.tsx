/**
 * Create / edit / convert-to-facet form (设计稿 03 · 屏 16 「特征编辑 · 基础
 * 单元的全部字段」).
 *
 * One modal, three entries:
 *   file === null            → create a new facet file
 *   file is an existing facet → edit it (frontmatter pre-filled)
 *   file is a plain attachment → convert it (defaults + body preserved)
 *
 * Single column, in the mockup's field order — 名称 / 注入方式 / 触发词 /
 * 互斥组 · 优先级 / 正文. The 注入方式 radio rows carry their own one-line
 * explanation, which is what retired the old left-hand 检索行为 card; the
 * facet *list* that used to live here is the entry detail's 特征 column now
 * (屏 15), so the modal only ever edits the one facet it was opened on.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles } from "lucide-react";
import {
  categoryTypeName,
  createFacetFile,
  parseFacetMeta,
  readEntityFile,
  saveFacetFile,
  type FacetMeta,
  type LoreEntity,
} from "../../lib/lore";
import { categoryFacetSlots, findFacetSlot, slotLabel } from "../../lib/profile";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { estimateTextTokens } from "../../lib/ai/tokenEstimate";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { MarkdownPreview } from "../common/MarkdownPreview";
import { ModalShell } from "../common/ModalShell";
import { useImeGuard } from "../../lib/ime";
import { FacetAiAssistantModal } from "./ai/FacetAiAssistantModal";
import styles from "./FacetEditModal.module.css";

interface Props {
  entity: LoreEntity;
  /** null → create; existing facet file → edit; plain attachment → convert. */
  file: string | null;
  /**
   * Slot to start on — set when the form was opened from a slot's ＋ or from a
   * gap row (屏 19/20), so the author lands with that 面 already chosen and its
   * defaults prefilled.
   */
  initialSlot?: string | null;
  onClose: () => void;
  /**
   * Fires after a successful save (with the saved/created file name), before
   * the modal closes — the read mode uses it to flash the edited section
   * (设计稿 16 屏 1d). Cancel/close never fires it.
   */
  onSaved?: (file: string) => void;
}

/** Which fields a slot's defaults filled, for the 预填 badges (屏 21). */
type Prefilled = { mode: boolean; keys: boolean; group: boolean; priority: boolean };
const NO_PREFILL: Prefilled = { mode: false, keys: false, group: false, priority: false };

/** The three injection modes, in the mockup's order, with their explanations. */
const MODES: FacetMeta["mode"][] = ["auto", "always", "manual"];

export function FacetEditModal({ entity, file, initialSlot = null, onClose, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const scanProject = useLoreStore((s) => s.scanProject);
  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();

  const [title, setTitle] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [group, setGroup] = useState("");
  const [priority, setPriority] = useState(0);
  const [mode, setMode] = useState<FacetMeta["mode"]>("auto");
  const [body, setBody] = useState("");
  const [bodyView, setBodyView] = useState<"editor" | "preview">("editor");
  const [loaded, setLoaded] = useState(file === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);

  // Group suggestions: every group already used on this entity.
  const knownGroups = useMemo(
    () => [...new Set((entity.facets ?? []).map((f) => f.group).filter(Boolean))] as string[],
    [entity.facets],
  );

  // ── 归属槽位 (屏 21) ────────────────────────────────────────────────────
  // The facet's place in its category's type schema. The whole field disappears
  // when the category declares no slots — a user-defined category, the `custom`
  // bucket, or one whose pack is off — which is the degraded form of this form.
  const slots = categoryFacetSlots(entity.category);
  const typeName = categoryTypeName(entity.category, isZh);
  const [slot, setSlot] = useState<string | null>(initialSlot);
  const [prefilled, setPrefilled] = useState<Prefilled>(NO_PREFILL);

  /**
   * Apply a slot's defaults to the form — creation only.
   *
   * Two rules, both from the mockup's own wording («只在新建时预填，保存后归你»):
   * a field the author has already filled is never overwritten, and a value that
   * *was* prefilled and is still untouched follows the slot when the choice
   * changes (otherwise switching 装扮 → 往事 would leave the outfit group behind
   * on a facet that no longer belongs to it). Editing an existing facet only
   * re-classifies: its metadata is the author's, however it got there.
   */
  const pickSlot = (next: string | null) => {
    setSlot(next);
    if (file) return; // editing: classification only, never a re-prefill
    const defaults = next ? findFacetSlot(entity.category, next)?.defaults : undefined;
    const filled: Prefilled = { ...NO_PREFILL };
    if (prefilled.mode || mode === "auto") {
      setMode(defaults?.mode ?? "auto");
      filled.mode = !!defaults?.mode;
    }
    if (prefilled.keys || keys.length === 0) {
      setKeys([...(defaults?.keys ?? [])]);
      filled.keys = !!defaults?.keys?.length;
    }
    if (prefilled.group || group.trim() === "") {
      setGroup(defaults?.group ?? "");
      filled.group = !!defaults?.group;
    }
    if (prefilled.priority || priority === 0) {
      setPriority(defaults?.priority ?? 0);
      filled.priority = defaults?.priority !== undefined;
    }
    setPrefilled(filled);
  };

  /** The author touching a prefilled field makes it theirs — the badge goes. */
  const own = (field: keyof Prefilled) =>
    setPrefilled((p) => (p[field] ? { ...p, [field]: false } : p));

  const initialSnapshot = useRef<string | null>(null);
  useEffect(() => {
    setTitle("");
    setKeys([]);
    setKeyInput("");
    setGroup("");
    setPriority(0);
    setMode("auto");
    setBody("");
    setError(null);
    initialSnapshot.current = null;
    if (!file) {
      // Fresh create: land on the slot the ＋ came from, defaults and all.
      // Applied straight from the schema rather than through `pickSlot`, which
      // reads the *current* form state — the resets above are still queued here,
      // so it would compare against the previous facet's values.
      const defaults = initialSlot
        ? findFacetSlot(entity.category, initialSlot)?.defaults
        : undefined;
      setSlot(initialSlot);
      if (defaults?.mode) setMode(defaults.mode);
      if (defaults?.keys?.length) setKeys([...defaults.keys]);
      if (defaults?.group) setGroup(defaults.group);
      if (defaults?.priority !== undefined) setPriority(defaults.priority);
      setPrefilled({
        mode: !!defaults?.mode,
        keys: !!defaults?.keys?.length,
        group: !!defaults?.group,
        priority: defaults?.priority !== undefined,
      });
      setLoaded(true);
      return;
    }
    setSlot(null);
    setPrefilled(NO_PREFILL);
    setLoaded(false);
    readEntityFile(entity.dirPath, file)
      .then((raw) => {
        const meta = parseFacetMeta(raw, file);
        if (meta) {
          setSlot(meta.slot);
          setTitle(meta.title);
          setKeys(meta.keys);
          setGroup(meta.group ?? "");
          setPriority(meta.priority);
          setMode(meta.mode);
        } else {
          // Convert flow: seed the title from the filename.
          setTitle(file.replace(/\.md$/, ""));
        }
        setBody(parseFrontmatter(raw).content);
      })
      .catch(() => setError(t("lore.facet.loadError", { defaultValue: "读取文件失败" })))
      .finally(() => setLoaded(true));
  }, [entity.category, entity.dirPath, file, initialSlot, t]);

  const keyIme = useImeGuard();
  const addKey = () => {
    const v = keyInput.trim();
    if (v && !keys.includes(v)) { setKeys([...keys, v]); own("keys"); }
    setKeyInput("");
  };

  // Dirty tracking: snapshot the form once it's loaded, then compare. A close
  // gesture only prompts when the current form differs from that baseline.
  const snapshot = JSON.stringify({ title, slot, keys, group, priority, mode, body });
  useEffect(() => {
    if (loaded && initialSnapshot.current === null) initialSnapshot.current = snapshot;
  }, [loaded, snapshot]);
  const dirty = loaded && initialSnapshot.current !== null && initialSnapshot.current !== snapshot;

  const canSave = loaded && !busy && title.trim().length > 0;

  const anyPrefilled = prefilled.mode || prefilled.keys || prefilled.group || prefilled.priority;
  const slotName = slot
    ? (() => {
        const found = slots.find((sl) => sl.id === slot);
        return found ? slotLabel(found, isZh) : slot;
      })()
    : "";
  const prefillLabel = t("lore.slot.prefilled", { defaultValue: "预填" });

  const handleSave = async () => {
    if (!canSave || !projectPath) return;
    setBusy(true);
    setError(null);
    try {
      const meta: FacetMeta = {
        title: title.trim(),
        slot,
        keys: keys.map((k) => k.trim()).filter(Boolean),
        group: group.trim() || null,
        priority: Number.isFinite(priority) ? priority : 0,
        mode,
      };
      let savedFile = file;
      if (file) {
        await saveFacetFile(entity.dirPath, file, meta, body);
      } else {
        savedFile = await createFacetFile(entity.dirPath, meta, body);
      }
      await scanProject(projectPath);
      if (savedFile) onSaved?.(savedFile);
      requestClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const modeLabel = (m: FacetMeta["mode"]) =>
    m === "auto"
      ? t("lore.facet.modeAutoShort", { defaultValue: "自动" })
      : m === "always"
        ? t("lore.facet.modeAlwaysShort", { defaultValue: "常驻" })
        : t("lore.facet.modeManualShort", { defaultValue: "手动" });
  const modeHint = (m: FacetMeta["mode"]) =>
    m === "auto"
      ? t("lore.facet.modeAutoHint", { defaultValue: "主条目命中 + 出现任一触发词" })
      : m === "always"
        ? t("lore.facet.modeAlwaysHint", { defaultValue: "主条目命中即注入" })
        : t("lore.facet.modeManualHint", { defaultValue: "仅在对话中手动引用时注入" });

  return (
    <>
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerTitle}>
            {file
              ? t("lore.facet.editTitle", { defaultValue: "编辑特征" })
              : t("lore.facet.createTitle", { defaultValue: "新建特征" })}
          </span>
          <span className={styles.headerFile}>{file ?? `${entity.id}/*.md`}</span>
          <span className={styles.spacer} />
          <button className={styles.closeBtn} onClick={requestClose} title={t("common.close", { defaultValue: "关闭" })}>
            <X size={14} />
          </button>
        </div>

        <div className={styles.form}>
          <div>
            <label className={styles.label}>
              {t("lore.facet.fieldTitle", { defaultValue: "名称" })}
            </label>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("lore.facet.titlePlaceholder", { defaultValue: "如：战甲形象" })}
              autoFocus
            />
          </div>

          {/* 归属槽位 (屏 21) — 面只影响归类与默认值，不影响注入规则本身。 */}
          {slots.length > 0 && (
            <div>
              <div className={styles.label}>
                {t("lore.slot.field", { defaultValue: "归属槽位" })}
                <span className={styles.labelOptional}>
                  {typeName
                    ? t("lore.slot.fieldHint", {
                        type: typeName,
                        defaultValue: `来自类型 ${typeName} · 只影响归类与默认值`,
                      })
                    : t("lore.slot.fieldHintNoType", { defaultValue: "只影响归类与默认值" })}
                </span>
              </div>
              <div className={styles.slotChips}>
                <button
                  type="button"
                  className={`${styles.slotChip} ${slot === null ? styles.slotChipActive : ""} ${styles.slotChipNone}`}
                  onClick={() => pickSlot(null)}
                  aria-pressed={slot === null}
                >
                  {t("lore.slot.none", { defaultValue: "不归类" })}
                </button>
                {slots.map((sl) => (
                  <button
                    key={sl.id}
                    type="button"
                    className={`${styles.slotChip} ${slot === sl.id ? styles.slotChipActive : ""}`}
                    onClick={() => pickSlot(sl.id)}
                    aria-pressed={slot === sl.id}
                    title={(isZh ? sl.hintZh : sl.hintEn) ?? undefined}
                  >
                    {slotLabel(sl, isZh)}
                  </button>
                ))}
              </div>
              {anyPrefilled && (
                <div className={styles.prefillNote}>
                  {t("lore.slot.prefillNote", {
                    slot: slotName,
                    defaultValue: `「${slotName}」的默认值已预填到下方。只在新建时预填，保存后归你，改动不会回写类型。`,
                  })}
                </div>
              )}
            </div>
          )}

          {/* 注入方式 — radio rows, each stating when it fires (屏 16). */}
          <div>
            <div className={styles.label}>
              {t("lore.facet.fieldMode", { defaultValue: "注入方式" })}
              {prefilled.mode && <span className={styles.prefillBadge}>{prefillLabel}</span>}
            </div>
            <div className={styles.modeRows}>
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`${styles.modeRow} ${mode === m ? styles.modeRowActive : ""}`}
                  onClick={() => { setMode(m); own("mode"); }}
                  aria-pressed={mode === m}
                >
                  <span className={styles.radio} />
                  <span className={styles.modeName}>{modeLabel(m)}</span>
                  <span className={styles.modeHint}>{modeHint(m)}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={styles.label}>
              {t("lore.facet.fieldKeys", { defaultValue: "触发词" })}
              {prefilled.keys && <span className={styles.prefillBadge}>{prefillLabel}</span>}
            </label>
            <div className={styles.chips}>
              {keys.map((k, i) => (
                <span key={`${k}-${i}`} className={`${styles.chipTag} ${prefilled.keys ? styles.chipTagPrefilled : ""}`}>
                  {k}
                  <button
                    className={styles.chipRemove}
                    onClick={() => { setKeys(keys.filter((_, x) => x !== i)); own("keys"); }}
                    title={t("lore.facet.removeKey", { defaultValue: "移除" })}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                className={styles.chipAddInput}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                {...keyIme.imeProps}
                onKeyDown={(e) => {
                  if (keyIme.isComposing(e)) return;
                  if (e.key === "Enter") { e.preventDefault(); addKey(); }
                }}
                onBlur={addKey}
                placeholder={t("lore.facet.addKeyEnter", { defaultValue: "输入后回车…" })}
              />
            </div>
            {mode === "auto" && keys.length === 0 && (
              <div className={styles.hintWarn}>
                {t("lore.facet.keysEmptyWarn", { defaultValue: "自动模式下没有关键词，此特征永远不会被自动注入" })}
              </div>
            )}
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.fieldGrow}>
              <label className={styles.label}>
                {t("lore.facet.fieldGroup", { defaultValue: "互斥组" })}
                <span className={styles.labelOptional}>
                  {t("lore.facet.optional", { defaultValue: "可选" })}
                </span>
                {prefilled.group && <span className={styles.prefillBadge}>{prefillLabel}</span>}
              </label>
              <input
                className={styles.input}
                value={group}
                onChange={(e) => { setGroup(e.target.value); own("group"); }}
                list="facet-group-suggestions"
                placeholder={t("lore.facet.groupPlaceholder", { defaultValue: "可留空；同组同时命中只注入优先级最高的一个（如 outfit）" })}
              />
              <datalist id="facet-group-suggestions">
                {knownGroups.map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
            <div className={styles.fieldNarrow}>
              <label className={styles.label}>
                {t("lore.facet.fieldPriority", { defaultValue: "优先级" })}
                {prefilled.priority && <span className={styles.prefillBadge}>{prefillLabel}</span>}
              </label>
              <input
                className={styles.input}
                type="number"
                value={priority}
                onChange={(e) => { setPriority(Number(e.target.value)); own("priority"); }}
              />
            </div>
          </div>

          <div className={styles.bodyBlock}>
            <div className={styles.bodyHead}>
              <label className={styles.label}>
                {t("lore.facet.fieldBody", { defaultValue: "正文" })}
              </label>
              <div className={styles.viewToggle}>
                {(["editor", "preview"] as const).map((v) => (
                  <button
                    key={v}
                    className={`${styles.viewBtn} ${bodyView === v ? styles.viewBtnActive : ""}`}
                    onClick={() => setBodyView(v)}
                  >
                    {t(`editor.viewMode.${v}`)}
                  </button>
                ))}
              </div>
            </div>
            {bodyView === "editor" ? (
              <MarkdownTextarea
                className={styles.bodyTextarea}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
                placeholder={t("lore.facet.bodyPlaceholder", { defaultValue: "这一特征的具体内容…" })}
              />
            ) : body.trim() ? (
              // basePath: facet files live in the entity folder, so relative
              // image links resolve against it.
              <MarkdownPreview source={body} basePath={entity.dirPath} className={styles.bodyPreview} />
            ) : (
              <div className={`${styles.bodyPreview} ${styles.bodyPreviewEmpty}`}>
                {t("lore.facet.previewEmpty", { defaultValue: "暂无内容" })}
              </div>
            )}
            <div className={styles.bodyCount}>
              {body.length} {isZh ? "字" : "ch"} ≈ {formatTokens(estimateTextTokens(body))} tokens
            </div>
          </div>

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <div className={styles.footer}>
          <button
            className={styles.aiLink}
            onClick={() => setShowAi(true)}
            disabled={!loaded}
            title={t("lore.facet.ai.open", { defaultValue: "AI 助手" })}
          >
            <Sparkles size={11} strokeWidth={2} />
            {t("lore.facet.ai.linkLabel", { defaultValue: "AI 助手 · 就这个特征提问或改写" })}
          </button>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={requestClose} disabled={busy}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          {/* btnPrimary 只带覆盖色，基础皮在 btn 上 (与其他模态一致) */}
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSave} disabled={!canSave}>
            {busy
              ? t("lore.facet.saving", { defaultValue: "保存中…" })
              : t("lore.facet.saveFacet", { defaultValue: "保存特征" })}
          </button>
        </div>
      </div>
    </ModalShell>

    {showAi && (
      <FacetAiAssistantModal
        entity={entity}
        facetTitle={title}
        facetKeys={keys}
        facetBody={body}
        onApply={(patch) => {
          if (patch.body !== undefined) setBody(patch.body);
          if (patch.keys) setKeys(patch.keys);
        }}
        onClose={() => setShowAi(false)}
      />
    )}
    </>
  );
}

/** 1,240 / 1.2k — the mockup's own two shapes for the counter. */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
