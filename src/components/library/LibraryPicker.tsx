/**
 * 添加到文库 — the checkbox tree the author picks the library's contents from.
 *
 * Folders join whole (their direct documents and resources, including ones
 * added later); a document can also be picked on its own. Only folders and
 * chapter files are listed: resources come along with their folder and can't
 * be picked one by one. Edits stay in a draft until 确定.
 * See docs/feature/library-plan.md → 第四期 and lib/context/library.ts.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check as CheckIcon, ChevronRight, FileText, Folder, FolderOpen, Search } from "lucide-react";
import { ModalShell } from "../common/ModalShell";
import { useTerms } from "../../stores/projectStore";
import { chapterTitle, type Volume } from "../../lib/context/outline";
import {
  buildPickerTree,
  filterPickerTree,
  folderState,
  folderSubtree,
  isDocMember,
  membersEqual,
  pruneMembers,
  setFolders,
  subtreeHasMembers,
  toggleDoc,
  toggleFolder,
  type LibraryMembers,
  type PickerNode,
} from "../../lib/context/library";
import styles from "./LibraryPicker.module.css";

interface Props {
  /** Every folder of the workspace, grouped (not just the members). */
  volumes: Volume[];
  members: LibraryMembers;
  onApply: (next: LibraryMembers) => void;
  onClose: () => void;
}

/**
 * The zero-radius square of the design (01f 1c) rather than a native checkbox,
 * whose rounded, platform-drawn box the app's square language can't restyle.
 */
function Check({ state, onChange, label }: { state: "all" | "some" | "none"; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      className={`${styles.check} ${state === "all" ? styles.checkOn : state === "some" ? styles.checkSome : ""}`}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
    >
      {state === "all" && <CheckIcon size={10} strokeWidth={3} />}
    </button>
  );
}

/** The name with every occurrence of the filter query marked (01f 1d). */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i} className={styles.hit}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export function LibraryPicker({ volumes, members, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const terms = useTerms();
  const closeRef = useRef<(() => void) | null>(null);
  // `initial` is what the draft started from. If the spine changes on disk
  // while the picker is open (a move by the agent) and the author hasn't
  // touched anything, follow it — applying a stale draft would undo the move.
  const [initial, setInitial] = useState<LibraryMembers>(members);
  const [draft, setDraft] = useState<LibraryMembers>(members);
  useEffect(() => {
    if (membersEqual(draft, initial) && !membersEqual(members, initial)) {
      setInitial(members);
      setDraft(members);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);
  const [query, setQuery] = useState("");

  const tree = useMemo(() => buildPickerTree(volumes), [volumes]);
  const shown = useMemo(() => filterPickerTree(tree, query), [tree, query]);
  const filtering = query.trim().length > 0;

  // Open where the library already is, plus the root row; everything else
  // starts folded so a workspace of dozens of folders reads as a short list.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set<string>([""]);
    const walk = (list: PickerNode[]) => {
      for (const n of list) {
        if (n.children.some((c) => subtreeHasMembers(members, c)) || folderState(members, n.vol) === "some") {
          open.add(n.vol.relPath);
        }
        walk(n.children);
      }
    };
    walk(tree);
    return open;
  });
  const isOpen = (rel: string) => filtering || expanded.has(rel);
  const toggleOpen = (rel: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel); else next.add(rel);
      return next;
    });

  const dirty = !membersEqual(draft, initial);
  // Counted over what exists: leftovers of deleted folders are pruned on apply.
  const live = useMemo(() => pruneMembers(draft, volumes), [draft, volumes]);
  const apply = () => {
    if (dirty) onApply(draft);
    closeRef.current?.();
  };

  const folderMeta = (vol: Volume) => {
    const parts: string[] = [];
    if (vol.chapters.length > 0) parts.push(t("library.picker.docCount", { count: vol.chapters.length, docs: terms.docs }));
    if (vol.resources.length > 0) parts.push(t("library.picker.resourceCount", { count: vol.resources.length }));
    return parts.join(" · ");
  };

  const renderNode = (node: PickerNode, depth: number) => {
    const { vol } = node;
    const isRoot = vol.relPath === "";
    const expandable = node.docs.length > 0 || node.children.length > 0;
    const open = expandable && isOpen(vol.relPath);
    const state = folderState(draft, vol);
    const subtree = node.children.length > 0 ? folderSubtree(node) : null;
    const subtreeOn = subtree?.every((rel) => draft.folders.includes(rel)) ?? false;
    return (
      <div key={`d:${vol.relPath}`}>
        <div
          className={styles.row}
          style={{ paddingLeft: 16 + depth * 18 }}
          onClick={() => expandable && !filtering && toggleOpen(vol.relPath)}
        >
          <button
            type="button"
            className={`${styles.caret} ${open ? styles.caretOpen : ""} ${expandable ? "" : styles.caretNone}`}
            aria-expanded={expandable ? open : undefined}
            aria-label={vol.name}
            tabIndex={expandable && !filtering ? 0 : -1}
            onClick={(e) => { e.stopPropagation(); if (expandable && !filtering) toggleOpen(vol.relPath); }}
          >
            <ChevronRight size={12} strokeWidth={1.8} />
          </button>
          <Check state={state} label={vol.name} onChange={() => setDraft((d) => toggleFolder(d, vol))} />
          {open
            ? <FolderOpen size={13} strokeWidth={1.6} className={styles.icon} />
            : <Folder size={13} strokeWidth={1.6} className={styles.icon} />}
          <span className={styles.name}><Highlight text={vol.name} query={query} /></span>
          <span className={styles.meta}>
            {[isRoot ? t("library.picker.root") : "", folderMeta(vol)].filter(Boolean).join(" · ")}
          </span>
          {subtree && (
            <button
              type="button"
              className={styles.rowAction}
              onClick={(e) => {
                e.stopPropagation();
                setDraft((d) => setFolders(d, subtree, !subtreeOn));
              }}
            >
              {t(subtreeOn ? "library.picker.subtreeOff" : "library.picker.subtreeOn", {
                group: terms.group,
                groups: terms.groups,
              })}
            </button>
          )}
        </div>
        {open && (
          <>
            {node.children.map((c) => renderNode(c, depth + 1))}
            {node.docs.map((doc) => (
              <div
                key={`f:${doc.relPath}`}
                className={styles.row}
                style={{ paddingLeft: 16 + (depth + 1) * 18 }}
                onClick={() => setDraft((d) => toggleDoc(d, doc.relPath))}
              >
                <span className={`${styles.caret} ${styles.caretNone}`} />
                <Check
                  state={isDocMember(draft, doc.relPath) ? "all" : "none"}
                  label={doc.name}
                  onChange={() => setDraft((d) => toggleDoc(d, doc.relPath))}
                />
                <FileText size={13} strokeWidth={1.6} className={styles.icon} />
                <span className={styles.docName}><Highlight text={chapterTitle(doc)} query={query} /></span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  return (
    <ModalShell overlayClassName={styles.backdrop} onClose={onClose} isDirty={dirty} closeRef={closeRef}>
      <div className={styles.panel} role="dialog" aria-label={t("library.picker.title")}>
        <div className={styles.head}>
          <span className={styles.title}>{t("library.picker.title")}</span>
          <span className={styles.subtitle}>
            {t("library.picker.subtitle", { group: terms.group, docs: terms.docs })}
          </span>
          <span className={styles.headEn}>Library</span>
        </div>

        <div className={styles.searchRow}>
          <Search size={13} strokeWidth={1.8} className={styles.searchIcon} />
          <input
            className={styles.search}
            autoFocus
            value={query}
            placeholder={t("library.picker.filter", { group: terms.group, groups: terms.groups, docs: terms.docs })}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className={styles.tree}>
          {tree.length === 0 ? (
            <div className={styles.empty}>{t("library.picker.emptyWorkspace", { docs: terms.docs })}</div>
          ) : shown.length === 0 ? (
            <div className={styles.empty}>{t("library.picker.noMatch")}</div>
          ) : (
            shown.map((n) => renderNode(n, 0))
          )}
        </div>

        <div className={styles.foot}>
          <span className={styles.summary}>
            {t("library.picker.summary", {
              folders: live.folders.length,
              docs: live.docs.length,
              group: terms.group,
              groups: terms.groups,
              docWord: terms.docs,
            })}
          </span>
          <span className={styles.spacer} />
          <button type="button" className={styles.cancel} onClick={() => closeRef.current?.()}>
            {t("library.picker.cancel")}
          </button>
          <button type="button" className={styles.apply} onClick={apply}>
            {t("library.picker.apply")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
