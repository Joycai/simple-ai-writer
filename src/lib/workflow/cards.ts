/**
 * 工作流卡的纯逻辑：解析、覆盖合并、清单拼装、查找。
 *
 * IO（目录扫描）在 `scan.ts`，这里的每个函数都不碰盘、不碰网——测试全在这层。
 * 设计：docs/feature/agent/workflow-cards-plan.md。三条：
 *
 * 1. **两级渐进披露。** 清单（一行一卡）恒挂在 briefing 里，正文只在模型调
 *    `read_workflow` 时进入上下文。所以 description 有硬限长——它是每轮都
 *    付费的那部分，正文不是。
 * 2. **覆盖是整张的。** 项目文件与内置卡同 id 时整张替换；`disabled: true`
 *    的卡保留在列表里（将来的管理 UI 要显示它）但不进清单、不可读取。
 * 3. **顺序是确定的。** 内置卡按声明序，项目新增按 id 码元序——清单文本进
 *    模型上下文，同一份工程在两台机器上必须拼出同一段话（和 collectGlossary
 *    的排序不用 localeCompare 是同一条理由）。
 */

import { BUILTIN_WORKFLOWS } from "./builtins";
import { parseFrontmatter } from "../fs/markdown";

export interface WorkflowCard {
  /** 内置卡的声明 id，或项目文件的主名（`<id>.md`）。 */
  id: string;
  name: string;
  description: string;
  body: string;
  /** false = 来自项目文件（含覆盖内置的那些——覆盖后它就是项目的卡了）。 */
  builtin: boolean;
  disabled: boolean;
}

/** 项目工作流目录，相对项目根。 */
export const WORKFLOW_DIR = ".ai-writer/workflows";

/** 清单最多列几张卡。超出的部分静默不列——见 workflowRoster 的注释。 */
export const ROSTER_LIMIT = 10;

/** description 在清单里的限长。它每轮都进上下文，正文才是放开写的地方。 */
const DESC_CHARS = 60;

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clampDesc(s: string): string {
  const one = oneLine(s);
  return one.length > DESC_CHARS ? one.slice(0, DESC_CHARS) + "…" : one;
}

/**
 * 把一个项目工作流文件解析成卡。
 *
 * 宽容：没有 frontmatter 就整个当正文，name 缺省用文件主名，description 缺省
 * 为空（这样的卡进清单只有名字——模型少一条判断依据，但卡仍然可用）。
 * `disabled` 与 lore 的 `dict` 同款：行式解析器交回字符串 "true"。
 */
export function parseWorkflowFile(id: string, raw: string): WorkflowCard {
  const { data, content } = parseFrontmatter(raw);
  return {
    id,
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : id,
    description: typeof data.description === "string" ? clampDesc(data.description) : "",
    body: content.trim(),
    builtin: false,
    disabled: data.disabled === true || data.disabled === "true",
  };
}

/**
 * 内置卡 + 项目卡的合并视图。
 *
 * 同 id 整张替换（文件头第 2 条）；项目新增排在内置之后、按 id 码元序。
 */
export function mergeWorkflows(projectCards: readonly WorkflowCard[]): WorkflowCard[] {
  const byId = new Map(projectCards.map((c) => [c.id, c]));
  const out: WorkflowCard[] = [];

  for (const b of BUILTIN_WORKFLOWS) {
    const override = byId.get(b.id);
    if (override) {
      byId.delete(b.id);
      out.push(override);
    } else {
      out.push({ ...b, builtin: true, disabled: false, description: clampDesc(b.description) });
    }
  }

  const extras = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...out, ...extras];
}

/** 清单里的（= 可被 read_workflow 读到的）卡。 */
export function activeWorkflows(cards: readonly WorkflowCard[]): WorkflowCard[] {
  return cards.filter((c) => !c.disabled);
}

/**
 * briefing 里的清单行，一行一卡：`- name — description`。
 *
 * 不带头部说明——那句话属于 briefing 模板（i18n），这里只出数据行。空清单
 * 返回空串，调用方据此把整段（含头部）省掉。超过 ROSTER_LIMIT 的卡不列：
 * 清单是每轮付费的固定头部，宁可少列也不无界增长；被挤掉的卡仍可按名读取。
 */
export function workflowRoster(cards: readonly WorkflowCard[]): string {
  return activeWorkflows(cards)
    .slice(0, ROSTER_LIMIT)
    .map((c) => (c.description ? `- ${c.name} — ${c.description}` : `- ${c.name}`))
    .join("\n");
}

/**
 * 按 id 或 name 找一张可用的卡（`read_workflow` 的查找规则）。
 *
 * 两个键都认，因为清单里展示的是 name，而文件系统里的身份是 id——模型抄
 * 哪个都该命中。停用的卡找不到：对模型而言它不存在，而不是"存在但拒绝"。
 */
export function findWorkflow(cards: readonly WorkflowCard[], ref: string): WorkflowCard | null {
  const key = ref.trim();
  if (!key) return null;
  return activeWorkflows(cards).find((c) => c.id === key || c.name === key) ?? null;
}
