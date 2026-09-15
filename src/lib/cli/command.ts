/**
 * What can be said about a command line *without running it* — the only
 * judgement this feature makes on its own, and therefore the narrowest.
 *
 * Four questions, feeding either the approval decision or its card
 * (docs/feature/agent/shell-command-plan.md §3.2 / §3.4):
 *   - {@link programNameOf} — the executable key used by the allowlist;
 *   - {@link isCompound} — whether the line uses shell composition. Erring
 *     toward *yes, compound* costs one more card; erring the other way lets
 *     a supposedly simple line cover `git status; rm -rf ~`. So the test is a
 *     character class, not a parser;
 *   - {@link looksDangerous} — a small table that changes the card's face and
 *     withholds the grant row. It never blocks: the author decides, and a
 *     list that pretended to be complete would be trusted as one.
 *   - {@link commandAccess} — the deliberately small, platform-aware allowlist
 *     of commands that are provably read-only enough to run without a card.
 *     Everything unknown is a write, including a read command wrapped in
 *     shell composition. False negatives cost a card; false positives run code.
 */

/**
 * The program a command starts with, lowercased, without directory or
 * Windows extension: `"C:\Program Files\Git\bin\git.exe" log` → `git`,
 * `FOO=1 python x.py` → `python`, `.\build.ps1` → `build`. Empty for an empty
 * line.
 */
export function programNameOf(command: string): string {
  let rest = command.trim();
  // Leading `VAR=value` assignments are environment, not the program.
  rest = rest.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  const m = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest);
  if (!m) return "";
  const token = m[1] ?? m[2] ?? m[3] ?? "";
  return token
    .replace(/^.*[\\/]/, "")
    .replace(/\.(exe|cmd|bat|com|ps1)$/i, "")
    .toLowerCase();
}

/**
 * Anything that lets one line do two things, or reach past its own words:
 * separators, pipes, background, redirections, substitution, a second line,
 * and PowerShell's call operator. Redirections count because `git log >
 * ~/.zshrc` is not a `git` command in any sense a grant should honour.
 */
const COMPOUND = /[;&|<>`\r\n]|\$\(|\$\{/;

export function isCompound(command: string): boolean {
  return COMPOUND.test(command);
}

/** Why a command looks dangerous — an id the card turns into words. */
export type DangerKind =
  | "delete"
  | "history-rewrite"
  | "elevate"
  | "pipe-to-shell"
  | "eval"
  | "disk";

/**
 * Each row: the shape it catches, and the false positive it was tuned to
 * avoid. Order is the order of severity when several hit; the first wins.
 */
const DANGER: { kind: DangerKind; re: RegExp }[] = [
  // Whole-disk operations. `format` alone would hit `git log --format`, so it
  // must be followed by a drive letter.
  { kind: "disk", re: /\b(mkfs(\.\w+)?|diskpart|fdisk|parted)\b|\bformat(\.com)?\s+[a-z]:|\bdd\s+if=|\/dev\/(sd|nvme|disk|hd)/i },
  // Fetch-and-execute: the command's *effect* is whatever the network says.
  { kind: "pipe-to-shell", re: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|invoke-expression)\b/i },
  { kind: "elevate", re: /\bsudo\b|\bdoas\b|\brunas\b|\bstart-process\b[^\n]*-verb\s+runas\b/i },
  // Recursive / forced deletion. `rm notes.txt` and `Remove-Item a.txt` are
  // ordinary; the flags are what make it a sweep.
  { kind: "delete", re: /\brm\s+(?:-[a-z]*[rf][a-z]*\b|--recursive\b|--force\b)/i },
  { kind: "delete", re: /\b(remove-item|ri|rm)\b[^\n]*-recurse\b|\brmdir\s+\/s\b|\brd\s+\/s\b|\bdel\s+(?:\/[a-z]\s+)*\/s\b/i },
  // `(?![\w-])` rather than `\b` after a git subcommand: `\b` sits happily
  // between `rebase` and `-`, so `git rebase-helper` would read as a rebase.
  { kind: "delete", re: /\bgit\s+clean(?![\w-])/i },
  { kind: "history-rewrite", re: /\bgit\s+(?:push(?![\w-])[^\n]*(?:--force\b|-f\b)|reset\s+--hard\b|rebase(?![\w-])|filter-branch\b)/i },
  // Text becoming code: what runs is not what the card shows.
  { kind: "eval", re: /\b(iex|invoke-expression|eval)\b/i },
];

export function looksDangerous(command: string): DangerKind | null {
  for (const { kind, re } of DANGER) {
    if (re.test(command)) return kind;
  }
  return null;
}

type CommandSyntax = "posix" | "powershell";
type CommandAccess = "read" | "write";

/**
 * Programs whose normal operation only observes state. The list is purposely
 * boring: a tool is absent when it has an execution hook (`awk`, `xargs`), an
 * output-file mode (`sort -o`), or too many mutating subcommands (`npm`).
 * Windows installations commonly have Git's POSIX tools too, so PowerShell
 * accepts this shared core in addition to its cmdlets.
 */
const READ_PROGRAMS = new Set([
  "basename", "cat", "cksum", "df", "dirname", "du", "fc-list", "grep",
  "head", "id", "ls", "md5", "md5sum", "more", "pwd", "readlink",
  "realpath", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum",
  "shasum", "strings", "tail", "tree", "uname", "wc", "whereis", "which",
]);

const POSIX_READ_PROGRAMS = new Set([
  ...READ_PROGRAMS,
  "file", "locate", "lsof", "mdfind", "mdls", "ps", "stat", "sw_vers",
]);

const POWERSHELL_READ_PROGRAMS = new Set([
  ...READ_PROGRAMS,
  // Native PowerShell names.
  "get-acl", "get-childitem", "get-content", "get-filehash", "get-item",
  "get-location", "get-process", "get-psdrive", "resolve-path",
  "select-string", "test-path",
  // Built-in aliases. The Rust runner starts PowerShell with -NoProfile, so
  // these resolve to the stock read cmdlets rather than profile functions.
  "cat", "dir", "gc", "gci", "gi", "gl", "ls", "pwd", "sls", "type",
  // Windows read utilities; programNameOf removes the extension.
  "findstr", "systeminfo", "tasklist", "where",
]);

/** Git subcommands with an observational contract. Mutating multi-mode names
 * (`branch`, `tag`, `remote`, `config`, `stash`) stay out even though some
 * invocations only list: an omitted flag must never turn a read into a write. */
const READ_GIT_SUBCOMMANDS = new Set([
  "blame", "count-objects", "describe", "diff", "diff-tree", "for-each-ref",
  "grep", "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev",
  "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status",
  "verify-commit", "verify-pack", "verify-tag", "whatchanged",
]);

/**
 * Split enough shell words to locate a Git subcommand and inspect risky flags.
 * It is not used to execute or rebuild the line. A malformed or clever line
 * returns null and therefore gets a card.
 */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const ch of command.trim()) {
    if (escaped) {
      word += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') escaped = true;
      else word += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\") {
      escaped = true;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote || escaped) return null;
  if (started) words.push(word);
  return words;
}

function gitIsReadOnly(words: string[]): boolean {
  // Skip the handful of global options that may precede the subcommand. An
  // unknown global option is conservative: Git adds new ones over time.
  let i = 1;
  while (i < words.length) {
    const raw = words[i];
    const word = raw.toLowerCase();
    if (word === "--no-pager" || word === "--paginate" || word === "-p"
      || word === "--literal-pathspecs" || word === "--glob-pathspecs"
      || word === "--noglob-pathspecs" || word === "--icase-pathspecs") {
      i += 1;
      continue;
    }
    // Uppercase -C changes directory. Lowercase -c and --config-env inject
    // configuration; diff.external is enough to turn a read into execution.
    if (raw === "-C" || word === "--git-dir" || word === "--work-tree"
      || word === "--namespace" || word === "--super-prefix") {
      i += 2;
      continue;
    }
    if (raw.startsWith("-C") && raw.length > 2) {
      i += 1;
      continue;
    }
    if (word === "-c" || word === "--config-env"
      || /^(?:-c.+|--config-env=)/.test(word)) return false;
    if (/^(?:--git-dir=|--work-tree=|--namespace=|--super-prefix=)/.test(word)) {
      i += 1;
      continue;
    }
    break;
  }
  const subcommand = words[i]?.toLowerCase();
  if (!subcommand || !READ_GIT_SUBCOMMANDS.has(subcommand)) return false;
  const args = words.slice(i + 1).map((word) => word.toLowerCase());
  return !args.some((arg) =>
    arg === "--ext-diff" || arg === "--textconv"
    || arg === "--output" || arg.startsWith("--output=")
    || arg === "--open-files-in-pager" || arg.startsWith("--open-files-in-pager="));
}

/** Options on otherwise read-oriented tools that execute code or write files. */
function hasMutatingReadFlag(program: string, words: string[]): boolean {
  const args = words.slice(1).map((word) => word.toLowerCase());
  if (program === "find") {
    return args.some((arg) => [
      "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint",
      "-fprint0", "-fprintf",
    ].includes(arg));
  }
  if (program === "rg" || program === "ripgrep") {
    return args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
  }
  if (program === "file") {
    const originalArgs = words.slice(1);
    return originalArgs.some((arg) => /^-[^-]*C/.test(arg) || arg.toLowerCase() === "--compile");
  }
  return false;
}

/**
 * Classify one command for approval. Only a single, non-dangerous invocation
 * of a known read program can be `read`; pipelines, redirections, command
 * substitutions, environment-prefix overrides and unknown flags all become
 * `write`. This is intentionally not a claim that arbitrary shell can be
 * perfectly parsed—it is a narrow fast path with a closed allowlist.
 */
export function commandAccess(command: string, syntax: CommandSyntax): CommandAccess {
  if (!command.trim() || isCompound(command) || looksDangerous(command)) return "write";
  // PowerShell evaluates parenthesised/array/script-block expressions inside
  // arguments: `Get-Item (Remove-Item x)` starts with a read cmdlet but writes.
  // Reject the syntax wholesale; a filename containing parentheses merely
  // gets an extra card.
  if (syntax === "powershell" && /[(){}]/.test(command)) return "write";
  const words = shellWords(command);
  if (!words?.length) return "write";

  // Environment prefixes can change a read tool's behaviour through config
  // variables (for example RIPGREP_CONFIG_PATH containing `--pre`).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return "write";

  const program = programNameOf(words[0]);
  if (program === "git") return gitIsReadOnly(words) ? "read" : "write";
  if (program === "rg" || program === "ripgrep") {
    return hasMutatingReadFlag(program, words) ? "write" : "read";
  }
  if (program === "find") {
    return hasMutatingReadFlag(program, words) ? "write" : "read";
  }
  if (program === "file") {
    return syntax === "posix" && !hasMutatingReadFlag(program, words) ? "read" : "write";
  }
  const allow = syntax === "powershell" ? POWERSHELL_READ_PROGRAMS : POSIX_READ_PROGRAMS;
  return allow.has(program) ? "read" : "write";
}
