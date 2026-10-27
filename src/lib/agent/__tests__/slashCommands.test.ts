import { describe, expect, it } from "vitest";
import { commandRequest, insertSlashCommand, mcpCommand, mcpTarget, parseSlash } from "../slashCommands";

describe("chat slash commands", () => {
  it("only recognizes commands at the start and preserves multiline requests", () => {
    expect(parseSlash("use /mcp here")).toBeNull();
    expect(parseSlash("/imageGen a tree\nwith birds")).toEqual({ command: "imageGen", request: "a tree\nwith birds" });
    expect(parseSlash("/mcp ")).toEqual({ command: "mcp", request: "" });
  });
  it("round trips server and tool names without namespace collisions", () => {
    for (const server of ["images", "two words", "a:b", "图片", "a/b", "%"]) {
      expect(mcpTarget(mcpCommand(server, "draw:picture"))).toEqual({ server, tool: "draw:picture" });
    }
    expect(mcpTarget("a:b:c")).toBeNull();
    expect(mcpTarget("%xx:draw")).toBeNull();
    expect(mcpTarget(":draw")).toBeNull();
  });
  it("requests discovery and approved dispatch for the explicitly selected MCP tool", () => {
    const request = commandRequest(mcpCommand("images", "generate"), "draw a tree");
    expect(request).toContain('"server":"images","tool":"generate"');
    expect(request).toContain("discover_mcp_tools");
    expect(request).toContain("call_mcp_tool");
    expect(request).toContain("normal approval flow");
    expect(request).toContain("draw a tree");
  });
  it("uses the built-in image route and asks for missing destinations", () => {
    expect(commandRequest("imageGen", "a tree")).toContain("built-in generate_image");
    expect(commandRequest("imageGen", "a tree")).toContain("missing destination");
  });
});

describe("command prefix replacement", () => {
  it("retains spacing and multiline content while changing the selected tool", () => {
    expect(insertSlashCommand("/mcp  paint a tree\n  with birds\n", "images:draw")).toBe("/images:draw  paint a tree\n  with birds\n");
    expect(insertSlashCommand("/ima", "imageGen")).toBe("/imageGen ");
  });
});
