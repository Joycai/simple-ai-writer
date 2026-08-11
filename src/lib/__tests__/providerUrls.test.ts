import { describe, it, expect } from "vitest";
import {
  anthropicRoot,
  anthropicUrl,
  defaultBaseFor,
  geminiUrl,
  migrateLegacyStandard,
  modelsUrl,
  openaiUrl,
} from "../ai/urls";
import { authModesFor, familyOf, isCompatStandard } from "../ai/types";

describe("anthropic base normalization", () => {
  // Every third-party gateway documents ANTHROPIC_BASE_URL as a bare root, so
  // the root form is the one authors actually paste. The other two show up
  // because this app's own preset carried /v1 and because curl examples show
  // the full endpoint.
  it.each([
    ["https://relay.example.com/anthropic", "https://relay.example.com/anthropic"],
    ["https://relay.example.com/anthropic/", "https://relay.example.com/anthropic"],
    ["https://relay.example.com/anthropic/v1", "https://relay.example.com/anthropic"],
    ["https://relay.example.com/anthropic/v1/messages", "https://relay.example.com/anthropic"],
    ["  https://relay.example.com/v1  ", "https://relay.example.com"],
  ])("reduces %s to its root", (input, root) => {
    expect(anthropicRoot(input)).toBe(root);
  });

  it("appends the version segment exactly once", () => {
    expect(anthropicUrl("https://relay.example.com/anthropic", "/messages"))
      .toBe("https://relay.example.com/anthropic/v1/messages");
    expect(anthropicUrl("https://relay.example.com/anthropic/v1", "/messages"))
      .toBe("https://relay.example.com/anthropic/v1/messages");
  });

  it("substitutes the vendor endpoint for an empty base", () => {
    expect(anthropicUrl("", "/messages")).toBe("https://api.anthropic.com/v1/messages");
  });
});

describe("openai / gemini base normalization", () => {
  // Their bases legitimately end in a version segment already — appending one
  // would break every relay that routes below its own prefix.
  it("appends nothing to an OpenAI base", () => {
    expect(openaiUrl("https://relay.example.com/v1", "/chat/completions"))
      .toBe("https://relay.example.com/v1/chat/completions");
    expect(openaiUrl("https://relay.example.com/v1/", "/chat/completions"))
      .toBe("https://relay.example.com/v1/chat/completions");
    expect(openaiUrl("", "/chat/completions")).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("drops a trailing /models from a Gemini base", () => {
    expect(geminiUrl("https://relay.example.com/v1beta/models", "/models/x:generateContent"))
      .toBe("https://relay.example.com/v1beta/models/x:generateContent");
    expect(geminiUrl("", "/models")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
  });

  it("builds the model list per family", () => {
    expect(modelsUrl("anthropic_compat", "https://relay.example.com", "?limit=1"))
      .toBe("https://relay.example.com/v1/models?limit=1");
    expect(modelsUrl("openai_compat", "https://relay.example.com/v1"))
      .toBe("https://relay.example.com/v1/models");
    expect(modelsUrl("gemini_compat", "https://relay.example.com/v1beta"))
      .toBe("https://relay.example.com/v1beta/models");
  });
});

describe("migrateLegacyStandard", () => {
  // Rows written before the official/compat split name the family only. Left
  // alone they would be treated as official, whose endpoint is locked to the
  // vendor's — silently repointing a working third-party provider.
  it("re-labels a family standard pointing somewhere other than the vendor", () => {
    expect(migrateLegacyStandard("anthropic", "https://relay.example.com/anthropic"))
      .toBe("anthropic_compat");
    expect(migrateLegacyStandard("openai", "https://api.deepseek.com")).toBe("openai_compat");
    expect(migrateLegacyStandard("gemini", "https://relay.example.com/v1beta"))
      .toBe("gemini_compat");
  });

  it("keeps official when the base is empty or is the vendor's own", () => {
    expect(migrateLegacyStandard("anthropic", "")).toBe("anthropic");
    expect(migrateLegacyStandard("anthropic", "https://api.anthropic.com/v1")).toBe("anthropic");
    // The root spelling of the same endpoint must not read as a third party.
    expect(migrateLegacyStandard("anthropic", "https://api.anthropic.com")).toBe("anthropic");
    expect(migrateLegacyStandard("anthropic", "https://API.Anthropic.com/v1/")).toBe("anthropic");
    expect(migrateLegacyStandard("openai", "https://api.openai.com/v1")).toBe("openai");
    expect(migrateLegacyStandard("gemini", defaultBaseFor("gemini"))).toBe("gemini");
  });

  it("never promotes a compat standard back to official", () => {
    expect(migrateLegacyStandard("openai_compat", "https://api.openai.com/v1"))
      .toBe("openai_compat");
    expect(migrateLegacyStandard("anthropic_compat", "")).toBe("anthropic_compat");
  });

  it("is idempotent", () => {
    const once = migrateLegacyStandard("anthropic", "https://relay.example.com");
    expect(migrateLegacyStandard(once, "https://relay.example.com")).toBe(once);
  });
});

describe("familyOf / isCompatStandard", () => {
  it("maps both halves of a family to one protocol", () => {
    expect(familyOf("anthropic")).toBe("anthropic");
    expect(familyOf("anthropic_compat")).toBe("anthropic");
    expect(familyOf("gemini_compat")).toBe("gemini");
    expect(familyOf("openai_compat")).toBe("openai");
  });

  it("falls back to the OpenAI family for a value the union never had", () => {
    // Reached from a DB row or an imported backup; the dispatch has always sent
    // unrecognised standards to the OpenAI adapter.
    expect(familyOf("something-else" as never)).toBe("openai");
  });

  it("identifies the compat half", () => {
    expect(isCompatStandard("gemini_compat")).toBe(true);
    expect(isCompatStandard("gemini")).toBe(false);
  });
});

describe("authModesFor", () => {
  // Only Anthropic has two first-class conventions. OpenAI's second one is
  // Azure's, which needs a different URL shape too; Gemini's is a query-string
  // key, deliberately unimplemented because it leaks into logs.
  it("offers a choice only where the protocol has one", () => {
    expect(authModesFor("anthropic_compat")).toEqual(["default", "bearer", "both"]);
    for (const s of ["anthropic", "openai", "openai_compat", "gemini", "gemini_compat"] as const) {
      expect(authModesFor(s)).toEqual(["default"]);
    }
  });

  // "both" on api.anthropic.com is a 401 — two credentials on one request.
  it("never offers `both` on an official standard", () => {
    expect(authModesFor("anthropic")).not.toContain("both");
  });
});
