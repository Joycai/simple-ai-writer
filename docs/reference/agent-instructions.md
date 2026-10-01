# Project instruction maintenance

> Status: `living`. The root `AGENTS.md` is the authoritative project guide.

## Maintenance contract

Edit [AGENTS.md](../../AGENTS.md) directly for project commands, hard rules,
the architecture map, and required reading. Keep it lean: directory details
belong in [codemap.md](codemap.md), and subsystem decisions belong in the
corresponding reference or feature document. There is no regeneration command.

[CLAUDE.md](../../CLAUDE.md) contains only its title and a plain `@AGENTS.md`
import. Keep that import outside code spans and fenced blocks. Claude Code
expands relative imports against the containing file, as documented in its
[import reference](https://code.claude.com/docs/en/memory#import-additional-files).
The local import preserves compatibility without maintaining a second copy of
the rules or requiring filesystem symlinks on Windows.

`src/lib/__tests__/agentInstructions.test.ts` guards the active import,
the absence of duplicated instructions in the Claude entry point, and the
removal of the old generator. It is a repository-wide guard, registered in
`testPlacement.test.ts`. Rule changes need no mirror update.

## Migration decision — 2026-10-01

Previously, `CLAUDE.md` was authoritative. Two scripts generated a full
`AGENTS.md` mirror by replacing its header, and a synchronization test
compared the generated result. That avoided drift but made agents using the
shared entry point edit a different file and run a generation step.

The author chose to maintain `AGENTS.md` directly. The migration preserves
the existing rule body, changing only the maintenance instruction. The old
renderer, generator, and mirror test are removed; a small import guard replaces
them. Current contributor guidance points to `AGENTS.md`. Dated accounts of
past work can still name `CLAUDE.md` when that was the file used at the time.

This is a documentation and repository-tooling change: application behavior,
local skills, version manifests, and Rust crates are unaffected. Validation is
the instruction/documentation guards followed by the normal frontend
TypeScript, Vitest, and build checks described in [ci.md](ci.md).
