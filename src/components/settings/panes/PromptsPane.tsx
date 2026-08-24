/**
 * 设置 → Prompt.
 *
 * One page, two regions, and the hierarchy between them is the design:
 *
 *   · **The snippet library owns the page.** It is the author's own writing —
 *     searchable, chip-filtered, sectioned exactly the way the picker sections
 *     it, so learning one list teaches the other. 「未分组」 leads rather than
 *     trails here: right-click saves land there, and draining that inbox is the
 *     one recurring job this page exists for, which is also why it is the only
 *     section whose group column is interactive.
 *   · **Built-in overrides are a collapsed strip at the foot.** Not a second
 *     tab — tabs would make "my sticky notes" and "rewrite the instruction every
 *     call carries" look like peers. Editing one of those six changes what every
 *     generation sends, so it costs a deliberate expand first.
 *
 * "More dangerous" is built without a second accent colour: position, the
 * collapse, a box around the whole region, a grey band stating the consequence,
 * a 2px bar on only the overridden entries, and a forced side-by-side of your
 * version against the built-in default. See `Prompts.module.css`.
 *
 * 设计稿 `10 提示词库` 1g/1h.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Pencil, X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { useProjectStore } from "../../../stores/projectStore";
import { SNIPPET_SCENE, type Prompt } from "../../../lib/ai/configDb";
import {
  buildSections, groupNames, hitSlice, previewLine, snippetsOf, splitPlaceholders,
} from "../../../lib/ai/snippets";
import { findTask, promptParams } from "../../../lib/profile";
import { Select } from "../../common/Select";
import { PromptDrawer } from "./PromptDrawer";
import { Pane, PaneHeader } from "./bits";
import ui from "../settingsUi.module.css";
import hub from "./ProvidersModels.module.css";
import styles from "./Prompts.module.css";

const BUILTIN_PROMPTS_CONFIG = [
  { scene: "system", instructionKey: "ai.instructions.system" },
  { scene: "continue", instructionKey: "ai.instructions.continue" },
  { scene: "polish", instructionKey: "ai.instructions.polish" },
  { scene: "rewrite", instructionKey: "ai.instructions.rewrite" },
  { scene: "summary", instructionKey: "ai.instructions.summary" },
  { scene: "lore", instructionKey: "ai.instructions.lore" },
];

type SortId = "recent" | "uses" | "name";

/** Preview text with `{{…}}` marked and the search hit tinted. */
function Body({ content, query }: { content: string; query: string }) {
  const line = previewLine(content);
  const slice = hitSlice(line, query);
  if (slice) {
    return (
      <span className={styles.preview}>
        {slice.leadEllipsis && "…"}{slice.before}
        <span className={styles.hit}>{slice.hit}</span>{slice.after}
      </span>
    );
  }
  return (
    <span className={styles.preview}>
      {splitPlaceholders(line).map((p, i) =>
        p.placeholder ? <span key={i} className={styles.ph}>{p.text}</span> : <span key={i}>{p.text}</span>,
      )}
    </span>
  );
}

interface Props {
  onEscapeInterceptChange: (handler: (() => void) | null) => void;
}

export function PromptsPane({ onEscapeInterceptChange }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { prompts, removePrompt, updatePrompt } = useAiStore();
  // Subscribe to the workspace so task-instruction previews follow the pack
  // selection (novel overrides continue/rewrite/summary with its own wording).
  useProjectStore((s) => s.workspace);

  const [draft, setDraft] = useState<Partial<Prompt> | null>(null);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("all");
  const [sort, setSort] = useState<SortId>("recent");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ovOpen, setOvOpen] = useState(false);
  const [ovRow, setOvRow] = useState<string | null>(null);

  const snippets = useMemo(() => snippetsOf(prompts), [prompts]);
  const groups = useMemo(() => groupNames(snippets), [snippets]);

  const sorted = useMemo(() => {
    const by: Record<SortId, (a: Prompt, b: Prompt) => number> = {
      recent: (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
      uses: (a, b) => (b.useCount ?? 0) - (a.useCount ?? 0),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...snippets].sort(by[sort]);
  }, [snippets, sort]);

  const visible = useMemo(
    () => chip === "all" ? sorted
      : chip === "__none__" ? sorted.filter((s) => !(s.group ?? "").trim())
      : sorted.filter((s) => (s.group ?? "").trim() === chip),
    [sorted, chip],
  );

  /* No 「常用」 section here: this page is about filing, and a row appearing
     twice would make "which one do I edit?" a real question. 「未分组」 is
     hoisted to the front instead of trailing — see the file comment. */
  const sections = useMemo(() => {
    const built = buildSections(visible, { query, frequentSection: false });
    const inbox = built.filter((s) => s.kind === "ungrouped");
    return [...inbox, ...built.filter((s) => s.kind !== "ungrouped")];
  }, [visible, query]);

  const closeDrawer = () => { setDraft(null); onEscapeInterceptChange(null); };
  const openDrawer = (d: Partial<Prompt>) => {
    setDraft(d);
    onEscapeInterceptChange(() => closeDrawer());
  };

  const toggle = (id: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const movePicked = async (group: string) => {
    for (const id of picked) {
      const p = prompts.find((x) => x.id === id);
      if (p) await updatePrompt({ ...p, group: group === "__none__" ? "" : group });
    }
    setPicked(new Set());
  };
  const deletePicked = async () => {
    for (const id of picked) await removePrompt(id);
    setPicked(new Set());
  };

  // Resolve against the merged workspace: a scene that is a task id shows the
  // instruction that task actually uses — otherwise the editor would display
  // a text no run ever sends. "system" is the one app-level neutral prompt.
  const builtins = BUILTIN_PROMPTS_CONFIG.map((b) => {
    const task = b.scene === "system" ? null : findTask(b.scene);
    const key = b.scene === "system" ? "ai.instructions.system" : task?.instructionKey ?? b.instructionKey;
    return {
      ...b,
      label: t(`ai.tasks.${b.scene}`),
      text: t(key, promptParams(isZh, task?.packId)),
      override: prompts.find((p) => p.scene === b.scene) ?? null,
    };
  });
  const overriddenCount = builtins.filter((b) => b.override).length;

  const groupOptions = [
    { value: "__none__", label: t("ai.snippets.ungrouped", { defaultValue: "未分组" }) },
    ...groups.map((g) => ({ value: g, label: g })),
  ];

  const usageLabel = (s: Prompt) =>
    (s.useCount ?? 0) > 0
      ? t("aiConfig.prompts.usedTimes", { defaultValue: "{{n}} 次", n: s.useCount })
      : t("aiConfig.prompts.neverUsed", { defaultValue: "未用过" });

  return (
    <Pane
      drawer={draft && (
        <>
          <div className={hub.scrim} onClick={closeDrawer} />
          <PromptDrawer key={draft.id ?? "new"} draft={draft} groups={groups} onClose={closeDrawer} />
        </>
      )}
    >
      <PaneHeader
        title={t("systemSettings.tabs.prompts")}
        sub={t("aiConfig.prompts.libSub", {
          defaultValue: "你自己的片段库 {{n}} 条 · 装机级，所有项目共用一份",
          n: snippets.length,
        })}
        action={
          <button
            className={ui.primaryBtn}
            onClick={() => openDrawer({ name: "", content: "", scene: SNIPPET_SCENE, group: "" })}
          >
            + {t("aiConfig.prompts.addSnippet", { defaultValue: "新建片段" })}
          </button>
        }
      />

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("aiConfig.prompts.searchPlaceholder", { defaultValue: "搜索名字或正文…" })}
        />
        <div className={styles.sortWrap}>
          <Select
            value={sort}
            onChange={(v) => setSort(v as SortId)}
            ariaLabel={t("aiConfig.prompts.sort", { defaultValue: "排序" })}
            options={[
              { value: "recent", label: t("aiConfig.prompts.sortRecent", { defaultValue: "最近使用" }) },
              { value: "uses", label: t("aiConfig.prompts.sortUses", { defaultValue: "使用次数" }) },
              { value: "name", label: t("aiConfig.prompts.sortName", { defaultValue: "名字" }) },
            ]}
          />
        </div>
      </div>

      {/* Group chips: unlike the picker's all/frequent/ungrouped, here the chips
          *are* the groups — this page's filter question is "which shelf". */}
      <div className={styles.chipRow}>
        <button
          className={`${styles.chip} ${chip === "all" ? styles.chipActive : ""}`}
          onClick={() => setChip("all")}
        >
          {t("ai.snippets.filterAll", { defaultValue: "全部" })} {snippets.length}
        </button>
        {groups.map((g) => (
          <button
            key={g}
            className={`${styles.chip} ${chip === g ? styles.chipActive : ""}`}
            onClick={() => setChip(g)}
          >
            {g} {snippets.filter((s) => (s.group ?? "").trim() === g).length}
          </button>
        ))}
        <button
          className={`${styles.chip} ${chip === "__none__" ? styles.chipActive : ""}`}
          onClick={() => setChip("__none__")}
        >
          {t("ai.snippets.ungrouped", { defaultValue: "未分组" })}{" "}
          {snippets.filter((s) => !(s.group ?? "").trim()).length}
        </button>
      </div>

      {snippets.length === 0 ? (
        <div className={styles.empty}>
          {t("aiConfig.prompts.libEmpty", {
            defaultValue:
              "还没有片段。在 AI 助手的输入框里选中一段指令，右键选「存为片段」，它就会出现在这里。",
          })}
        </div>
      ) : sections.length === 0 ? (
        <div className={styles.empty}>{t("aiConfig.prompts.noMatch", { defaultValue: "没有匹配的片段。" })}</div>
      ) : (
        sections.map((sec) => (
          <div key={sec.key}>
            <div className={styles.sectionLabel}>
              {sec.kind === "ungrouped"
                ? t("ai.snippets.ungrouped", { defaultValue: "未分组" })
                : sec.group}
              {" · "}{sec.items.length}
              {sec.kind === "ungrouped" && (
                <span className={styles.sectionNote}>
                  {t("aiConfig.prompts.inboxNote", { defaultValue: "刚从右键存进来的" })}
                </span>
              )}
            </div>
            <div className={styles.list}>
              {sec.items.map((s) => (
                <div
                  key={s.id}
                  className={`${styles.row} ${picked.has(s.id) ? styles.rowChecked : ""}`}
                >
                  <span
                    className={`${styles.check} ${picked.has(s.id) ? styles.checkOn : ""}`}
                    role="checkbox"
                    aria-checked={picked.has(s.id)}
                    tabIndex={0}
                    onClick={() => toggle(s.id)}
                    onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(s.id); } }}
                  >
                    {picked.has(s.id) && <Check size={11} strokeWidth={2.4} />}
                  </span>
                  <span className={styles.name} title={s.name}>{s.name}</span>
                  <Body content={s.content} query={query} />
                  <span className={styles.groupCell}>
                    {sec.kind === "ungrouped" ? (
                      <Select
                        value=""
                        onChange={(v) => void updatePrompt({ ...s, group: v === "__none__" ? "" : v })}
                        placeholder={t("aiConfig.prompts.pickGroup", { defaultValue: "选择分组" })}
                        ariaLabel={t("aiConfig.prompts.pickGroup", { defaultValue: "选择分组" })}
                        options={groups.map((g) => ({ value: g, label: g }))}
                      />
                    ) : (
                      <span className={styles.groupChip}>{s.group}</span>
                    )}
                  </span>
                  <span className={styles.uses}>{usageLabel(s)}</span>
                  <span className={styles.rowActions}>
                    <button
                      className={styles.rowBtn}
                      title={t("aiConfig.prompts.editTitle")}
                      onClick={() => openDrawer(s)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className={styles.rowBtn}
                      title={t("aiConfig.prompts.delete")}
                      onClick={() => void removePrompt(s.id)}
                    >
                      <X size={14} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {picked.size > 0 && (
        <div className={styles.batchBar}>
          <span className={styles.batchCount}>
            {t("aiConfig.prompts.pickedCount", { defaultValue: "已选 {{n}} 条", n: picked.size })}
          </span>
          <span className={styles.batchSpacer} />
          <div className={styles.batchSelect}>
            <Select
              value=""
              onChange={(v) => void movePicked(v)}
              placeholder={t("aiConfig.prompts.moveTo", { defaultValue: "移到分组" })}
              ariaLabel={t("aiConfig.prompts.moveTo", { defaultValue: "移到分组" })}
              options={groupOptions}
            />
          </div>
          <button className={`${styles.batchBtn} ${styles.batchDanger}`} onClick={() => void deletePicked()}>
            {t("aiConfig.prompts.delete")}
          </button>
          <button className={styles.batchBtn} onClick={() => setPicked(new Set())}>
            {t("aiConfig.prompts.cancel")}
          </button>
        </div>
      )}

      {/* ── 内置指令覆盖 ─────────────────────────────────────────────────── */}
      <div className={styles.ovRegion}>
        <button className={styles.ovHead} onClick={() => setOvOpen((o) => !o)}>
          <span className={`${styles.ovChevron} ${ovOpen ? styles.ovChevronOpen : ""}`}>
            <ChevronRight size={14} />
          </span>
          <span className={styles.ovTitle}>
            {t("aiConfig.prompts.builtinTitle")}
          </span>
          <span className={styles.ovCount}>
            {t("aiConfig.prompts.overriddenCount", {
              defaultValue: "{{n}} / {{total}} 已覆盖",
              n: overriddenCount, total: builtins.length,
            })}
          </span>
          <span className={styles.ovSpacer} />
          {ovOpen && overriddenCount > 0 && (
            <span
              className={styles.ovResetAll}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                for (const b of builtins) if (b.override) void removePrompt(b.override.id);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.click(); }}
            >
              {t("aiConfig.prompts.resetAll", { defaultValue: "全部恢复默认" })}
            </span>
          )}
        </button>

        {!ovOpen ? (
          <div className={styles.ovWarn}>{t("aiConfig.prompts.builtinWarn", {
            defaultValue: "改这里等于改 AI 每次调用都会带上的底层指令，六个功能一起变。",
          })}</div>
        ) : (
          <>
            <div className={styles.ovWarn}>{t("aiConfig.prompts.builtinWarn", {
              defaultValue: "改这里等于改 AI 每次调用都会带上的底层指令，六个功能一起变。",
            })}</div>
            {builtins.map((b) => {
              const open = ovRow === b.scene;
              return (
                <div key={b.scene}>
                  <div
                    className={`${styles.ovRow} ${b.override ? styles.ovRowOn : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setOvRow(open ? null : b.scene)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOvRow(open ? null : b.scene); }
                    }}
                  >
                    <span className={`${styles.ovDot} ${b.override ? styles.ovDotOn : ""}`} />
                    <span className={styles.ovName}>{b.label}</span>
                    {b.override && (
                      <span className={styles.ovBadge}>
                        {t("aiConfig.prompts.overridden")}
                      </span>
                    )}
                    <span className={styles.ovPreview}>
                      {previewLine(b.override?.content ?? b.text)}
                    </span>
                    <button
                      className={styles.ovAction}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (b.override) void removePrompt(b.override.id);
                        else openDrawer({ name: b.label, content: b.text, scene: b.scene });
                      }}
                    >
                      {b.override
                        ? t("aiConfig.prompts.reset", { defaultValue: "恢复默认" })
                        : t("aiConfig.prompts.writeOverride", { defaultValue: "写一份覆盖版" })}
                    </button>
                  </div>
                  {open && (
                    <div className={styles.ovBody}>
                      <div className={styles.ovCol}>
                        <div className={`${styles.ovColHead} ${b.override ? styles.ovColHeadLive : ""}`}>
                          {b.override
                            ? t("aiConfig.prompts.yourVersion", { defaultValue: "当前生效 · 你的覆盖版" })
                            : t("aiConfig.prompts.yourVersionNone", { defaultValue: "你的覆盖版 · 尚未写" })}
                        </div>
                        <div className={styles.ovText}>
                          {b.override?.content ?? t("aiConfig.prompts.noOverrideYet", { defaultValue: "—" })}
                        </div>
                      </div>
                      <div className={styles.ovCol}>
                        <div className={styles.ovColHead}>
                          {t("aiConfig.prompts.builtinDefault", { defaultValue: "内置默认" })}
                        </div>
                        <div className={styles.ovText}>{b.text}</div>
                      </div>
                      <div className={styles.ovFoot}>
                        <button
                          className={styles.ovEditBtn}
                          onClick={() => openDrawer(b.override ?? { name: b.label, content: b.text, scene: b.scene })}
                        >
                          {b.override
                            ? t("aiConfig.prompts.editOverride", { defaultValue: "编辑覆盖版" })
                            : t("aiConfig.prompts.writeOverride", { defaultValue: "写一份覆盖版" })}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </Pane>
  );
}
