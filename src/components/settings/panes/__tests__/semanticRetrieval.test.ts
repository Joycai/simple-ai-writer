import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Model } from "../../../../lib/ai/configDb";
import type { SemanticPrefs } from "../../../../lib/context/semanticPrefs";

type Choice = { value: string; label: string };
const fixture = vi.hoisted(() => ({
  models: [] as Model[], providers: [{ id: "channel", name: "Local" }],
  prefs: { enabled: true, embeddingModelId: "", rerankerModelId: "", minScore: 0.5 } as SemanticPrefs,
  choices: {} as Record<string, { options: Choice[]; onChange: (value: string) => void }>,
  save: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../../stores/projectStore", () => ({
  useProjectStore: (select: (s: { projectPath: string }) => unknown) => select({ projectPath: "/fictional-project" }),
  useTerms: () => ({ kb: "Knowledge Base", entry: "entry" }),
}));
vi.mock("../../../../stores/aiStore", () => ({ useAiStore: (select: (s: typeof fixture) => unknown) => select(fixture) }));
vi.mock("../../../../lib/context/semanticPrefs", () => ({
  semanticPrefs: () => fixture.prefs, saveSemanticPrefs: fixture.save,
}));
vi.mock("../../../common/Select", () => ({ Select: (props: { ariaLabel: string; options: Choice[]; onChange: (value: string) => void }) => {
  fixture.choices[props.ariaLabel] = props;
  return null;
} }));
vi.mock("../SemanticIndexPanel", () => ({ SemanticIndexPanel: () => null }));
import { SemanticRetrieval } from "../SemanticRetrieval";

const model = (id: string, type: Model["type"], extra: Partial<Model> = {}): Model => ({
  id, type, providerId: "channel", modelId: id, name: id, enabled: true,
  priceIn: 0, priceCachedIn: 0, priceOut: 0, ...extra,
});
beforeEach(() => {
  fixture.models = [model("vectors", "embedding"), model("ranking", "rerank"), model("chat", "text"),
    model("disabled", "embedding", { enabled: false }), model("orphan", "embedding", { providerId: "missing" })];
  fixture.prefs = { enabled: true, embeddingModelId: "", rerankerModelId: "", minScore: 0.5 };
  fixture.choices = {};
  fixture.save.mockClear();
});
describe("Labs retrieval model selection", () => {
  it("offers enabled models by purpose from existing channels and only saves the project selection", () => {
    const html = renderToStaticMarkup(createElement(SemanticRetrieval));
    expect(fixture.choices["semantic.embedding"].options.map((o) => o.value)).toEqual(["", "vectors"]);
    expect(fixture.choices["semantic.reranker"].options.map((o) => o.value)).toEqual(["", "ranking"]);
    fixture.choices["semantic.embedding"].onChange("vectors");
    expect(fixture.save).toHaveBeenCalledWith("/fictional-project", { ...fixture.prefs, embeddingModelId: "vectors" });
    expect(html).toContain("semantic.manageModelsHint");
    expect(html).not.toContain("<form");
  });
  it.each(["disabled", "orphan", "chat", "deleted"])("preserves unavailable selection %s without substituting a model", (id) => {
    fixture.prefs.embeddingModelId = id;
    renderToStaticMarkup(createElement(SemanticRetrieval));
    expect(fixture.choices["semantic.embedding"].options).toContainEqual({ value: id, label: "semantic.unavailableModel" });
    expect(fixture.save).not.toHaveBeenCalled();
  });
});
