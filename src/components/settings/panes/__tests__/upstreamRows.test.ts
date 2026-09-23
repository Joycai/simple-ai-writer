/**
 * 渠道抽屉 · 上游前缀表的行内提示：标出来的行，正是保存时 `parseUpstreamPrefixes`
 * 会丢掉的那些——不多也不少。半填的行不占前缀，不会把下面完整的同前缀行说成「重复」。
 */
import { describe, expect, it } from "vitest";
import { rowErrors, type PrefixRow } from "../UpstreamFields";
import { parseUpstreamPrefixes } from "../../../../lib/ai/relayUpstream";

const kept = (rows: PrefixRow[]) => (parseUpstreamPrefixes(rows) ?? []).map((r) => r.prefix.toLowerCase());

describe("rowErrors", () => {
  it("flags exactly the rows saving drops", () => {
    const rows: PrefixRow[] = [
      { prefix: "[CC量]", upstream: "" },
      { prefix: "[CC量]", upstream: "cc" },
      { prefix: "[cc量]", upstream: "anti" },
      { prefix: "  ", upstream: "bedrock" },
      { prefix: "", upstream: "" },
      { prefix: "[anti量]", upstream: "anti" },
    ];
    expect(rowErrors(rows)).toEqual(["noUpstream", undefined, "dup", "empty", undefined, undefined]);
    // Every row that is complete, unflagged and non-blank is one parseUpstreamPrefixes keeps.
    const unflagged = rows.filter((r, i) => !rowErrors(rows)[i] && r.prefix.trim()).map((r) => r.prefix.trim().toLowerCase());
    expect(unflagged).toEqual(kept(rows));
  });
});
