/**
 * Strict-mode schema adaptation. The two rules under test are the ones
 * `docs/api/structured.md` §3 lists for `strict: true` — every object says
 * `additionalProperties: false` and lists every property in `required` — and
 * the round trip: a reply parsed under the strictified schema, with nulls
 * stripped, has the shape a caller written against the original expects.
 */
import { describe, expect, it } from "vitest";
import { strictify, stripNulls } from "../ai/jsonSchemaStrict";

/** The consistency scan's shape, in miniature: optional fields, enum, nesting. */
const FINDINGS = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["error", "warning"] },
          title: { type: "string" },
          suggestion: { type: "string", description: "optional" },
          entity: { type: "string", enum: ["a", "b"] },
        },
        required: ["severity", "title"],
      },
    },
    passed: { type: "array", items: { type: "string" } },
  },
  required: ["issues", "passed"],
};

function walk(node: Record<string, unknown>, visit: (n: Record<string, unknown>) => void): void {
  visit(node);
  for (const p of Object.values((node.properties ?? {}) as Record<string, Record<string, unknown>>)) walk(p, visit);
  if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) {
    walk(node.items as Record<string, unknown>, visit);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const s of (node[key] as Record<string, unknown>[] | undefined) ?? []) walk(s, visit);
  }
}

describe("strictify", () => {
  it("satisfies both strict rules at every object level", () => {
    const strict = strictify(FINDINGS);
    walk(strict, (n) => {
      if (n.type !== "object") return;
      expect(n.additionalProperties).toBe(false);
      expect((n.required as string[]).sort()).toEqual(Object.keys(n.properties as object).sort());
    });
  });

  it("makes exactly the originally-optional fields nullable, enum included", () => {
    const strict = strictify(FINDINGS);
    const issue = ((strict.properties as Record<string, Record<string, unknown>>).issues.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(issue.severity).toEqual({ type: "string", enum: ["error", "warning"] });
    expect(issue.title).toEqual({ type: "string" });
    expect(issue.suggestion).toEqual({ type: ["string", "null"], description: "optional" });
    // A null type with an enum that excludes null is a contradiction validators reject.
    expect(issue.entity).toEqual({ type: ["string", "null"], enum: ["a", "b", null] });
  });

  it("leaves the caller's schema untouched", () => {
    const before = JSON.stringify(FINDINGS);
    strictify(FINDINGS);
    expect(JSON.stringify(FINDINGS)).toBe(before);
  });

  it("is idempotent", () => {
    const once = strictify(FINDINGS);
    expect(strictify(once)).toEqual(once);
  });

  it("wraps a node with no type keyword in anyOf rather than inventing a type", () => {
    const strict = strictify({
      type: "object",
      properties: { any: { description: "whatever" } },
    });
    expect((strict.properties as Record<string, unknown>).any).toEqual({
      anyOf: [{ description: "whatever" }, { type: "null" }],
    });
  });
});

describe("stripNulls", () => {
  it("removes null-valued properties at every depth", () => {
    expect(stripNulls({
      issues: [{ severity: "error", title: "t", suggestion: null, entity: null }],
      passed: [],
      extra: null,
    })).toEqual({
      issues: [{ severity: "error", title: "t" }],
      passed: [],
    });
  });

  it("keeps a null the model put inside an array", () => {
    expect(stripNulls({ list: [1, null, 2] })).toEqual({ list: [1, null, 2] });
  });

  it("round-trips a reply to the shape the original schema promised", () => {
    // What a caller written against FINDINGS expects: optional fields absent,
    // not null. `"suggestion" in issue` must be false.
    const reply = { issues: [{ severity: "warning", title: "x", suggestion: null, entity: "a" }], passed: ["ok"] };
    const out = stripNulls(reply) as typeof reply;
    expect("suggestion" in out.issues[0]).toBe(false);
    expect(out.issues[0].entity).toBe("a");
  });
});
