import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../../.claude/skills/bump-version/scripts/bump-version.mjs", import.meta.url));
const manifests = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
function fixture(t, newline) {
  const root = mkdtempSync(join(tmpdir(), "release-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src-tauri"));
  const contents = ['{"version":"2.0.28"}\n', '{"version":"2.0.28"}\n', '[package]\nname = "simple-ai-writer"\nversion = "2.0.28"\n', '[[package]]\nname = "simple-ai-writer"\nversion = "2.0.28"\n'];
  manifests.forEach((name, i) => writeFileSync(join(root, name), contents[i].replaceAll("\n", newline)));
  const run = (...args) => spawnSync(process.execPath, [script, ...args, "--repo-root", root], { encoding: "utf8" });
  const snapshot = () => manifests.map(name => readFileSync(join(root, name), "utf8"));
  return { root, run, snapshot };
}

for (const newline of ["\n", "\r\n"]) {
  test(`release dry-run/apply succeeds when merged version already matches (${JSON.stringify(newline)})`, t => {
    const { run, snapshot } = fixture(t, newline);
    const before = snapshot();
    for (const flags of [["--dry-run"], [], []]) {
      const result = run("2.0.28", ...flags);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /all four manifests agree/);
      assert.deepEqual(snapshot(), before);
    }
  });

  test(`release can update all manifests then safely repeat (${JSON.stringify(newline)})`, t => {
    const { run, snapshot } = fixture(t, newline);
    const before = snapshot();
    assert.equal(run("2.0.29", "--dry-run").status, 0);
    assert.deepEqual(snapshot(), before);
    assert.equal(run("2.0.29").status, 0);
    const updated = snapshot();
    for (const content of updated) assert.match(content, /2\.0\.29/);
    assert.equal(run("2.0.29").status, 0);
    assert.deepEqual(snapshot(), updated);
  });
}

test("same package version cannot hide drift or invalid release input", t => {
  const { root, run, snapshot } = fixture(t, "\n");
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), '{"version":"2.0.27"}\n');
  const before = snapshot();
  for (const flags of [["--dry-run"], []]) {
    const result = run("2.0.28", ...flags);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Version drift/);
  }
  assert.equal(run("invalid").status, 2);
  assert.deepEqual(snapshot(), before);
});
