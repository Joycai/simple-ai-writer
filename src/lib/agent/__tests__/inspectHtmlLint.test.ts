/**
 * `inspect_html` carries the source check beside the measured report.
 *
 * The measured half needs a browser and is not testable here; the harvest is
 * mocked to a clean deck so what these pin is the *seam*: the source findings
 * come after the measurement, never instead of it, cost nothing on a clean
 * page, and survive a page that could not be laid out at all — those findings
 * never needed a layout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = new Map<string, string>();
let harvest: () => Promise<unknown> = async () => ({ canvas: { width: 1280, height: 720 }, slides: [{ blocks: [], degraded: [] }] });

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
    return fs.get(p)!;
  }),
  fileExists: vi.fn(async (p: string) => fs.has(p)),
}));
vi.mock("../../pptx/harvest", () => ({ harvestDeck: () => harvest() }));

import { inspectHtmlTool } from "../htmlTools";
import type { ToolContext } from "../registry";

const PROJECT = "/proj";
const PAGE = "/proj/deck.html";
const ctx = () => ({ projectPath: PROJECT, loreIndex: {}, multimodal: false }) as unknown as ToolContext;

const measuredHeader = /^\/proj\/deck\.html: 1 slide\(s\) at 1280×720px/;

beforeEach(() => {
  fs.clear();
  harvest = async () => ({ canvas: { width: 1280, height: 720 }, slides: [{ blocks: [], degraded: [] }] });
});

describe("inspect_html + source check", () => {
  it("adds nothing for a page that converts as it looks", async () => {
    fs.set(PAGE, `<style>.slide{font-family:Arial}</style><section class="slide"><p>hi</p></section>`);
    const { content } = await inspectHtmlTool("c1", { path: PAGE }, ctx());
    expect(content).toMatch(measuredHeader);
    expect(content).not.toContain("Found in the SOURCE");
  });

  it("appends the source findings after the measured report", async () => {
    fs.set(PAGE, `<style>\nli::before{content:"•"}\n</style><section class="slide"><ul><li>a</li></ul></section>`);
    const { content } = await inspectHtmlTool("c1", { path: PAGE }, ctx());
    const [measured, source] = content.split("\n\n");
    expect(measured).toMatch(measuredHeader);
    expect(measured).toContain("Nothing is outside its slide");
    expect(source).toMatch(/^Found in the SOURCE/);
    expect(source).toContain("LOST line 2: `li::before`");
  });

  it("keeps them when the page could not be laid out", async () => {
    harvest = async () => { throw new Error("timed out"); };
    fs.set(PAGE, `<style>.reveal{opacity:0;animation:in 1s}</style><section class="slide"></section>`);
    const { content } = await inspectHtmlTool("c1", { path: PAGE }, ctx());
    expect(content).toMatch(/^Could not measure \/proj\/deck\.html: timed out/);
    expect(content).toContain("LOST line 1: `.reveal` starts at opacity 0 for an entrance animation");
  });
});
