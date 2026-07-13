import { describe, it, expect } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  toggleBold,
  toggleItalic,
  toggleInlineCode,
  toggleHeading,
  toggleQuote,
  toggleBulletList,
  insertLink,
} from "../editor/format";

/** Minimal EditorView stand-in: holds an EditorState, applies dispatched
 *  transactions, and reports the resulting doc + primary selection. The
 *  formatting commands only touch state/dispatch/focus, so this is enough to
 *  exercise them without a DOM. */
function fakeView(doc: string, anchor = 0, head = anchor) {
  let state = EditorState.create({ doc, selection: { anchor, head } });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = tr.state;
    },
    focus() {},
  } as unknown as EditorView;
  return {
    view,
    doc: () => state.doc.toString(),
    sel: () => {
      const s = state.selection.main;
      return [s.from, s.to] as const;
    },
  };
}

describe("inline formatting", () => {
  it("wraps a selection in bold markers and keeps it selected", () => {
    const f = fakeView("hello world", 0, 5);
    toggleBold(f.view);
    expect(f.doc()).toBe("**hello** world");
    expect(f.doc().slice(...f.sel())).toBe("hello");
  });

  it("unwraps bold when the markers surround the selection", () => {
    const f = fakeView("**hello** world", 2, 7); // "hello" between the **
    toggleBold(f.view);
    expect(f.doc()).toBe("hello world");
  });

  it("inserts empty italic markers with the cursor between them", () => {
    const f = fakeView("ab", 1, 1);
    toggleItalic(f.view);
    expect(f.doc()).toBe("a**b"); // "*" + "*" around the empty selection
    expect(f.sel()).toEqual([2, 2]); // cursor sits between the two markers
  });

  it("wraps inline code", () => {
    const f = fakeView("x = 1", 0, 5);
    toggleInlineCode(f.view);
    expect(f.doc()).toBe("`x = 1`");
  });
});

describe("heading toggle", () => {
  it("adds a level-2 heading prefix", () => {
    const f = fakeView("Title", 2, 2);
    toggleHeading(f.view, 2);
    expect(f.doc()).toBe("## Title");
  });

  it("removes the prefix when toggling the same level", () => {
    const f = fakeView("## Title", 4, 4);
    toggleHeading(f.view, 2);
    expect(f.doc()).toBe("Title");
  });

  it("replaces a different heading level", () => {
    const f = fakeView("# Title", 3, 3);
    toggleHeading(f.view, 3);
    expect(f.doc()).toBe("### Title");
  });
});

describe("block prefixes", () => {
  it("quotes every line the selection spans", () => {
    const f = fakeView("a\nb", 0, 3);
    toggleQuote(f.view);
    expect(f.doc()).toBe("> a\n> b");
  });

  it("toggles a bullet list off when already applied", () => {
    const f = fakeView("- item", 3, 3);
    toggleBulletList(f.view);
    expect(f.doc()).toBe("item");
  });
});

describe("link", () => {
  it("wraps the selection as the label and selects the url placeholder", () => {
    const f = fakeView("Anthropic", 0, 9);
    insertLink(f.view);
    expect(f.doc()).toBe("[Anthropic](url)");
    expect(f.doc().slice(...f.sel())).toBe("url");
  });
});
