import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installExternalLinkNavigation } from "../externalLinks";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function setup() {
  const listeners = new Map<string, (event: MouseEvent) => void>();
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: (event: MouseEvent) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  const dispose = installExternalLinkNavigation();
  const click = (href: string | null, options: Partial<MouseEvent> = {}) => {
    const event = {
      type: "click", button: 0, defaultPrevented: false,
      target: { closest: () => href === null ? null : { getAttribute: () => href } },
      ...options, preventDefault: vi.fn(),
    };
    listeners.get(event.type)?.(event as unknown as MouseEvent);
    return event;
  };
  return { click, dispose, listeners };
}

describe("external link navigation", () => {
  it.each(["https://example.com/path?q=1#part", "http://localhost:8080", "mailto:author@example.com"])("opens %s outside the webview", (href) => {
    const { click } = setup();
    const event = click(href);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(href);
    expect(event.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openUrl).mock.invocationCallOrder[0]);
  });

  it("handles modified and middle clicks, and protocol-relative links", () => {
    const { click } = setup();
    click("//example.com", { ctrlKey: true, metaKey: true });
    click("https://example.org", { type: "auxclick", button: 1 });
    expect(openUrl).toHaveBeenNthCalledWith(1, "https://example.com");
    expect(openUrl).toHaveBeenNthCalledWith(2, "https://example.org");
  });

  it("leaves internal links, unsupported protocols, handled events and right clicks alone", () => {
    const { click } = setup();
    for (const href of [null, "", "#heading", "../notes.md", "file:///tmp/a", "javascript:alert(1)"]) {
      expect(click(href).preventDefault).not.toHaveBeenCalled();
    }
    expect(click("https://example.com", { defaultPrevented: true }).preventDefault).not.toHaveBeenCalled();
    expect(click("https://example.com", { type: "auxclick", button: 2 }).preventDefault).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps navigation cancelled when the OS opener rejects and cleans up listeners", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { click, dispose, listeners } = setup();
    expect(click("https://example.com").preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledOnce();
    dispose();
    expect(listeners.size).toBe(0);
  });
});
