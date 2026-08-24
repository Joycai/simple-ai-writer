/**
 * read_workflow 工具与 briefing 注入——工作流卡两级渐进披露的接线层。
 *
 * fileio 全部 mock：readDir 抛错 = 项目没有 workflows 目录，此时清单里站着
 * 内置卡（开箱即用正是靠这条路）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const hit = files.get(p);
    if (hit === undefined) throw new Error(`no file: ${p}`);
    return hit;
  }),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
  writeBinaryFile: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  readDir: vi.fn(async (dir: string) => {
    const names = [...files.keys()]
      .filter((p) => p.startsWith(`${dir}/`))
      .map((p) => p.slice(dir.length + 1))
      .filter((n) => !n.includes("/"));
    if (!names.length) throw new Error(`no dir: ${dir}`);
    return names.map((name) => ({ name, isDirectory: false }));
  }),
}));
vi.mock("../../project", () => ({ readDirRecursive: vi.fn(async () => []) }));
vi.mock("../../../i18n", () => ({
  default: { t: (key: string, params?: Record<string, string>) => `${key}|${params?.roster ?? ""}` },
}));

import { executeRegisteredTool, type ToolContext } from "../registry";
import { BUILTIN_WORKFLOWS, workflowBriefingSection } from "../../workflow";

const ctx = { projectPath: "/p", loreIndex: {}, multimodal: false } as ToolContext;

const call = async (args: object) =>
  executeRegisteredTool(
    { id: "c1", name: "read_workflow", arguments: JSON.stringify(args) },
    ["read_workflow"],
    ctx,
  );

const readWorkflow = async (workflow?: string) =>
  call(workflow === undefined ? {} : { workflow });

beforeEach(() => files.clear());

describe("read_workflow", () => {
  it("零项目文件时读得到内置卡 —— 开箱即用", async () => {
    const r = await readWorkflow(BUILTIN_WORKFLOWS[0].name);
    expect(r.content).toContain(BUILTIN_WORKFLOWS[0].name);
    expect(r.content).toContain("translate 工具");
  });

  it("项目同 id 文件整张覆盖内置卡的正文", async () => {
    files.set(
      `/p/.ai-writer/workflows/${BUILTIN_WORKFLOWS[0].id}.md`,
      "---\nname: 我的翻译流程\n---\n改过的步骤。",
    );
    const r = await readWorkflow("我的翻译流程");
    expect(r.content).toContain("改过的步骤。");
    // 内置名字随覆盖一起消失——同 id 只有一张卡。
    expect((await readWorkflow(BUILTIN_WORKFLOWS[0].name)).content).toContain("Error");
  });

  it("名字不存在时报可用清单，而不是干巴巴的失败", async () => {
    const r = await readWorkflow("不存在的卡");
    expect(r.content).toContain("Error");
    expect(r.content).toContain(BUILTIN_WORKFLOWS[0].name);
  });

  it("缺 workflow 参数是参数错误", async () => {
    expect((await readWorkflow()).content).toContain("'workflow' argument is required");
  });

  // 参数在 1.28 改名 name → workflow（与「寻址参数一律以被寻址物命名」对齐）。
  // 旧拼法仍然接受：改名当天在飞的会话不该因此开始报错。
  it("旧拼法 name 仍然读得到同一张卡", async () => {
    const r = await call({ name: BUILTIN_WORKFLOWS[0].name });
    expect(r.content).toContain(BUILTIN_WORKFLOWS[0].name);
    expect(r.content).not.toContain("Error");
  });
});

describe("workflowBriefingSection", () => {
  it("清单进 i18n 模板的 {{roster}}，一行一卡", async () => {
    const s = await workflowBriefingSection("/p");
    expect(s.startsWith("ai.instructions.workflows|")).toBe(true);
    expect(s).toContain(`- ${BUILTIN_WORKFLOWS[0].name} — `);
  });

  it("全部停用时返回空串 —— 调用方据此省掉整段", async () => {
    for (const b of BUILTIN_WORKFLOWS) {
      files.set(`/p/.ai-writer/workflows/${b.id}.md`, "---\ndisabled: true\n---\n");
    }
    expect(await workflowBriefingSection("/p")).toBe("");
  });
});
