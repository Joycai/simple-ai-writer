import { describe, expect, it } from "vitest";
import { moveId } from "../ai/providerOrder";

const IDS = ["a", "b", "c", "d"];

describe("moveId", () => {
  it("moves up and down by one", () => {
    expect(moveId(IDS, "c", "up")).toEqual(["a", "c", "b", "d"]);
    expect(moveId(IDS, "b", "down")).toEqual(["a", "c", "b", "d"]);
  });

  it("sends to top and bottom across any distance", () => {
    expect(moveId(IDS, "d", "top")).toEqual(["d", "a", "b", "c"]);
    expect(moveId(IDS, "a", "bottom")).toEqual(["b", "c", "d", "a"]);
  });

  it("returns null for a no-op so callers can skip the write", () => {
    expect(moveId(IDS, "a", "up")).toBeNull();
    expect(moveId(IDS, "a", "top")).toBeNull();
    expect(moveId(IDS, "d", "down")).toBeNull();
    expect(moveId(IDS, "d", "bottom")).toBeNull();
  });

  it("returns null for an unknown id", () => {
    expect(moveId(IDS, "zzz", "up")).toBeNull();
  });

  it("does not mutate the input", () => {
    const input = [...IDS];
    moveId(input, "c", "top");
    expect(input).toEqual(IDS);
  });

  it("handles a single-element list", () => {
    expect(moveId(["only"], "only", "up")).toBeNull();
    expect(moveId(["only"], "only", "bottom")).toBeNull();
  });
});
