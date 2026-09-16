/**
 * Write the repo-root `AGENTS.md` mirror of `CLAUDE.md`.
 *
 *   node scripts/gen-agents-md.ts
 *
 * Run it after editing `CLAUDE.md`; `agentsMdSync.test.ts` fails until the
 * mirror and the source agree again. The transform lives in `agents-md.ts`
 * (pure, no I/O) so the test calls the same function this script does.
 * `CLAUDE.md` stays the only file anyone edits — this one is a build step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_MARKER, renderAgentsMd } from "./agents-md.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
const out = renderAgentsMd(claude);
writeFileSync(join(root, "AGENTS.md"), out);

const kb = (n: number): string => (n / 1024).toFixed(1) + "KB";
const body = out.slice(out.indexOf(BODY_MARKER));
console.log(
  `AGENTS.md ${kb(out.length)} = 换上的头 ${kb(out.length - body.length)} + CLAUDE.md 正文 ${kb(body.length)}` +
    `（被换掉的原头 ${kb(claude.length - body.length)}）`,
);
