import { describe, test, expect } from "bun:test";
import {
  unsafeBrand,
  type BugId,
  type DNumber,
  type ModuleSlug,
  type RevisionPHID,
} from "../src/util/brand.ts";

describe("brand", () => {
  test("unsafeBrand preserves the runtime value for numeric brands", () => {
    const bugId: BugId = unsafeBrand<BugId>(12_345);
    const dNumber: DNumber = unsafeBrand<DNumber>(678_901);
    expect(bugId).toBe(12_345 as BugId);
    expect(dNumber).toBe(678_901 as DNumber);
  });

  test("unsafeBrand preserves the runtime value for string brands", () => {
    const slug: ModuleSlug = unsafeBrand<ModuleSlug>("dom-core-html");
    const phid: RevisionPHID = unsafeBrand<RevisionPHID>("PHID-DREV-abc123");
    expect(slug).toBe("dom-core-html" as ModuleSlug);
    expect(phid).toBe("PHID-DREV-abc123" as RevisionPHID);
  });
});
