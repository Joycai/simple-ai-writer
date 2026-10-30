import { describe, expect, it } from "vitest";
import { formatTokenBadge, formatTokenLimit, parseTokenLimit, TOKEN_STOPS } from "../tokenLimit";

describe("model token limits", () => {
  it("uses compact display-only badges while keeping editable values exact", () => {
    expect(formatTokenBadge(262144)).toBe("256K");
    expect(formatTokenBadge(1048576)).toBe("1M");
    expect(formatTokenBadge(1572864)).toBe("1.5M");
    expect(formatTokenBadge(200000)).toBe("195.3K");
    expect(formatTokenLimit(200000)).toBe("200000");
  });
  it("accepts binary suffixes, decimals and exact counts", () => {
    for (const [text, count] of [["32K", 32768], [" 1m ", 1048576], ["1.5 K", 1536], ["200000", 200000], ["", 0], ["0", 0]] as const) {
      expect(parseTokenLimit(text, 2000000)).toBe(count);
    }
  });
  it("rejects malformed, fractional-token and out-of-range inputs", () => {
    for (const text of ["-1", "1e6", "32KB", "Infinity", "1.1", "1.1K", "2M", "32Kjunk"]) {
      expect(parseTokenLimit(text, 1048576)).toBeNull();
    }
  });
  it("formats all slider steps without changing their value", () => {
    for (let n = 4096; n <= 1048576; n += 4096) {
      expect(parseTokenLimit(formatTokenLimit(n), 1048576)).toBe(n);
    }
    expect(formatTokenLimit(200000)).toBe("200000");
    expect(formatTokenLimit(1048576)).toBe("1M");
    expect(TOKEN_STOPS.map(formatTokenLimit)).toEqual(["32K", "64K", "128K", "256K", "384K", "512K", "1M"]);
  });
});
