import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useSlashCommands } from "../useSlashCommands";
vi.mock("../../../lib/mcp/config", () => ({
  isMcpEnabled: () => true,
  readMcpServers: () => [{ id: "one", name: "<script>server</script>", revision: "1", enabled: true }],
}));
vi.mock("../../../lib/platform", () => ({ IS_TAURI: true }));
vi.mock("../../../lib/mcp/client", () => ({ withMcp: vi.fn() }));
vi.mock("../../../stores/appStore", () => ({ useAppStore: { getState: () => ({ openSettings: vi.fn() }) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
function Menu({ draft, image = false }: { draft: string; image?: boolean }) {
  return useSlashCommands("chat", draft, () => {}, image).panel;
}
describe("slash command menu", () => {
  it("lists built-ins with an unavailable image state", () => {
    const html = renderToStaticMarkup(createElement(Menu, { draft: "/" }));
    expect(html).toContain("/help"); expect(html).toContain("/mcp"); expect(html).toContain("/imageGen");
    expect(html).toContain("slash.imageUnavailable");
    expect(html).toContain('disabled=""');
  });
  it("shows an unloaded server rather than inventing a zero tool count, escaping names", () => {
    const html = renderToStaticMarkup(createElement(Menu, { draft: "/mcp" }));
    expect(html).toContain("slash.notLoaded");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("slash.load");
  });
  it("does not cover a completed execution request with suggestions", () => {
    expect(renderToStaticMarkup(createElement(Menu, { draft: "/imageGen draw a tree", image: true }))).toBe("");
  });
});

/** Capture the hook's event boundary without installing a browser-only DOM shim. */
function composer(draft: string) {
  let result!: ReturnType<typeof useSlashCommands>;
  const setDraft = vi.fn();
  function Harness() {
    result = useSlashCommands("chat", draft, setDraft, true);
    return result.panel;
  }
  renderToStaticMarkup(createElement(Harness));
  const key = (name: string, shiftKey = false) => ({ key: name, shiftKey, preventDefault: vi.fn() });
  return { result, setDraft, key };
}

describe("slash composer interactions", () => {
  it("preserves multiline requests when Enter inserts a menu command", () => {
    const { result, setDraft, key } = composer("/mcp  paint a tree\n  with birds\n");
    const event = key("Enter");
    expect(result.keyDown(event as never, false)).toBe(true);
    expect(setDraft).toHaveBeenCalledWith("/mcp  paint a tree\n  with birds\n");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it.each(["/Users/me/story.md please summarize", "/tmp/story.md", "/ordinary prose"])("sends literal text unchanged: %s", draft => {
    const { result, key } = composer(draft);
    expect(result.prepare()).toBe(draft);
    expect(result.keyDown(key("Enter") as never, false)).toBe(false);
  });

  it("moves forward Tab to the catalogue control but preserves Shift+Tab and IME", () => {
    const { result, key } = composer("/mcp");
    // The real ref points at the rendered panel. Supply the focus boundary here
    // to verify the handler instead of relying on static markup's tab order.
    const panel = result.panel.props.children[0];
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    panel.props.ref.current = { querySelector };
    const forward = key("Tab");
    expect(result.keyDown(forward as never, false)).toBe(true);
    expect(forward.preventDefault).toHaveBeenCalled();
    expect(querySelector).toHaveBeenCalledWith("[data-slash-control]:not(:disabled)");
    expect(focus).toHaveBeenCalledOnce();
    expect(result.keyDown(key("Tab", true) as never, false)).toBe(false);
    expect(result.keyDown(key("Tab") as never, true)).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("keeps unavailable image commands blocked while allowing ordinary text", () => {
    let prepare!: () => string | null;
    function Harness() {
      const commands = useSlashCommands("chat", "/imageGen a tree", () => {}, false);
      prepare = commands.prepare;
      return commands.panel;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(prepare()).toBeNull();
  });
});
