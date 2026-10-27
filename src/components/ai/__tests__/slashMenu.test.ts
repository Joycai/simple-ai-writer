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
