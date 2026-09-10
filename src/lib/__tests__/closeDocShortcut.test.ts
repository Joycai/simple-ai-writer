/**
 * 「关闭」这一族的三层分工，以及它们互不串台。
 *
 * 关文档 ⌘W · 关项目 ⇧⌘W · 关窗口 ⌥⌘W（仅 mac，实现在 `windowmenu.rs`，注册表里
 * 只留一行说明）。三条都在 W 上，所以这里逐条钉住「谁答应谁不答应」——它们错起来
 * 的样子是作者想关一篇稿子、结果整个项目没了。
 *
 * `matchesCombo` 在 mac 上把 Control 当独立修饰键严格比对，这条也一并测：没有它，
 * 每个 plain-⌘ 绑定都会顺带答应自己的 ⌃⌘ 变体。
 */
import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMac: true }));
vi.mock("../platform", () => ({
  get IS_MAC() { return platform.isMac; },
  IS_TAURI: false,
  MOD_KEY: "⌘",
  MOD_K: "⌘K",
}));

const { CLOSE_DOC_COMBOS, SHORTCUTS, combosLabel, matchesCombo } = await import("../shortcuts");

/** A keydown as the global listener would see it. */
function press(p: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; key: string }): KeyboardEvent {
  return {
    key: p.key,
    metaKey: !!p.meta,
    ctrlKey: !!p.ctrl,
    shiftKey: !!p.shift,
    altKey: !!p.alt,
  } as KeyboardEvent;
}

const closesDoc = (e: KeyboardEvent) => CLOSE_DOC_COMBOS.some((c) => matchesCombo(e, c));
/** ProjectRow 挂的那一条，原样抄在这里——它是这一族的第二层。 */
const CLOSE_PROJECT = { mod: true, shift: true, key: "w" } as const;
/** windowmenu.rs 的菜单项，注册表里那一行是它的影子。 */
const CLOSE_WINDOW = { mod: true, alt: true, key: "w" } as const;

describe("关闭三层（mac）", () => {
  it("⌘W 只关文档", () => {
    const e = press({ meta: true, key: "w" });
    expect(closesDoc(e)).toBe(true);
    expect(matchesCombo(e, CLOSE_PROJECT)).toBe(false);
    expect(matchesCombo(e, CLOSE_WINDOW)).toBe(false);
  });

  it("⇧⌘W 只关项目", () => {
    const e = press({ meta: true, shift: true, key: "w" });
    expect(closesDoc(e)).toBe(false);
    expect(matchesCombo(e, CLOSE_PROJECT)).toBe(true);
    expect(matchesCombo(e, CLOSE_WINDOW)).toBe(false);
  });

  it("⌥⌘W 只关窗口", () => {
    const e = press({ meta: true, alt: true, key: "w" });
    expect(closesDoc(e)).toBe(false);
    expect(matchesCombo(e, CLOSE_PROJECT)).toBe(false);
    expect(matchesCombo(e, CLOSE_WINDOW)).toBe(true);
  });

  it("⌃⌘W 谁也不关", () => {
    // 上一版给 mac 加过这条后备（那时 ⌘W 被系统菜单占着）。菜单让位之后它就该消失，
    // 而不是留成一个没人记得的第二绑定。
    const e = press({ meta: true, ctrl: true, key: "w" });
    expect(closesDoc(e)).toBe(false);
    expect(matchesCombo(e, CLOSE_PROJECT)).toBe(false);
    expect(matchesCombo(e, CLOSE_WINDOW)).toBe(false);
  });

  it("严格比对：⌃⌘K 不再被当作 ⌘K", () => {
    expect(matchesCombo(press({ meta: true, ctrl: true, key: "k" }), { mod: true, key: "k" })).toBe(false);
    expect(matchesCombo(press({ meta: true, key: "k" }), { mod: true, key: "k" })).toBe(true);
  });

  it("快捷键表里三层都在，标签各写各的", () => {
    const rows = Object.fromEntries(
      SHORTCUTS.filter((s) => ["closeDoc", "filesCloseProject", "closeWindow"].includes(s.id))
        .map((s) => [s.id, s.combo ? combosLabel([s.combo]) : s.keysLabel]),
    );
    expect(rows).toEqual({ closeDoc: "⌘W", filesCloseProject: "⌘⇧W", closeWindow: "⌘⌥W" });
  });
});

describe("关闭三层（非 mac）", () => {
  it("只有前两层，且关窗口那一行不出现在表里", async () => {
    platform.isMac = false;
    vi.resetModules();
    const m = await import("../shortcuts");
    try {
      expect(m.CLOSE_DOC_COMBOS).toEqual([{ mod: true, key: "w" }]);
      expect(m.combosLabel(m.CLOSE_DOC_COMBOS)).toBe("Ctrl+W");
      // 关窗口是 mac 菜单的事；Windows/Linux 上窗口按钮和 Alt+F4 各就各位。
      expect(m.SHORTCUTS.some((s) => s.id === "closeWindow")).toBe(false);
      // 关键的反面：ctrl 那条规则在这里必须**跳过**而不是判 false，
      // 否则每一个 Windows 绑定都会当场失灵。
      expect(m.matchesCombo(press({ ctrl: true, key: "w" }), { mod: true, key: "w" })).toBe(true);
      expect(m.matchesCombo(press({ ctrl: true, key: "k" }), { mod: true, key: "k" })).toBe(true);
    } finally {
      platform.isMac = true;
      vi.resetModules();
    }
  });
});
