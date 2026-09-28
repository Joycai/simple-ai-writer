/**
 * The hint under a declared capability the route will not send. What is held:
 * the reason comes from the real verdict of a real platform cell, and the
 * sentence names it — a platform measured refusing video is not told "this
 * route has no spelling", and neither is one nobody measured; the two
 * sentences PDF showed before (no spelling on the route, the relay's upstream)
 * come out word for word as they did.
 */
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import zh from "../../../../i18n/locales/zh-CN.json";
import { capabilityVerdict, type CapabilityId } from "../../../../lib/ai/capabilities";
import type { Wire } from "../../../../lib/ai/platforms";
import { capabilityModelOf, type RelayUpstreamId } from "../../../../lib/ai/relayUpstream";
import { ROUTE_LONG } from "../../../../lib/ai/routes";
import { declNotSentNote } from "../declNotes";

/** i18next's lookup and `{{x}}` interpolation over the shipped zh-CN file. */
const t = ((key: string, params: Record<string, unknown> = {}) => {
  const raw = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], zh);
  if (typeof raw !== "string") throw new Error(`missing locale key ${key}`);
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""));
}) as unknown as TFunction;

/** The note the drawer shows, from the verdict it asks — the drawer's own arguments. */
function note(id: CapabilityId, wire: Wire, opts: { modelId?: string; upstream?: RelayUpstreamId } = {}) {
  const model = id === "videoInput"
    ? { type: "vision" as const }
    : capabilityModelOf({ modelId: opts.modelId, relayUpstream: opts.upstream ?? "none" });
  const v = capabilityVerdict(id, wire, model);
  expect(v.status, `${id} on ${wire.platform}`).toBe("no");
  return declNotSentNote(t, v.reason, {
    route: ROUTE_LONG.responses, platform: wire.platform, modelId: opts.modelId ?? "", upstream: opts.upstream,
  });
}

describe("the hint under a declaration that is not sent", () => {
  it("says a platform measured refusing video did so", () => {
    expect(note("videoInput", { platform: "deepseek", standard: "openai_compat" }))
      .toBe("声明保留在模型上，但请求里不发：DeepSeek 官方 实测不收，或收了不起作用");
  });

  it("says a platform nobody measured was not", () => {
    expect(note("videoInput", { platform: "openai", standard: "openai" }))
      .toBe("声明保留在模型上，但请求里不发：这是别家平台的私有字段，OpenAI 官方 上没有实测过");
  });

  it("keeps the route sentence where the route has no spelling", () => {
    expect(note("videoInput", { platform: "dashscope", standard: "openai_responses_compat" }))
      .toBe(`声明保留在模型上；${ROUTE_LONG.responses} 线路没有这项的拼法，走这条线路时不发`);
  });

  it("keeps the upstream sentence where the relay's upstream drops it", () => {
    expect(note("pdfInput", { platform: "newapi", standard: "openai_compat" }, { modelId: "claude-opus-5", upstream: "kiro" }))
      .toBe(`不发送：中转站上游「${t("aiConfig.upstream.name.kiro")}」实测不收这一项。`);
  });
});
