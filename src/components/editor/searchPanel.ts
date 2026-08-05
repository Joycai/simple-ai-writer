/**
 * Themed find / replace panel for the editor.
 *
 * CodeMirror's stock search panel is raw browser chrome — bare inputs, default
 * buttons, English-only labels — which reads as a foreign object inside the
 * manuscript UI. `search({ createPanel })` lets us hand it our own DOM instead
 * while keeping every stock command (findNext, replaceAll, the search-panel
 * keymap scope) intact, so behaviour is unchanged and only the surface differs.
 *
 * Plain DOM rather than React: the panel is mounted and unmounted by
 * CodeMirror, and a second render root inside the editor would buy nothing.
 * Class names come from the sibling CSS module, so it still reads from tokens.
 */
import { EditorView, Panel, ViewUpdate, runScopeHandlers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import i18n from "../../i18n";
import styles from "./SearchPanel.module.css";

/** Counting every hit in a long chapter is cheap, but not unbounded — past this
 *  the readout switches to "1000+" and stops scanning. */
const MAX_COUNTED = 1000;

type Match = { from: number; to: number };

function svg(paths: string, size = 14): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "2");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.innerHTML = paths;
  return el;
}

const ICON = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  replace: '<path d="M4 14h10a4 4 0 0 0 0-8H7"/><path d="m10 3-3 3 3 3"/>',
};

function button(className: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

/** All matches for `query`, capped at MAX_COUNTED. Null when the query can't run
 *  (empty, or a half-typed regexp). */
function collectMatches(state: EditorState, query: SearchQuery): Match[] | null {
  if (!query.valid) return null;
  const out: Match[] = [];
  const cursor = query.getCursor(state);
  for (let it = cursor.next(); !it.done; it = cursor.next()) {
    out.push({ from: it.value.from, to: it.value.to });
    if (out.length >= MAX_COUNTED) break;
  }
  return out;
}

class ThemedSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;

  private query: SearchQuery;
  private matches: Match[] | null = null;

  private searchInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private countEl: HTMLElement;
  private replaceRow: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private opts: Record<"caseSensitive" | "wholeWord" | "regexp", HTMLButtonElement>;
  private expanded = false;

  constructor(private view: EditorView) {
    const t = (key: string) => i18n.t(`editor.search.${key}`);
    this.query = getSearchQuery(view.state);

    // ── Row 1: find ──────────────────────────────────────────
    this.searchInput = document.createElement("input");
    this.searchInput.className = styles.input;
    this.searchInput.type = "text";
    this.searchInput.value = this.query.search;
    this.searchInput.placeholder = t("find");
    this.searchInput.setAttribute("aria-label", t("find"));
    // openSearchPanel re-focuses the panel through this attribute — keep it.
    this.searchInput.setAttribute("main-field", "true");
    this.searchInput.addEventListener("input", () => this.commit());

    this.countEl = document.createElement("span");
    this.countEl.className = styles.count;

    const findField = document.createElement("div");
    findField.className = styles.field;
    const findIcon = document.createElement("span");
    findIcon.className = styles.fieldIcon;
    findIcon.appendChild(svg(ICON.search, 13));
    findField.append(findIcon, this.searchInput, this.countEl);

    this.opts = {
      caseSensitive: this.optButton("Aa", t("matchCase"), "caseSensitive"),
      wholeWord: this.optButton("[w]", t("wholeWord"), "wholeWord"),
      regexp: this.optButton(".*", t("regexp"), "regexp"),
    };

    const prevBtn = button(styles.iconBtn, t("previous"), () => findPrevious(this.view));
    prevBtn.appendChild(svg(ICON.up));
    const nextBtn = button(styles.iconBtn, t("next"), () => findNext(this.view));
    nextBtn.appendChild(svg(ICON.down));
    const allBtn = button(styles.textBtn, t("selectAll"), () => selectMatches(this.view));
    allBtn.textContent = t("selectAll");

    const closeBtn = button(styles.iconBtn, t("close"), () => closeSearchPanel(this.view));
    closeBtn.appendChild(svg(ICON.close));

    const spacer = document.createElement("div");
    spacer.className = styles.spacer;

    const findRow = document.createElement("div");
    findRow.className = styles.row;
    findRow.append(
      findField,
      this.opts.caseSensitive,
      this.opts.wholeWord,
      this.opts.regexp,
      sep(),
      prevBtn,
      nextBtn,
      allBtn,
      spacer,
      closeBtn,
    );

    // ── Row 2: replace (collapsed until asked for) ───────────
    this.replaceInput = document.createElement("input");
    this.replaceInput.className = styles.input;
    this.replaceInput.type = "text";
    this.replaceInput.value = this.query.replace;
    this.replaceInput.placeholder = t("replace");
    this.replaceInput.setAttribute("aria-label", t("replace"));
    this.replaceInput.addEventListener("input", () => this.commit());

    const replaceField = document.createElement("div");
    replaceField.className = styles.field;
    const replaceIcon = document.createElement("span");
    replaceIcon.className = styles.fieldIcon;
    replaceIcon.appendChild(svg(ICON.replace, 13));
    replaceField.append(replaceIcon, this.replaceInput);

    const replaceOne = button(styles.textBtn, t("replaceOne"), () => replaceNext(this.view));
    replaceOne.textContent = t("replaceOne");
    const replaceEvery = button(styles.textBtn, t("replaceAll"), () => replaceAll(this.view));
    replaceEvery.textContent = t("replaceAll");

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = `${styles.row} ${styles.rowHidden}`;
    this.replaceRow.append(replaceField, replaceOne, replaceEvery);

    // ── Frame ────────────────────────────────────────────────
    this.toggleBtn = button(styles.toggle, t("toggleReplace"), () => this.setExpanded(!this.expanded));
    const chevron = svg(ICON.chevron, 13);
    chevron.classList.add(styles.toggleIcon);
    this.toggleBtn.appendChild(chevron);
    this.toggleBtn.setAttribute("aria-expanded", "false");

    const rows = document.createElement("div");
    rows.className = styles.rows;
    rows.append(findRow, this.replaceRow);

    const inner = document.createElement("div");
    inner.className = styles.inner;
    inner.append(this.toggleBtn, rows);

    this.dom = document.createElement("div");
    this.dom.className = styles.panel;
    this.dom.setAttribute("role", "search");
    this.dom.addEventListener("keydown", (e) => this.onKeydown(e));
    this.dom.appendChild(inner);

    this.syncToggles();
    this.refreshMatches();
  }

  mount() {
    this.searchInput.focus();
    this.searchInput.select();
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.setQuery(effect.value);
      }
    }
    if (update.docChanged) this.refreshMatches();
    else if (update.selectionSet) this.renderCount();
  }

  private optButton(
    label: string,
    title: string,
    flag: "caseSensitive" | "wholeWord" | "regexp",
  ): HTMLButtonElement {
    const b = button(styles.opt, title, () => {
      this.commit({ [flag]: !this.query[flag] });
      this.searchInput.focus();
    });
    b.textContent = label;
    return b;
  }

  private onKeydown(e: KeyboardEvent) {
    // Escape / Mod-f / F3 & friends stay with the stock search-panel keymap.
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.target === this.searchInput) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.target === this.replaceInput) {
      e.preventDefault();
      (e.ctrlKey || e.metaKey ? replaceAll : replaceNext)(this.view);
    }
  }

  private setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.replaceRow.classList.toggle(styles.rowHidden, !expanded);
    this.toggleBtn.classList.toggle(styles.toggleOpen, expanded);
    this.toggleBtn.setAttribute("aria-expanded", String(expanded));
    if (expanded) this.replaceInput.focus();
  }

  /** Push the fields into editor state as the live query. */
  private commit(overrides: Partial<Record<"caseSensitive" | "wholeWord" | "regexp", boolean>> = {}) {
    this.query = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      literal: this.query.literal,
      caseSensitive: overrides.caseSensitive ?? this.query.caseSensitive,
      wholeWord: overrides.wholeWord ?? this.query.wholeWord,
      regexp: overrides.regexp ?? this.query.regexp,
    });
    this.syncToggles();
    this.view.dispatch({ effects: setSearchQuery.of(this.query) });
    this.refreshMatches();
  }

  /** Adopt a query set from outside (e.g. Mod-f over a selection). */
  private setQuery(query: SearchQuery) {
    this.query = query;
    this.searchInput.value = query.search;
    this.replaceInput.value = query.replace;
    this.syncToggles();
    this.refreshMatches();
  }

  private syncToggles() {
    for (const [flag, btn] of Object.entries(this.opts)) {
      const on = this.query[flag as keyof typeof this.opts];
      btn.classList.toggle(styles.optActive, on);
      btn.setAttribute("aria-pressed", String(on));
    }
    // An unparseable regexp is the one state worth flagging in the field itself.
    this.searchInput.classList.toggle(styles.countEmpty, !!this.query.search && !this.query.valid);
  }

  private refreshMatches() {
    this.matches = collectMatches(this.view.state, this.query);
    this.renderCount();
  }

  private renderCount() {
    const matches = this.matches;
    if (!this.query.search) {
      this.countEl.textContent = "";
      this.countEl.classList.remove(styles.countEmpty);
      return;
    }
    if (!matches || matches.length === 0) {
      this.countEl.textContent = i18n.t("editor.search.noResults");
      this.countEl.classList.add(styles.countEmpty);
      return;
    }
    this.countEl.classList.remove(styles.countEmpty);
    const total = matches.length >= MAX_COUNTED ? `${MAX_COUNTED}+` : String(matches.length);
    const sel = this.view.state.selection.main;
    const current = matches.findIndex((m) => m.from === sel.from && m.to === sel.to);
    this.countEl.textContent = current >= 0 ? `${current + 1}/${total}` : total;
  }
}

function sep(): HTMLElement {
  const el = document.createElement("div");
  el.className = styles.sep;
  return el;
}

/** Search extension wired to the themed panel. */
export function themedSearch() {
  return search({ top: true, createPanel: (view) => new ThemedSearchPanel(view) });
}
