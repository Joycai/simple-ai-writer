/**
 * 实验室 → 命令行 → 免审批命令：清单怎么画。
 *
 * 读写与拒收在 lib/cli/__tests__/allowlist.test.ts；这里只钉住界面读到的是
 * 那份清单本身——有就一个程序一个方块、可移除，没有就是空态邀请，建议里不重复
 * 已经列着的。服务端渲染即可，不需要 DOM。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = new Map<string, string>();
vi.mock("../../../../lib/prefs", () => ({
  readPref: vi.fn((k: string) => prefs.get(k)),
  writePref: vi.fn((k: string, v: string) => void prefs.set(k, v)),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "name" in opts ? `${key}:${String(opts.name)}` : key,
  }),
}));

import { CliAllowlist } from "../CliAllowlist";

const html = () => renderToStaticMarkup(createElement(CliAllowlist));

beforeEach(() => prefs.clear());

describe("CliAllowlist", () => {
  it("draws one removable chip per listed program, and no suggestion for them", () => {
    prefs.set("app:cliAllowlist", JSON.stringify(["git", "pandoc"]));
    const out = html();
    expect(out).toContain(">git<");
    expect(out).toContain(">pandoc<");
    expect(out).toContain('aria-label="systemSettings.lab.cliAllowRemove:git"');
    expect(out).not.toContain("systemSettings.lab.cliAllowEmpty");
    expect(out).not.toContain("+ git");
    expect(out).toContain("+ gh");
    expect(out).toContain("+ find");
  });

  it("shows the empty invitation and every suggestion when nothing is listed", () => {
    const out = html();
    expect(out).toContain("systemSettings.lab.cliAllowEmpty");
    expect(out).not.toContain("cliAllowRemove");
    for (const name of ["git", "gh", "find", "pandoc"]) expect(out).toContain(`+ ${name}`);
  });

  it("does not draw an entry the matcher would refuse", () => {
    prefs.set("app:cliAllowlist", JSON.stringify(["bash", "cd", "gh"]));
    const out = html();
    expect(out).toContain(">gh<");
    expect(out).not.toContain(">bash<");
    expect(out).not.toContain(">cd<");
  });

  it("starts with the add button disabled", () => {
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*>systemSettings\.lab\.cliAllowAdd</);
  });
});
