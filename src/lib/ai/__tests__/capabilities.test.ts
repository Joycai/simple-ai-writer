/**
 * The capability table (lib/ai/capabilities.ts), held three ways:
 *
 *   1. `docs/api/capability-matrix.md` is this table rendered — so a change to
 *      a rule or a platform cell shows up in review as *which cells moved*,
 *      not as a condition edited somewhere. Regenerate with
 *      `UPDATE_CAPABILITY_MATRIX=1 pnpm exec vitest run src/lib/ai/__tests__/capabilities.test.ts`.
 *   2. The leak guard walks the rules, not a list of names: a private
 *      capability added tomorrow is covered without anyone remembering to.
 *   3. A few named cells, each one a measurement someone paid for.
 *
 * docs/api/capability-gating-plan.md §3.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS, CAPABILITY_REASONS, CAPABILITY_RULES, PLATFORM_CAPABILITIES, SERVER_TOOL_CAPABILITIES, capabilityVerdict, familyVerdict, hasCapability,
  type CapabilityId, type CapabilityWire,
} from "../capabilities";
import { PLATFORM_IDS, platformEndpoints } from "../platforms";
import { SERVER_TOOL_IDS } from "../serverTools";
import type { ProtocolFamily } from "../types";

declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  writeFileSync(p: string, data: string): void;
};
declare const process: { cwd(): string; env: Record<string, string | undefined> };
const fs = require("node:fs");
const MATRIX = `${process.cwd()}/docs/api/capability-matrix.md`;

const FAMILIES: readonly ProtocolFamily[] = ["openai", "responses", "gemini", "anthropic"];
const FAMILY_LABEL: Record<ProtocolFamily, string> = { openai: "Chat", responses: "Resp", gemini: "Gemini", anthropic: "Anth" };
/** An id no matcher names — tells a per-model cell from a whole-wire one. */
const NO_SUCH_MODEL = "no-such-model";

function cell(id: CapabilityId, platform: (typeof PLATFORM_IDS)[number], family: ProtocolFamily): string {
  if (!platformEndpoints(platform).some((e) => e.family === family)) return "";
  const v = familyVerdict(id, platform, family);
  if (v.status === "no") return "·";
  const perModel = familyVerdict(id, platform, family, { modelId: NO_SUCH_MODEL }).status === "no";
  return (v.status === "yes" ? "✓" : "?") + (perModel ? " 按模型" : "") + ` ${v.reason}`;
}

function renderMatrix(): string {
  const out = [
    "# 能力矩阵（生成物，勿手改）",
    "",
    "> **状态：`living`——由 `src/lib/ai/capabilities.ts` 的两张表渲染，`capabilities.test.ts` 保证与代码一致。**",
    "> 改的是那两张表；改完用测试文件头注里的命令重新生成。设计与理由：[`capability-gating-plan.md`](capability-gating-plan.md)。",
    ">",
    "> `✓` 会发送 · `?` 未实测、照发并在抽屉里注明 · `·` 不发送。符号后面是原因码；「按模型」= 该格还要过模型 id 这一轴。",
    "> 空格 = 这个平台没有这一族的线路。模型类型（看图的能力只对多模态 / 视觉模型成立）不在此表内——那是模型行上的事，不是线路上的。",
    "",
  ];
  for (const id of CAPABILITY_IDS) {
    const rule = CAPABILITY_RULES[id];
    out.push(`## ${id}`, "", `\`${rule.origin}\` · 规则缺省适用的协议族：${rule.families.map((f) => FAMILY_LABEL[f]).join(" / ")}`, "");
    out.push(`| 平台 | ${FAMILIES.map((f) => FAMILY_LABEL[f]).join(" | ")} |`, `| --- | ${FAMILIES.map(() => "---").join(" | ")} |`);
    for (const p of PLATFORM_IDS) out.push(`| ${p} | ${FAMILIES.map((f) => cell(id, p, f)).join(" | ")} |`);
    out.push("");
  }
  return out.join("\n");
}

describe("capability matrix", () => {
  it("docs/api/capability-matrix.md is the table as it stands", () => {
    const rendered = renderMatrix();
    if (process.env.UPDATE_CAPABILITY_MATRIX) fs.writeFileSync(MATRIX, rendered);
    expect(
      fs.readFileSync(MATRIX, "utf8"),
      "能力表变了而矩阵文档没跟上：确认变动的格子是你要的，再用文件头注里的命令重新生成。",
    ).toBe(rendered);
  });
});

describe("a private capability does not leak", () => {
  const PRIVATE = CAPABILITY_IDS.filter((id) => CAPABILITY_RULES[id].origin === "private");

  it("is `no` wherever no cell lists it — a relay excepted only for a rule that says so", () => {
    expect(PRIVATE.length).toBeGreaterThan(0);
    for (const id of PRIVATE) for (const platform of PLATFORM_IDS) for (const family of FAMILIES) {
      const caps = PLATFORM_CAPABILITIES[platform];
      const listed = caps.families?.[family]?.[id] !== undefined || caps.families?.all?.[id] !== undefined;
      if (listed) continue;
      const relayed = !!caps.relay && !!CAPABILITY_RULES[id].relay && CAPABILITY_RULES[id].families.includes(family)
        && (CAPABILITY_RULES[id].requires ?? []).every((dep) => familyVerdict(dep, platform, family).status !== "no");
      expect(familyVerdict(id, platform, family).status, `${id} on ${platform}/${family}`).toBe(relayed ? "unknown" : "no");
    }
  });

  it("is never `yes` on a relay", () => {
    for (const id of PRIVATE) for (const platform of PLATFORM_IDS) {
      if (!PLATFORM_CAPABILITIES[platform].relay) continue;
      for (const family of FAMILIES) {
        expect(familyVerdict(id, platform, family).status, `${id} on ${platform}/${family}`).not.toBe("yes");
      }
    }
  });
});

describe("the rule table is well-formed", () => {
  it("CAPABILITY_IDS lists every rule exactly once", () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(Object.keys(CAPABILITY_RULES).sort());
  });

  it("the server tool ids are the ones serverTools.ts selects from", () => {
    expect([...SERVER_TOOL_CAPABILITIES].sort()).toEqual([...SERVER_TOOL_IDS].sort());
  });

  // familyVerdict resolves `requires` by recursion; a loop would be a stack
  // overflow in the drawer and the adapter, not a failed build.
  it("`requires` has no cycle", () => {
    const walk = (id: CapabilityId, seen: readonly CapabilityId[]): void => {
      expect(seen, `${[...seen, id].join(" → ")}`).not.toContain(id);
      for (const dep of CAPABILITY_RULES[id].requires ?? []) walk(dep, [...seen, id]);
    };
    for (const id of CAPABILITY_IDS) walk(id, []);
  });
});

// The reason is a code; the sentence is the locale files' (the ThemeReasonCode
// split). A code without a sentence would show its raw key in the matrix tooltip.
describe("every reason has a sentence", () => {
  it.each(["en", "zh-CN"])("in %s", (lang) => {
    const locale = JSON.parse(fs.readFileSync(`${process.cwd()}/src/i18n/locales/${lang}.json`, "utf8")) as {
      aiConfig: { capReason: Record<string, string> };
    };
    expect(Object.keys(locale.aiConfig.capReason).sort()).toEqual([...CAPABILITY_REASONS].sort());
    for (const r of CAPABILITY_REASONS) expect(locale.aiConfig.capReason[r], r).toMatch(/\S/);
  });
});

describe("capabilityVerdict", () => {
  const chat = (platform: (typeof PLATFORM_IDS)[number]) => ({ platform, standard: "openai_compat" as const });

  it("gives the reason, not just the answer", () => {
    expect(capabilityVerdict("vlHighResolution", chat("dashscope"))).toEqual({ status: "yes", reason: "measured" });
    expect(capabilityVerdict("vlHighResolution", chat("zhipu"))).toEqual({ status: "no", reason: "platform-unlisted" });
    expect(capabilityVerdict("vlHighResolution", chat("newapi"))).toEqual({ status: "unknown", reason: "relay" });
    expect(capabilityVerdict("vlHighResolution", { platform: "dashscope", standard: "openai_responses_compat" }))
      .toEqual({ status: "no", reason: "family" });
    expect(capabilityVerdict("forcedToolChoice", chat("zhipu"))).toEqual({ status: "no", reason: "platform-absent" });
    expect(capabilityVerdict("pdfInput", chat("custom"))).toEqual({ status: "yes", reason: "protocol" });
    expect(capabilityVerdict("web_search", { platform: "deepseek", standard: "anthropic_compat" }))
      .toEqual({ status: "unknown", reason: "unmeasured" });
  });

  it("a platform cell reaches a family the rule does not default to", () => {
    const anth = (platform: (typeof PLATFORM_IDS)[number]) => ({ platform, standard: "anthropic_compat" as const });
    expect(hasCapability("pdfInput", anth("volcengine-plan"))).toBe(true);
    expect(capabilityVerdict("pdfInput", anth("deepseek"))).toEqual({ status: "no", reason: "family" });
    expect(hasCapability("web_search", chat("dashscope"))).toBe(true);
  });

  it("consults the model id only when given one", () => {
    expect(hasCapability("code_interpreter", chat("dashscope"))).toBe(true);
    expect(capabilityVerdict("code_interpreter", chat("dashscope"), { modelId: " QWEN3.5-Plus " }).status).toBe("yes");
    expect(capabilityVerdict("code_interpreter", chat("dashscope"), { modelId: "qwen3.8-flash" }))
      .toEqual({ status: "no", reason: "model" });
  });

  it("rules out by model type before anything else, and by what it requires", () => {
    expect(capabilityVerdict("vlHighResolution", chat("dashscope"), { type: "text" })).toEqual({ status: "no", reason: "model-type" });
    expect(hasCapability("videoFps", chat("dashscope"), { type: "vision" })).toBe(true);
    expect(capabilityVerdict("videoFps", { platform: "newapi", standard: "anthropic_compat" }))
      .toEqual({ status: "no", reason: "requires" });
  });

  it("rules temperature out on Anthropic while the model thinks, and only when told the category", () => {
    const anth = { platform: "anthropic" as const, standard: "anthropic" as const };
    expect(capabilityVerdict("temperature", anth, { thinkingCategory: "claude-adaptive" })).toEqual({ status: "no", reason: "thinking" });
    expect(hasCapability("temperature", anth, { thinkingCategory: "off" })).toBe(true);
    expect(hasCapability("temperature", chat("dashscope"), { thinkingCategory: "qwen-budget" })).toBe(true);
    expect(hasCapability("temperature", anth)).toBe(true);
  });

  it("keeps the output capabilities to the families that spell them", () => {
    expect(hasCapability("textVerbosity", { platform: "xai", standard: "openai_responses_compat" })).toBe(true);
    expect(capabilityVerdict("textVerbosity", chat("dashscope")).reason).toBe("family");
    expect(capabilityVerdict("structuredOutput", { platform: "minimax", standard: "anthropic_compat" }).reason).toBe("family");
    expect(hasCapability("translateFormat", chat("custom"), { type: "text" })).toBe(true);
    expect(capabilityVerdict("translateFormat", chat("custom"), { type: "vision" }).reason).toBe("model-type");
  });
});

// The old per-question readers, gone in C1; the cells they pinned stay pinned.
const status = (wire: CapabilityWire, id: CapabilityId, modelId?: string) => capabilityVerdict(id, wire, { modelId }).status;
const runsCodeInterpreter = (family: ProtocolFamily, modelId: string) =>
  familyVerdict("code_interpreter", "dashscope", family, { modelId }).status === "yes";

describe("server tools, per wire", () => {
  it("answers yes where the platform lists a tool, unknown for a protocol-native one it doesn't, no otherwise", () => {
    expect(status({ platform: "minimax", standard: "anthropic_compat" }, "web_search")).toBe("yes");
    expect(status({ platform: "orcarouter", standard: "anthropic_compat" }, "web_search")).toBe("unknown");
    expect(status({ platform: "newapi", standard: "openai_responses_compat" }, "web_search")).toBe("unknown");
    expect(status({ platform: "newapi", standard: "openai_responses_compat" }, "web_extractor")).toBe("no");
    expect(status({ platform: "newapi", standard: "openai_compat" }, "web_search")).toBe("no");
    expect(status({ platform: "openai", standard: "openai" }, "web_search")).toBe("no");
    expect(status({ platform: "google", standard: "gemini" }, "web_search")).toBe("no");
    // A local server runs no tools: explicit, not "unknown".
    expect(status({ platform: "ollama", standard: "anthropic_compat" }, "web_search")).toBe("no");
    expect(status({ platform: "deepseek", standard: "anthropic_compat" }, "web_search")).toBe("unknown");
  });

  it("consults the model gate only when given a model id", () => {
    const wire = { platform: "dashscope", standard: "openai_compat" } as const;
    expect(status(wire, "code_interpreter")).toBe("yes");
    expect(status(wire, "code_interpreter", "qwen3.8-flash")).toBe("no");
    expect(status(wire, "code_interpreter", "qwen3.5-plus")).toBe("yes");
  });
});

// The code interpreter's model table is a measurement, not a guess: every id
// below was sent to DashScope on 2026-09-17 (landscape.md §7 第六个样本「代码解释器」).
describe("DashScope's code interpreter, per model id", () => {
  it("matches what Chat Completions compat ran", () => {
    for (const id of [
      "qwen3-max", "qwen3-max-2026-01-23", "qwen3.5-plus", "qwen3.5-plus-2026-04-20", "qwen3.6-plus",
      "qwen3.7-plus", "qwen3.7-max", "qwen3.6-max-preview", "qwen3.5-flash", "qwen3.6-flash", "qwen3.5-397b-a17b",
      "Qwen3.5-Plus",
    ]) {
      expect(runsCodeInterpreter("openai", id), id).toBe(true);
    }
  });

  it("refuses what Chat Completions compat refused or silently ignored", () => {
    for (const id of [
      // 400 `does not support the code_interpreter tool`
      "qwen3.8-flash", "qwen3.8-max", "qwen3.8-27b",
      // accepted, but the prompt never grew: ignored
      "qwen-max", "qwen3-max-preview", "qwen3.5-omni-plus",
      "gpt-5.6", "",
    ]) {
      expect(runsCodeInterpreter("openai", id), id).toBe(false);
    }
  });

  it("matches what Responses compat ran", () => {
    for (const id of [
      "qwen3-max", "qwen3.5-plus", "qwen3.5-flash", "qwen3.7-plus", "qwen3.7-max", "qwen3.8-max", "qwen3.8-max-0902",
      "qwen3.8-flash", "qwen3.6-max-preview", "qwen3.5-397b-a17b", "qwen3.5-27b", "qwen3.6-35b-a3b", "qwen3.8-27b",
      "qwen3.8-2.4t-a95b", "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4.1-flash",
    ]) {
      expect(runsCodeInterpreter("responses", id), id).toBe(true);
    }
  });

  it("refuses what Responses compat failed", () => {
    for (const id of [
      "qwen3.6-27b", "qwen3-max-preview", "qwen3-235b-a22b-thinking-2507", "qwen3-vl-plus", "qwen3.5-omni-plus",
      "qwen-plus", "qwen3.8-livetranslate-flash-realtime", "qwen3.7-text-embedding",
    ]) {
      expect(runsCodeInterpreter("responses", id), id).toBe(false);
    }
  });

  it("has no table outside the two OpenAI-shaped wires", () => {
    expect(runsCodeInterpreter("anthropic", "qwen3.5-plus")).toBe(false);
    expect(runsCodeInterpreter("gemini", "qwen3.5-plus")).toBe(false);
  });
});

// 火山方舟: one host, two products told apart by path (landscape.md §7 第十二个样本).
describe("volcengine", () => {
  it("spells the plan's measured tools: Anthropic web_search yes, Chat none", () => {
    expect(status({ platform: "volcengine-plan", standard: "anthropic_compat" }, "web_search")).toBe("yes");
    expect(status({ platform: "volcengine-plan", standard: "openai_compat" }, "web_search")).toBe("no");
    expect(status({ platform: "volcengine-plan", standard: "openai_responses_compat" }, "web_search")).toBe("yes");
    expect(status({ platform: "volcengine", standard: "openai_responses_compat" }, "web_search")).toBe("unknown");
  });
});

describe("pdfInput", () => {
  it("is Chat + Responses by default, and Anthropic only where a platform measured it", () => {
    expect(hasCapability("pdfInput", { platform: "custom", standard: "openai_compat" })).toBe(true);
    expect(hasCapability("pdfInput", { platform: "custom", standard: "openai_responses_compat" })).toBe(true);
    expect(hasCapability("pdfInput", { platform: "deepseek", standard: "anthropic_compat" })).toBe(false);
    expect(hasCapability("pdfInput", { platform: "google", standard: "gemini" })).toBe(false);
    expect(hasCapability("pdfInput", { platform: "volcengine-plan", standard: "anthropic_compat" })).toBe(true);
    expect(hasCapability("pdfInput", { platform: "volcengine-plan", standard: "openai_compat" })).toBe(true);
    expect(hasCapability("pdfInput", { platform: "volcengine-plan", standard: "openai_responses_compat" })).toBe(true);
  });
});

// 智谱 (landscape.md §7 第十四个样本): forcing a tool is sent as auto.
describe("zhipu", () => {
  it("takes auto only, and spells no server tool yet", () => {
    const wire = { platform: "zhipu" as const, standard: "openai_compat" as const };
    expect(hasCapability("forcedToolChoice", wire)).toBe(false);
    expect(hasCapability("forcedToolChoice", { platform: "deepseek", standard: "openai_compat" })).toBe(true);
    expect(status(wire, "web_search")).toBe("no");
  });
});

// DashScope's vision knobs belong to the platforms that read them: its own two,
// plus the host-less relays that may front it — never a hosted vendor that
// merely speaks the same family (智谱 ignores both, landscape.md §7 第十四个样本).
describe.each(["vlHighResolution", "videoFps"] as const)("%s", (id) => {
  const on = (platform: CapabilityWire["platform"], standard: CapabilityWire["standard"] = "openai_compat") =>
    hasCapability(id, { platform, standard });
  it("is DashScope's, and a relay's that may front it", () => {
    for (const p of ["dashscope", "dashscope-intl", "newapi", "custom"] as const) expect(on(p), p).toBe(true);
  });
  it("is no hosted vendor's, and no family but Chat Completions", () => {
    for (const p of ["zhipu", "volcengine", "deepseek", "xai", "orcarouter", "ollama"] as const) expect(on(p), p).toBe(false);
    expect(on("openai", "openai")).toBe(false);
    expect(on("dashscope", "openai_responses_compat")).toBe(false);
  });
});
