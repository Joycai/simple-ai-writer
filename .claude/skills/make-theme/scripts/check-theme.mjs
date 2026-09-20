#!/usr/bin/env node
/**
 * Check a theme file against the app's own validator predicates, and
 * optionally render a preview page.
 *
 *   node .claude/skills/make-theme/scripts/check-theme.mjs <theme.css> [--preview] [--with <other.css>]
 *
 * Run from the repo root (it needs the repo's node_modules). The repo has no
 * tsx / esbuild, so the TypeScript half is loaded through vite's
 * ssrLoadModule — which is also why check.ts must live inside the repo.
 *
 *   --preview   write previews.local/<id>.html (gitignored): a mock of the app
 *               shell plus a full sample document, palette resolved by the
 *               app's own exportPaletteCss so the derived layer is real.
 *   --with      the partner file: an appearance theme to draw a typography
 *               theme over, or a typography theme to set inside an appearance.
 *
 * Exit code 1 when the file has errors (things the app would drop or refuse).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const { createServer } = await import(resolve(root, "node_modules/vite/dist/node/index.js")).catch(() => {
  console.error("check-theme: run from the repo root after `pnpm install` (node_modules/vite not found)");
  process.exit(2);
});
const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
let code = 0;
try {
  const mod = await server.ssrLoadModule(resolve(here, "check.ts"));
  code = await mod.main(process.argv.slice(2), root);
} catch (e) {
  console.error(e);
  code = 2;
}
// server.close() never settles in middleware mode with nothing listening; the
// work is done, so leave.
process.exit(code);
