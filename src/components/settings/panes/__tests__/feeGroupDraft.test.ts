/**
 * 计费组编辑抽屉的表单 → `FeeGroup`。
 *
 * 表单里价格一律是字符串（受控数字输入框清空后会变成 NaN，而「清空」是
 * 作者的一次编辑中途，不该当场变成 0），所以落成数那一步是有判断的一步。
 * 它错了不会报错：缓存价的空串写成 0，就是所有老组一夜之间缓存免费。
 */
import { describe, expect, it } from "vitest";

import { draftToGroup } from "../FeeGroupDrawer";

const draft = (over: Partial<Parameters<typeof draftToGroup>[0]> = {}) => ({
  name: " 千问 ", vendor: "", billingMode: "token" as const,
  inputPrice: "0.8", cacheInputPrice: "", outputPrice: "2.4", requestPrice: "",
  outputUnit: "image" as const, rates: [], inputUnitPrice: "", inputFreeUnits: "",
  ...over,
});

describe("draftToGroup", () => {
  it("缓存价的空串落成 null（＝同输入价），不是 0", () => {
    expect(draftToGroup(draft()).cacheInputPrice).toBeNull();
  });

  it("缓存价的 \"0\" 落成 0（＝真免费）", () => {
    expect(draftToGroup(draft({ cacheInputPrice: "0" })).cacheInputPrice).toBe(0);
  });

  it("名字去空白", () => {
    expect(draftToGroup(draft()).name).toBe("千问");
  });

  it("厂商去空白", () => {
    expect(draftToGroup(draft({ vendor: " 阿里云百炼 " })).vendor).toBe("阿里云百炼");
  });

  it("没填的厂商落成 undefined，不是空串——「没填」只有一种长相", () => {
    expect(draftToGroup(draft()).vendor).toBeUndefined();
    expect(draftToGroup(draft({ vendor: "    " })).vendor).toBeUndefined();
  });

  it("只改名字不该把厂商弄丢——这一行漏掉时 tsc 不会拦", () => {
    // vendor 是可选字段，所以「draftToGroup 的字面量里忘了写它」编译得过，
    // 而后果是：导入一份带厂商的备份，在抽屉里点一次保存就把它抹成 NULL。
    const g = draftToGroup(draft({ name: "新名字", vendor: "Anthropic" }));
    expect(g).toMatchObject({ name: "新名字", vendor: "Anthropic" });
  });

  it("档位里留空的条件不写进去——空条件匹配一切，写成空串会匹配不上任何东西", () => {
    const g = draftToGroup(draft({
      billingMode: "spec",
      rates: [{ size: " 1K ", quality: "", seconds: "", price: "0.04" }],
    }));
    expect(g.outputRates).toEqual([{ price: 0.04, size: "1K" }]);
  });

  it("时长只认正整数", () => {
    const g = draftToGroup(draft({
      billingMode: "spec",
      rates: [{ size: "", quality: "", seconds: "0", price: "1" }, { size: "", quality: "", seconds: "8", price: "2" }],
    }));
    expect(g.outputRates).toEqual([{ price: 1 }, { price: 2, seconds: 8 }]);
  });

  it("读不出来的价落成 0，而不是 NaN 一路传到金额列", () => {
    expect(draftToGroup(draft({ inputPrice: "贵" })).inputPrice).toBe(0);
  });

  it("免费张数取整", () => {
    expect(draftToGroup(draft({ inputFreeUnits: "1.9" })).inputFreeUnits).toBe(1);
  });
});
