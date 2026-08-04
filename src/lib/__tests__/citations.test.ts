/**
 * Lore citations: the `[[lore:…]]` syntax parse, target resolution against a
 * lore index (name → alias → category/id tail), and the markdown renderer's
 * citation rule (escaping included — targets are model output).
 */
import { describe, expect, it } from "vitest";
import { parseCiteBody, resolveCitation } from "../lore/citations";
import { renderMarkdown } from "../fs/markdown";
import type { LoreEntity, LoreIndex } from "../lore";

const entity = (over: Partial<LoreEntity>): LoreEntity =>
  ({
    id: "x",
    category: "capabilities",
    dirPath: "C:/proj/.ai-writer/lore/capabilities/x",
    name: "X",
    aliases: [],
    summary: "",
    mdFiles: [],
    facets: [],
    images: [],
    avatarPath: null,
    ...over,
  }) as LoreEntity;

const INDEX: LoreIndex = {
  capabilities: [
    entity({
      id: "multi-tenant",
      dirPath: "C:/proj/.ai-writer/lore/capabilities/multi-tenant",
      name: "多租户架构",
      aliases: ["多租户", "Multi-Tenant"],
    }),
  ],
  boundaries: [
    entity({
      id: "sla",
      category: "boundaries",
      dirPath: "C:/proj/.ai-writer/lore/boundaries/sla",
      name: "SLA 承诺边界",
    }),
  ],
};

describe("parseCiteBody", () => {
  it("splits target and optional label", () => {
    expect(parseCiteBody("多租户架构")).toEqual({ target: "多租户架构", label: "多租户架构" });
    expect(parseCiteBody("多租户架构|租户隔离")).toEqual({ target: "多租户架构", label: "租户隔离" });
    expect(parseCiteBody(" 多租户架构 | ")).toEqual({ target: "多租户架构", label: "多租户架构" });
    expect(parseCiteBody("")).toBeNull();
    expect(parseCiteBody("|只有标签")).toBeNull();
  });
});

describe("resolveCitation", () => {
  it("resolves by exact name, case-insensitively", () => {
    expect(resolveCitation("多租户架构", INDEX)?.id).toBe("multi-tenant");
    expect(resolveCitation("sla 承诺边界", INDEX)?.id).toBe("sla");
  });

  it("falls back to aliases, then the category/id tail", () => {
    expect(resolveCitation("Multi-Tenant", INDEX)?.id).toBe("multi-tenant");
    expect(resolveCitation("capabilities/multi-tenant", INDEX)?.id).toBe("multi-tenant");
  });

  it("returns null for anything the index doesn't hold", () => {
    expect(resolveCitation("不存在的能力", INDEX)).toBeNull();
    expect(resolveCitation("", INDEX)).toBeNull();
  });
});

describe("renderMarkdown lore_cite rule", () => {
  it("renders a citation span carrying the raw target", () => {
    const html = renderMarkdown("依据 [[lore:多租户架构]]。");
    expect(html).toContain('data-lore-cite="多租户架构"');
    expect(html).toContain('class="lore-cite"');
    expect(html).toContain(">多租户架构</span>");
  });

  it("uses the display label when one is given", () => {
    const html = renderMarkdown("[[lore:多租户架构|租户隔离能力]]");
    expect(html).toContain('data-lore-cite="多租户架构"');
    expect(html).toContain(">租户隔离能力</span>");
  });

  it("escapes targets — they are model output, not trusted markup", () => {
    const html = renderMarkdown('[[lore:a"><script>x</script>]]');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;");
  });

  it("leaves unclosed or empty citations as literal text", () => {
    // Unclosed opener — the ]] on a later line must not swallow the paragraph.
    expect(renderMarkdown("[[lore:甲\n乙]]")).not.toContain("lore-cite");
    // Empty body renders as prose, not as an empty chip.
    expect(renderMarkdown("[[lore:]]")).not.toContain("lore-cite");
  });

  it("renders citations inside emphasis and lists", () => {
    const html = renderMarkdown("- **依据**：[[lore:SLA 承诺边界]]");
    expect(html).toContain('data-lore-cite="SLA 承诺边界"');
  });
});
