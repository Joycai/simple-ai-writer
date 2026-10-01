/**
 * Project rules live only in AGENTS.md. CLAUDE.md imports that guide so a
 * Claude Code session cannot silently receive a stale copied rule set.
 * See docs/reference/agent-instructions.md for the maintenance contract.
 */
import { describe, expect, it } from "vitest";

declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  existsSync(p: string): boolean;
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const read = (rel: string): string => fs.readFileSync(process.cwd() + "/" + rel, "utf8");

describe("shared project instructions", () => {
  it("keeps CLAUDE.md as an active import without duplicated instructions", () => {
    // An import in a code span or fenced block would not load in Claude Code.
    expect(read("CLAUDE.md").split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
      .toEqual(["# CLAUDE.md", "@AGENTS.md"]);
  });

  it("keeps AGENTS.md directly maintained without the old generator", () => {
    const agents = read("AGENTS.md");
    expect(agents.startsWith("# AGENTS.md\n")).toBe(true);
    expect(agents).toContain("edit this file directly");
    expect(agents).not.toContain("GENERATED from");
    expect(agents).not.toContain("gen-agents-md");
    expect(fs.existsSync(process.cwd() + "/scripts/gen-agents-md.ts")).toBe(false);
    expect(fs.existsSync(process.cwd() + "/scripts/agents-md.ts")).toBe(false);
  });
});
