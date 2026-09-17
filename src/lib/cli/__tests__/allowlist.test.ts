import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = new Map<string, string>();
vi.mock("../../prefs", () => ({
  readPref: vi.fn((k: string) => prefs.get(k)),
  writePref: vi.fn((k: string, v: string) => void prefs.set(k, v)),
}));

import {
  addCliAllowed,
  addCliAllowedAll,
  readCliAllowlist,
  removeCliAllowed,
} from "../allowlist";

beforeEach(() => prefs.clear());

describe("免审批命令清单", () => {
  it("缺席或读不懂＝空", () => {
    expect(readCliAllowlist()).toEqual([]);
    prefs.set("app:cliAllowlist", "{not json");
    expect(readCliAllowlist()).toEqual([]);
    prefs.set("app:cliAllowlist", '{"git":true}');
    expect(readCliAllowlist()).toEqual([]);
  });

  it("加入时规整成同一个键，存在 app:cliAllowlist", () => {
    expect(addCliAllowed(" Git.exe ")).toEqual({ ok: true, name: "git", list: ["git"] });
    expect(addCliAllowed("/usr/bin/gh")).toMatchObject({ ok: true, list: ["git", "gh"] });
    expect(JSON.parse(prefs.get("app:cliAllowlist")!)).toEqual(["git", "gh"]);
  });

  it("重复、空、带参数、会跑代码的都不加", () => {
    addCliAllowed("git");
    expect(addCliAllowed("GIT")).toEqual({ ok: false, name: "git", reason: "duplicate" });
    expect(addCliAllowed("   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(addCliAllowed("git status")).toMatchObject({ ok: false, reason: "invalid" });
    expect(addCliAllowed("bash")).toMatchObject({ ok: false, name: "bash", reason: "runs-code" });
    expect(readCliAllowlist()).toEqual(["git"]);
  });

  it("手改进去的非法项读的时候丢掉，不被信任", () => {
    prefs.set("app:cliAllowlist", JSON.stringify(["git", "bash", "Git", 3, "rm -rf", "pandoc"]));
    expect(readCliAllowlist()).toEqual(["git", "pandoc"]);
  });

  it("一次加几个（卡上的「始终允许 git · gh」），再移除", () => {
    expect(addCliAllowedAll(["git", "gh", "git"])).toEqual(["git", "gh"]);
    expect(removeCliAllowed("Git")).toEqual(["gh"]);
    expect(readCliAllowlist()).toEqual(["gh"]);
  });
});
