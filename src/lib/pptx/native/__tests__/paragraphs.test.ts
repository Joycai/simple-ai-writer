import { expect, it } from 'vitest';
import { normalizeParagraphs } from '../paragraphs';
it('keeps the first paragraph style and every font run in each paragraph', () => {
  const first = '<a:pPr marL="228600"><a:buChar char="•"/></a:pPr>';
  const run = '<a:r><a:t>中 / A &amp; B</a:t></a:r>';
  const xml = `<a:p>${first}${run}<a:pPr><a:buNone/></a:pPr>${run}</a:p><a:p><a:pPr/>${run}<a:pPr/>${run}</a:p>`;
  const result = normalizeParagraphs(xml);
  expect(result).toBe(`<a:p>${first}${run}${run}</a:p><a:p><a:pPr/>${run}${run}</a:p>`);
  expect(normalizeParagraphs(result)).toBe(result);
});
it('leaves empty and single-run paragraphs intact', () => {
  const xml = '<a:p/><a:p><a:pPr/><a:r><a:t>&lt;a:pPr/&gt;</a:t></a:r></a:p>';
  expect(normalizeParagraphs(xml)).toBe(xml);
});
