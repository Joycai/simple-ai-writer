/**
 * convertJobs — 「转换文档」's state, shared by the top bar and the file tree and
 * kept by path outside any button: an author who walks away mid-conversion
 * still hears how it ended, and no two conversions run in one folder (they
 * would pick the same target name).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginConvert, clearConvertFailure, convertBlocker, endConvert, getConvertJobs, resetConvertJobs,
} from "../convertJobs";

describe("convertJobs", () => {
  beforeEach(() => resetConvertJobs());

  it("refuses a second conversion of a file that is already converting", () => {
    expect(beginConvert("/p/a.docx")).toBe(true);
    expect(beginConvert("/p/a.docx")).toBe(false);
    expect(getConvertJobs().busy).toEqual(["/p/a.docx"]);
  });

  it("one conversion per folder: a sibling waits (they'd race for the same target name)", () => {
    expect(beginConvert("/p/a.docx")).toBe(true);
    expect(beginConvert("/p/a.pdf")).toBe(false);
    expect(convertBlocker(getConvertJobs(), "/p/a.pdf")).toBe("/p/a.docx");
    endConvert("/p/a.docx");
    expect(beginConvert("/p/a.pdf")).toBe(true);
  });

  it("different folders convert alongside", () => {
    expect(beginConvert("/p/a.docx")).toBe(true);
    expect(beginConvert("/p/sub/b.pdf")).toBe(true);
    endConvert("/p/a.docx");
    expect(getConvertJobs().busy).toEqual(["/p/sub/b.pdf"]);
  });

  it("records a failure against the file it was about, and releases it", () => {
    beginConvert("/p/a.docx");
    endConvert("/p/a.docx", "corrupt zip");
    const { busy, failed } = getConvertJobs();
    expect(busy).toEqual([]);
    expect(failed).toMatchObject({ path: "/p/a.docx", message: "corrupt zip" });
  });

  it("a retry of the same file retires its old failure; another file's retry does not", () => {
    beginConvert("/p/a.docx");
    endConvert("/p/a.docx", "corrupt zip");
    beginConvert("/p/b.pdf");
    endConvert("/p/b.pdf");
    expect(getConvertJobs().failed?.path).toBe("/p/a.docx");
    beginConvert("/p/a.docx");
    expect(getConvertJobs().failed).toBeNull();
  });

  it("an old timer can't clear a newer failure", () => {
    beginConvert("/p/a.docx");
    endConvert("/p/a.docx", "first");
    const older = getConvertJobs().failed!.seq;
    beginConvert("/p/sub/b.pdf");
    endConvert("/p/sub/b.pdf", "second");
    clearConvertFailure(older);
    expect(getConvertJobs().failed?.message).toBe("second");
    clearConvertFailure(getConvertJobs().failed!.seq);
    expect(getConvertJobs().failed).toBeNull();
  });
});
