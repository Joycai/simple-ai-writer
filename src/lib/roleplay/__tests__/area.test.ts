/**
 * 记忆区的纯逻辑。
 *
 * 最要紧的一条是**条目落盘的形状**：`aliases` 就是关键字，而 `selectLore` 认的正是
 * 这个字段。写错了不会报错，只会让角色再也想不起任何事——最难自查的一类坏法。
 */

import { describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const dirs = new Set<string>();

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }),
  writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
  makeDir: vi.fn(async (p: string) => { dirs.add(p); }),
  fileExists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
  renamePath: vi.fn(),
  readDir: vi.fn(async (p: string) => {
    const kids = new Set<string>();
    for (const d of [...dirs, ...files.keys()]) {
      if (d.startsWith(`${p}/`)) kids.add(d.slice(p.length + 1).split("/")[0]);
    }
    return [...kids].map((name) => ({
      name, path: `${p}/${name}`, isDirectory: !files.has(`${p}/${name}`),
    }));
  }),
}));
vi.mock("../../lore/entity", () => ({ scanEntityFolder: vi.fn(async () => []) }));

import { addAreaEntry, generateAreaId, isValidAreaId } from "../area";

describe("记忆区的条目格式", () => {
  it("关键字落成 aliases —— selectLore 认的就是这个字段", async () => {
    files.clear(); dirs.clear();
    const id = await addAreaEntry("/p", "rp-area-abc", {
      title: "塔上那件事", body: "她说的时候我看着窗外，没有承认。", keys: ["塔", "阿箬"], scene: 3,
    }, 1755000000);
    const md = files.get(`/p/.ai-writer/roleplay/areas/rp-area-abc/history/${id}/index.md`)!;
    expect(md).toContain('aliases: ["塔", "阿箬"]');
    expect(md).toContain('name: "塔上那件事"');
    expect(md).toContain("scene: 3");
    expect(md).toContain("她说的时候我看着窗外");
  });

  it("没给 summary 时取正文首句，不是整段", async () => {
    files.clear(); dirs.clear();
    const id = await addAreaEntry("/p", "rp-area-abc", {
      title: "t", body: "第一句。第二句也在这里。", keys: [], scene: 1,
    }, 0);
    const md = files.get(`/p/.ai-writer/roleplay/areas/rp-area-abc/history/${id}/index.md`)!;
    expect(md).toContain('summary: "第一句。"');
  });

  it("编号顺延，永不复用", async () => {
    files.clear(); dirs.clear();
    const a = await addAreaEntry("/p", "rp-area-abc", { title: "a", body: "b", keys: [], scene: 1 }, 0);
    const b = await addAreaEntry("/p", "rp-area-abc", { title: "c", body: "d", keys: [], scene: 1 }, 0);
    expect(a).toBe("e001");
    expect(b).toBe("e002");
  });

  it("区 id 要校验，不转义 —— 它会拼进文件路径", async () => {
    expect(isValidAreaId(generateAreaId(1755000000000, 0.5))).toBe(true);
    expect(isValidAreaId("../../etc")).toBe(false);
    expect(isValidAreaId("rp-area-")).toBe(false);
    // 异步函数是 reject 不是 throw——校验本身是对的，第一版测试写错了。
    await expect(
      addAreaEntry("/p", "../evil", { title: "", body: "", keys: [], scene: 0 }, 0),
    ).rejects.toThrow("invalid area id");
  });
});
