import { describe, test, expect } from "bun:test";
import { buildPrompt, SYSTEM_PROMPT } from "../src/synthesis/prompt.ts";
import { unsafeBrand, type ModuleSlug } from "../src/util/brand.ts";
import type { ReviewBundle } from "../src/synthesis/bundle.ts";

const sampleBundle: ReviewBundle = {
  moduleHeader: "# Module: URL Bar\nPaths: browser/components/urlbar/**/*",
  body: "Bug 1: test\n  D100: test revision\n  General comments:\n  * lgtm",
  stats: { bugs: 1, revisions: 1, inlineComments: 0, generalComments: 1 },
};

describe("buildPrompt", () => {
  test("places system prompt and bundle under cache_control=ephemeral", () => {
    const slug = unsafeBrand<ModuleSlug>("url-bar");
    const prompt = buildPrompt(sampleBundle, slug);
    expect(prompt.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    const userContent = prompt.messages[0]?.content;
    expect(userContent?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("includes the module header + body in the user content", () => {
    const slug = unsafeBrand<ModuleSlug>("url-bar");
    const prompt = buildPrompt(sampleBundle, slug);
    const text = prompt.messages[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("URL Bar");
    expect(text).toContain("D100");
  });

  test("mentions the target skill slug in the trailing instruction", () => {
    const slug = unsafeBrand<ModuleSlug>("my-module");
    const prompt = buildPrompt(sampleBundle, slug);
    const instruction = prompt.messages[0]?.content?.[1]?.text ?? "";
    expect(instruction).toContain("my-module-review");
  });

  test("system prompt defines the required skill sections", () => {
    expect(SYSTEM_PROMPT).toContain("Module Scope");
    expect(SYSTEM_PROMPT).toContain("Recurring Review Patterns");
    expect(SYSTEM_PROMPT).toContain("Checklist");
  });
});
