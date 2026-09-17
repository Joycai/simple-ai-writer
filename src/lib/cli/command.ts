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
 * The words of a line that is one plain invocation — or null when anything
 * about its shape needs the author's eyes: composition, a dangerous shape,
 * braces / PowerShell expressions, a variable, a malformed quote, an
 * environment prefix, a path-qualified program, or an argument that reaches
 * outside the project. Shared by the two ways a line may skip the card (the
 * built-in read list and the author's always-allowed programs), so neither can
 * be looser about shape than the other.
 */
function plainInvocation(command: string, syntax: CommandSyntax): string[] | null {
  if (!command.trim() || isCompound(command) || looksDangerous(command)) return null;
  // Braces are brace expansion in POSIX (`{,/}etc/passwd` builds a path the
  // fence never sees) and script blocks in PowerShell, which also evaluates
  // parenthesised/array expressions inside arguments: `Get-Item (Remove-Item
  // x)` starts with a read cmdlet but writes. Reject the syntax wholesale; a
  // filename containing them merely gets an extra card.
  if (/[{}]/.test(command) || (syntax === "powershell" && /[()]/.test(command))) return null;
  if (expandsVariable(command, syntax)) return null;
  const words = shellWords(command, syntax);
  if (!words?.length) return null;

  // Environment prefixes can change a tool's behaviour through config
  // variables (for example RIPGREP_CONFIG_PATH containing `--pre`).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return null;
  if (!isBareProgram(words[0], syntax)) return null;
  if (words.slice(1).some((w) => argumentValues(w, syntax).some((v) => leavesProject(v, syntax)))) {
    return null;
  }
  return words;
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
  const words = plainInvocation(command, syntax);
  if (!words) return "write";

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

// ---------------------------------------------------------------------------
// 免审批命令 — the programs the author has always-allowed
// (docs/feature/agent/shell-command-plan.md §3.8).

/**
 * Programs that may never be always-allowed, because what they run is their
 * argument: shells, interpreters, wrappers that start another program, and
 * elevation. Allowing `bash` would make `bash -c '<anything>'` card-free,
 * and `python x.py` runs whatever a lore write left in `x.py` — either one
 * turns "this program" into "any program". Not complete (nothing here can be);
 * it catches the names an author is likely to type.
 */
const NEVER_ALLOW = new Set([
  // shells
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "nu", "pwsh",
  "powershell", "powershell_ise", "cmd", "wsl", "busybox",
  // interpreters and package runners
  "python", "python2", "python3", "py", "pythonw", "node", "deno", "bun",
  "ruby", "perl", "php", "lua", "luajit", "tclsh", "wish", "osascript",
  "cscript", "wscript", "mshta", "rscript", "julia", "java", "dotnet",
  "npx", "bunx", "pnpx", "uvx", "pipx", "go",
  // program launchers and wrappers
  "env", "exec", "eval", "xargs", "nohup", "time", "timeout", "nice",
  "ionice", "stdbuf", "command", "builtin", "watch", "script", "parallel",
  "start", "start-process", "invoke-expression", "iex", "invoke-command",
  "icm", "invoke-item", "ii", "call", "open", "xdg-open", "rundll32",
  "regsvr32", "schtasks", "at", "crontab", "launchctl", "systemd-run",
  "ssh", "make", "just",
  // build tools and containers: running project code is what they are for
  "gradle", "mvn", "ant", "sbt", "rake", "tox", "nox", "bazel", "cmake",
  "ninja", "meson", "scons", "docker", "podman", "nix", "nix-shell",
  "pixi", "rye", "pdm", "hatch", "conda", "mamba",
  // elevation
  "sudo", "doas", "su", "runas", "pkexec",
]);

/**
 * Builtins that change what the *next* link of a chain runs against. None
 * runs a program itself, but `cd && cat .ssh/id_rsa` leaves the argument
 * fence behind (a bare `cd` goes home), and `export GIT_EXTERNAL_DIFF=./x
 * && git diff` turns a free read into execution.
 */
const CHANGES_SHELL = new Set([
  "cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location",
  "pop-location", "export", "set", "unset", "declare", "typeset", "local",
  "readonly", "alias", "unalias", "set-alias", "new-alias", "sal", "nal",
  "set-variable", "sv", "new-variable", "nv", "clear-variable", "source",
  "trap", "hash", "shopt", "setopt", "unsetopt", "ulimit", "umask",
  "function", "enable", "disable", "autoload", "emulate", "zmodload",
]);

/**
 * Package managers are allowed only for their *looking* subcommands: most of
 * the rest run code the project (or a registry) supplies — `npm run` / `exec`
 * / `test`, the install lifecycle scripts, `pnpm build` and `yarn build`
 * running a script by bare name, `cargo build` running build.rs. A closed list
 * per manager, so a subcommand nobody thought of gets a card. The empty
 * subcommand (flags only: `npm -v`) is a look too.
 */
const PACKAGE_MANAGER_LOOKS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["", "ls", "list", "ll", "la", "view", "info", "show", "v", "outdated", "search", "s", "find", "help", "doctor", "whoami", "ping", "root", "prefix", "fund", "explain", "why", "docs", "repo", "bugs"]),
  pnpm: new Set(["", "ls", "list", "ll", "la", "why", "outdated", "view", "info", "root", "bin", "licenses", "help"]),
  yarn: new Set(["", "list", "info", "why", "outdated", "licenses", "help", "versions"]),
  cargo: new Set(["", "tree", "metadata", "search", "help", "locate-project", "pkgid", "verify-project", "version"]),
  pip: new Set(["", "list", "show", "freeze", "check", "help", "search", "index", "inspect", "debug"]),
  uv: new Set(["", "tree", "help", "version"]),
  poetry: new Set(["", "show", "check", "search", "about", "help"]),
  gem: new Set(["", "list", "search", "info", "contents", "environment", "help", "which", "specification"]),
  bundle: new Set(["", "list", "info", "outdated", "show", "platform", "help", "check"]),
  composer: new Set(["", "show", "info", "outdated", "why", "depends", "licenses", "search", "help", "validate"]),
};

/**
 * Programs a card never offers to always-allow, though the settings page still
 * takes them: deleting and moving files. The danger table only catches the
 * recursive / forced shapes, so one click on 「始终允许 rm」 would quietly make
 * `rm *.md` card-free — a decision worth making on purpose, in Settings, not
 * in the middle of approving one line.
 */
const NEVER_OFFER = new Set([
  "rm", "rmdir", "unlink", "shred", "trash", "truncate", "del", "erase",
  "rd", "move", "mv", "remove-item", "ri", "rni", "move-item", "mi",
  "clear-content", "clc",
]);

/**
 * The name a refusal or a hook table is keyed on: a trailing version dropped
 * (`node22` → `node`, `pip3` → `pip`), so a numbered spelling of a refused
 * program is the same program.
 */
function baseProgram(name: string): string {
  return name.replace(/(?<=[a-z])[\d._-]+$/, "") || name;
}

/** Why a name cannot join the list — an id the settings pane turns into words. */
export type AllowRefusal = "invalid" | "runs-code" | "changes-shell";

/**
 * The key a typed name is stored under: what `programNameOf` would read off a
 * command line, so `Git.exe`, `/usr/bin/git` and `git` are one entry.
 */
export function normalizeProgramName(raw: string): string {
  const name = raw.trim();
  return /\s/.test(name) ? name.toLowerCase() : programNameOf(name);
}

/** Null when `name` (already normalized) may be always-allowed. */
export function allowRefusal(name: string): AllowRefusal | null {
  if (!/^[a-z0-9][a-z0-9._+-]*$/.test(name)) return "invalid";
  if (NEVER_ALLOW.has(name) || NEVER_ALLOW.has(baseProgram(name))) return "runs-code";
  if (CHANGES_SHELL.has(name)) return "changes-shell";
  return null;
}

const GIT_EXEC_SUBCOMMANDS = new Set([
  // `config` writes an alias (`!cmd`) or hooksPath that a later, also-allowed
  // `git` line would run; the rest start a program by design.
  "config", "bisect", "submodule", "difftool", "mergetool", "filter-branch",
  "filter-repo", "rebase", "hook", "daemon", "instaweb", "web--browse",
  "send-email", "credential", "var",
]);
const GIT_EXEC_OPTIONS = [
  "--config", "--config-env", "--exec-path", "--exec", "--upload-pack",
  "--receive-pack", "--extcmd", "--ext-diff", "--textconv", "--template",
  "--open-files-in-pager", "--output",
];

/**
 * Options and subcommands that make an always-allowed program start *another*
 * program, or rewrite the configuration a later allowed line would obey. The
 * author allowed `git`, not "whatever `git -c alias.x='!…'` runs". Like the
 * danger table this is a short list of known shapes, not a proof — which is why
 * the shape checks in `plainInvocation` run first and the list is closed to
 * shells and interpreters.
 */
function runsAnotherProgram(name: string, words: string[]): boolean {
  const args = words.slice(1);
  const program = baseProgram(name);
  const looks = PACKAGE_MANAGER_LOOKS[program];
  if (looks) {
    // `uv pip list` is pip's look under uv's name.
    const [sub = "", next = ""] = args.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
    if (program === "uv" && sub === "pip") return !PACKAGE_MANAGER_LOOKS.pip.has(next);
    return !looks.has(sub);
  }
  switch (program) {
    case "git": {
      // The subcommand is the first word that is not a global option (or the
      // value of one that takes a value).
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) {
        i += ["-C", "--git-dir", "--work-tree", "--namespace"].includes(args[i]) ? 2 : 1;
      }
      const sub = args[i]?.toLowerCase() ?? "";
      if (GIT_EXEC_SUBCOMMANDS.has(sub)) return true;
      return args.some((a) => a === "-c" || /^-c./.test(a)
        || (a.startsWith("--") && GIT_EXEC_OPTIONS.some((opt) => abbreviates(a.toLowerCase(), opt)))
        // `-u <program>` is --upload-pack on the fetching commands only;
        // elsewhere (`add -u`, `push -u`) it is harmless.
        || (/^-[^-]*u/.test(a) && ["clone", "fetch", "ls-remote", "archive", "pull"].includes(sub))
        // `git grep -O<pager>`, alone or in a cluster.
        || (sub === "grep" && /^-[^-]*O/.test(a)));
    }
    case "gh":
      // `gh alias set --shell` stores a shell line; extensions are programs.
      return args.some((a) => ["alias", "extension", "ext", "codespace", "cs"].includes(a.toLowerCase()));
    case "pandoc":
      // A defaults file (`-d`) can name filters and a PDF engine itself, and
      // `--data-dir` is where a bare `-d name` is looked up.
      return args.some((a) => /^(?:-F|-L|-d)/.test(a)
        || /^--(?:filter|lua-filter|pdf-engine|pdf-engine-opt|defaults|data-dir)(?:=|$)/i.test(a));
    case "find":
    case "rg":
    case "ripgrep":
    case "file":
    case "tree":
      return hasMutatingReadFlag(program, words);
    default:
      return false;
  }
}

/**
 * The always-allowed program this line runs under, or null when the line
 * still needs a card. A covered line is one plain invocation (see
 * `plainInvocation`), of a program on `allowed`, that is not refused by
 * `allowRefusal` (a list edited by hand, or by an older build, is not trusted
 * past that), and that uses none of the program's known execution hooks.
 */
export function allowlistCovers(
  command: string,
  syntax: CommandSyntax,
  allowed: readonly string[],
): string | null {
  const words = plainInvocation(command, syntax);
  if (!words) return null;
  const program = programNameOf(words[0]);
  if (!allowed.includes(program) || allowRefusal(program)) return null;
  return runsAnotherProgram(program, words) ? null : program;
}

/**
 * Split a chain of plain commands at `&&` `||` `;` `|` and line breaks,
 * outside quotes. Null for anything a chain of plain commands does not need:
 * a lone `&` (background), redirection, backticks, `$(…)` / `${…}` (also
 * inside double quotes, where POSIX still expands them), an unterminated
 * quote, or an empty link (`a && && b`). A trailing separator is tolerated.
 * Each piece is then judged on its own; the split only decides where the
 * pieces are, never whether they are safe.
 */
export function splitChain(command: string, syntax: CommandSyntax): string[] | null {
  const pieces: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const escapes = syntax === "posix";
  const push = (): boolean => {
    if (!cur.trim()) return false;
    pieces.push(cur.trim());
    cur = "";
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (ch === "`" || (ch === "$" && (next === "(" || next === "{") && quote !== "'")) return null;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (escapes && ch === "\\" && quote === '"' && next !== undefined) cur += command[++i];
      continue;
    }
    if (escapes && ch === "\\") {
      if (next === undefined || next === "\n" || next === "\r") return null;
      cur += ch + command[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (!push()) return null;
      i++;
    } else if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
      // `\r\n` is one break; a blank line between commands is not a link.
      if (!push() && ch !== "\n" && ch !== "\r") return null;
    } else if (ch === "&" || ch === "<" || ch === ">") {
      return null;
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  if (cur.trim()) pieces.push(cur.trim());
  return pieces.length ? pieces : null;
}

/**
 * Whether a line may run without a card, and under which always-allowed
 * programs. A single line or a chain qualifies when **every** piece is either
 * a built-in read (`commandAccess`) or covered by the author's list
 * (`allowlistCovers`), and the whole line has no dangerous shape — the danger
 * table looks across pieces (`curl … | sh`). Returns the allowed programs the
 * line leans on (empty: reads only), or null for a card.
 */
export function commandCover(
  command: string,
  syntax: CommandSyntax,
  allowed: readonly string[],
): string[] | null {
  if (!command.trim() || looksDangerous(command)) return null;
  const pieces = splitChain(command, syntax);
  if (!pieces) return null;
  const used = new Set<string>();
  for (const piece of pieces) {
    if (commandAccess(piece, syntax) === "read") continue;
    const program = allowlistCovers(piece, syntax, allowed);
    if (!program) return null;
    used.add(program);
  }
  return [...used];
}

/**
 * The programs a card may offer to always-allow: exactly the ones this very
 * line still lacks, and only when allowing them would let it through. A line
 * that would still get a card after the click (a dangerous shape, a
 * redirection, an argument outside the project, a hook option, a shell) is
 * offered nothing — a button whose promise the next identical line breaks is
 * worse than no button.
 */
export function allowlistCandidates(
  command: string,
  syntax: CommandSyntax,
  allowed: readonly string[],
): string[] | null {
  if (!command.trim() || looksDangerous(command)) return null;
  const pieces = splitChain(command, syntax);
  if (!pieces) return null;
  const missing = new Set<string>();
  for (const piece of pieces) {
    if (commandAccess(piece, syntax) === "read" || allowlistCovers(piece, syntax, allowed)) continue;
    const words = plainInvocation(piece, syntax);
    const program = words ? programNameOf(words[0]) : "";
    if (!program || NEVER_OFFER.has(program) || !allowlistCovers(piece, syntax, [program])) return null;
    missing.add(program);
  }
  return missing.size ? [...missing] : null;
}
