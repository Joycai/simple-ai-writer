/** Explicit trust to run project code, NOT a read-only classification or sandbox.
 * Keep database clients, shells, system administration and publishing outside
 * this entry point. Code and build hooks themselves have full account access.
 */
import { commandAccess, literalInvocationWords, looksDangerous, splitChain } from "./command";

type Syntax = "posix" | "powershell";

const RUNTIMES = /^(?:node(?:\d+)?|python(?:\d+(?:\.\d+)*)?|py|java|javac|jshell|pytest|ruff|mypy|pyright|tsc|vitest|jest|eslint|prettier|tsx|ts-node)$/;
const BUILDS = new Set(["mvn", "mvnw", "gradle", "gradlew", "ant"]);
const PACKAGES: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["install", "i", "ci", "add", "uninstall", "remove", "update", "run", "run-script", "test", "exec", "ls", "list", "view", "info", "why", "explain"]),
  pnpm: new Set(["install", "i", "add", "remove", "update", "run", "test", "build", "dev", "lint", "check", "typecheck", "exec", "dlx", "ls", "list", "why"]),
  yarn: new Set(["install", "add", "remove", "up", "run", "test", "build", "dev", "lint", "check", "typecheck", "exec", "dlx", "info", "why"]),
  pip: new Set(["install", "uninstall", "download", "wheel", "list", "show", "freeze", "check"]),
  uv: new Set(["run", "sync", "add", "remove", "lock", "venv", "tree"]),
  poetry: new Set(["install", "add", "remove", "update", "lock", "run", "build", "check", "show"]),
};

function developmentInvocation(command: string, syntax: Syntax): boolean {
  const words = literalInvocationWords(command, syntax);
  if (!words) return false;
  const executable = words[0].replace(/\\/g, "/");
  // Explicit project-relative wrappers / virtual environments are useful, but
  // absolute executables, home paths and parent climbs need individual review.
  if (/^(?:\/|~|[A-Za-z]:)/.test(executable) || executable.split("/").includes("..")) return false;
  let name = executable.split("/").pop() ?? "";
  if (syntax === "powershell") name = name.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
  if (RUNTIMES.test(name)) return words.length > 1;
  const args = words.slice(1);
  if (BUILDS.has(name)) {
    // These are explicit remote publication tasks; arbitrary project hooks
    // are still code and cannot be classified by their effects here.
    return args.length > 0 && !args.some(a => /(?:^|:)(?:publish\w*|deploy|release)(?:$|:)/i.test(a));
  }
  if (["npx", "pnpx", "uvx"].includes(name)) return args.length > 0;
  const program = name.replace(/^pip\d+(?:\.\d+)*$/, "pip");
  if (program === "uv" && args[0] === "pip") return PACKAGES.pip.has(args[1] ?? "");
  // Options before the subcommand are ambiguous without each CLI's grammar.
  // Use tool.cwd rather than npm --prefix / pnpm -C / shell cd.
  return PACKAGES[program]?.has(args[0] ?? "") ?? false;
}

export function isCodeDevelopmentCommand(command: string, syntax: Syntax): boolean {
  if (looksDangerous(command)) return false;
  const pieces = splitChain(command, syntax);
  if (!pieces?.length) return false;
  let hasCode = false;
  for (const piece of pieces) {
    if (developmentInvocation(piece, syntax)) { hasCode = true; continue; }
    if (commandAccess(piece, syntax) !== "read") return false;
  }
  // Pure reads must retain the runtime checks in the existing automatic path.
  return hasCode;
}

/** Only thrown before starting a process, so returning to a card is safe. */
export class CodeDevelopmentRevokedError extends Error {}
