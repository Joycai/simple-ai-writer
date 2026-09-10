/**
 * What can be said about a command line *without running it* — the only
 * judgement this feature makes on its own, and therefore the narrowest.
 *
 * Three questions, each feeding the approval card
 * (docs/feature/agent/shell-command-plan.md §3.2 / §3.4):
 *   - {@link programNameOf} — the key a per-program grant is made on;
 *   - {@link isCompound} — whether a grant may cover this line at all. Erring
 *     toward *yes, compound* costs one more card; erring the other way lets
 *     a grant for `git` cover `git status; rm -rf ~`. So the test is a
 *     character class, not a parser;
 *   - {@link looksDangerous} — a small table that changes the card's face and
 *     withholds the grant row. It never blocks: the author decides, and a
 *     list that pretended to be complete would be trusted as one.
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
