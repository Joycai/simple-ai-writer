/**
 * `scanEntity` answers "is this file here?" from the one directory listing it
 * already has, never from a per-file probe.
 *
 * It used to ask the disk once per candidate — four avatar extensions,
 * images.md, every gallery picture — and each probe is an IPC round trip that
 * canonicalizes the path on the Rust side (twice when the file is absent).
 * Over a few hundred entries those probes were most of a scan's wall-clock,
 * and a scan follows every agent write. The guard here is `fileExists`
 * throwing: if anything in the plain-filename path reaches it, this fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dirs = new Map<string, { name: string; isDirectory: boolean }[]>();
const files = new Map<string, string>();
const readFile = vi.fn(async (path: string) => {
  const content = files.get(path);
  if (content == null) throw new Error(`no such file: ${path}`);
  return content;
});
const fileExists = vi.fn(async (path: string): Promise<boolean> => {
  throw new Error(`probed the disk for ${path}`);
});

vi.mock("../fs/fileio", () => ({
  readDir: async (path: string) => {
    const entries = dirs.get(path);
    if (!entries) throw new Error(`no such directory: ${path}`);
    return entries;
  },
  readFile: (path: string) => readFile(path),
  fileExists: (path: string) => fileExists(path),
  writeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
  makeDir: vi.fn(),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
}));

import { scanEntity } from "../lore";

const DIR = "/proj/.ai-writer/lore/characters/ava";

function layout(names: string[], contents: Record<string, string> = {}): void {
  dirs.set(DIR, names.map((name) => ({ name, isDirectory: false })));
  for (const [name, body] of Object.entries(contents)) files.set(`${DIR}/${name}`, body);
}

describe("scanEntity reads existence off the directory listing", () => {
  beforeEach(() => {
    dirs.clear();
    files.clear();
    readFile.mockClear();
    fileExists.mockClear();
  });

  it("finds the avatar without probing, spelled as the disk spells it", async () => {
    layout(["index.md", "Avatar.PNG"], { "index.md": "---\nname: Ava\n---\nbody" });
    const entity = await scanEntity("characters", "ava", DIR);
    expect(entity.avatarPath).toBe(`${DIR}/Avatar.PNG`);
    expect(fileExists).not.toHaveBeenCalled();
  });

  it("reports no avatar without probing either", async () => {
    layout(["index.md"], { "index.md": "---\nname: Ava\n---\nbody" });
    const entity = await scanEntity("characters", "ava", DIR);
    expect(entity.avatarPath).toBeNull();
    expect(fileExists).not.toHaveBeenCalled();
  });

  it("does not read images.md when the listing has none", async () => {
    layout(["index.md"], { "index.md": "---\nname: Ava\n---\nbody" });
    const entity = await scanEntity("characters", "ava", DIR);
    expect(entity.images).toEqual([]);
    expect(readFile.mock.calls.map(([p]) => p)).not.toContain(`${DIR}/images.md`);
  });

  it("keeps the gallery pictures the listing has and drops the ones it lacks", async () => {
    layout(["index.md", "images.md", "portrait.png"], {
      "index.md": "---\nname: Ava\n---\nbody",
      "images.md": "## portrait.png\n\nher portrait\n\n## missing.png\n\ngone\n",
    });
    const entity = await scanEntity("characters", "ava", DIR);
    expect(entity.images.map((i) => i.file)).toEqual(["portrait.png"]);
    expect(fileExists).not.toHaveBeenCalled();
  });

  it("still asks the disk for a heading that names a sub-path", async () => {
    // The one shape a flat listing cannot answer; the gallery never writes it,
    // but a hand-edited images.md might.
    fileExists.mockImplementation(async (path) => path === `${DIR}/sub/deep.png`);
    layout(["index.md", "images.md"], {
      "index.md": "---\nname: Ava\n---\nbody",
      "images.md": "## sub/deep.png\n\nnested\n",
    });
    const entity = await scanEntity("characters", "ava", DIR);
    expect(entity.images.map((i) => i.file)).toEqual(["sub/deep.png"]);
    expect(fileExists).toHaveBeenCalledTimes(1);
  });

  it("lists an unreadable folder as an entity with defaults", async () => {
    files.set(`${DIR}/index.md`, "---\nname: Ava\n---\nbody"); // readable file, no listing
    const entity = await scanEntity("characters", "ava", DIR);
    expect(entity.name).toBe("Ava");
    expect(entity.mdFiles).toEqual([]);
    expect(entity.avatarPath).toBeNull();
    expect(entity.images).toEqual([]);
  });
});
