import { describe, expect, it } from "vitest";
import { mergeConcatenatedArgs } from "../toolArgs";

describe("mergeConcatenatedArgs", () => {
  it("merges a placeholder object followed by the real one, left to right", () => {
    expect(JSON.parse(mergeConcatenatedArgs('{}{"id":1}'))).toEqual({ id: 1 });
    expect(JSON.parse(mergeConcatenatedArgs('{"a":1} {"a":2,"b":"x"}'))).toEqual({ a: 2, b: "x" });
  });

  it("is not fooled by braces inside strings", () => {
    // `{"t":"}{"}` then `{"u":"x\"}"}` — a brace and an escaped quote inside strings.
    expect(JSON.parse(mergeConcatenatedArgs('{"t":"}{"}{"u":"x\\"}"}'))).toEqual({ t: "}{", u: 'x"}' });
  });

  it("leaves valid JSON and the empty string untouched", () => {
    expect(mergeConcatenatedArgs('{"path":"a.md"}')).toBe('{"path":"a.md"}');
    expect(mergeConcatenatedArgs("")).toBe("");
  });

  it("leaves a genuinely broken string alone for the caller to report", () => {
    // A truncation: one object that never closes.
    expect(mergeConcatenatedArgs('{"content":"half')).toBe('{"content":"half');
    // Something other than objects between them.
    expect(mergeConcatenatedArgs('{} x {"id":1}')).toBe('{} x {"id":1}');
    // An array among them.
    expect(mergeConcatenatedArgs('{}[1]')).toBe("{}[1]");
  });
});
