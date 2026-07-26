import { describe, it, expect } from "vitest";
import { EditorState, type StateEffect, type TransactionSpec } from "@codemirror/state";
import {
  aiTargetField,
  clearAiTarget,
  setAiTargetEnd,
  setAiTargetStart,
} from "../editor/aiTarget";

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [aiTargetField] });
}

function apply(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update(spec).state;
}

function effect(state: EditorState, e: StateEffect<unknown>): EditorState {
  return apply(state, { effects: e });
}

/** The marked span's current text — what a consumer would actually act on. */
function markedText(state: EditorState): string | null {
  const range = state.field(aiTargetField);
  if (!range || range.to === null) return null;
  return state.sliceDoc(range.from, range.to);
}

const DOC = "第一段。\n\n第二段。\n\n第三段。";
const SECOND = DOC.indexOf("第二段。");

describe("aiTargetField", () => {
  it("is empty until both ends are marked", () => {
    let state = stateWith(DOC);
    expect(state.field(aiTargetField)).toBeNull();

    state = effect(state, setAiTargetStart.of(SECOND));
    // Half-marked: a start with no end is deliberately not a usable target.
    expect(state.field(aiTargetField)).toEqual({ from: SECOND, to: null });
    expect(markedText(state)).toBeNull();

    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    expect(markedText(state)).toBe("第二段。");
  });

  it("swaps the ends when they are marked out of order", () => {
    let state = stateWith(DOC);
    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    state = effect(state, setAiTargetStart.of(SECOND));
    expect(markedText(state)).toBe("第二段。");

    // …and the other way round: end marked before the existing start.
    let back = stateWith(DOC);
    back = effect(back, setAiTargetStart.of(SECOND + 4));
    back = effect(back, setAiTargetEnd.of(SECOND));
    expect(markedText(back)).toBe("第二段。");
  });

  it("keeps naming the same prose when text above it is edited", () => {
    // The reason the range lives in editor state at all: a bare pair of offsets
    // would now be pointing four characters short of the passage.
    let state = stateWith(DOC);
    state = effect(state, setAiTargetStart.of(SECOND));
    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    state = apply(state, { changes: { from: 0, insert: "新增开头。\n\n" } });
    expect(markedText(state)).toBe("第二段。");
  });

  it("grows with text inserted inside it", () => {
    let state = stateWith(DOC);
    state = effect(state, setAiTargetStart.of(SECOND));
    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    state = apply(state, { changes: { from: SECOND + 3, insert: "又及" } });
    expect(markedText(state)).toBe("第二段又及。");
  });

  it("does not swallow text typed against either edge", () => {
    let state = stateWith(DOC);
    state = effect(state, setAiTargetStart.of(SECOND));
    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    state = apply(state, { changes: { from: SECOND, insert: "前" } });
    expect(markedText(state)).toBe("第二段。");

    const end = state.field(aiTargetField)!.to!;
    state = apply(state, { changes: { from: end, insert: "后" } });
    expect(markedText(state)).toBe("第二段。");
  });

  it("survives its own prose being deleted, collapsing rather than inverting", () => {
    let state = stateWith(DOC);
    state = effect(state, setAiTargetStart.of(SECOND));
    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    state = apply(state, { changes: { from: SECOND, to: SECOND + 4, insert: "" } });
    const range = state.field(aiTargetField)!;
    expect(range.to).toBeGreaterThanOrEqual(range.from);
    expect(markedText(state)).toBe("");
  });

  it("is dropped by clearAiTarget", () => {
    let state = stateWith(DOC);
    state = effect(state, setAiTargetStart.of(SECOND));
    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    state = effect(state, clearAiTarget.of(null));
    expect(state.field(aiTargetField)).toBeNull();
  });

  it("clears even when the clear rides along with a full-document replace", () => {
    // Exactly what a file switch dispatches. Mapping a range across a
    // replace-everything change leaves offsets pointing at unrelated prose.
    let state = stateWith(DOC);
    state = effect(state, setAiTargetStart.of(SECOND));
    state = effect(state, setAiTargetEnd.of(SECOND + 4));
    state = apply(state, {
      changes: { from: 0, to: state.doc.length, insert: "另一章的正文。" },
      effects: clearAiTarget.of(null),
    });
    expect(state.field(aiTargetField)).toBeNull();
  });
});
