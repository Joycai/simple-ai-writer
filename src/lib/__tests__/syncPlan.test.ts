import { describe, it, expect } from "vitest";
import { planSync, actionableSteps, hasWarnings } from "../sync/plan";
import type { HashMap, SyncDirection, SyncStep } from "../sync/model";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function plan(
  direction: SyncDirection,
  local: HashMap,
  remote: HashMap,
  snapshot: HashMap = {},
) {
  return planSync({ local, remote, snapshot, direction });
}

function at(steps: SyncStep[], path: string): SyncStep {
  const found = steps.find((s) => s.path === path);
  if (!found) throw new Error(`no step for ${path}`);
  return found;
}

describe("planSync — the three-way rail", () => {
  it("does nothing when both sides already agree", () => {
    const p = plan("push", { "characters/alice": A }, { "characters/alice": A }, { "characters/alice": A });
    expect(at(p.steps, "characters/alice").action).toBe("none");
    expect(p.summary).toMatchObject({ unchanged: 1, warnings: 0 });
    expect(actionableSteps(p)).toHaveLength(0);
  });

  it("treats independently converged sides as done, not as a conflict", () => {
    // Both machines made the same edit. The snapshot disagrees with both, so a
    // naive "did it change?" test would call this a two-sided conflict — but
    // the content is identical, which is the state a sync is trying to reach.
    const p = plan("push", { "characters/alice": B }, { "characters/alice": B }, { "characters/alice": A });
    const step = at(p.steps, "characters/alice");
    expect(step.action).toBe("none");
    expect(step.warning).toBeNull();
    expect(step.localChanged && step.remoteChanged).toBe(true);
  });

  it("pushes a local-only edit without a warning", () => {
    const p = plan("push", { "characters/alice": B }, { "characters/alice": A }, { "characters/alice": A });
    expect(at(p.steps, "characters/alice")).toMatchObject({
      action: "overwrite",
      warning: null,
      sourceHash: B,
      targetHash: A,
    });
  });

  it("warns when pulling would discard a local-only edit", () => {
    // Same inputs as above, other direction: the side being overwritten is the
    // one that moved, so this is the author throwing away their own work.
    const p = plan("pull", { "characters/alice": B }, { "characters/alice": A }, { "characters/alice": A });
    expect(at(p.steps, "characters/alice")).toMatchObject({
      action: "overwrite",
      warning: "overwrites-newer",
    });
  });

  it("warns when pushing a stale copy over a newer remote", () => {
    const p = plan("push", { "characters/alice": A }, { "characters/alice": B }, { "characters/alice": A });
    expect(at(p.steps, "characters/alice").warning).toBe("overwrites-newer");
  });

  it("flags both-changed in either direction", () => {
    const local = { "characters/alice": B };
    const remote = { "characters/alice": C };
    const snapshot = { "characters/alice": A };
    for (const direction of ["push", "pull"] as const) {
      expect(at(plan(direction, local, remote, snapshot).steps, "characters/alice")).toMatchObject({
        action: "overwrite",
        warning: "both-changed",
      });
    }
  });
});

describe("planSync — creates and deletes", () => {
  it("creates an entry the receiving side never had, silently", () => {
    const p = plan("push", { "characters/alice": A }, {}, {});
    expect(at(p.steps, "characters/alice")).toMatchObject({ action: "create", warning: null });
  });

  it("propagates a local deletion as a remote deletion", () => {
    // Mirror semantics: without this, a deletion could never travel — remove it
    // here, push, pull there, and it is still present (docs §14.1).
    const p = plan("push", {}, { "characters/alice": A }, { "characters/alice": A });
    expect(at(p.steps, "characters/alice")).toMatchObject({
      action: "delete",
      warning: null,
      sourceHash: null,
      targetHash: A,
    });
  });

  it("warns when a push would resurrect an entry deleted on the remote", () => {
    const p = plan("push", { "characters/alice": A }, {}, { "characters/alice": A });
    expect(at(p.steps, "characters/alice")).toMatchObject({ action: "create", warning: "resurrects" });
  });

  it("calls a local delete against a remote edit a two-sided conflict", () => {
    // Both sides moved: this machine deleted the entry, the other rewrote it.
    // Not a plain deletion — going either way destroys one of those decisions.
    const p = plan("push", {}, { "characters/alice": B }, { "characters/alice": A });
    expect(at(p.steps, "characters/alice")).toMatchObject({ action: "delete", warning: "both-changed" });
  });

  it("warns when a pull would delete a local-only entry", () => {
    // The dangerous shape of "just pull the server copy": entries this machine
    // has and the server never saw are removed, and nothing else in the flow
    // would tell the author that.
    const p = plan("pull", { "characters/alice": A }, {}, {});
    expect(at(p.steps, "characters/alice")).toMatchObject({ action: "delete", warning: "deletes-unsynced" });
  });
});

describe("planSync — first sync", () => {
  it("reports the absence of a snapshot", () => {
    expect(plan("push", { "a/x": A }, {}, {}).firstSync).toBe(true);
    expect(plan("push", { "a/x": A }, {}, { "a/x": A }).firstSync).toBe(false);
  });

  it("calls differing content a conflict when there is nothing to compare against", () => {
    // Honest rather than reassuring: with no snapshot, nothing distinguishes
    // "my edit" from "their edit", so both-changed is the truthful answer.
    const p = plan("push", { "characters/alice": A }, { "characters/alice": B }, {});
    expect(at(p.steps, "characters/alice").warning).toBe("both-changed");
  });

  it("still recognises identical entries on a first sync", () => {
    const p = plan("push", { "characters/alice": A }, { "characters/alice": A }, {});
    expect(at(p.steps, "characters/alice").action).toBe("none");
  });
});

describe("planSync — shape of the result", () => {
  it("covers the union of all three sides, sorted", () => {
    const p = plan(
      "push",
      { "b/local-only": A },
      { "c/remote-only": A },
      { "a/gone-from-both": A },
    );
    expect(p.steps.map((s) => s.path)).toEqual([
      "a/gone-from-both",
      "b/local-only",
      "c/remote-only",
    ]);
  });

  it("counts each action and every warning", () => {
    const p = plan(
      "push",
      { "a/create": A, "a/overwrite": B, "a/same": A },
      { "a/overwrite": A, "a/same": A, "a/delete": A },
      { "a/overwrite": A, "a/same": A, "a/delete": B },
    );
    expect(p.summary).toEqual({ create: 1, overwrite: 1, delete: 1, unchanged: 1, warnings: 1 });
    expect(hasWarnings(p)).toBe(true);
    expect(actionableSteps(p).map((s) => s.path)).toEqual(["a/create", "a/delete", "a/overwrite"]);
  });

  it("orients sourceHash/targetHash by direction", () => {
    const local = { "a/x": A };
    const remote = { "a/x": B };
    expect(at(plan("push", local, remote).steps, "a/x")).toMatchObject({ sourceHash: A, targetHash: B });
    expect(at(plan("pull", local, remote).steps, "a/x")).toMatchObject({ sourceHash: B, targetHash: A });
  });

  it("handles two empty sides", () => {
    const p = plan("push", {}, {}, {});
    expect(p.steps).toEqual([]);
    expect(p.summary).toEqual({ create: 0, overwrite: 0, delete: 0, unchanged: 0, warnings: 0 });
  });
});
