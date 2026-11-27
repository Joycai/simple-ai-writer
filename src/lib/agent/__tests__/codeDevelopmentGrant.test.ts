import { describe, expect, it } from "vitest";
import { grantsCodeDevelopment } from "../codeDevelopmentGrant";
import type { CommandProposal } from "../toolTypes";
const proposal: CommandProposal = {
  kind: "command", id: "c", path: "/project", command: "pnpm test && pnpm build", cwdLabel: ".",
  timeoutMs: 60000, shell: { kind: "zsh", path: "/bin/zsh", version: null, os: "macos", osVersion: null, arch: "arm64" },
  compound: true, danger: null,
};
describe("project binding", () => {
  it("covers development chains within the granting project", () => {
    expect(grantsCodeDevelopment({ projectPath: "/project" }, "/project", proposal)).toBe(true);
    expect(grantsCodeDevelopment({ projectPath: "/project" }, "/project", { ...proposal, path: "/project/packages/app" })).toBe(true);
  });
  it.each(["/other", "/project-other", "/project/.ai-writer", "/project/../other"])("rejects cwd %s", path => {
    expect(grantsCodeDevelopment({ projectPath: "/project" }, "/project", { ...proposal, path })).toBe(false);
  });
  it("requires a live matching project and preserves individual-review fallback", () => {
    expect(grantsCodeDevelopment(null, "/project", proposal)).toBe(false);
    expect(grantsCodeDevelopment({ projectPath: "/project" }, "/other", proposal)).toBe(false);
    expect(grantsCodeDevelopment({ projectPath: "/project" }, null, proposal)).toBe(false);
    expect(grantsCodeDevelopment({ projectPath: "/project" }, "/project", { ...proposal, requiresIndividualApproval: true })).toBe(false);
    expect(grantsCodeDevelopment({ projectPath: "/project" }, "/project", { ...proposal, command: "psql -c 'select 1'" })).toBe(false);
  });
});
