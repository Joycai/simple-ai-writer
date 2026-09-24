/**
 * convertJobs — the top bar's 「转换文档」 state, kept by path outside the button
 * so an author who walks away mid-conversion still hears how it ended, and
 * can't start a second conversion of the same file on the way back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginConvert, clearConvertFailure, endConvert, getConvertJobs, resetConvertJobs,
} from "../convertJobs";

describe("convertJobs", () => {
  beforeEach(() => resetConvertJobs());

  it("refuses a second conversion of a file that is already converting", () => {
    expect(beginConvert("/p/a.docx")).toBe(true);
    expect(beginConvert("/p/a.docx")).toBe(false);
    expect(getConvertJobs().busy).toEqual(["/p/a.docx"]);
  });

  it("lets a different file convert alongside", () => {
    expect(beginConvert("/p/a.docx")).toBe(true);
    expect(beginConvert("/p/b.pdf")).toBe(true);
    endConvert("/p/a.docx");
    expect(getConvertJobs().busy).toEqual(["/p/b.pdf"]);
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
    expect(getConvertJobs().failed?.path).toBe("/p/a.docx");
    beginConvert("/p/a.docx");
    expect(getConvertJobs().failed).toBeNull();
  });

  it("an old timer can't clear a newer failure", () => {
    beginConvert("/p/a.docx");
    endConvert("/p/a.docx", "first");
    const older = getConvertJobs().failed!.seq;
    beginConvert("/p/b.pdf");
    endConvert("/p/b.pdf", "second");
    clearConvertFailure(older);
    expect(getConvertJobs().failed?.message).toBe("second");
    clearConvertFailure(getConvertJobs().failed!.seq);
    expect(getConvertJobs().failed).toBeNull();
  });
});
