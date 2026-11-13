/** A complete reading copy; never uses the AI context selector or its budgets. */
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { readDir, readFile } from "../fs/fileio";
import { imageToDataUrl } from "../fs/images";
import { parseFrontmatter, parseMarkdown, renderMarkdown } from "../fs/markdown";
import { printHtmlDocument } from "../fs/export";
import { saveTextFileDialog } from "../fs/transfer";
import { resolveLinkPath } from "../paths";
import type { LoreEntityAddress } from "./model";
import { parseImagesMd } from "./gallery";
import { CITE_ATTR } from "./citations";
import presentationCss from "./presentation.css?raw";
import { categoryLabel, findCategory } from "../profile";
import i18n from "../../i18n";

export type PresentationFormat = "html" | "md" | "pdf";
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join(" · ") : String(value ?? "");

interface EntryPresentation { title: string; html: string; markdown: string }

/** Read actual files, including non-facet markdown attachments and unlisted images. */
export async function buildEntryPresentation(address: LoreEntityAddress): Promise<EntryPresentation> {
  const files: string[] = [];
  const collect = async (relative = ""): Promise<void> => {
    for (const file of await readDir(`${address.dirPath}${relative ? `/${relative}` : ""}`)) {
      const name = relative ? `${relative}/${file.name}` : file.name;
      if (file.isDirectory) await collect(name);
      else files.push(name);
    }
  };
  await collect();
  const indexFile = files.find(f => f.toLowerCase() === "index.md");
  if (!indexFile) throw new Error(i18n.t("lore.presentation.missingIndex"));
  const index = parseFrontmatter(await readFile(`${address.dirPath}/${indexFile}`));
  const title = text(index.data.name || address.id);
  const category = findCategory(address.category);
  const categoryName = category ? categoryLabel(category, i18n.language?.startsWith("zh") ?? false) : address.category;
  const cache = new Map<string, Promise<string>>();
  const embed = (src: string): Promise<string> => {
    if (/^(https?:|data:)/i.test(src)) return Promise.resolve(src);
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[/\\]/i.test(src)) {
      return Promise.reject(new Error(i18n.t("lore.presentation.imageError", { file: src })));
    }
    const path = resolveLinkPath(address.dirPath, src);
    if (!cache.has(path)) cache.set(path, imageToDataUrl(path).then(r => r.dataUrl).catch(() => {
      throw new Error(i18n.t("lore.presentation.imageError", { file: src }));
    }));
    return cache.get(path)!;
  };
  const prose = async (source: string, folder = "") => {
    const tokens = parseMarkdown(source);
    const replacements = new Map<string, string>();
    const visit = async (list: typeof tokens): Promise<void> => {
      for (const token of list) {
        if (token.type === "image") {
          const src = token.attrGet("src");
          if (src) {
            const url = String(src);
            const relative = folder && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url);
            replacements.set(escape(url), escape(await embed(relative ? `${folder}/${url}` : url)));
          }
        }
        if (token.children) await visit(token.children);
      }
    };
    await visit(tokens);
    return renderMarkdown(source).replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/g,
      (_match, before: string, src: string, after: string) => before + (replacements.get(src) ?? src) + after);
  };
  const metadata = (data: Record<string, unknown>) => Object.keys(data).length
    ? `<table class="metadata"><tbody>${Object.entries(data).map(([k, v]) => `<tr><th>${escape(i18n.t(`lore.presentation.fields.${k}`, { defaultValue: k }))}</th><td>${escape(text(v))}</td></tr>`).join("")}</tbody></table>` : "";
  const photo = async (file: string, caption: string, cls = "") =>
    `<figure class="${cls}"><img src="${escape(await embed(file))}" alt="${escape(file)}"><figcaption>${escape(caption)}</figcaption></figure>`;
  const avatar = files.find(f => /^avatar\.(png|jpe?g|webp)$/i.test(f));
  const imagesFile = files.find(f => f.toLowerCase() === "images.md");
  const gallerySource = imagesFile ? await readFile(`${address.dirPath}/${imagesFile}`) : "";
  const gallery = parseImagesMd(gallerySource);
  // Do not use scanEntity.images: the scanner intentionally drops missing pictures.
  const cover = typeof index.data.cover === "string" && index.data.cover ? index.data.cover : null;
  const parts: string[] = [];
  const toc: string[] = [];
  const section = (id: string, label: string, body: string) => {
    toc.push(`<li><a href="#${id}">${escape(label)}</a></li>`);
    parts.push(`<section id="${id}"><h2>${escape(label)}</h2>${body}</section>`);
  };
  section("overview", i18n.t("lore.presentation.overview"), metadata({ category: address.category, ...index.data }) + await prose(index.content));
  const attachments = files.filter(f => /\.md$/i.test(f) && !/^(index|images)\.md$/i.test(f)).sort((a, b) => a.localeCompare(b));
  for (const [n, file] of attachments.entries()) {
    const parsed = parseFrontmatter(await readFile(`${address.dirPath}/${file}`));
    section(`part-${n}`, text(parsed.data.facet || file.replace(/\.md$/i, "")),
      metadata({ file, ...parsed.data }) + await prose(parsed.content, file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""));
  }
  const pictures: string[] = [];
  for (const img of gallery) {
    pictures.push(await photo(img.file, img.file) + metadata(img.slot ? { slot: img.slot } : {}) + await prose(img.desc));
  }
  const listed = new Set([avatar, cover, ...gallery.map(img => img.file)].filter(Boolean));
  for (const file of files.filter(f => /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(f) && !listed.has(f))) {
    pictures.push(await photo(file, file));
  }
  // Preserve prose preceding the first image block without repeating every caption.
  const galleryIntro = gallerySource.split(/^##\s+.+$/m)[0];
  if (pictures.length || galleryIntro.trim()) {
    section("gallery", i18n.t("lore.presentation.gallery"), await prose(galleryIntro) + pictures.join("\n"));
  }
  const body = `<header>${avatar ? await photo(avatar, i18n.t("lore.presentation.avatar"), "avatar") : ""}<p class="eyebrow">${escape(categoryName)}</p><h1>${escape(title)}</h1>${index.data.summary ? `<p class="summary">${escape(text(index.data.summary))}</p>` : ""}</header>
${cover ? await photo(cover, i18n.t("lore.presentation.cover"), "cover") : ""}
<nav aria-label="${escape(i18n.t("lore.presentation.contents"))}"><h2>${escape(i18n.t("lore.presentation.contents"))}</h2><ol>${toc.join("")}</ol></nav>${parts.join("\n")}`;
  const lang = i18n.language?.startsWith("zh") ? "zh-CN" : "en";
  const html = `<!DOCTYPE html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${presentationCss}</style></head><body><main>${body}</main></body></html>`;
  const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  converter.use(gfm);
  const markdownEscape = converter.escape.bind(converter);
  converter.escape = value => markdownEscape(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Preserve formulas rather than exporting KaTeX's visual/accessibility copies twice.
  converter.addRule("math", {
    filter: node => node.classList.contains("katex") || node.classList.contains("katex-display"),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const source = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? "";
      return element.classList.contains("katex-display") ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
    },
  });
  converter.addRule("citation", {
    filter: node => node.hasAttribute(CITE_ATTR),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      return `[[lore:${element.getAttribute(CITE_ATTR)}|${element.textContent}]]`;
    },
  });
  converter.addRule("sectionAnchor", {
    filter: "section",
    replacement: (content, node) => `\n\n<a id="${(node as HTMLElement).id}"></a>\n\n${content}\n\n`,
  });
  // GFM needs a header row; metadata tables deliberately have row headers instead.
  converter.addRule("metadata", {
    filter: node => node.nodeName === "TABLE" && node.classList.contains("metadata"),
    replacement: (_content, node) => "\n\n" + Array.from((node as HTMLElement).querySelectorAll("tr")).map(row => {
      const cells = row.querySelectorAll("th,td");
      return `- **${converter.escape(cells[0].textContent ?? "")}**: ${converter.escape(cells[1].textContent ?? "")}`;
    }).join("\n") + "\n\n",
  });
  return { title, html, markdown: converter.turndown(body) + "\n" };
}

export async function exportEntryPresentation(address: LoreEntityAddress, format: PresentationFormat): Promise<string | null | void> {
  const result = await buildEntryPresentation(address);
  const filename = result.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 100) || "entry";
  if (format === "pdf") return printHtmlDocument(result.html, result.title);
  return saveTextFileDialog(format === "html" ? result.html : result.markdown, `${filename}.${format}`, format === "html" ? "HTML" : "Markdown", [format]);
}
