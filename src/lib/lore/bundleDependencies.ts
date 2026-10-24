import type { Token } from 'markdown-it';
import { parseFrontmatter, parseMarkdown } from '../fs/markdown';
import { readDir, readFile } from '../fs/fileio';
import { baseName, decodeLinkSegments, dirName, normalizePathSegments, pathKey, resolveRelativePath } from '../paths';
import { parseImagesMd } from './gallery';

export interface BundleDependency {
  source: string;
  target: string;
  kind: 'citation' | 'file';
}

/** Inspect only the copied snapshot. No outside files are opened or added. */
export async function inspectBundleDependencies(root: string): Promise<BundleDependency[]> {
  const files = new Set<string>();
  const markdown = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readDir(dir)) {
      if (entry.isDirectory) await walk(entry.path);
      else {
        files.add(pathKey(entry.path));
        if (/\.md$/i.test(entry.name)) markdown.set(entry.path, await readFile(entry.path));
      }
    }
  }
  await walk(root);
  return bundleDependencies(root, files, markdown);
}

/** Report unresolved bundle-local references, not whether the destination already has them. */
export function bundleDependencies(root: string, files: ReadonlySet<string>, markdown: ReadonlyMap<string, string>): BundleDependency[] {
  root = normalizePathSegments(root);
  const documents = new Map([...markdown].map(([path, raw]) => [normalizePathSegments(path), raw]));
  const identities = new Set<string>();
  const relative = (path: string) => path.slice(root.length + 1);
  for (const [path, raw] of documents) {
    if (!/^[^/]+\/[^/]+\/index\.md$/i.test(relative(path))) continue;
    const tail = relative(dirName(path));
    const { data } = parseFrontmatter(raw);
    identities.add(tail.toLowerCase());
    identities.add((typeof data.name === 'string' && data.name.trim() ? data.name : baseName(dirName(path))).toLowerCase());
    for (const alias of Array.isArray(data.aliases) ? data.aliases : []) {
      if (typeof alias === 'string') identities.add(alias.toLowerCase());
    }
  }
  const result: BundleDependency[] = [];
  const seen = new Set<string>();
  for (const [path, raw] of documents) {
    const source = relative(path);
    const add = (kind: BundleDependency['kind'], target: string) => {
      const key = JSON.stringify([source, kind, target]);
      if (!seen.has(key)) { seen.add(key); result.push({ source, target, kind }); }
    };
    const link = (target: string, markdownLink = true) => {
      if (!target || (markdownLink && target.startsWith('#'))) return;
      // Web/data/mail links are intentionally external. Absolute local links
      // remain machine-specific even when their original target was selected.
      if (/^(?:https?:|mailto:|data:|tel:)/i.test(target)) return;
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('/')) { add('file', target); return; }
      const clean = markdownLink ? decodeLinkSegments(target.split(/[?#]/, 1)[0]) : target;
      if (!files.has(pathKey(resolveRelativePath(dirName(path), clean)))) add('file', target);
    };
    const visit = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.type === 'lore_cite') {
          const target = String(token.meta?.target ?? '');
          if (!identities.has(target.toLowerCase())) add('citation', target);
        } else if (token.type === 'link_open') link(String(token.attrGet('href') ?? ''));
        else if (token.type === 'image') link(String(token.attrGet('src') ?? ''));
        if (token.children) visit(token.children);
      }
    };
    const { data, content } = parseFrontmatter(raw);
    if (typeof data.cover === 'string') link(data.cover, false);
    visit(parseMarkdown(content));
    if (baseName(path) === 'images.md') for (const image of parseImagesMd(content)) link(image.file, false);
  }
  return result;
}
