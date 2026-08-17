import { describe, it, expect } from "vitest";
import {
  allRows,
  flattenVisible,
  isDirOpen,
  pruneNested,
  pruneSelection,
  rangeBetween,
  type TreeNodeLike,
} from "../fs/selection";

const ROOT = "/p";

/** Terse tree builder: `dir("卷一", file("第1章.md"))`. */
const dir = (path: string, ...children: TreeNodeLike[]): TreeNodeLike => ({
  path: `${ROOT}/${path}`,
  is_dir: true,
  children,
});
const file = (path: string): TreeNodeLike => ({ path: `${ROOT}/${path}`, is_dir: false });

/**
 *  /p
 *  ├ 卷一            (depth 0 — open by default)
 *  │ ├ 第1章.md
 *  │ └ 附录          (depth 1 — closed by default)
 *  │   └ 设定.md
 *  ├ 卷二
 *  │ └ 第2章.md
 *  └ 大纲.md
 */
const TREE: TreeNodeLike[] = [
  dir("卷一", file("卷一/第1章.md"), dir("卷一/附录", file("卷一/附录/设定.md"))),
  dir("卷二", file("卷二/第2章.md")),
  file("大纲.md"),
];

describe("isDirOpen", () => {
  it("opens top-level folders and closes deeper ones by default", () => {
    expect(isDirOpen(undefined, 0)).toBe(true);
    expect(isDirOpen(undefined, 1)).toBe(false);
  });

  it("lets an explicit choice win at any depth", () => {
    expect(isDirOpen(false, 0)).toBe(false);
    expect(isDirOpen(true, 3)).toBe(true);
  });
});

describe("flattenVisible", () => {
  it("walks open folders and stops at closed ones", () => {
    expect(flattenVisible(TREE, {}).map((r) => r.path)).toEqual([
      `${ROOT}/卷一`,
      `${ROOT}/卷一/第1章.md`,
      `${ROOT}/卷一/附录`, // its own row shows; 设定.md does not
      `${ROOT}/卷二`,
      `${ROOT}/卷二/第2章.md`,
      `${ROOT}/大纲.md`,
    ]);
  });

  it("follows the author's explicit expand/collapse", () => {
    const paths = flattenVisible(TREE, {
      [`${ROOT}/卷一/附录`]: true,
      [`${ROOT}/卷二`]: false,
    }).map((r) => r.path);
    expect(paths).toContain(`${ROOT}/卷一/附录/设定.md`);
    expect(paths).not.toContain(`${ROOT}/卷二/第2章.md`);
  });

  it("reports whether each row is a folder", () => {
    const rows = flattenVisible(TREE, {});
    expect(rows.find((r) => r.path === `${ROOT}/卷一`)?.isDir).toBe(true);
    expect(rows.find((r) => r.path === `${ROOT}/大纲.md`)?.isDir).toBe(false);
  });
});

describe("rangeBetween", () => {
  const rows = flattenVisible(TREE, {});

  it("spans the visible rows between the two endpoints, inclusive", () => {
    expect(rangeBetween(rows, `${ROOT}/卷一/第1章.md`, `${ROOT}/卷二`)).toEqual([
      `${ROOT}/卷一/第1章.md`,
      `${ROOT}/卷一/附录`,
      `${ROOT}/卷二`,
    ]);
  });

  it("reads the same in either direction", () => {
    const down = rangeBetween(rows, `${ROOT}/卷一`, `${ROOT}/大纲.md`);
    const up = rangeBetween(rows, `${ROOT}/大纲.md`, `${ROOT}/卷一`);
    expect(up).toEqual(down);
  });

  it("never reaches into a collapsed folder", () => {
    // 设定.md sits between 第1章.md and 卷二 on disk but is not on screen.
    expect(rangeBetween(rows, `${ROOT}/卷一`, `${ROOT}/卷二`)).not.toContain(
      `${ROOT}/卷一/附录/设定.md`,
    );
  });

  it("falls back to the clicked row when the anchor is no longer visible", () => {
    // The author shift-clicked after collapsing the folder the anchor was in:
    // selecting a span they cannot see would be worse than selecting one row.
    expect(rangeBetween(rows, `${ROOT}/卷一/附录/设定.md`, `${ROOT}/卷二`)).toEqual([
      `${ROOT}/卷二`,
    ]);
  });

  it("selects nothing when the clicked row itself is gone", () => {
    expect(rangeBetween(rows, `${ROOT}/卷一`, `${ROOT}/已删除.md`)).toEqual([]);
  });
});

describe("pruneNested", () => {
  it("drops entries that travel inside another selected folder", () => {
    const sources = [
      { path: `${ROOT}/卷一`, isDir: true },
      { path: `${ROOT}/卷一/第1章.md`, isDir: false },
      { path: `${ROOT}/卷一/附录/设定.md`, isDir: false },
      { path: `${ROOT}/大纲.md`, isDir: false },
    ];
    expect(pruneNested(sources).map((s) => s.path)).toEqual([
      `${ROOT}/卷一`,
      `${ROOT}/大纲.md`,
    ]);
  });

  it("keeps siblings whose names merely share a prefix", () => {
    const sources = [
      { path: `${ROOT}/卷一`, isDir: true },
      { path: `${ROOT}/卷一-备份`, isDir: true },
    ];
    expect(pruneNested(sources)).toHaveLength(2);
  });

  it("leaves a flat selection untouched", () => {
    const sources = [
      { path: `${ROOT}/卷一/第1章.md`, isDir: false },
      { path: `${ROOT}/卷二/第2章.md`, isDir: false },
    ];
    expect(pruneNested(sources)).toHaveLength(2);
  });
});

describe("pruneSelection", () => {
  const rows = allRows(TREE);

  it("keeps paths that still exist, including collapsed ones", () => {
    const kept = pruneSelection(
      new Set([`${ROOT}/卷一/附录/设定.md`, `${ROOT}/大纲.md`]),
      rows,
    );
    expect([...kept].sort()).toEqual([`${ROOT}/卷一/附录/设定.md`, `${ROOT}/大纲.md`].sort());
  });

  it("drops paths the last operation moved or deleted", () => {
    const kept = pruneSelection(new Set([`${ROOT}/大纲.md`, `${ROOT}/没了.md`]), rows);
    expect([...kept]).toEqual([`${ROOT}/大纲.md`]);
  });
});

describe("allRows", () => {
  it("reaches every entry regardless of expansion", () => {
    expect(allRows(TREE)).toHaveLength(7);
  });
});
