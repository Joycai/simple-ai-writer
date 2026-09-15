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
 * output-file mode (`sort -o`), too many mutating subcommands (`npm`), or its
 * whole point is to look outside the project (`locate`, `mdfind`) or it can
 * print other processes' environments (`ps e`) — a read that runs without a
 * card still sends its output to the model. Windows installations commonly
 * have Git's POSIX tools too, so PowerShell accepts this shared core in
 * addition to its cmdlets.
 */
const READ_PROGRAMS = new Set([
  "basename", "cat", "cksum", "df", "dirname", "du", "fc-list", "grep",
  "head", "id", "ls", "md5", "md5sum", "more", "pwd", "readlink",
  "realpath", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum",
  "shasum", "strings", "tail", "tree", "uname", "wc", "whereis", "which",
]);

const POSIX_READ_PROGRAMS = new Set([
  ...READ_PROGRAMS,
  "file", "lsof", "mdls", "stat", "sw_vers",
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
  // Windows read utilities, reached as `findstr.exe` or bare. Bare `where` is
  // PowerShell's alias for Where-Object, not where.exe; without a pipeline
  // and without a script block (braces are refused) it has nothing to run.
  "findstr", "systeminfo", "tasklist", "where",
]);

/** Git subcommands with an observational contract. Mutating multi-mode names
 * (`branch`, `tag`, `remote`, `config`, `stash`) stay out even though some
 * invocations only list: an omitted flag must never turn a read into a write.
 * `ls-remote` stays out too: it talks to the network, and `--upload-pack=<cmd>`
 * starts an arbitrary program for a local remote. */
const READ_GIT_SUBCOMMANDS = new Set([
  "blame", "count-objects", "describe", "diff", "diff-tree", "for-each-ref",
  "grep", "log", "ls-files", "ls-tree", "merge-base", "name-rev",
  "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status",
  "verify-commit", "verify-pack", "verify-tag", "whatchanged",
]);

/** Long options on Git's read subcommands that write a file or run a program. */
const GIT_UNSAFE_LONG_OPTIONS = ["--output", "--ext-diff", "--textconv", "--open-files-in-pager"];

/**
 * Split enough shell words to locate a Git subcommand and inspect arguments.
 * It is not used to execute or rebuild the line. A malformed line returns null
 * and therefore gets a card. Backslash escapes only in POSIX: in PowerShell it
 * is a path separator (its escape, the backtick, is already compound).
 */
function shellWords(command: string, syntax: CommandSyntax): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  const escapes = syntax === "posix";
  for (const ch of command.trim()) {
    if (escaped) {
      word += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (escapes && ch === "\\" && quote === '"') escaped = true;
      else word += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (escapes && ch === "\\") {
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

/**
 * Whether the shell would expand a variable anywhere in the line — `$HOME`,
 * `$env:USERPROFILE`. Single quotes are literal in both shells, so a regex
 * anchor like `'TODO$'` stays a read. What a variable names cannot be judged
 * from the text, so it cannot be fenced.
 */
function expandsVariable(command: string, syntax: CommandSyntax): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (syntax === "posix" && ch === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === "$") {
      return true;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return false;
}

/**
 * The first word must name a program looked up on PATH, not a file: `./cat`,
 * `bin/ls` or `./ls.ps1` would otherwise match the allowlist by basename and
 * run whatever the project holds under that name. PowerShell may add `.exe`
 * (`where.exe`), which still resolves through PATH only.
 */
function isBareProgram(word: string, syntax: CommandSyntax): boolean {
  if (!word || /[\\/\s]/.test(word)) return false;
  if (!word.includes(".")) return true;
  return syntax === "powershell" && /^[^.]+\.exe$/i.test(word);
}

/**
 * The values one argument hands its program: the word itself, what follows
 * `--opt=` (PowerShell also `-Path:`), and an attached short-option value
 * (`-f/etc/passwd`). Over-collecting only costs a card.
 */
function argumentValues(word: string, syntax: CommandSyntax): string[] {
  const values = [word];
  if (word.startsWith("-")) {
    const sep = (syntax === "powershell" ? /[=:]/ : /=/).exec(word);
    if (sep) values.push(word.slice(sep.index + 1));
    if (!word.startsWith("--") && word.length > 2) values.push(word.slice(2));
  }
  return values;
}

/**
 * Whether an argument may name something outside the project folder the
 * command runs in: an absolute path, a home-relative one, a `..` climb, a
 * dot-glob that can match `..`, or (PowerShell) a drive or provider such as
 * `C:` / `Env:` / `HKLM:`. A read that needs no card must not become a way to
 * hand `~/.ssh/id_rsa` to the model, so these go back to the card.
 */
function leavesProject(value: string, syntax: CommandSyntax): boolean {
  if (value.startsWith("~")) return true;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return true;
  if (/(?:^|[\\/])\.[^\\/]*[*?[]/.test(value)) return true;
  if (syntax === "posix") return value.startsWith("/");
  // cmd-style switches (`findstr /s`, `/c:text`) are not root paths; what a
  // switch carries after its colon is judged on its own.
  const sw = /^\/[A-Za-z?]{1,2}(?::(.*))?$/.exec(value);
  if (sw) return sw[1] !== undefined && leavesProject(sw[1], syntax);
  return /^[\\/]/.test(value) || /^[A-Za-z][\w-]*:/.test(value);
}

/** Whether a long option is `option` or an abbreviation of it — Git accepts
 * any unambiguous prefix, so `--outp=x` is `--output=x`. */
function abbreviates(arg: string, option: string): boolean {
  const name = arg.split("=")[0];
  return name.length > 2 && option.startsWith(name);
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
    // Uppercase -C changes directory (its value is fenced like any other
    // argument). Lowercase -c and --config-env inject configuration;
    // diff.external is enough to turn a read into execution.
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
  const args = words.slice(i + 1);
  return !args.some((arg) =>
    (arg.startsWith("--") && GIT_UNSAFE_LONG_OPTIONS.some((opt) => abbreviates(arg.toLowerCase(), opt)))
    // `git grep -O<pager>` is the short --open-files-in-pager, alone or in a
    // cluster (`-iOvim`). Case matters: `-o` is --only-matching.
    || (subcommand === "grep" && /^-[^-]*O/.test(arg)));
}

/** Options on otherwise read-oriented tools that execute code or write files. */
function hasMutatingReadFlag(program: string, words: string[]): boolean {
  const args = words.slice(1);
  if (program === "find") {
    return args.some((arg) => [
      "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint",
      "-fprint0", "-fprintf",
    ].includes(arg.toLowerCase()));
  }
  if (program === "rg" || program === "ripgrep") {
    return args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
  }
  if (program === "file") {
    return args.some((arg) => /^-[^-]*C/.test(arg) || arg.toLowerCase() === "--compile");
  }
  if (program === "tree") {
    // `-o file` writes the listing; `-R` writes 00Tree.html into every level.
    return args.some((arg) => /^-[^-]*[oR]/.test(arg));
  }
  return false;
}

/**
 * Classify one command for approval. Only a single, non-dangerous invocation
 * of a known read program, by bare name, with every argument inside the
 * project, can be `read`; pipelines, redirections, substitutions, variables,
 * braces, environment-prefix overrides, path-qualified programs and unknown
 * flags all become `write`. This is intentionally not a claim that arbitrary
 * shell can be perfectly parsed — it is a narrow fast path with a closed
 * allowlist.
 */
export function commandAccess(command: string, syntax: CommandSyntax): CommandAccess {
  if (!command.trim() || isCompound(command) || looksDangerous(command)) return "write";
  // Braces are brace expansion in POSIX (`{,/}etc/passwd` builds a path the
  // fence never sees) and script blocks in PowerShell, which also evaluates
  // parenthesised/array expressions inside arguments: `Get-Item (Remove-Item
  // x)` starts with a read cmdlet but writes. Reject the syntax wholesale; a
  // filename containing them merely gets an extra card.
  if (/[{}]/.test(command) || (syntax === "powershell" && /[()]/.test(command))) return "write";
  if (expandsVariable(command, syntax)) return "write";
  const words = shellWords(command, syntax);
  if (!words?.length) return "write";

  // Environment prefixes can change a read tool's behaviour through config
  // variables (for example RIPGREP_CONFIG_PATH containing `--pre`).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return "write";
  if (!isBareProgram(words[0], syntax)) return "write";
  if (words.slice(1).some((w) => argumentValues(w, syntax).some((v) => leavesProject(v, syntax)))) {
    return "write";
  }

  const program = programNameOf(words[0]);
  if (program === "git") return gitIsReadOnly(words) ? "read" : "write";
  if (program === "rg" || program === "ripgrep" || program === "find" || program === "tree") {
    return hasMutatingReadFlag(program, words) ? "write" : "read";
  }
  if (program === "file") {
    return syntax === "posix" && !hasMutatingReadFlag(program, words) ? "read" : "write";
  }
  const allow = syntax === "powershell" ? POWERSHELL_READ_PROGRAMS : POSIX_READ_PROGRAMS;
  return allow.has(program) ? "read" : "write";
}

