import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../fs/fileio", () => ({ readDir: vi.fn(), readFile: vi.fn() }));
vi.mock("../../fs/images", () => ({ imageToDataUrl: vi.fn() }));
vi.mock("../../fs/export", () => ({ printHtmlDocument: vi.fn() }));
vi.mock("../../fs/transfer", () => ({ saveTextFileDialog: vi.fn() }));
vi.mock("../../profile", () => ({ findCategory: () => null, categoryLabel: () => "" }));
vi.mock("../../../i18n", () => ({ default: { language: "en", t: (key: string, args?: { file: string }) => key + (args ? `: ${args.file}` : "") } }));
import { readDir, readFile } from "../../fs/fileio";
import { imageToDataUrl } from "../../fs/images";
import { saveTextFileDialog } from "../../fs/transfer";
import { printHtmlDocument } from "../../fs/export";
import { buildEntryPresentation, exportEntryPresentation } from "../presentation";

const address = { id: "alice", category: "characters", dirPath: "/project/.ai-writer/lore/characters/alice" };
let files: Record<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  files = {
    "index.md": '---\nname: Alice <script>alert(1)</script>\naliases: [A, B]\nsummary: A complete portrait\ncollections: [Book One]\ncover: portrait.png\ncustom: Extra field\n---\nBody with **bold** and ![Inline](inline%20image.png).\n\n![Reference][pic]\n\n[pic]: portrait.png\n\n`![code](not-real.png)`\n\n$x^2$\n\n| Key | Value |\n| --- | --- |\n| age | 42 |',
    "secret.md": '---\nfacet: Secret\nmode: manual\npriority: 0\nkeys: [secret]\nslot: history\ngroup: hidden\n---\nEverything in the manual facet.',
    "outfit.md": '---\nfacet: Outfit\nmode: auto\n---\nAll outfit details.',
    "notes.md": 'An ordinary attachment.',
    "images.md": 'Gallery introduction\n\n## portrait.png\nslot: portrait\nFull **caption**.',
    "avatar.png": "", "portrait.png": "", "inline image.png": "", "unlisted.png": "",
  };
  vi.mocked(readDir).mockImplementation(async () => Object.keys(files).map(name => ({ name, isDirectory: false, path: `${address.dirPath}/${name}` })));
  vi.mocked(readFile).mockImplementation(async path => {
    const name = path.slice(address.dirPath.length + 1);
    if (!(name in files)) throw new Error(`Missing ${name}`);
    return files[name];
  });
  vi.mocked(imageToDataUrl).mockImplementation(async path => {
    if (!(path.slice(address.dirPath.length + 1) in files)) throw new Error("Missing image");
    return { dataUrl: `data:image/png;base64,${btoa(path)}`, ext: "png", bytes: new Uint8Array() };
  });
});

describe("entry presentation", () => {
  it("exports every facet, metadata, attachment, avatar and gallery, independent of injection mode", async () => {
    const result = await buildEntryPresentation(address);
    for (const output of [result.html, result.markdown]) {
      for (const value of ["Everything in the manual facet", "All outfit details", "An ordinary attachment", "custom", "Extra field", "Book One", "priority", "hidden", "Gallery introduction", "unlisted.png", "42"]) expect(output).toContain(value);
      expect(output).toContain("data:image/png;base64,");
      expect(output).not.toContain('<script>alert(1)</script>');
    }
    expect(result.html).toContain('href="#part-');
    expect(result.markdown).toContain('<a id="part-');
    expect(result.markdown).toContain("$x^2$");
    expect(result.markdown).toContain("![code](not-real.png)");
    const paths = vi.mocked(imageToDataUrl).mock.calls.map(([path]) => path);
    expect(paths.filter(path => path.endsWith("portrait.png"))).toHaveLength(1);
    expect(paths).toContain(`${address.dirPath}/avatar.png`);
    expect(paths).toContain(`${address.dirPath}/inline image.png`);
    expect(paths.some(path => path.includes("not-real"))).toBe(false);
  });
  it("reads nested attachments and resolves their images relative to their own folder", async () => {
    files["extra/detail.md"] = "Nested content ![detail](detail.png)";
    files["extra/detail.png"] = "";
    vi.mocked(readDir).mockImplementation(async path => path === address.dirPath
      ? [...Object.keys(files).filter(name => !name.includes("/")).map(name => ({ name, isDirectory: false, path: `${path}/${name}` })), { name: "extra", isDirectory: true, path: `${path}/extra` }]
      : ["detail.md", "detail.png"].map(name => ({ name, isDirectory: false, path: `${path}/${name}` })));
    const result = await buildEntryPresentation(address);
    expect(result.markdown).toContain("Nested content");
    expect(imageToDataUrl).toHaveBeenCalledWith(`${address.dirPath}/extra/detail.png`);
  });
  it("stops on a missing gallery image instead of silently filtering it out", async () => {
    delete files["portrait.png"];
    await expect(buildEntryPresentation(address)).rejects.toThrow("imageError");
    expect(saveTextFileDialog).not.toHaveBeenCalled();
  });
  it("stops on unreadable content and missing headword", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("Read failed"));
    await expect(buildEntryPresentation(address)).rejects.toThrow("Read failed");
    delete files["index.md"];
    await expect(buildEntryPresentation(address)).rejects.toThrow("missingIndex");
  });
  it("saves HTML/Markdown and delegates PDF to the native print path", async () => {
    vi.mocked(saveTextFileDialog).mockResolvedValue(null);
    await expect(exportEntryPresentation(address, "html")).resolves.toBeNull();
    expect(saveTextFileDialog).toHaveBeenLastCalledWith(expect.stringContaining("<!DOCTYPE html>"), expect.not.stringContaining("/"), "HTML", ["html"]);
    await exportEntryPresentation(address, "md");
    expect(saveTextFileDialog).toHaveBeenLastCalledWith(expect.stringContaining("data:image/png"), expect.stringMatching(/\.md$/), "Markdown", ["md"]);
    await exportEntryPresentation(address, "pdf");
    expect(printHtmlDocument).toHaveBeenCalledWith(expect.stringContaining("<!DOCTYPE html>"), expect.stringContaining("Alice"));
  });
});
