import { describe, expect, it } from "vitest";
import {
  currentSceneNo, formatSceneAddress, parseSceneAddress, resolveScene,
} from "../scene";

describe("parseSceneAddress", () => {
  it("reads a bare agent id as the current scene", () => {
    expect(parseSceneAddress("rp-a-0001")).toEqual({ agentId: "rp-a-0001", scene: null });
  });

  it("splits <agentId>#<N>", () => {
    expect(parseSceneAddress("rp-a-0001#3")).toEqual({ agentId: "rp-a-0001", scene: 3 });
  });

  it("trims surrounding space", () => {
    expect(parseSceneAddress("  rp-a-0001#12 ")).toEqual({ agentId: "rp-a-0001", scene: 12 });
  });

  // 认不出的后缀退回当前这一场，不抛也不返回一个「坏地址」：读到当前这一场比
  // 让工具报错更接近模型的本意。
  it("falls back to the current scene on a non-numeric suffix", () => {
    expect(parseSceneAddress("rp-a-0001#latest")).toEqual({ agentId: "rp-a-0001", scene: null });
  });

  it("treats #0 as no scene", () => {
    expect(parseSceneAddress("rp-a-0001#0")).toEqual({ agentId: "rp-a-0001", scene: null });
  });

  it("round-trips through formatSceneAddress", () => {
    expect(parseSceneAddress(formatSceneAddress("rp-a-0001", 7)))
      .toEqual({ agentId: "rp-a-0001", scene: 7 });
  });
});

describe("currentSceneNo", () => {
  it("is 1 when nothing is archived", () => {
    expect(currentSceneNo([])).toBe(1);
  });

  // peekNextArchiveNo 的口径：最大值 + 1，**不是文件个数**。作者手删掉中间一场
  // 之后两者会错开，而记忆记录里的场号是按前者写下的。
  it("is max + 1, not count + 1", () => {
    expect(currentSceneNo([1, 3])).toBe(4);
  });

  it("does not care about order", () => {
    expect(currentSceneNo([3, 1, 2])).toBe(4);
  });
});

describe("resolveScene", () => {
  it("maps a missing scene number to the current scene", () => {
    expect(resolveScene([1, 2], null)).toEqual({ kind: "current", scene: 3 });
  });

  it("maps the current scene number to the current scene", () => {
    expect(resolveScene([1, 2], 3)).toEqual({ kind: "current", scene: 3 });
  });

  it("maps an existing archive number to that archive", () => {
    expect(resolveScene([1, 2], 2)).toEqual({ kind: "archived", scene: 2 });
  });

  // 编号有洞时**绝不**滑到相邻的一场：那会给出一个看起来完全正常、内容却属于
  // 另一场的答案。
  it("reports a hole as unknown instead of sliding to a neighbour", () => {
    expect(resolveScene([1, 3], 2)).toEqual({ kind: "unknown", scene: 2 });
    expect(resolveScene([1, 3], 4)).toEqual({ kind: "current", scene: 4 });
  });

  it("reports an out-of-range number as unknown", () => {
    expect(resolveScene([1, 2], 9)).toEqual({ kind: "unknown", scene: 9 });
  });
});
