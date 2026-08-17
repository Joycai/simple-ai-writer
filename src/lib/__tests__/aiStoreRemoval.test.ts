/**
 * aiStore.removeModel/removeProvider — deleting the model or provider behind
 * activeModelId/memoryModelId must clear the pointer, not leave the store
 * referencing an id that no longer resolves to anything. removeModel already
 * did this for activeModelId; memoryModelId (Story-Memory's model choice) and
 * the provider-cascade case (removing a provider deletes its models too) were
 * both missed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useAiStore } from "../../stores/aiStore";
import type { Model, Provider } from "../ai/configDb";

const PROVIDER: Provider = {
  id: "p1",
  name: "Test",
  baseUrl: "http://localhost",
  apiStandard: "openai",
  createdAt: 0,
} as unknown as Provider;

const MODEL_A: Model = { id: "m1", providerId: "p1", name: "A" } as unknown as Model;
const MODEL_B: Model = { id: "m2", providerId: "p1", name: "B" } as unknown as Model;
const MODEL_OTHER: Model = { id: "m3", providerId: "p2", name: "Other" } as unknown as Model;

beforeEach(() => {
  useAiStore.setState({
    providers: [PROVIDER],
    models: [MODEL_A, MODEL_B],
    activeModelId: "m1",
    memoryModelId: "m1",
    subAgents: {
      search: { kind: "search", modelId: "m1", enabled: true },
      vision: { kind: "vision", modelId: "m2", enabled: true },
      longread: { kind: "longread", modelId: null, enabled: false },
      pdf: { kind: "pdf", modelId: null, enabled: false },
      imagegen: { kind: "imagegen", modelId: null, enabled: false },
    },
  });
});

describe("aiStore.removeModel", () => {
  it("clears activeModelId when it points at the removed model", async () => {
    await useAiStore.getState().removeModel("m1");
    expect(useAiStore.getState().activeModelId).toBeNull();
  });

  it("clears memoryModelId when it points at the removed model", async () => {
    await useAiStore.getState().removeModel("m1");
    expect(useAiStore.getState().memoryModelId).toBeNull();
  });

  it("clears subAgents.modelId when it points at the removed model", async () => {
    await useAiStore.getState().removeModel("m1");
    expect(useAiStore.getState().subAgents.search.modelId).toBeNull();
    expect(useAiStore.getState().subAgents.vision.modelId).toBe("m2");
  });

  it("leaves both pointers alone when a different model is removed", async () => {
    await useAiStore.getState().removeModel("m2");
    expect(useAiStore.getState().activeModelId).toBe("m1");
    expect(useAiStore.getState().memoryModelId).toBe("m1");
  });
});

describe("aiStore.removeProvider", () => {
  it("clears activeModelId, memoryModelId, and subAgents.modelId when they point at a model owned by the removed provider", async () => {
    await useAiStore.getState().removeProvider("p1");

    const state = useAiStore.getState();
    expect(state.models).toHaveLength(0);
    expect(state.activeModelId).toBeNull();
    expect(state.memoryModelId).toBeNull();
    expect(state.subAgents.search.modelId).toBeNull();
    expect(state.subAgents.vision.modelId).toBeNull();
  });

  it("leaves the pointers alone when the removed provider owns neither model", async () => {
    useAiStore.setState({
      providers: [PROVIDER, { ...PROVIDER, id: "p2" }],
      models: [MODEL_A, MODEL_OTHER],
      activeModelId: "m3",
      memoryModelId: "m3",
      subAgents: {
        search: { kind: "search", modelId: "m3", enabled: true },
        vision: { kind: "vision", modelId: null, enabled: false },
        longread: { kind: "longread", modelId: null, enabled: false },
        pdf: { kind: "pdf", modelId: null, enabled: false },
      imagegen: { kind: "imagegen", modelId: null, enabled: false },
      },
    });

    await useAiStore.getState().removeProvider("p1");

    const state = useAiStore.getState();
    expect(state.activeModelId).toBe("m3");
    expect(state.memoryModelId).toBe("m3");
    expect(state.subAgents.search.modelId).toBe("m3");
  });
});

describe("subagent key resolution", () => {
  it("reports a missing API key as configuration, not as a subagent failure", async () => {
    const { resolveSubAgentConn } = await import("../agent/subagent");
    const models = [{ id: "m1", providerId: "p1", modelId: "x", name: "N", type: "text",
      priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true }] as never;
    const providers = [{ id: "p1", name: "Prov", baseUrl: "", apiStandard: "openai" }] as never;
    const subs = {
      search: { kind: "search", modelId: "m1", enabled: true },
      vision: { kind: "vision", modelId: null, enabled: false },
      longread: { kind: "longread", modelId: null, enabled: false },
    } as never;

    // An empty string used to be substituted here, so the request went out
    // keyless and came back 401 — which the parent model read as "the subagent
    // is broken" rather than "paste a key".
    const res = await resolveSubAgentConn("search", models, providers, subs, async () => null);
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/API key/i);

    const ok = await resolveSubAgentConn("search", models, providers, subs, async () => "k");
    expect("error" in ok).toBe(false);
  });
});
