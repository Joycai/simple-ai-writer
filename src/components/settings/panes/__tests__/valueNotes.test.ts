/**
 * The line under 上下文 / 最大输出 / 思考类目 (P6 界面, LLD §9.9). What is held:
 * every note is chosen from the real `valueFacts` of real platform rows, the
 * sentence names the source `valueFacts` reports (which `values.test.ts` holds
 * to the request), what clearing a typed value gives up is said where it gives
 * something up — and an effort follows a new id only while the category is 自动.
 */
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import zh from "../../../../i18n/locales/zh-CN.json";
import { PLATFORM_CELLS, thinkingCategoryOf, type Source } from "../../../../lib/ai/capabilities";
import { valueFacts } from "../../../../lib/ai/modelSummary";
import { PLATFORM_IDS, type PlatformId } from "../../../../lib/ai/platforms";
import { categoryNote, contextNote, effortForNewId, maxOutputNote, sourceName } from "../valueNotes";

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
    // Typed, max_tokens is the field: nothing to add.
    const typed = valueFacts({ modelId: "deepseek-v4-pro", maxOutput: 9000 }, deepseekMessages.standard, deepseekMessages.platform);
    expect(maxOutputNote(t, typed.maxOutput, name("deepseek"))).toBe("手填 · 覆盖平台 · DeepSeek 官方 393,216");
    const unknown = valueFacts({ modelId: "mystery-model" }, deepseekMessages.standard, deepseekMessages.platform);
    expect(maxOutputNote(t, unknown.maxOutput, name("deepseek"))).toBe("未知 · max_tokens 发 32,768");
  });

  it("says what clearing a typed value that matches the tables gives up", () => {
    // Clearing the window drops the pre-send gate (TRUST.contextGate).
    const ctx = valueFacts({ modelId: "glm-5.3", contextSize: 1_048_576 }, zhipu.standard, zhipu.platform);
    expect(contextNote(t, ctx.contextSize, name("zhipu"))).toBe("与平台 · 智谱 BigModel一致 · 清空后跟随它，但发送前不再拦截");
    // On a Messages route, clearing the cap drops max_tokens to the adapter's default.
    const cap = valueFacts({ modelId: "deepseek-v4-pro", maxOutput: 393_216 }, deepseekMessages.standard, deepseekMessages.platform);
    expect(maxOutputNote(t, cap.maxOutput, name("deepseek"))).toBe("与平台 · DeepSeek 官方一致 · 清空后跟随它；max_tokens 改发 32,768");
    // Where the cap is never sent, clearing changes nothing a request carries.
    const chat = valueFacts({ modelId: "glm-5.3", maxOutput: 131_072 }, zhipu.standard, zhipu.platform);
    expect(maxOutputNote(t, chat.maxOutput, name("zhipu"))).toBe("与平台 · 智谱 BigModel一致 · 清空后跟随它");
  });

  it("typed and different: covers the tables", () => {
    const over = valueFacts({ modelId: "glm-5.3", maxOutput: 4000 }, zhipu.standard, zhipu.platform);
    expect(maxOutputNote(t, over.maxOutput, name("zhipu"))).toBe("手填 · 覆盖平台 · 智谱 BigModel 131,072");
  });

  it("says nothing the tables cannot back, and 未知 where an empty field follows nothing", () => {
    const v = valueFacts({ modelId: "mystery-model", contextSize: 8000, maxOutput: 2000 }, zhipu.standard, zhipu.platform);
    expect(contextNote(t, v.contextSize, name("zhipu"))).toBeUndefined();
    expect(maxOutputNote(t, v.maxOutput, name("zhipu"))).toBeUndefined();
    const blank = valueFacts({ modelId: "mystery-model" }, zhipu.standard, zhipu.platform);
    expect(contextNote(t, blank.contextSize, name("zhipu"))).toBe("未知 · 发送前不拦截，预算用默认");
    expect(maxOutputNote(t, blank.maxOutput, name("zhipu"))).toBe("未知 · 预算用默认，不发送");
    // A picked category the tables agree with needs no note.
    expect(categoryNote(t, valueFacts({ modelId: "glm-5.3", thinkingCategory: "glm" }, zhipu.standard, zhipu.platform).thinkingCategory, name("zhipu")))
      .toBeUndefined();
    expect(categoryNote(t, valueFacts({ modelId: "glm-5.3", thinkingCategory: "glm-effort" }, zhipu.standard, zhipu.platform).thinkingCategory, name("zhipu")))
      .toBe("自动时为 GLM-5.3 · 平台 · 智谱 BigModel");
  });

  it("names the source valueFacts reports, for every platform row", () => {
    for (const platform of PLATFORM_IDS) {
      for (const block of Object.values(PLATFORM_CELLS[platform]?.families ?? {})) {
        for (const row of block?.models ?? []) {
          if (!("eq" in row.match)) continue;
          const v = valueFacts({ modelId: row.match.eq }, "openai_compat", platform);
          const note = contextNote(t, v.contextSize, name(platform));
          if (v.contextSize.table) expect(note).toContain(sourceName(t, v.contextSize.table.source, platform));
          else expect(note).toBe("未知 · 发送前不拦截，预算用默认");
        }
      }
    }
  });
});

describe("an effort when the model id changes", () => {
  const glm53 = thinkingCategoryOf({ modelId: "glm-5.3" }, zhipu).value;

  it("follows the new id while the category is 自动", () => {
    // glm-5.2 takes off; glm-5.3 cannot stop thinking, so off would be ignored.
    expect(glm53.menu).not.toContain("off");
    expect(effortForNewId("auto", "off", glm53)).not.toBe("off");
    expect(effortForNewId(undefined, "off", glm53)).not.toBe("off");
    // A level the new category has stays.
    expect(effortForNewId("auto", "high", glm53)).toBe("high");
  });

  it("leaves a declared category's effort alone", () => {
    expect(effortForNewId("glm-effort", "off", glm53)).toBe("off");
  });
});
