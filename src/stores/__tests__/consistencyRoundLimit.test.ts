import { afterEach, expect, it, vi } from "vitest";
import { requestReviewRoundExtension } from "../consistencyStore";
import { useAgentStore } from "../agentStore";
import { cardsForSurface } from "../../lib/agent/approvalRouting";

vi.mock("../appStore", () => ({ useAppStore: { getState: () => ({}) } }));
vi.mock("../../lib/notify", () => ({ notify: vi.fn(), notifyApproval: vi.fn(), notifyDone: vi.fn(), notifyError: vi.fn() }));
const original = useAgentStore.getState();
afterEach(() => { useAgentStore.setState(original, true); });

it("routes concurrent windows separately and abort settles both pending decisions", async () => {
  const controller = new AbortController();
  const first = requestReviewRoundExtension(0, 11, controller.signal);
  const second = requestReviewRoundExtension(1, 11, controller.signal);
  const cards = useAgentStore.getState().pendingRoundLimits;
  expect(cardsForSurface(cards, null)).toHaveLength(0);
  expect(cardsForSurface(cards, "consistency:0")).toHaveLength(1);
  expect(cardsForSurface(cards, "consistency:1")).toHaveLength(1);
  expect(cards[0].runId).not.toBe(cards[1].runId);
  controller.abort();
  expect(await first).toEqual({ action: "finish" });
  expect(await second).toEqual({ action: "finish" });
  expect(useAgentStore.getState().pendingRoundLimits).toHaveLength(0);
});

it("continues only the selected window and cleans up its card", async () => {
  const controller = new AbortController();
  const first = requestReviewRoundExtension(0, 11, controller.signal);
  const second = requestReviewRoundExtension(1, 11, controller.signal);
  const firstCard = useAgentStore.getState().pendingRoundLimits[0];
  useAgentStore.getState().resolveRoundLimit(firstCard.runId, { action: "extend", rounds: 8 });
  expect(await first).toEqual({ action: "extend", rounds: 8 });
  expect(useAgentStore.getState().pendingRoundLimits.map((p) => p.surface)).toEqual(["consistency:1"]);
  controller.abort();
  await second;
});

it("does not create a card for an already stopped review", async () => {
  const controller = new AbortController();
  controller.abort();
  await requestReviewRoundExtension(0, 11, controller.signal);
  expect(useAgentStore.getState().pendingRoundLimits).toHaveLength(0);
});
