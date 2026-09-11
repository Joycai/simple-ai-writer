/**
 * Config for the live local-model probe only (scripts/local-model-probe.ts).
 *
 * Separate from the repo's vitest.config.ts for the same reason as
 * ab.vitest.config.ts: that one includes `src/**` and is what CI runs, and this
 * probe talks to a live model on the LAN — it must never join that suite.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/local-model-probe.ts"],
    testTimeout: 3 * 60 * 60 * 1000,
  },
});
