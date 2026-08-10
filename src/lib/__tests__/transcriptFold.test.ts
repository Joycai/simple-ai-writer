import { describe, expect, it } from "vitest";
import {
  FOLD_KEEP_ENTRIES,
  FOLD_MIN_HIDDEN,
  foldBoundary,
} from "../agent/transcriptFold";

/** n exchanges: user, assistant, user, assistant, … */
function exchanges(n: number): ("user" | "assistant")[] {
  return Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? "user" : "assistant"));
}

describe("foldBoundary", () => {
  it("hides nothing while the transcript is short", () => {
    expect(foldBoundary([])).toBe(0);
    expect(foldBoundary(exchanges(2))).toBe(0);
    // Just past the keep window but under the minimum worth hiding.
    expect(foldBoundary(exchanges(5))).toBe(0);
  });

  it("folds a long transcript down to the keep window", () => {
    const roles = exchanges(10); // 20 entries
    const cut = foldBoundary(roles);
    expect(cut).toBeGreaterThanOrEqual(FOLD_MIN_HIDDEN);
    expect(roles.length - cut).toBeGreaterThanOrEqual(FOLD_KEEP_ENTRIES);
    // The visible transcript opens with a question, not an orphaned answer.
    expect(roles[cut]).toBe("user");
  });

  it("walks the cut back to a user entry when it would land mid-exchange", () => {
    // Two assistant entries per exchange (e.g. an error turn appended after) —
    // a naive length-based cut lands on an assistant entry.
    const roles: ("user" | "assistant")[] = [];
    for (let i = 0; i < 5; i++) roles.push("user", "assistant", "assistant");
    const cut = foldBoundary(roles);
    if (cut > 0) expect(roles[cut]).toBe("user");
  });

  it("keeps growing sessions folded to the same window as turns append", () => {
    const before = foldBoundary(exchanges(10));
    const after = foldBoundary(exchanges(11));
    expect(after).toBeGreaterThan(before);
  });
});
