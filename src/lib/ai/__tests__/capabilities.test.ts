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
  CAPABILITY_IDS, CAPABILITY_REASONS, CAPABILITY_RULES, PLATFORM_CAPABILITIES, SERVER_TOOL_CAPABILITIES, UPSTREAM_CAPABILITIES,
  capabilityVerdict, effortMenuOnWire, effortOnWire, familyVerdict, hasCapability,
  type CapabilityId, type CapabilityWire,
} from "../capabilities";
import { RELAY_UPSTREAMS, capabilityModelOf } from "../relayUpstream";
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
  const perUpstream = !!PLATFORM_CAPABILITIES[platform].relay && upstreamCell(id, family).some((c) => c !== undefined);
  if (v.status === "no") return perUpstream ? "· 按上游" : "·";
  const families = PLATFORM_CAPABILITIES[platform].families;
  const matcher = typeof (families?.[family]?.[id] ?? families?.all?.[id]) === "object";
  const perModel = matcher || familyVerdict(id, platform, family, { modelId: NO_SUCH_MODEL }).reason === "model-unlisted";
  return (v.status === "yes" ? "✓" : "?") + (perModel ? " 按模型" : "") + (perUpstream ? " 按上游" : "") + ` ${v.reason}`;
}

/** Each upstream's own cell for this capability and family, in `RELAY_UPSTREAMS` order. */
function upstreamCell(id: CapabilityId, family: ProtocolFamily): (boolean | undefined)[] {
  return RELAY_UPSTREAMS.map((u) => {
    const f = UPSTREAM_CAPABILITIES[u].families;
    return f[family]?.[id] ?? f.all?.[id];
  });
}

function renderUpstreams(): string[] {
  const out = [
    "## 中转站上游画像",
    "",
    "中转站平台（`newapi` / `custom`）上，模型背后的上游由 `relayUpstream.ts` 解析（模型手选 → 渠道前缀表 → id 里的产品名）。",
    "上游的格子先于平台格生效，只作用于画像覆盖的模型（见表头各上游的作用域）。`✓` 实测可用 · `·` 实测不生效 · 空 = 不写，落回平台格与规则。",
    "",
    `| 能力 | 族 | ${RELAY_UPSTREAMS.map((u) => `${u}（${UPSTREAM_CAPABILITIES[u].modelsLabel}）`).join(" | ")} |`,
    `| --- | --- | ${RELAY_UPSTREAMS.map(() => "---").join(" | ")} |`,
  ];
  for (const id of CAPABILITY_IDS) {
    for (const f of FAMILIES) {
      const cells = upstreamCell(id, f);
      if (cells.every((c) => c === undefined)) continue;
      out.push(`| ${id} | ${FAMILY_LABEL[f]} | ${cells.map((c) => (c === undefined ? "" : c ? "✓" : "·")).join(" | ")} |`);
    }
  }
  out.push("");
  return out;
}

function renderMatrix(): string {
  const out = [
    "# 能力矩阵（生成物，勿手改）",
    "",
    "> **状态：`living`——由 `src/lib/ai/capabilities.ts` 的三张表渲染，`capabilities.test.ts` 保证与代码一致。**",
    "> 改的是那三张表；改完用测试文件头注里的命令重新生成。设计与理由：[`capability-gating-plan.md`](capability-gating-plan.md)。",
    ">",
    "> `✓` 会发送 · `?` 未实测、照发并在抽屉里注明 · `·` 不发送。符号后面是原因码；「按模型」= 该格还要过模型 id 这一轴；",
    "> 「按上游」= 中转站上还要看模型背后的上游（本文末节）。表里是没有上游时的答案。",
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
  out.push(...renderUpstreams());
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
    expect(capabilityVerdict("code_interpreter", chat("dashscope"), { modelId: "qwen3.9-plus" }))
      .toEqual({ status: "unknown", reason: "model-unlisted" });
    // Blank = nothing typed yet, the same as not asking.
    expect(capabilityVerdict("code_interpreter", chat("dashscope"), { modelId: "  " }).status).toBe("yes");
  });

  it("rules out by model type before anything else, and by what it requires", () => {
    expect(capabilityVerdict("vlHighResolution", chat("dashscope"), { type: "text" })).toEqual({ status: "no", reason: "model-type" });
    expect(hasCapability("videoFps", chat("dashscope"), { type: "vision" })).toBe(true);
    expect(capabilityVerdict("videoFps", { platform: "newapi", standard: "anthropic_compat" }))
      .toEqual({ status: "no", reason: "requires" });
  });

  it("rules temperature out on Anthropic unless the model is declared not to think", () => {
    const anth = { platform: "anthropic" as const, standard: "anthropic" as const };
    expect(capabilityVerdict("temperature", anth, { thinkingCategory: "claude-adaptive" })).toEqual({ status: "no", reason: "thinking" });
    expect(hasCapability("temperature", anth, { thinkingCategory: "off" })).toBe(true);
    expect(hasCapability("temperature", chat("dashscope"), { thinkingCategory: "qwen-budget" })).toBe(true);
    // No category = the family default, which thinks: the safe answer for a caller that forgot to resolve it.
    expect(capabilityVerdict("temperature", anth)).toEqual({ status: "no", reason: "thinking" });
    expect(hasCapability("temperature", { platform: "google", standard: "gemini" })).toBe(true);
  });

  it("keeps the output capabilities to the families that spell them", () => {
    expect(hasCapability("textVerbosity", { platform: "xai", standard: "openai_responses_compat" })).toBe(true);
    expect(capabilityVerdict("textVerbosity", chat("dashscope")).reason).toBe("family");
    expect(capabilityVerdict("textVerbosity", { platform: "minimax", standard: "anthropic_compat" }).reason).toBe("family");
    // Anthropic's schema tier: yes where measured, unknown on an unmeasured relay (第十八个样本，补测).
    expect(capabilityVerdict("jsonSchema", { platform: "anthropic", standard: "anthropic" }).status).toBe("yes");
    expect(capabilityVerdict("jsonSchema", { platform: "orcarouter", standard: "anthropic_compat" }).status).toBe("yes");
    expect(capabilityVerdict("jsonSchema", { platform: "minimax", standard: "anthropic_compat" }).status).toBe("unknown");
    expect(hasCapability("translateFormat", chat("custom"), { type: "text" })).toBe(true);
    expect(capabilityVerdict("translateFormat", chat("custom"), { type: "vision" }).reason).toBe("model-type");
  });
});

// Relay upstreams (landscape.md §7 第十五、十六个样本, 2026-09-23;
// capability-gating-plan §8.11). The Kiro cells replaced a model-id matcher
// (`KIRO_CLAUDE`, PR #685); asked the way the adapters ask — through
// `capabilityModelOf`, which infers Kiro from the id — each keeps the status
// it had, now for the reason `upstream`.
describe("relay upstreams", () => {
  const RELAYS = ["newapi", "custom"] as const;
  const chat = (platform: (typeof RELAYS)[number] | (typeof PLATFORM_IDS)[number]) => ({ platform, standard: "openai_compat" as const });
  const anth = (platform: (typeof RELAYS)[number] | (typeof PLATFORM_IDS)[number]) => ({ platform, standard: "anthropic_compat" as const });
  const inferred = (modelId?: string) => capabilityModelOf({ modelId });

  describe("Kiro, inferred from the id: what the old matcher refused", () => {
    const KIRO = ["[特价kiro量]claude-opus-5", "特价kiro | claude-opus-4-6", "[kiro2]kiro-claude-sonnet-5"];
    // The five cells KIRO_CLAUDE held, and the status each gave these ids.
    const WAS_NO = [
      [chat, "pdfInput"], [chat, "forcedToolChoice"], [chat, "structuredOutput"],
      [anth, "forcedToolChoice"], [anth, "web_search"],
    ] as const;

    it("is still not sent", () => {
      for (const platform of RELAYS) for (const modelId of KIRO) {
        for (const [wire, id] of WAS_NO) {
          expect(capabilityVerdict(id, wire(platform), inferred(modelId)), `${platform} ${id} ${modelId}`)
            .toEqual({ status: "no", reason: "upstream" });
        }
        expect(capabilityVerdict("jsonSchema", chat(platform), inferred(modelId))).toEqual({ status: "no", reason: "requires" });
      }
    });

    it("keeps what works", () => {
      for (const modelId of KIRO) {
        expect(hasCapability("temperature", chat("newapi"), inferred(modelId))).toBe(true);
        expect(hasCapability("temperature", anth("newapi"), { ...inferred(modelId), thinkingCategory: "off" })).toBe(true);
      }
    });

    it("leaves every other model on the relay, and a blank id, to the rule", () => {
      for (const modelId of [undefined, "", "claude-opus-5", "[anti]claude-opus-4-6", "kiro-deepseek-v4"]) {
        expect(capabilityVerdict("pdfInput", chat("newapi"), inferred(modelId))).toEqual({ status: "yes", reason: "protocol" });
        expect(capabilityVerdict("forcedToolChoice", anth("custom"), inferred(modelId))).toEqual({ status: "yes", reason: "protocol" });
        expect(capabilityVerdict("web_search", anth("newapi"), inferred(modelId))).toEqual({ status: "unknown", reason: "unmeasured" });
      }
    });
  });

  // The one verdict inference changes for a model nobody configured (design
  // §4, on purpose): `bedrock` in a Claude id names the upstream, which has no
  // server tools (every request carrying one is a 400) and reads PDFs.
  it("infers Bedrock from the id, and with it drops web search and opens the PDF block", () => {
    for (const platform of RELAYS) {
      const m = inferred("bedrock/claude-opus-4-6");
      expect(capabilityVerdict("web_search", anth(platform), m)).toEqual({ status: "no", reason: "upstream" });
      expect(capabilityVerdict("pdfInput", anth(platform), m)).toEqual({ status: "yes", reason: "upstream" });
    }
  });

  it("answers each upstream's measured cells, both ways", () => {
    const opus = (upstream: (typeof RELAY_UPSTREAMS)[number]) => ({ modelId: "[x]claude-opus-4-6", upstream });
    expect(capabilityVerdict("web_search", anth("newapi"), opus("cc"))).toEqual({ status: "yes", reason: "upstream" });
    expect(capabilityVerdict("pdfInput", anth("newapi"), opus("cc"))).toEqual({ status: "yes", reason: "upstream" });
    expect(capabilityVerdict("forcedToolChoice", anth("newapi"), opus("cc"))).toEqual({ status: "yes", reason: "protocol" });
    // Probed without thinking only on Chat: no cell, the rule's answer.
    expect(capabilityVerdict("forcedToolChoice", chat("newapi"), opus("cc"))).toEqual({ status: "yes", reason: "protocol" });
    expect(capabilityVerdict("forcedToolChoice", chat("custom"), opus("anti"))).toEqual({ status: "no", reason: "upstream" });
    expect(capabilityVerdict("pdfInput", chat("custom"), opus("anti"))).toEqual({ status: "no", reason: "upstream" });
    expect(capabilityVerdict("web_search", anth("custom"), opus("anti"))).toEqual({ status: "no", reason: "upstream" });
    expect(capabilityVerdict("web_search", anth("newapi"), opus("bedrock"))).toEqual({ status: "no", reason: "upstream" });
    expect(capabilityVerdict("pdfInput", anth("newapi"), opus("bedrock"))).toEqual({ status: "yes", reason: "upstream" });
    // Only Kiro carries the Chat JSON-mode cell (the relay conversion's, kept where the old rule put it).
    expect(capabilityVerdict("structuredOutput", chat("newapi"), opus("bedrock"))).toEqual({ status: "yes", reason: "protocol" });
    // Unmeasured: no cell, no change.
    for (const id of CAPABILITY_IDS) for (const f of FAMILIES) {
      expect(familyVerdict(id, "newapi", f, opus("official")), `${id} ${f}`).toEqual(familyVerdict(id, "newapi", f, { modelId: "[x]claude-opus-4-6" }));
    }
  });

  it("applies only to the models it was measured on, and only on a relay", () => {
    expect(capabilityVerdict("web_search", anth("newapi"), { modelId: "[anti量]gemini-3-pro", upstream: "anti" }))
      .toEqual({ status: "unknown", reason: "unmeasured" });
    expect(capabilityVerdict("web_search", anth("newapi"), { upstream: "anti" }))
      .toEqual({ status: "unknown", reason: "unmeasured" });
    // A platform that is not a relay has no upstream to consult.
    expect(capabilityVerdict("web_search", { platform: "anthropic", standard: "anthropic" }, { modelId: "claude-opus-4-6", upstream: "bedrock" }))
      .toEqual({ status: "yes", reason: "measured" });
    expect(capabilityVerdict("pdfInput", anth("deepseek"), { modelId: "claude-opus-4-6", upstream: "cc" }))
      .toEqual({ status: "no", reason: "family" });
  });

  describe("GPT upstreams (第十七个样本)", () => {
    const resp = (platform: (typeof RELAYS)[number]) => ({ platform, standard: "openai_responses_compat" as const });
    const sol = (upstream: "codex" | "azure") => ({ modelId: "[x]gpt-5.6-sol", upstream });
    const up = (status: "yes" | "no") => ({ status, reason: "upstream" });

    it("codex: search, verbosity, PDF and forced tools measured; temperature ignored on Responses", () => {
      for (const platform of RELAYS) {
        for (const id of ["web_search", "textVerbosity", "pdfInput", "forcedToolChoice"] as const) {
          expect(capabilityVerdict(id, resp(platform), sol("codex")), id).toEqual(up("yes"));
        }
        expect(capabilityVerdict("temperature", resp(platform), sol("codex"))).toEqual(up("no"));
        expect(capabilityVerdict("pdfInput", chat(platform), sol("codex"))).toEqual(up("yes"));
        expect(capabilityVerdict("forcedToolChoice", chat(platform), sol("codex"))).toEqual(up("yes"));
        // No echo on Chat Completions: nothing measured, the rule's answer.
        expect(capabilityVerdict("temperature", chat(platform), sol("codex"))).toEqual({ status: "yes", reason: "protocol" });
        // The system prompt stays in `instructions` — without it a Codex upstream injects its own.
        expect(capabilityVerdict("instructionsField", resp(platform), sol("codex"))).toEqual(up("yes"));
      }
    });

    it("codex: no JSON-mode cell — one tier dropped it, two executed it", () => {
      expect(capabilityVerdict("structuredOutput", resp("newapi"), sol("codex"))).toEqual({ status: "yes", reason: "protocol" });
      expect(capabilityVerdict("jsonSchema", resp("newapi"), sol("codex"))).toEqual({ status: "unknown", reason: "unmeasured" });
      expect(capabilityVerdict("structuredOutput", chat("custom"), sol("codex"))).toEqual({ status: "yes", reason: "protocol" });
    });

    it("azure: no web search, temperature fails, a named Chat tool fails, and no instructions field", () => {
      for (const platform of RELAYS) {
        for (const id of ["web_search", "temperature", "instructionsField"] as const) {
          expect(capabilityVerdict(id, resp(platform), sol("azure")), id).toEqual(up("no"));
        }
        expect(capabilityVerdict("forcedToolChoice", chat(platform), sol("azure"))).toEqual(up("no"));
        for (const id of ["forcedToolChoice", "textVerbosity", "pdfInput", "structuredOutput", "jsonSchema"] as const) {
          expect(capabilityVerdict(id, resp(platform), sol("azure")), id).toEqual(up("yes"));
        }
        for (const id of ["pdfInput", "structuredOutput", "jsonSchema"] as const) {
          expect(capabilityVerdict(id, chat(platform), sol("azure")), id).toEqual(up("yes"));
        }
      }
    });

    it("stays on its own models, and Claude's upstreams stay on theirs", () => {
      for (const id of CAPABILITY_IDS) for (const f of FAMILIES) {
        const bare = (modelId: string) => familyVerdict(id, "newapi", f, { modelId });
        for (const upstream of ["codex", "azure"] as const) {
          expect(familyVerdict(id, "newapi", f, { modelId: "[x]claude-opus-4-6", upstream }), `${upstream} ${id} ${f}`)
            .toEqual(bare("[x]claude-opus-4-6"));
        }
        for (const upstream of ["kiro", "cc", "anti", "bedrock", "official"] as const) {
          expect(familyVerdict(id, "newapi", f, { modelId: "[x]gpt-5.6-sol", upstream }), `${upstream} ${id} ${f}`)
            .toEqual(bare("[x]gpt-5.6-sol"));
        }
      }
    });

    it("names its models as its measurements scope them", () => {
      for (const up of RELAY_UPSTREAMS) {
        const { models, modelsLabel } = UPSTREAM_CAPABILITIES[up];
        expect(models.test(modelsLabel.toLowerCase()), up).toBe(true);
      }
    });

    it("is never inferred from the id", () => {
      for (const modelId of ["[Azure]gpt-5.6-sol", "codex/gpt-5.6-sol", "gpt-5.3-codex"]) {
        expect(capabilityModelOf({ modelId })).toEqual({ modelId });
      }
    });
  });

  it("says no upstream when resolved to none, even where the id names one", () => {
    expect(capabilityVerdict("web_search", anth("newapi"), capabilityModelOf({ modelId: "[kiro]claude-opus-5", relayUpstream: "none" })))
      .toEqual({ status: "unknown", reason: "unmeasured" });
    expect(capabilityVerdict("web_search", anth("newapi"), capabilityModelOf({ modelId: "[kiro]claude-opus-5", relayUpstream: "cc" })))
      .toEqual({ status: "yes", reason: "upstream" });
  });
});

// The old per-question readers, gone in C1; the cells they pinned stay pinned.
const status = (wire: CapabilityWire, id: CapabilityId, modelId?: string) => capabilityVerdict(id, wire, { modelId }).status;
const codeInterpreter = (family: ProtocolFamily, modelId: string) =>
  familyVerdict("code_interpreter", "dashscope", family, { modelId }).status;
const runsCodeInterpreter = (family: ProtocolFamily, modelId: string) => codeInterpreter(family, modelId) === "yes";

describe("server tools, per wire", () => {
  it("answers yes where the platform lists a tool, unknown for a protocol-native one it doesn't, no otherwise", () => {
    expect(status({ platform: "minimax", standard: "anthropic_compat" }, "web_search")).toBe("yes");
    // Measured on paid models (landscape.md §7 第十八个样本).
    expect(status({ platform: "orcarouter", standard: "anthropic_compat" }, "web_search")).toBe("yes");
    expect(status({ platform: "deepseek", standard: "anthropic_compat" }, "web_search")).toBe("unknown");
    expect(status({ platform: "newapi", standard: "openai_responses_compat" }, "web_search")).toBe("unknown");
    expect(status({ platform: "newapi", standard: "openai_responses_compat" }, "web_extractor")).toBe("no");
    expect(status({ platform: "newapi", standard: "openai_compat" }, "web_search")).toBe("no");
    expect(status({ platform: "openai", standard: "openai" }, "web_search")).toBe("no");
    // `googleSearch` is the protocol's own; AI Studio unmeasured — offered, noted.
    expect(status({ platform: "google", standard: "gemini" }, "web_search")).toBe("unknown");
    expect(status({ platform: "google", standard: "gemini" }, "web_extractor")).toBe("no");
    expect(status({ platform: "google", standard: "gemini" }, "code_interpreter")).toBe("no");
    expect(status({ platform: "newapi", standard: "gemini_compat" }, "code_interpreter")).toBe("no");
    // OrcaRouter's Vertex route ran all three (第十八个样本「再补测」).
    for (const id of ["web_search", "web_extractor", "code_interpreter"] as const) {
      expect(status({ platform: "orcarouter", standard: "gemini_compat" }, id), id).toBe("yes");
    }
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
    ]) {
      expect(codeInterpreter("openai", id), id).toBe("no");
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
      "qwen-plus",
    ]) {
      expect(codeInterpreter("responses", id), id).toBe("no");
    }
  });

  // The platform has the tool, so an id nobody measured keeps the switch and
  // says it is unmeasured (capability-gating-plan §8.7) — including the
  // prefix-sharing ids the `runs` patterns are anchored against.
  it("offers an unmeasured id at unknown on both wires", () => {
    for (const id of ["qwen3.9-plus", "qwen3.8-livetranslate-flash-realtime", "qwen3.7-text-embedding", "gpt-5.6"]) {
      expect(codeInterpreter("responses", id), id).toBe("unknown");
    }
    for (const id of ["qwen3.9-plus", "qwen3-vl-plus", "gpt-5.6", "qwen3.6-35b-a3b", "deepseek-v4-pro"]) {
      expect(codeInterpreter("openai", id), id).toBe("unknown");
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

  it("reads PDFs on OrcaRouter's Messages and Gemini routes and on Anthropic's own (第十八个样本「再补测」)", () => {
    expect(capabilityVerdict("pdfInput", { platform: "orcarouter", standard: "anthropic_compat" })).toEqual({ status: "yes", reason: "measured" });
    expect(capabilityVerdict("pdfInput", { platform: "orcarouter", standard: "gemini_compat" })).toEqual({ status: "yes", reason: "measured" });
    expect(capabilityVerdict("pdfInput", { platform: "anthropic", standard: "anthropic" })).toEqual({ status: "yes", reason: "measured" });
    // ③ behind OrcaRouter is Vertex AI, not AI Studio: the official cell stays.
    expect(hasCapability("pdfInput", { platform: "google", standard: "gemini" })).toBe(false);
    expect(hasCapability("pdfInput", { platform: "newapi", standard: "gemini_compat" })).toBe(false);
  });
});

// 智谱 (landscape.md §7 第十四个样本): forcing a tool is sent as auto.
// landscape.md §7 第十八个样本「GPT 全家补测」.
describe("effort cells", () => {
  const orcaChat: CapabilityWire = { platform: "orcarouter", standard: "openai_compat" };
  const orcaResp: CapabilityWire = { platform: "orcarouter", standard: "openai_responses_compat" };
  const anthropic: CapabilityWire = { platform: "anthropic", standard: "anthropic" };

  it("effortOnWire: off beside tools where the wire refuses the pair, the lowest level where there is no off", () => {
    const sol = { modelId: "openai/gpt-5.6-sol" };
    const astra = { modelId: "openai/gpt-6-astra" };
    expect(effortOnWire("high", orcaChat, sol, true)).toBe("off");
    expect(effortOnWire(undefined, orcaChat, sol, true)).toBe("off");
    expect(effortOnWire("high", orcaChat, sol, false)).toBe("high");
    expect(effortOnWire("high", orcaResp, sol, true)).toBe("high");
    expect(effortOnWire("off", orcaChat, astra, false)).toBe("low");
    expect(effortOnWire("off", orcaResp, astra, true)).toBe("low");
    expect(effortOnWire(undefined, orcaResp, astra, false)).toBeUndefined();
    // Only the OpenAI wires' ladder: Anthropic spells off its own way.
    expect(effortOnWire("off", anthropic, astra, true)).toBe("off");
  });

  it("effortMenuOnWire drops off for a model with none, and only there", () => {
    const menu = ["off", "low", "medium", "high", "xhigh", "max"] as const;
    expect(effortMenuOnWire(menu, orcaResp, { modelId: "openai/gpt-6-astra" })).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortMenuOnWire(menu, orcaChat, { modelId: "openai/gpt-6-astra" })).not.toContain("off");
    expect(effortMenuOnWire(menu, orcaResp, { modelId: "openai/gpt-6-luna" })).toEqual([...menu]);
    expect(effortMenuOnWire(menu, undefined, { modelId: "openai/gpt-6-astra" })).toEqual([...menu]);
  });
});

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
