import { describe, expect, it } from "vitest";
import { commandAccess, isCompound, looksDangerous, programNameOf } from "../command";

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

describe("commandAccess — cross-platform approval boundary", () => {
  it.each([
    "ls -la",
    "cat README.md",
    "grep -R TODO src",
    "rg --files",
    "find src -type f -name '*.ts'",
    "head -20 README.md",
    "tail -50 app.log",
    "wc -w README.md",
    "stat README.md",
    "git status --short",
    "git -C ../other log --oneline -5",
    "git diff -- README.md",
  ])("POSIX read: %j", (command) => {
    expect(commandAccess(command, "posix")).toBe("read");
  });

  it.each([
    "Get-ChildItem -Recurse -Filter *.md",
    "Get-Content README.md",
    "Select-String -Path src\\*.ts -Pattern TODO",
    "Get-Item README.md",
    "Test-Path README.md",
    "Get-FileHash README.md",
    "dir",
    "type README.md",
    "findstr /s TODO *.ts",
    "where.exe git",
    "git status --short",
  ])("PowerShell read: %j", (command) => {
    expect(commandAccess(command, "powershell")).toBe("read");
  });

  it.each([
    ["touch new.txt", "posix"],
    ["mkdir out", "posix"],
    ["cp a b", "posix"],
    ["sed -i s/a/b/ file", "posix"],
    ["python script.py", "posix"],
    ["git add README.md", "posix"],
    ["git commit -m update", "posix"],
    ["git branch new-name", "posix"],
    ["git config user.name Ada", "posix"],
    ["git diff --output=patch.txt", "posix"],
    ["git diff --ext-diff", "posix"],
    ["git -c diff.external=touch diff", "posix"],
    ["rg --pre touch TODO", "posix"],
    ["RIPGREP_CONFIG_PATH=.ripgreprc rg TODO", "posix"],
    ["find . -delete", "posix"],
    ["find . -exec touch x ;", "posix"],
    ["file -C -m custom.magic", "posix"],
    ["cat README.md > copy.md", "posix"],
    ["ls | grep src", "posix"],
    ["Set-Content out.txt hi", "powershell"],
    ["Remove-Item out.txt", "powershell"],
    ["Copy-Item a b", "powershell"],
    ["Get-Content a | Set-Content b", "powershell"],
    ["Get-Item (Remove-Item secret.txt)", "powershell"],
    ["Get-Content @(Set-Content out.txt hi)", "powershell"],
    ["Invoke-Expression 'Get-ChildItem'", "powershell"],
    ["cmd /c dir", "powershell"],
  ] as const)("requires approval: %j", (command, syntax) => {
    expect(commandAccess(command, syntax)).toBe("write");
  });

  it("does not apply one platform's cmdlet allowlist to another", () => {
    expect(commandAccess("Get-Content README.md", "posix")).toBe("write");
    expect(commandAccess("stat README.md", "powershell")).toBe("write");
  });
});
