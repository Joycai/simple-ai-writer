/**
 * 模型抽屉里计费组下拉的初值。
 *
 * 渠道默认组只预填新模型。它错了不报错：编辑一个未绑定的模型时填上渠道默认，
 * 价格段又是收起的，改个名字一保存，这个模型就被绑上、开始计费。
 */
import { describe, expect, it } from "vitest";

import { initialFeeGroupId } from "../ModelDrawer";

describe("initialFeeGroupId", () => {
  it("新建的模型预填渠道默认组", () => {
    expect(initialFeeGroupId(undefined, "g-default")).toBe("g-default");
  });

  it("新建、渠道也没有默认组 → 未绑定", () => {
    expect(initialFeeGroupId(undefined, undefined)).toBe("");
  });

  it("已有的模型读它自己的绑定，不看渠道默认", () => {
    expect(initialFeeGroupId({ feeGroupId: "g-own" }, "g-default")).toBe("g-own");
  });

  it("已有的未绑定模型（故意不绑，或组被删后引用置空）保持未绑定", () => {
    expect(initialFeeGroupId({ feeGroupId: undefined }, "g-default")).toBe("");
    expect(initialFeeGroupId({}, "g-default")).toBe("");
  });
});
