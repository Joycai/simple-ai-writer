/**
 * Which upstream a relay model has (lib/ai/relayUpstream.ts): the model's own
 * choice → the channel's longest prefix → a product name in the id → none,
 * and only on a relay platform. capability-gating-plan §8.11.
 */
import { describe, expect, it } from "vitest";
import {
  bracketPrefixes, capabilityModelOf, inferRelayUpstream, isRelayPlatform, matchUpstreamPrefix,
  parseRelayUpstreamChoice, parseUpstreamPrefixes, resolveRelayUpstream, type UpstreamPrefix,
} from "../relayUpstream";

const TABLE: UpstreamPrefix[] = [
  { prefix: "[CC量]", upstream: "cc" },
  { prefix: "[正向AWSb量]", upstream: "bedrock" },
  { prefix: "[正向AWSb量1]", upstream: "official" },
  { prefix: "[特价kiro量]", upstream: "anti" },
];

describe("resolveRelayUpstream", () => {
  it("takes the model's choice first, then the table, then the id, then nothing", () => {
    expect(resolveRelayUpstream("newapi", "[CC量]claude-opus-5", "anti", TABLE)).toEqual({ upstream: "anti", source: "model" });
    expect(resolveRelayUpstream("newapi", "[CC量]claude-opus-5", undefined, TABLE))
      .toEqual({ upstream: "cc", source: "prefix", prefix: "[CC量]" });
    expect(resolveRelayUpstream("custom", "[kiro2]claude-sonnet-5", undefined, TABLE))
      .toEqual({ upstream: "kiro", source: "inferred", word: "kiro" });
    expect(resolveRelayUpstream("newapi", "[anti量]claude-opus-4-6", undefined, TABLE)).toEqual({ source: "none" });
  });

  it("lets the table override what the id would infer", () => {
    // The author mapped this relay's `[特价kiro量]` elsewhere; their table wins over the product name.
    expect(resolveRelayUpstream("newapi", "[特价kiro量]claude-opus-5", undefined, TABLE))
      .toEqual({ upstream: "anti", source: "prefix", prefix: "[特价kiro量]" });
  });

  it("treats `none` as a resolution, not a gap", () => {
    expect(resolveRelayUpstream("newapi", "[kiro]claude-opus-5", "none", TABLE)).toEqual({ source: "model" });
  });

  it("means nothing off a relay", () => {
    expect(resolveRelayUpstream("anthropic", "[CC量]claude-opus-5", "cc", TABLE)).toEqual({ source: "none" });
    expect(resolveRelayUpstream("dashscope", "kiro-claude", undefined, undefined)).toEqual({ source: "none" });
    expect(resolveRelayUpstream(undefined, "kiro-claude", undefined, undefined)).toEqual({ source: "none" });
    expect(isRelayPlatform("newapi")).toBe(true);
    expect(isRelayPlatform("custom")).toBe(true);
    expect(isRelayPlatform("openai")).toBe(false);
  });
});

describe("matchUpstreamPrefix", () => {
  it("takes the longest prefix that starts the id, ignoring case and outer spaces", () => {
    expect(matchUpstreamPrefix("[正向AWSb量1]claude-opus-5", TABLE)?.upstream).toBe("official");
    expect(matchUpstreamPrefix("[正向AWSb量]claude-opus-4-6", TABLE)?.upstream).toBe("bedrock");
    expect(matchUpstreamPrefix("  [cc量]Claude-Opus-5 ", TABLE)?.upstream).toBe("cc");
  });

  it("matches only at the start, and never on an empty prefix", () => {
    expect(matchUpstreamPrefix("claude-opus-5 [CC量]", TABLE)).toBeUndefined();
    expect(matchUpstreamPrefix("claude-opus-5", [{ prefix: "  ", upstream: "cc" }])).toBeUndefined();
    expect(matchUpstreamPrefix("", TABLE)).toBeUndefined();
    expect(matchUpstreamPrefix("[CC量]x", undefined)).toBeUndefined();
  });
});

describe("inferRelayUpstream", () => {
  it("reads the upstream's product name, anywhere in the id", () => {
    expect(inferRelayUpstream("[特价kiro量]claude-opus-5")).toEqual({ upstream: "kiro", word: "kiro" });
    expect(inferRelayUpstream("特价KIRO | claude-opus-4-6")).toEqual({ upstream: "kiro", word: "kiro" });
    expect(inferRelayUpstream("bedrock/claude-opus-4-6")).toEqual({ upstream: "bedrock", word: "bedrock" });
  });

  it("never guesses a relay owner's abbreviation", () => {
    for (const id of ["[CC量]claude-opus-5", "[anti量]claude-opus-4-6", "[正向AWSb量]claude-opus-4-6", "[官key量]claude-opus-5", "", undefined]) {
      expect(inferRelayUpstream(id), String(id)).toBeUndefined();
    }
  });
});

describe("capabilityModelOf", () => {
  it("uses the resolved upstream, infers only when there is none, and keeps `none`", () => {
    expect(capabilityModelOf({ modelId: "[x]claude", relayUpstream: "cc" })).toEqual({ modelId: "[x]claude", upstream: "cc" });
    expect(capabilityModelOf({ modelId: "[kiro]claude" })).toEqual({ modelId: "[kiro]claude", upstream: "kiro" });
    expect(capabilityModelOf({ modelId: "[kiro]claude", relayUpstream: "none" })).toEqual({ modelId: "[kiro]claude" });
    expect(capabilityModelOf({ modelId: "claude-opus-5" })).toEqual({ modelId: "claude-opus-5" });
  });
});

describe("bracketPrefixes", () => {
  it("lists the unmapped bracketed prefixes, most frequent first", () => {
    const ids = [
      "[anti量]claude-opus-4-6", "[CC量]claude-opus-5", "[官key量]claude-opus-5", "[anti量]claude-sonnet-5",
      "claude-opus-5", "[cc量]claude-sonnet-5", " [anti量]gemini-3-pro", "[CC量]claude-sonnet-5",
    ];
    expect(bracketPrefixes(ids, TABLE)).toEqual(["[anti量]", "[官key量]"]);
    // Case-insensitive, like a row: one suggestion, in the spelling most ids use.
    expect(bracketPrefixes(ids)).toEqual(["[anti量]", "[CC量]", "[官key量]"]);
    expect(bracketPrefixes([])).toEqual([]);
  });
});

describe("parsing what was stored", () => {
  it("keeps valid rows, drops the rest, and reads empty as absent", () => {
    expect(parseUpstreamPrefixes(JSON.stringify(TABLE))).toEqual(TABLE);
    expect(parseUpstreamPrefixes([
      { prefix: " [CC量] ", upstream: "cc" },
      { prefix: "[cc量]", upstream: "anti" },
      { prefix: "", upstream: "cc" },
      { prefix: "[x]", upstream: "nope" },
      { upstream: "cc" },
      "junk",
      null,
    ])).toEqual([{ prefix: "[CC量]", upstream: "cc" }]);
    expect(parseUpstreamPrefixes([])).toBeUndefined();
    expect(parseUpstreamPrefixes("not json")).toBeUndefined();
    expect(parseUpstreamPrefixes(null)).toBeUndefined();
    expect(parseUpstreamPrefixes({ prefix: "[x]", upstream: "cc" })).toBeUndefined();
  });

  it("reads a model's choice, or nothing", () => {
    expect(parseRelayUpstreamChoice("bedrock")).toBe("bedrock");
    expect(parseRelayUpstreamChoice("none")).toBe("none");
    for (const v of ["", "Bedrock", "follow", null, undefined, 3]) expect(parseRelayUpstreamChoice(v)).toBeUndefined();
  });
});
