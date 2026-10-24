import { expect, it } from 'vitest';
import { bundleDependencies } from '../bundleDependencies';
import { pathKey } from '../../paths';

function report(body: string, extra: Record<string, string> = {}, root = '/bundle') {
  const markdown = new Map(Object.entries({
    'people/hero/index.md': '---\nname: Hero\naliases: ["Champion"]\ncollections: ["Not a dependency"]\n---\n' + body,
    ...extra,
  }).map(([p, raw]) => [`${root}/${p}`, raw]));
  return bundleDependencies(root, new Set([...markdown.keys(), `${root}/people/hero/map a.png`].map(pathKey)), markdown);
}

it('recognizes included names, aliases, path citations and cross-entry local links', () => {
  expect(report('[[lore:HERO]] [[lore:champion|label]] [[lore:people/hero]] [[lore:Friend]]\n[friend](../friend/index.md#part) ![map](map%20a.png)', {
    'people/friend/index.md': '---\nname: Friend\n---\nHello',
  })).toEqual([]);
});

it('reports missing citations and links from facets, nested markdown and galleries without reading outside', () => {
  expect(report('[[lore:Missing]] [[lore:Missing]]', {
    'people/hero/facet.md': '[ref][r]\n\n[r]: ../../absent/a.md "title"',
    'people/hero/nested/note.md': '![map](../../../outside.png)',
    'people/hero/images.md': '## missing.png\nA picture',
  })).toEqual([
    { source: 'people/hero/index.md', target: 'Missing', kind: 'citation' },
    { source: 'people/hero/facet.md', target: '../../absent/a.md', kind: 'file' },
    { source: 'people/hero/nested/note.md', target: '../../../outside.png', kind: 'file' },
    { source: 'people/hero/images.md', target: 'missing.png', kind: 'file' },
  ]);
});

it('ignores code examples, anchors, web and data links', () => {
  expect(report('`[[lore:Missing]]`\n```md\n[local](missing.md)\n```\n[web](https://example.com) [mail](mailto:a@example.com) [here](#here) ![inline](data:image/png;base64,YQ==)')).toEqual([]);
});

it('warns on absolute local paths even if their original target is exported', () => {
  expect(report('[file](/original/people/hero/index.md)')).toEqual([
    { source: 'people/hero/index.md', target: '/original/people/hero/index.md', kind: 'file' },
  ]);
});

it('normalizes relative paths and Windows comparisons without treating sibling prefixes as included', () => {
  expect(report('[map](./nested/../map%20a.png) [missing](../hero-other/map.png)', {}, 'C:/bundle')).toEqual([
    { source: 'people/hero/index.md', target: '../hero-other/map.png', kind: 'file' },
  ]);
});

it('handles native Windows snapshot paths and frontmatter cover files', () => {
  const markdown = new Map([
    ['C:\\bundle\\people\\hero\\index.md', '---\nname: Hero\ncover: missing.png\n---\n[[lore:people/hero]] [map](MAP.png)'],
  ]);
  expect(bundleDependencies('C:/bundle', new Set(['c:/bundle/people/hero/map.png']), markdown)).toEqual([
    { source: 'people/hero/index.md', target: 'missing.png', kind: 'file' },
  ]);
});

it('treats gallery and cover filenames as raw paths rather than URL-encoded Markdown', () => {
  const root = '/bundle';
  const markdown = new Map([
    [root + '/people/hero/index.md', '---\ncover: #portrait%.png\n---\n'],
    [root + '/people/hero/images.md', '## #portrait%.png\nPicture'],
  ]);
  expect(bundleDependencies(root, new Set([root + '/people/hero/#portrait%.png']), markdown)).toEqual([]);
});
