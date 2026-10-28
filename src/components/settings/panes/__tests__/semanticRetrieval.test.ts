import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Model } from "../../../../lib/ai/configDb";
import type { SemanticPrefs } from "../../../../lib/context/semanticPrefs";

type Choice = { value: string; label: string };
const fixture = vi.hoisted(() => ({
  project: "/fictional-project" as string | null,
  models: [] as Model[], providers: [{ id: "channel", name: "Local" }],
  prefs: { enabled: true, embeddingModelId: "", rerankerModelId: "", minScore: 0.5 } as SemanticPrefs,
  choices: {} as Record<string, { options: Choice[]; onChange: (value: string) => void }>,
  save: vi.fn(),
  toggles: {} as Record<string, (on: boolean) => void>,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../../stores/projectStore", () => ({
  useProjectStore: (select: (s: { projectPath: string | null }) => unknown) => select({ projectPath: fixture.project }),
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
vi.mock("../bits", async (original) => ({
  ...await original<typeof import("../bits")>(),
  Toggle: (props: { label: string; onChange: (on: boolean) => void }) => {
    fixture.toggles[props.label] = props.onChange;
    return null;
  },
}));
import { SemanticRetrieval } from "../SemanticRetrieval";

const model = (id: string, type: Model["type"], extra: Partial<Model> = {}): Model => ({
  id, type, providerId: "channel", modelId: id, name: id, enabled: true,
  priceIn: 0, priceCachedIn: 0, priceOut: 0, ...extra,
});
beforeEach(() => {
  fixture.project = "/fictional-project";
  fixture.models = [model("vectors", "embedding"), model("ranking", "rerank"), model("chat", "text"),
    model("disabled", "embedding", { enabled: false }), model("orphan", "embedding", { providerId: "missing" })];
  fixture.prefs = { enabled: true, embeddingModelId: "", rerankerModelId: "", minScore: 0.5 };
  fixture.choices = {}; fixture.toggles = {};
  fixture.save.mockClear();
});
describe("Semantic retrieval model selection", () => {
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


it("saves the current-document opt-in without changing model selection", () => {
  renderToStaticMarkup(createElement(SemanticRetrieval));
  fixture.toggles["semantic.documentEnable"](true);
  expect(fixture.save).toHaveBeenCalledWith("/fictional-project", { ...fixture.prefs, documentEnabled: true });
});

it("keeps configuration visible and editable before enabling retrieval", () => {
  fixture.prefs.enabled = false;
  const html = renderToStaticMarkup(createElement(SemanticRetrieval));
  expect(fixture.toggles["semantic.documentEnable"]).toBeDefined();
  expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  fixture.choices["semantic.embedding"].onChange("vectors");
  expect(fixture.save).toHaveBeenCalledWith("/fictional-project", { ...fixture.prefs, embeddingModelId: "vectors" });
});

it("renders independently saved thresholds with only cosine bounded", () => {
  fixture.prefs = { ...fixture.prefs, cosineMinScore: -0.2, rerankerMinScore: 3 };
  const html = renderToStaticMarkup(createElement(SemanticRetrieval));
  const inputs = html.match(/<input[^>]*>/g) ?? [];
  expect(inputs.find((s) => s.includes('semantic.cosineMinScore'))).toMatch(/min="-1" max="1".*value="-0.2"/);
  const reranker = inputs.find((s) => s.includes('semantic.rerankerMinScore'));
  expect(reranker).toContain('value="3"');
  expect(reranker).not.toMatch(/ (min|max)=/);
});


it("allows enabling and configuring defaults without an open project", () => {
  fixture.project = null;
  fixture.prefs.enabled = false;
  const html = renderToStaticMarkup(createElement(SemanticRetrieval));
  expect(fixture.toggles["semantic.defaultEnable"]).toBeDefined();
  expect(fixture.toggles["semantic.documentEnable"]).toBeDefined();
  expect(fixture.choices["semantic.embedding"]).toBeDefined();
  expect(fixture.choices["semantic.reranker"]).toBeDefined();
  expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  expect(html).toContain("semantic.noProject");
  expect(html).toContain("semantic.cosineMinScore");
  expect(html).toContain("semantic.rerankerMinScore");
  fixture.toggles["semantic.defaultEnable"](true);
  fixture.choices["semantic.embedding"].onChange("vectors");
  expect(fixture.save).toHaveBeenCalledWith(null, { ...fixture.prefs, enabled: true });
  expect(fixture.save).toHaveBeenCalledWith(null, { ...fixture.prefs, embeddingModelId: "vectors" });
});
