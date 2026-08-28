// 谁比较新 — the freshness verdict is drawn from the same three hash maps the
// plan reads, so these cases mirror `syncPlan.test.ts`'s vocabulary: h1/h2/h3
// are contents, and "changed" always means "differs from the snapshot".

import { describe, expect, it } from "vitest";
import { compareFreshness } from "../sync/status";

const h1 = "a".repeat(64);
const h2 = "b".repeat(64);
const h3 = "c".repeat(64);

describe("compareFreshness", () => {
  it("reports in-sync when every entry matches, however each side got there", () => {
    const f = compareFreshness({ "characters/alice": h1 }, { "characters/alice": h1 }, {});
    expect(f).toEqual({ verdict: "in-sync", localAhead: 0, remoteAhead: 0, diverged: 0 });

    // Both sides edited their way to the same content: still nothing to do,
    // even though the snapshot disagrees with both — same rule as the plan.
    const converged = compareFreshness(
      { "characters/alice": h2 },
      { "characters/alice": h2 },
      { "characters/alice": h1 },
    );
    expect(converged.verdict).toBe("in-sync");
  });

  it("attributes a one-sided edit to the side that moved", () => {
    const snapshot = { "characters/alice": h1 };
    expect(compareFreshness({ "characters/alice": h2 }, { "characters/alice": h1 }, snapshot))
      .toMatchObject({ verdict: "local-ahead", localAhead: 1 });
    expect(compareFreshness({ "characters/alice": h1 }, { "characters/alice": h2 }, snapshot))
      .toMatchObject({ verdict: "remote-ahead", remoteAhead: 1 });
  });

  it("treats appearing and disappearing as changes, like the plan does", () => {
    // A new local-only entry: only local moved.
    expect(compareFreshness({ "world/north": h1 }, {}, {})).toMatchObject({
      verdict: "first-sync",
      localAhead: 1,
    });
    // Deleted remotely since the last sync: only remote moved.
    expect(
      compareFreshness({ "world/north": h1 }, {}, { "world/north": h1 }),
    ).toMatchObject({ verdict: "remote-ahead", remoteAhead: 1 });
    // Deleted on both sides: they agree, nothing to attribute.
    expect(compareFreshness({}, {}, { "world/north": h1 }).verdict).toBe("in-sync");
  });

  it("calls it diverged when both sides moved — same entry or different ones", () => {
    const snapshot = { "characters/alice": h1, "world/north": h1 };
    // The same entry edited on both sides.
    const same = compareFreshness(
      { "characters/alice": h2, "world/north": h1 },
      { "characters/alice": h3, "world/north": h1 },
      snapshot,
    );
    expect(same).toMatchObject({ verdict: "diverged", diverged: 1 });
    // Disjoint entries: each side ahead somewhere — still no safe direction,
    // because a mirror overwrites the whole receiving side.
    const disjoint = compareFreshness(
      { "characters/alice": h2, "world/north": h1 },
      { "characters/alice": h1, "world/north": h2 },
      snapshot,
    );
    expect(disjoint).toMatchObject({ verdict: "diverged", localAhead: 1, remoteAhead: 1 });
  });

  it("refuses to guess before the first sync", () => {
    // No snapshot: a difference cannot be attributed to either side, and a
    // verdict that guessed would send the author mirroring the wrong way.
    const f = compareFreshness({ "characters/alice": h1 }, { "characters/alice": h2 }, {});
    expect(f.verdict).toBe("first-sync");
    expect(f.diverged).toBe(1);
  });
});
