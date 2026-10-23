import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatError, errorPreview } from "../ChatError";

const gateway = 'Error: Anthropic API error 504 (https://relay/v1/messages): <!DOCTYPE html><html><script>alert(1)</script></html>';

describe("chat error disclosure", () => {
  it("keeps status and endpoint without gateway HTML in the preview", () => {
    expect(errorPreview(gateway)).toBe('Error: Anthropic API error 504 (https://relay/v1/messages):');
    expect(errorPreview("x".repeat(2000))).toHaveLength(180);
  });

  it.each(["<center>Bad gateway</center>", '<?xml version="1.0"?><error/>', "<div class='error'>Down</div>"])("omits markup starting with %s", (body) => {
    expect(errorPreview("HTTP 502: " + body)).toBe("HTTP 502:");
  });

  it("starts collapsed and escapes the full response", () => {
    const html = renderToStaticMarkup(createElement(ChatError, { error: gateway, onRetry: () => {} }));
    expect(html).toContain("<details");
    expect(html).not.toContain(" open");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<button type="button"');
  });
});
