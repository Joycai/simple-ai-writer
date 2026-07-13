import { describe, it, expect } from "vitest";
import { extractJsonObject } from "../ai/json";

describe("extractJsonObject", () => {
  it("returns a bare JSON object unchanged", () => {
    const s = '{"name":"Kaladin","aliases":["Kal"]}';
    expect(extractJsonObject(s)).toBe(s);
  });

  it("unwraps a ```json fenced block", () => {
    const out = extractJsonObject('```json\n{"a":1}\n```');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("unwraps a plain ``` fence", () => {
    const out = extractJsonObject('```\n{"a":1}\n```');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("pulls the object out of surrounding reasoning prose", () => {
    const reply =
      'Let me think. The summary should be short.\n{"name":"Shallan","summary":"A scholar."}\nDone.';
    expect(JSON.parse(extractJsonObject(reply))).toEqual({
      name: "Shallan",
      summary: "A scholar.",
    });
  });

  it("keeps nested braces via the outermost span", () => {
    const reply = 'result: {"a":{"b":2},"c":3} end';
    expect(JSON.parse(extractJsonObject(reply))).toEqual({ a: { b: 2 }, c: 3 });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJsonObject("no json here")).toThrow();
  });
});
