import { describe, expect, it } from "vitest";
import { networkDiagnostics } from "../networkDiagnostics";

describe("Rust network diagnostics", () => {
  it("retains send/body phase, causes and classifications from IPC strings and Errors", () => {
    const detail = { phase: "send", phaseElapsedMs: 61000, timeout: false, causes: ["connection reset by peer"] };
    const message = `error sending request\n[network-details] ${JSON.stringify(detail)}`;
    expect(networkDiagnostics(message)).toEqual(detail);
    expect(networkDiagnostics(new Error(message))).toEqual(detail);
  });
  it("leaves ordinary, canceled and malformed errors alone", () => {
    for (const message of ["Request canceled", "HTTP 400", "error\n[network-details] invalid", "error\n[network-details] []"]) {
      expect(networkDiagnostics(message)).toBeUndefined();
    }
  });
});
