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
  toggleOrderedList,
  toggleTaskList,
  toggleCodeBlock,
  insertHorizontalRule,
  insertTable,
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

describe("list markers", () => {
  it("numbers every touched line from the top of the selection", () => {
    const f = fakeView("alpha\nbeta\ngamma", 0, 16);
    toggleOrderedList(f.view);
    expect(f.doc()).toBe("1. alpha\n2. beta\n3. gamma");
  });

  it("renumbers a block that already carries stray numbers", () => {
    const f = fakeView("5. alpha\nbeta", 0, 13);
    toggleOrderedList(f.view);
    expect(f.doc()).toBe("1. alpha\n2. beta");
  });

  it("strips the numbering when every line is already numbered", () => {
    const f = fakeView("1. alpha\n2. beta", 0, 16);
    toggleOrderedList(f.view);
    expect(f.doc()).toBe("alpha\nbeta");
  });

  it("adds task boxes and clears ticked ones too", () => {
    const f = fakeView("buy milk", 0, 0);
    toggleTaskList(f.view);
    expect(f.doc()).toBe("- [ ] buy milk");

    const done = fakeView("- [x] buy milk", 0, 0);
    toggleTaskList(done.view);
    expect(done.doc()).toBe("buy milk");
  });
});

describe("code blocks", () => {
  it("fences the touched lines and keeps the body selected", () => {
    const f = fakeView("let x = 1\nlet y = 2", 0, 19);
    toggleCodeBlock(f.view);
    expect(f.doc()).toBe("```\nlet x = 1\nlet y = 2\n```");
    expect(f.doc().slice(...f.sel())).toBe("let x = 1\nlet y = 2");
  });

  it("takes the info string when one is given", () => {
    const f = fakeView("print(1)", 0, 8);
    toggleCodeBlock(f.view, "python");
    expect(f.doc()).toBe("```python\nprint(1)\n```");
  });

  it("unfences when the selection spans the fences", () => {
    const f = fakeView("```\nbody\n```", 0, 12);
    toggleCodeBlock(f.view);
    expect(f.doc()).toBe("body");
  });

  it("unfences when the caret sits inside an existing block", () => {
    const f = fakeView("```js\nbody\n```", 8, 8); // caret in "body"
    toggleCodeBlock(f.view);
    expect(f.doc()).toBe("body");
  });
});

describe("block insertion", () => {
  it("takes over a blank line rather than opening another one", () => {
    const f = fakeView("intro\n\n", 6, 6);
    insertHorizontalRule(f.view);
    expect(f.doc()).toBe("intro\n---\n");
  });

  it("opens a new paragraph below a line that has text", () => {
    const f = fakeView("intro", 5, 5);
    insertHorizontalRule(f.view);
    expect(f.doc()).toBe("intro\n\n---");
  });

  it("parts the block from a paragraph that follows it", () => {
    const f = fakeView("intro\nafter", 5, 5);
    insertHorizontalRule(f.view);
    expect(f.doc()).toBe("intro\n\n---\n\nafter");
  });

  it("writes a table with a header row, a rule and empty body rows", () => {
    const f = fakeView("", 0, 0);
    insertTable(f.view, 2, 1, "Column");
    expect(f.doc()).toBe(
      "| Column 1 | Column 2 |\n" +
      "| -------- | -------- |\n" +
      "|          |          |",
    );
    // Caret lands after the block, ready to keep writing.
    expect(f.sel()).toEqual([f.doc().length, f.doc().length]);
  });
});
