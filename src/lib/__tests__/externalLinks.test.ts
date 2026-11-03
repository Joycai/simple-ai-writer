import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { assistantLinkPath, installExternalLinkNavigation } from "../externalLinks";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function setup(inAssistant = false, basePath?: string) {
  const openFile = vi.fn();
  const listeners = new Map<string, (event: MouseEvent) => void>();
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: (event: MouseEvent) => void, capture = false) => listeners.set(`${type}:${capture}`, listener),
    removeEventListener: (type: string, _listener: unknown, capture = false) => listeners.delete(`${type}:${capture}`),
  });
  const dispose = installExternalLinkNavigation({ projectPath: () => "/project", openFile });
  const click = (href: string | null, options: Partial<MouseEvent> = {}) => {
    const event = {
      type: "click", button: 0, defaultPrevented: false,
      target: { closest: (selector: string) => selector === "[data-ai-surface]" ? (inAssistant ? {} : null) : href === null ? null : { getAttribute: () => href, closest: (selector: string) => selector === "[data-document-base]" ? (basePath ? { getAttribute: () => basePath } : null) : inAssistant ? {} : null } },
      ...options, preventDefault: vi.fn(() => { event.defaultPrevented = true; }),
    };
    listeners.get(`${event.type}:true`)?.(event as unknown as MouseEvent);
    listeners.get(`${event.type}:false`)?.(event as unknown as MouseEvent);
    return event;
  };
  return { click, dispose, listeners, openFile };
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
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    dispose();
    expect(listeners.size).toBe(0);
  });
});


describe("assistant file navigation", () => {
  it.each([
    ["reports/result.html", "/project/reports/result.html"],
    ["./%E6%8A%A5%E5%91%8A.html#part", "/project/报告.html"],
    ["/project/result.html?view=1", "/project/result.html"],
    ["file:///project/result.html", "/project/result.html"],
  ])("opens %s through app state without navigating the webview", (href, path) => {
    const { click, openFile } = setup(true);
    const event = click(href);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(event.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(openFile.mock.invocationCallOrder[0]);
  });

  it("handles external links once even when capture and bubble both run", () => {
    const { click } = setup(true);
    expect(click("https://example.com").preventDefault).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com");
  });

  it.each(["../outside.html", "%2e%2e/outside.html", "file:///tmp/outside.html", ".ai-writer/project.db", "javascript:alert(1)"])("cancels refused link %s", (href) => {
    const { click, openFile } = setup(true);
    expect(click(href).preventDefault).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("resolves Windows paths and refuses local links without a project", () => {
    expect(assistantLinkPath("C:/project", "file:///C:/project/report.html")).toBe("C:/project/report.html");
    expect(assistantLinkPath(null, "report.html")).toBeNull();
    expect(assistantLinkPath("/project", "file://remote/report.html")).toBeNull();
  });
});


describe("Markdown document file navigation", () => {
  it.each(["report.pdf", "image.png", "report.docx", "table.xlsx", "slides.pptx", "archive.zip", "notes.md", "page.html"])("opens %s through app navigation", (name) => {
    const { click, openFile } = setup(false, "/project/chapters");
    const event = click(`../assets/${name}?download=1#page=2`);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledExactlyOnceWith(`/project/assets/${name}`);
    expect(event.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(openFile.mock.invocationCallOrder[0]);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("decodes paths, handles middle clicks, and preserves document anchors", () => {
    const { click, openFile } = setup(false, "/project/chapters");
    click("./附件%20一.pdf", { type: "auxclick", button: 1 });
    expect(openFile).toHaveBeenCalledExactlyOnceWith("/project/chapters/附件 一.pdf");
    expect(click("#heading").preventDefault).not.toHaveBeenCalled();
  });

  it.each(["../../outside.pdf", "file:///outside.pdf", "custom:payload"])("blocks unsafe navigation %s", (href) => {
    const { click, openFile } = setup(false, "/project/chapters");
    expect(click(href).preventDefault).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps the webview in place when opening a local file fails", async () => {
    const { click, openFile } = setup(false, "/project/chapters");
    openFile.mockRejectedValueOnce(new Error("missing"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(click("missing.pdf").preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });
});
