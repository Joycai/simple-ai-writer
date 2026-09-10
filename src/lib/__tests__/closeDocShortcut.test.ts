/**
 * 关闭文档的绑定，以及它逼出来的那条修饰键规则。
 *
 * mac 的 ⌘W 很可能到不了 webview——应用菜单挂着 `PredefinedMenuItem::close_window`，
 * 原生菜单的 key equivalent 先于页面处理。所以 mac 上多给一条 ⌃⌘W。麻烦在于
 * `matchesCombo` 的 `mod` 是 `metaKey || ctrlKey`：⌃⌘W 按下时它同样为真，plain-⌘
 * 那一条会**一起**答应，两条就分不开了。于是 mac 上把 Control 当成独立修饰键严格
 * 比对；非 mac 不能这么做——那里 Control 就是 mod 本身。
 */
import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMac: true }));
vi.mock("../platform", () => ({
  get IS_MAC() { return platform.isMac; },
  IS_TAURI: false,
  MOD_KEY: "⌘",
  MOD_K: "⌘K",
}));

const { CLOSE_DOC_COMBOS, combosLabel, matchesCombo } = await import("../shortcuts");

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

const fires = (e: KeyboardEvent) => CLOSE_DOC_COMBOS.some((c) => matchesCombo(e, c));

describe("关闭文档的绑定（mac）", () => {
  it("⌘W 与 ⌃⌘W 都关文档", () => {
    expect(fires(press({ meta: true, key: "w" }))).toBe(true);
    expect(fires(press({ meta: true, ctrl: true, key: "w" }))).toBe(true);
  });

  it("两条绑定各自只答应自己那一个和弦", () => {
    const [plain, withCtrl] = CLOSE_DOC_COMBOS;
    // 这一条是整个改动的支点：没有它，plain-⌘ 那条会连 ⌃⌘W 一起接下，
    // 「多给一条绑定」就成了空话。
    expect(matchesCombo(press({ meta: true, ctrl: true, key: "w" }), plain)).toBe(false);
    expect(matchesCombo(press({ meta: true, key: "w" }), withCtrl)).toBe(false);
  });

  it("不碰关闭**项目**的 ⌘⇧W，也不碰单独的 W", () => {
    expect(fires(press({ meta: true, shift: true, key: "w" }))).toBe(false);
    expect(fires(press({ meta: true, alt: true, key: "w" }))).toBe(false);
    expect(fires(press({ key: "w" }))).toBe(false);
  });

  it("严格比对不会误伤别的绑定：⌃⌘K 不再当作 ⌘K", () => {
    expect(matchesCombo(press({ meta: true, ctrl: true, key: "k" }), { mod: true, key: "k" })).toBe(false);
    expect(matchesCombo(press({ meta: true, key: "k" }), { mod: true, key: "k" })).toBe(true);
  });

  it("标签把两条都写出来", () => {
    expect(combosLabel(CLOSE_DOC_COMBOS)).toBe("⌘W / ⌘⌃W");
  });
});

describe("关闭文档的绑定（非 mac）", () => {
  it("只有一条 Ctrl+W —— 那里 Control 就是 mod，⌃⌘W 是敲不出来的和弦", async () => {
    platform.isMac = false;
    vi.resetModules();
    const m = await import("../shortcuts");
    try {
      expect(m.CLOSE_DOC_COMBOS).toHaveLength(1);
      expect(m.combosLabel(m.CLOSE_DOC_COMBOS)).toBe("Ctrl+W");
      // 关键的反面：ctrl 那条规则在这里必须**跳过**而不是判false，
      // 否则每一个 Windows 绑定都会当场失灵。
      expect(m.matchesCombo(press({ ctrl: true, key: "w" }), { mod: true, key: "w" })).toBe(true);
      expect(m.matchesCombo(press({ ctrl: true, key: "k" }), { mod: true, key: "k" })).toBe(true);
    } finally {
      platform.isMac = true;
      vi.resetModules();
    }
  });
});
