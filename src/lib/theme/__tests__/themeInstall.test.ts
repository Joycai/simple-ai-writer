import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fileBackedIds, LAYER_ORDER, userLayerCss } from "../install";

/**
 * 回归：两套 id 名字空间是分开的，判据也必须分开。
 *
 * `paper` / `night` 只对外观主题保留，`manuscript` / `clean` / `magazine` /
 * `wechat` / `typewriter` 只对排版主题保留，互不相干（`registry.ts` 的
 * `entryFromFile` 就是按分类各查各的）。曾经这里拿每个 id 同时查两张表，于是一份
 * 名叫 `clean.css` 的**外观**主题在启动时根本不会被读：设置开着时它能用（那时
 * 文件夹已经扫过），关掉应用再开就退回内置，而作者看不出为什么。
 */
describe("fileBackedIds", () => {
  it("keeps an appearance theme whose id is a built-in *typography* id", () => {
    expect(fileBackedIds({ light: "clean", dark: "night", markdown: "manuscript" })).toEqual(["clean"]);
    expect(fileBackedIds({ light: "paper", dark: "typewriter", markdown: "manuscript" })).toEqual(["typewriter"]);
  });

  it("keeps a typography theme whose id is a built-in *appearance* id", () => {
    expect(fileBackedIds({ light: "paper", dark: "night", markdown: "paper" })).toEqual(["paper"]);
  });

  it("drops the built-ins of the right kind, and nothing else", () => {
    expect(fileBackedIds({ light: "paper", dark: "night", markdown: "manuscript" })).toEqual([]);
    expect(fileBackedIds({ light: "宣纸", dark: "墨", markdown: "宋楷" })).toEqual(["宣纸", "墨", "宋楷"]);
  });

  it("de-duplicates one file selected for both polarities", () => {
    expect(fileBackedIds({ light: "灰", dark: "灰", markdown: "manuscript" })).toEqual(["灰"]);
  });
});

/**
 * 回归：外观主题那张 `<style>` 必须自带五层顺序。
 *
 * 层的优先级在层名**第一次出现**的地方定死。启动时 `preloadSelectedThemes` 先于
 * `import("./App")` 跑，这张 sheet 比 `tokens.css` 早进文档；它要是只写
 * `@layer tokens.user {…}`，`tokens.user` 就成了第一个声明的层 = 最低优先级，文件
 * 里的每个令牌都输给内置核心——设置页里当场挑是好的，重启就失效。node 里没有级联，
 * 这里能钉住的是「自带、且与 tokens.css 一字不差」。
 */
describe("userLayerCss", () => {
  const tokensCss = readFileSync(resolve(__dirname, "../../../styles/tokens.css"), "utf8");

  it("opens with the exact layer-order statement tokens.css declares", () => {
    const statement = tokensCss.match(/^@layer [^{;]+;/m)?.[0];
    expect(statement).toBe(LAYER_ORDER);
    expect(userLayerCss('[data-theme="x"] {}').startsWith(`${LAYER_ORDER}\n@layer tokens.user {`)).toBe(true);
  });

  it("emits nothing when no appearance theme is installable", () => {
    expect(userLayerCss("")).toBe("");
  });
});
