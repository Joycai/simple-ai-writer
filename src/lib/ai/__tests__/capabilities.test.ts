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
  CAPABILITY_IDS, CAPABILITY_RULES, PLATFORM_CAPABILITIES, SERVER_TOOL_CAPABILITIES, capabilityVerdict, familyVerdict, hasCapability,
  type CapabilityId,
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
});
