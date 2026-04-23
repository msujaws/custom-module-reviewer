import { describe, test, expect } from "bun:test";
import { parseDNumber } from "../src/util/dnumber.ts";
import { unsafeBrand, type DNumber } from "../src/util/brand.ts";

describe("parseDNumber", () => {
  test("extracts D-number from a canonical Bugzilla phabricator attachment filename", () => {
    expect(parseDNumber("phabricator-D123456-url.txt")).toBe(
      unsafeBrand<DNumber>(123_456),
    );
  });

  test("extracts D-number from a minimal 'D<digits>' filename", () => {
    expect(parseDNumber("D42.txt")).toBe(unsafeBrand<DNumber>(42));
  });

  test("returns the first D-number when multiple are present", () => {
    expect(parseDNumber("phabricator-D99-mirror-D100.txt")).toBe(
      unsafeBrand<DNumber>(99),
    );
  });

  test("returns null when no D-number pattern is present", () => {
    expect(parseDNumber("patch.diff")).toBeNull();
    expect(parseDNumber("")).toBeNull();
    expect(parseDNumber("Diff-1234")).toBeNull();
  });

  test("ignores non-integer 'D' prefixes", () => {
    expect(parseDNumber("Debugger.txt")).toBeNull();
  });

  test("rejects zero and negative D-numbers via Zod validation", () => {
    expect(parseDNumber("D0.txt")).toBeNull();
  });
});
