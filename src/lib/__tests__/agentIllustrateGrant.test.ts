/**
 * The counted illustrate grant (批准并连批): the next N image proposals apply
 * without a card, each decrementing the budget, and the leftover budget dies
 * with the run that created it.
 *
 * Counted and run-scoped on purpose — every auto-approval here spends real
 * money, so the authorisation is an amount given for this run's pictures,
 * never a standing mode (which is why illustrate stays outside 本次都批准).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IllustrateProposal } from "../agent/registry";

const runIllustration = vi.fn(async () => ({ path: "/proj/w/assets/pic.png", markdown: "", degraded: false }));
vi.mock("../image/illustrate", () => ({
  runIllustration: () => runIllustration(),
}));
vi.mock("../../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projectPath: "/proj" }) },
}));

import { useAgentStore } from "../../stores/agentStore";

// applyProposal reaches both mocked modules through dynamic import(). Two
// auto-approvals settle concurrently, and vitest's module runner can race a
// concurrent first-load of a mocked module into evaluating the real file —
// warming the cache here keeps every later import() on the mock.
await import("../../stores/projectStore");
await import("../image/illustrate");

const KEY = "chat";
let seq = 0;
function illu(): IllustrateProposal {
  return {
    kind: "illustrate",
    id: `il-${++seq}`,
    path: "/proj/w/a.md",
    prompt: "a knight",
    destination: "a.md",
    dest: { kind: "document", docPath: "/proj/w/a.md" },
    note: "n",
    modelId: "m1",
    modelName: "M",
    costUsd: 0.04,
  };
}

beforeEach(() => {
  runIllustration.mockClear();
  useAgentStore.setState({ pending: [], autoApprove: null });
});

describe("counted illustrate grant", () => {
  it("covers exactly N follow-ups, then goes back to asking", async () => {
    const run = {};
    useAgentStore.getState().grantIllustrations(KEY, run, 2);

    // Sequential like the real tool loop (write tools run one at a time).
    // Both apply without a card, and report as auto so the model knows nobody
    // read them.
    const d1 = await useAgentStore.getState().requestApproval(illu(), run, { autoApproveKey: KEY });
    const d2 = await useAgentStore.getState().requestApproval(illu(), run, { autoApproveKey: KEY });
    expect(d1).toMatchObject({ approved: true, auto: true });
    expect(d2).toMatchObject({ approved: true, auto: true });
    expect(runIllustration).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().pending).toHaveLength(0);

    // Budget spent: the third asks like it always did.
    useAgentStore.getState().requestApproval(illu(), run, { autoApproveKey: KEY });
    expect(useAgentStore.getState().pending).toHaveLength(1);
    expect(runIllustration).toHaveBeenCalledTimes(2);
    useAgentStore.getState().rejectAll("cleanup", run);
  });

  it("voids the leftover budget when the granting run ends — even for chat", () => {
    const run = {};
    useAgentStore.getState().grantIllustrations(KEY, run, 3);
    // The run ends; the chat-keyed grant object survives (that is the boolean
    // grants' contract) but the money budget inside it must not.
    useAgentStore.getState().rejectAll("run over", run);
    expect(useAgentStore.getState().autoApprove?.illustrateLeft ?? 0).toBe(0);

    const nextRun = {};
    useAgentStore.getState().requestApproval(illu(), nextRun, { autoApproveKey: KEY });
    expect(useAgentStore.getState().pending).toHaveLength(1);
    expect(runIllustration).not.toHaveBeenCalled();
    useAgentStore.getState().rejectAll("cleanup", nextRun);
  });

  it("does not leak across surfaces, and never covers an unbound card", () => {
    const run = {};
    useAgentStore.getState().grantIllustrations(KEY, run, 3);
    // A surface that never offered the button (no binding) keeps asking.
    useAgentStore.getState().requestApproval(illu(), run, {});
    // A different surface's key is not this grant's key.
    useAgentStore.getState().requestApproval(illu(), run, { autoApproveKey: {} });
    expect(useAgentStore.getState().pending).toHaveLength(2);
    expect(runIllustration).not.toHaveBeenCalled();
    useAgentStore.getState().rejectAll("cleanup", run);
  });

  it("clamps the granted count to the card's own 1–5 range", () => {
    useAgentStore.getState().grantIllustrations(KEY, {}, 99);
    expect(useAgentStore.getState().autoApprove?.illustrateLeft).toBe(5);
    useAgentStore.getState().grantIllustrations(KEY, {}, 0);
    expect(useAgentStore.getState().autoApprove?.illustrateLeft).toBe(1);
  });

  it("keeps the blanket grants' own rule: illustrate is never covered by 本次都批准", () => {
    const run = {};
    useAgentStore.getState().enableAutoApprove(KEY, "proposals");
    useAgentStore.getState().requestApproval(illu(), run, { autoApproveKey: KEY });
    expect(useAgentStore.getState().pending).toHaveLength(1);
    expect(runIllustration).not.toHaveBeenCalled();
    useAgentStore.getState().rejectAll("cleanup", run);
  });
});
