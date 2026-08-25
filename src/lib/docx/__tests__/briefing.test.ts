/**
 * briefing 里的格式清单。没有它，模型知道 `export_docx` 存在却不知道有哪些格式
 * 可以点名——只能要么永远用默认，要么猜一个 id 然后吃一个错误。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const beta = { on: true };
vi.mock("../flag", () => ({ isDocxExportEnabled: () => beta.on }));

import { BUILTIN_FORMATS } from "../format";
import { docxBriefingSection, docxRoster } from "../briefing";

beforeEach(() => { beta.on = true; });

describe("清单", () => {
  it("一行一套，标出默认那一套", () => {
    const roster = docxRoster(BUILTIN_FORMATS, "gongwen");
    const lines = roster.split("\n");
    expect(lines).toHaveLength(BUILTIN_FORMATS.length);
    // id 必须在，因为模型要拿它去填 format_id
    expect(lines.every((l, i) => l.startsWith(`- ${BUILTIN_FORMATS[i].id} ·`))).toBe(true);
    expect(roster).toContain("公文（默认）");
    // 摘要和列表里的那句是同一个函数产的——同一串数字在三个地方长得一样
    expect(roster).toContain("三号（16 磅）");
    expect(roster).toContain("固定值 28 磅");
  });

  it("只有默认那一套带标记", () => {
    const roster = docxRoster(BUILTIN_FORMATS, "clean");
    expect(roster.match(/（默认）/g)).toHaveLength(1);
  });
});

describe("整段", () => {
  it("Beta 关着就是空串——调用方把整段省掉，零成本", () => {
    beta.on = false;
    expect(docxBriefingSection(BUILTIN_FORMATS, "clean")).toBe("");
  });

  it("一套预设都没有也是空串", () => {
    expect(docxBriefingSection([], "clean")).toBe("");
  });

  it("开着就带上清单和「没点名就别传 format_id」那句", () => {
    const section = docxBriefingSection(BUILTIN_FORMATS, "clean");
    expect(section).toContain("format_id");
    expect(section).toContain("- clean ·");
  });
});
