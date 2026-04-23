import { describe, test, expect } from "bun:test";
import { toModuleSlug } from "../src/util/slug.ts";
import { unsafeBrand, type ModuleName, type ModuleSlug } from "../src/util/brand.ts";

const asName = (s: string) => unsafeBrand<ModuleName>(s);
const asSlug = (s: string) => unsafeBrand<ModuleSlug>(s);

describe("toModuleSlug", () => {
  test("kebab-cases a simple multi-word module name", () => {
    expect(toModuleSlug(asName("URL Bar"))).toBe(asSlug("url-bar"));
  });

  test("strips punctuation and collapses separators", () => {
    expect(toModuleSlug(asName("DOM: Core & HTML"))).toBe(asSlug("dom-core-html"));
  });

  test("strips leading and trailing separators", () => {
    expect(toModuleSlug(asName("  -- New Tab Page -- "))).toBe(asSlug("new-tab-page"));
  });

  test("preserves digits", () => {
    expect(toModuleSlug(asName("Core: XPCOM v2"))).toBe(asSlug("core-xpcom-v2"));
  });

  test("handles already-slugged input idempotently", () => {
    expect(toModuleSlug(asName("dom-core-html"))).toBe(asSlug("dom-core-html"));
  });
});
