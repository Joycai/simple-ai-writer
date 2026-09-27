/**
 * The line under 上下文 / 最大输出 / 思考类目 (P6 界面, LLD §9.9). What is held:
 * every note is chosen from the real `valueFacts` of real platform rows, the
 * sentence names the source the request actually uses, the `max_tokens` part
 * appears exactly where the wire sends one and differs from the field — and a
 * new row takes nothing but its type and PDF declaration from the platform.
 */
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import zh from "../../../../i18n/locales/zh-CN.json";
import { PLATFORM_CELLS, platformModelCalibration, type Source } from "../../../../lib/ai/capabilities";
import { valueFacts } from "../../../../lib/ai/modelSummary";
import { PLATFORM_IDS, type PlatformId } from "../../../../lib/ai/platforms";
import { calibrationPrefill, categoryNote, contextNote, maxOutputNote, sourceName } from "../valueNotes";

/** i18next's lookup and `{{x}}` interpolation over the shipped zh-CN file. */
const t = ((key: string, params: Record<string, unknown> = {}) => {
  const raw = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], zh);
  if (typeof raw !== "string") throw new Error(`missing locale key ${key}`);
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""));
}) as unknown as TFunction;

const zhipu = { standard: "openai_compat" as const, platform: "zhipu" as const };
const deepseekMessages = { standard: "anthropic_compat" as const, platform: "deepseek" as const };
const name = (platform?: PlatformId) => (s: Source) => sourceName(t, s, platform);

describe("the note under a value", () => {
  it("left empty: the tables' value, its source, and what uses it", () => {
    const v = valueFacts({ modelId: "glm-5.3" }, zhipu.standard, zhipu.platform);
    expect(contextNote(t, v.contextSize, name("zhipu"))).toBe("平台 · 智谱 BigModel 1,048,576 · 预算按它算，发送前不拦截");
    expect(maxOutputNote(t, v.maxOutput, name("zhipu"))).toBe("平台 · 智谱 BigModel 131,072 · 预算按它算，不发送");
    expect(categoryNote(t, v.thinkingCategory, name("zhipu"))).toBe("自动 → GLM-5.3 · 平台 · 智谱 BigModel");
  });

  it("says what max_tokens carries where the wire sends one and the field does not say it", () => {
    const blank = valueFacts({ modelId: "deepseek-v4-pro" }, deepseekMessages.standard, deepseekMessages.platform);
    expect(maxOutputNote(t, blank.maxOutput, name("deepseek")))
      .toBe("平台 · DeepSeek 官方 393,216 · 预算按它算；max_tokens 发 32,768（只发手填的值）");
    const typed = valueFacts({ modelId: "deepseek-v4-pro", maxOutput: 9000 }, deepseekMessages.standard, deepseekMessages.platform);
    expect(maxOutputNote(t, typed.maxOutput, name("deepseek"))).toBe("手填 · 覆盖平台 · DeepSeek 官方 393,216；max_tokens 发 9,000");
    const unknown = valueFacts({ modelId: "mystery-model" }, deepseekMessages.standard, deepseekMessages.platform);
    expect(maxOutputNote(t, unknown.maxOutput, name("deepseek"))).toBe("未知 · max_tokens 发 32,768");
  });

  it("typed: agrees with the tables, or covers them", () => {
    const same = valueFacts({ modelId: "glm-5.3", contextSize: 1_048_576 }, zhipu.standard, zhipu.platform);
    expect(contextNote(t, same.contextSize, name("zhipu"))).toBe("与平台 · 智谱 BigModel一致 · 清空后跟随它");
    const over = valueFacts({ modelId: "glm-5.3", maxOutput: 4000 }, zhipu.standard, zhipu.platform);
    expect(maxOutputNote(t, over.maxOutput, name("zhipu"))).toBe("手填 · 覆盖平台 · 智谱 BigModel 131,072");
  });

  it("says nothing the tables cannot back", () => {
    const v = valueFacts({ modelId: "mystery-model", contextSize: 8000, maxOutput: 2000 }, zhipu.standard, zhipu.platform);
    expect(contextNote(t, v.contextSize, name("zhipu"))).toBeUndefined();
    expect(maxOutputNote(t, v.maxOutput, name("zhipu"))).toBeUndefined();
    // A picked category the tables agree with needs no note.
    expect(categoryNote(t, valueFacts({ modelId: "glm-5.3", thinkingCategory: "glm" }, zhipu.standard, zhipu.platform).thinkingCategory, name("zhipu")))
      .toBeUndefined();
    expect(categoryNote(t, valueFacts({ modelId: "glm-5.3", thinkingCategory: "glm-effort" }, zhipu.standard, zhipu.platform).thinkingCategory, name("zhipu")))
      .toBe("自动时为 GLM-5.3 · 平台 · 智谱 BigModel");
  });

  it("names the source the request uses, for every platform row", () => {
    for (const platform of PLATFORM_IDS) {
      for (const block of Object.values(PLATFORM_CELLS[platform]?.families ?? {})) {
        for (const row of block?.models ?? []) {
          if (!("eq" in row.match)) continue;
          const v = valueFacts({ modelId: row.match.eq }, "openai_compat", platform);
          const note = contextNote(t, v.contextSize, name(platform));
          if (v.contextSize.table) expect(note).toContain(sourceName(t, v.contextSize.table.source, platform));
          else expect(note).toBeUndefined();
        }
      }
    }
  });
});

describe("a new row's prefill", () => {
  it("takes the type and the PDF declaration, never a value fact", () => {
    for (const platform of PLATFORM_IDS) {
      for (const block of Object.values(PLATFORM_CELLS[platform]?.families ?? {})) {
        for (const row of block?.models ?? []) {
          if (!("eq" in row.match)) continue;
          const prefill = calibrationPrefill(platformModelCalibration(platform, row.match.eq) ?? {});
          expect(Object.keys(prefill).sort()).toEqual(["pdfInput", "type"]);
        }
      }
    }
  });
});
