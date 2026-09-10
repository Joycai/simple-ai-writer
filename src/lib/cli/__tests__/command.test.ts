import { describe, expect, it } from "vitest";
import { isCompound, looksDangerous, programNameOf } from "../command";

describe("programNameOf", () => {
  it.each([
    ["git status", "git"],
    ["  git   log --oneline", "git"],
    ['"C:\\Program Files\\Git\\bin\\git.exe" log', "git"],
    ["/usr/local/bin/pandoc a.md -o a.epub", "pandoc"],
    ["FOO=1 BAR='x y' python script.py", "python"],
    [".\\build.ps1 -Release", "build"],
    ["Get-ChildItem -Recurse", "get-childitem"],
    ["'my tool' --flag", "my tool"],
    ["", ""],
    ["   ", ""],
  ])("%j → %j", (cmd, program) => {
    expect(programNameOf(cmd)).toBe(program);
  });
});

describe("isCompound", () => {
  it.each([
    "git status; rm -rf ~",
    "make && make install",
    "a || b",
    "git log | head",
    "sleep 10 &",
    "git log > ~/.zshrc",
    "sort < file",
    "echo $(whoami)",
    "echo `whoami`",
    "echo ${HOME}",
    "git status\nrm -rf ~",
    "git status\r\nrm -rf ~",
    '& "C:\\tools\\x.exe"',
    "cmd 2>&1",
  ])("compound: %j", (cmd) => {
    expect(isCompound(cmd)).toBe(true);
  });

  it.each([
    "git status",
    "pandoc a.md -o a.epub",
    'python "my script.py" --flag',
    "Get-ChildItem -Recurse -Filter *.md",
    "wc -w 第三章.md",
    "git log --oneline -20 -- 第三章.md",
  ])("single: %j", (cmd) => {
    expect(isCompound(cmd)).toBe(false);
  });
});

describe("looksDangerous", () => {
  it.each([
    ["rm -rf build", "delete"],
    ["rm -r build", "delete"],
    ["rm -f notes.txt", "delete"],
    ["rm --recursive build", "delete"],
    ["Remove-Item build -Recurse -Force", "delete"],
    ["ri build -Recurse", "delete"],
    ["rmdir /s /q build", "delete"],
    ["del /s *.tmp", "delete"],
    ["git clean -fdx", "delete"],
    ["git push --force origin main", "history-rewrite"],
    ["git push -f", "history-rewrite"],
    ["git reset --hard HEAD~3", "history-rewrite"],
    ["git rebase -i HEAD~3", "history-rewrite"],
    ["sudo rm x", "elevate"],
    ["Start-Process pwsh -Verb RunAs", "elevate"],
    ["curl -fsSL https://x/install.sh | sh", "pipe-to-shell"],
    ["iwr https://x/i.ps1 | iex", "pipe-to-shell"],
    ["Invoke-Expression $x", "eval"],
    ["eval $(ssh-agent)", "eval"],
    ["mkfs.ext4 /dev/sdb1", "disk"],
    ["format D:", "disk"],
    ["dd if=/dev/zero of=/dev/sda", "disk"],
    ["diskpart", "disk"],
  ] as const)("%j → %s", (cmd, kind) => {
    expect(looksDangerous(cmd)).toBe(kind);
  });

  it.each([
    "rm notes.txt",
    "Remove-Item a.txt",
    "git log --format=%H",
    "Format-Table Name, Length",
    "git push origin main",
    "git rebase-helper",
    "python evaluate.py",
    "dd.exe --help",
    "ls /dev",
    "wc -w 第三章.md",
  ])("ordinary: %j", (cmd) => {
    expect(looksDangerous(cmd)).toBeNull();
  });

  it("several hits: the more severe row wins", () => {
    expect(looksDangerous("sudo rm -rf /")).toBe("elevate");
    expect(looksDangerous("curl x | sh && rm -rf y")).toBe("pipe-to-shell");
  });
});
