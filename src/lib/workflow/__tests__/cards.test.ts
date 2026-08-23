import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOWS } from "../builtins";
import {
  activeWorkflows,
  findWorkflow,
  mergeWorkflows,
  parseWorkflowFile,
  ROSTER_LIMIT,
  workflowRoster,
  type WorkflowCard,
} from "../cards";

function card(id: string, over: Partial<WorkflowCard> = {}): WorkflowCard {
  return {
    id,
    name: id,
    description: `${id} 的描述`,
    body: `${id} 的步骤`,
    builtin: false,
    disabled: false,
    ...over,
  };
}

describe("parseWorkflowFile", () => {
  it("frontmatter 三个字段 + 正文", () => {
    const raw = "---\nname: 翻译输出格式\ndescription: 翻译前先确认格式\n---\n\n1. 先问作者。\n";
    const c = parseWorkflowFile("translate-output", raw);
    expect(c).toEqual({
      id: "translate-output",
      name: "翻译输出格式",
      description: "翻译前先确认格式",
      body: "1. 先问作者。",
      builtin: false,
      disabled: false,
    });
  });

  it("没有 frontmatter 时整个文件当正文，name 缺省用文件主名", () => {
    const c = parseWorkflowFile("my-flow", "直接写的步骤。\n");
    expect(c.name).toBe("my-flow");
    expect(c.description).toBe("");
    expect(c.body).toBe("直接写的步骤。");
  });

  it("disabled 认行式解析器交回的字符串 —— 和 lore 的 dict 同款", () => {
    const c = parseWorkflowFile("x", "---\nname: X\ndisabled: true\n---\n正文");
    expect(c.disabled).toBe(true);
  });

  it("description 压成一行并按清单限长截断 —— 它每轮都进上下文", () => {
    const long = "这一段描述写得非常长，" + "很长".repeat(40);
    const c = parseWorkflowFile("x", `---\ndescription: "${long}"\n---\n正文`);
    expect(c.description.length).toBeLessThanOrEqual(61);
    expect(c.description.endsWith("…")).toBe(true);
  });
});

describe("mergeWorkflows", () => {
  it("零项目文件时清单里站着全部内置卡 —— 开箱即用", () => {
    const merged = mergeWorkflows([]);
    expect(merged.map((c) => c.id)).toEqual(BUILTIN_WORKFLOWS.map((b) => b.id));
    expect(merged.every((c) => c.builtin && !c.disabled)).toBe(true);
  });

  it("同 id 的项目文件整张替换内置卡，位置不变", () => {
    const mine = card(BUILTIN_WORKFLOWS[0].id, { name: "我的版本" });
    const merged = mergeWorkflows([mine]);
    expect(merged[0]).toBe(mine);
    expect(merged.filter((c) => c.id === mine.id)).toHaveLength(1);
  });

  it("disabled: true 的覆盖文件把内置卡从清单里藏掉", () => {
    const off = card(BUILTIN_WORKFLOWS[0].id, { disabled: true });
    const merged = mergeWorkflows([off]);
    // 合并视图里还在（管理 UI 要显示它），但不进清单、不可读取。
    expect(merged.some((c) => c.id === off.id)).toBe(true);
    expect(workflowRoster(merged)).not.toContain(BUILTIN_WORKFLOWS[0].name);
    expect(findWorkflow(merged, off.id)).toBeNull();
  });

  it("项目新增排在内置之后、按 id 码元序 —— 清单文本必须两台机器一致", () => {
    const merged = mergeWorkflows([card("b-flow"), card("a-flow")]);
    expect(merged.slice(-2).map((c) => c.id)).toEqual(["a-flow", "b-flow"]);
  });
});

describe("workflowRoster", () => {
  it("一行一卡 `- name — description`，没有描述的卡只列名字", () => {
    const roster = workflowRoster([card("a", { name: "甲", description: "干甲事" }), card("b", { name: "乙", description: "" })]);
    expect(roster).toBe("- 甲 — 干甲事\n- 乙");
  });

  it("空清单返回空串，调用方据此省掉整段", () => {
    expect(workflowRoster([])).toBe("");
    expect(workflowRoster([card("x", { disabled: true })])).toBe("");
  });

  it("超过上限的卡不列 —— 清单是每轮付费的固定头部", () => {
    const many = Array.from({ length: ROSTER_LIMIT + 5 }, (_, i) => card(`w${i}`));
    const roster = workflowRoster(many);
    expect(roster.split("\n")).toHaveLength(ROSTER_LIMIT);
  });
});

describe("findWorkflow", () => {
  const cards = [card("translate-output", { name: "翻译输出格式" })];

  it("id 和 name 都认 —— 清单展示 name，文件系统的身份是 id", () => {
    expect(findWorkflow(cards, "translate-output")?.id).toBe("translate-output");
    expect(findWorkflow(cards, "翻译输出格式")?.id).toBe("translate-output");
    expect(findWorkflow(cards, " 翻译输出格式 ")?.id).toBe("translate-output");
  });

  it("找不到、空引用、停用的卡都返回 null", () => {
    expect(findWorkflow(cards, "不存在")).toBeNull();
    expect(findWorkflow(cards, "")).toBeNull();
    expect(findWorkflow(activeWorkflows([card("x", { disabled: true })]), "x")).toBeNull();
  });
});
