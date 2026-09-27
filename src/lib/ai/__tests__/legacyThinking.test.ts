/**
 * The one-time migration of the legacy `thinkingDialect` (LLD §9.10). What is
 * held: a migrated row keeps a declared category that fits, else takes the
 * dialect's category for that family when it fits, else 自动 — on the row (by
 * its pinned route's family) and on every parked route (by its own); a row
 * without a dialect is left alone; the database migration and the backup
 * parser both apply it.
 */
import { describe, expect, it, vi } from "vitest";
import type { SqlStatement } from "../../sqlTx";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("../../project", () => ({
  getGlobalDb: async () => ({ execute: async () => {}, select: async () => [] }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../../keyStore", () => ({ saveApiKey: async () => {}, loadApiKey: async () => null }));

const { migrateThinkingDialects, providerUpsert } = await import("../configDb");
const { parseConfigBundle, CONFIG_BACKUP_KIND } = await import("../configTransfer");
const { migrateLegacyThinking } = await import("../legacyThinking");
const { fitsFamily, THINKING_CATEGORIES } = await import("../reasoning");
type Provider = import("../configDb").Provider;

const legacy = (thinkingDialect: string, thinkingCategory?: string, routes?: unknown) =>
  ({ thinkingCategory, thinkingDialect, routes });

describe("migrateLegacyThinking", () => {
  it("gives each dialect its category on the family it was resolved on", () => {
    expect(migrateLegacyThinking(legacy("adaptive"), "anthropic")?.thinkingCategory).toBe("claude-adaptive");
    expect(migrateLegacyThinking(legacy("extended"), "anthropic")?.thinkingCategory).toBe("claude-budget");
    expect(migrateLegacyThinking(legacy("switch"), "anthropic")?.thinkingCategory).toBe("minimax");
    // switch on the OpenAI family → qwen-budget (budget left unset: enable_thinking only).
    expect(migrateLegacyThinking(legacy("switch"), "openai")?.thinkingCategory).toBe("qwen-budget");
    for (const f of ["openai", "responses", "gemini", "anthropic"] as const) {
      expect(migrateLegacyThinking(legacy("none"), f)?.thinkingCategory).toBe("off");
    }
  });

  it("leaves 自动 where the dialect has no category on that family — what the request already sent", () => {
    const out = migrateLegacyThinking(legacy("adaptive"), "openai");
    expect(out).toBeDefined();
    expect(out?.thinkingCategory).toBeUndefined();
    expect(migrateLegacyThinking(legacy("extended"), "gemini")?.thinkingCategory).toBeUndefined();
  });

  it("keeps a declared category that fits, whatever the dialect", () => {
    expect(migrateLegacyThinking(legacy("adaptive", "glm"), "openai")?.thinkingCategory).toBe("glm");
  });

  it("migrates each parked route by its own family, and drops the field there", () => {
    const out = migrateLegacyThinking(
      { thinkingCategory: null, thinkingDialect: null, routes: {
        anthropic: { thinkingDialect: "switch", maxOutput: 4096 },
        openai: { thinkingDialect: "adaptive", thinkingCategory: "claude-adaptive", reasoningEffort: "high" },
        gemini: { maxOutput: 1024 },
      } },
      "responses",
    );
    expect(out?.routes).toEqual({
      anthropic: { thinkingCategory: "minimax", maxOutput: 4096 },
      // A Claude category on the Chat route is not what it sent: 自动.
      openai: { reasoningEffort: "high" },
      gemini: { maxOutput: 1024 },
    });
  });

  it("touches nothing that carries no dialect", () => {
    expect(migrateLegacyThinking({ thinkingCategory: "glm", thinkingDialect: null, routes: { openai: { maxOutput: 1 } } }, "openai"))
      .toBeUndefined();
  });

  it("only ever writes a category the family can spell, and never overrides one that fits", () => {
    const families = ["openai", "responses", "gemini", "anthropic"] as const;
    for (const dialect of ["adaptive", "extended", "switch", "none"]) {
      for (const family of families) {
        for (const declared of [undefined, ...Object.keys(THINKING_CATEGORIES)]) {
          const out = migrateLegacyThinking(legacy(dialect, declared), family);
          const at = `${dialect}/${family}/${declared}`;
          expect(out, at).toBeDefined();
          const cat = out!.thinkingCategory;
          if (cat) expect(fitsFamily(THINKING_CATEGORIES[cat], family), at).toBe(true);
          if (declared && fitsFamily(THINKING_CATEGORIES[declared as keyof typeof THINKING_CATEGORIES], family)) {
            expect(cat, at).toBe(declared);
          }
        }
      }
    }
    // The case that motivated the guard: switch named the Chat family's category on every non-Messages route.
    expect(migrateLegacyThinking(legacy("switch"), "responses")?.thinkingCategory).toBeUndefined();
    expect(migrateLegacyThinking(legacy("switch"), "gemini")?.thinkingCategory).toBeUndefined();
  });
});

/** The row an upsert would store: its column list zipped with its values. */
function rowOf({ sql, values }: SqlStatement): Record<string, unknown> {
  const cols = /\(([^)]*)\)\s*VALUES/i.exec(sql)?.[1].split(",").map((c) => c.trim());
  if (!cols || cols.length !== values.length) throw new Error(`column list and values disagree in: ${sql}`);
  return Object.fromEntries(cols.map((c, i) => [c, values[i]]));
}

const channel: Provider = {
  id: "p1", name: "Relay", baseUrl: "https://relay.example/v1", apiStandard: "openai_compat", platform: "newapi",
  host: "https://relay.example",
  endpoints: [{ family: "openai", official: false }, { family: "anthropic", official: false }],
  createdAt: 0,
};

describe("migrateThinkingDialects (config.db)", () => {
  it("rewrites the row's and its routes' dialects, by the row's current route", async () => {
    const executed: { sql: string; args: unknown[] }[] = [];
    const db = {
      select: async (sql: string) => (sql.includes("FROM providers")
        ? [rowOf(providerUpsert(channel))]
        : [
          // On the Anthropic route; its Chat route parked with `switch`.
          { id: "m1", provider_id: "p1", thinking_category: null, thinking_dialect: "switch", active_route: "anthropic",
            routes: JSON.stringify({ openai: { thinkingDialect: "switch", temperature: 0.3 } }) },
          // No active route: the channel's primary, Chat.
          { id: "m2", provider_id: "p1", thinking_category: null, thinking_dialect: "adaptive", active_route: null, routes: null },
          // Pinned to a route the channel no longer has: its fields are that route's.
          // (The channel serves Chat and Messages; on Chat, switch would be qwen-budget.)
          { id: "m3", provider_id: "p1", thinking_category: null, thinking_dialect: "switch", active_route: "gemini", routes: null },
        ]),
      execute: async (sql: string, args: unknown[]) => { executed.push({ sql, args }); },
    } as never;
    expect(await migrateThinkingDialects(db)).toBe(3);
    expect(executed.map((e) => e.args)).toEqual([
      ["minimax", JSON.stringify({ openai: { temperature: 0.3, thinkingCategory: "qwen-budget" } }), "m1"],
      [null, null, "m2"],
      [null, null, "m3"],
    ]);
    expect(executed.every((e) => /thinking_dialect = NULL/.test(e.sql))).toBe(true);
  });
});

describe("a backup from before categories", () => {
  it("is parsed into categories the same way", () => {
    const bundle = {
      kind: CONFIG_BACKUP_KIND, version: 2, exportedAt: 0,
      providers: [channel], prompts: [],
      models: [{
        id: "m1", providerId: "p1", modelId: "minimax-m2.5", name: "M", type: "text", activeRoute: "anthropic",
        thinkingDialect: "switch", routes: { openai: { thinkingDialect: "switch" } },
      }],
    };
    const m = parseConfigBundle(bundle, []).models[0];
    expect(m.thinkingCategory).toBe("minimax");
    expect(m.routes?.openai?.thinkingCategory).toBe("qwen-budget");
    expect(m).not.toHaveProperty("thinkingDialect");
  });
});
