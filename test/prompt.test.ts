import { describe, test, expect } from "bun:test";
import { buildPrompt, SYSTEM_PROMPT } from "../src/synthesis/prompt.ts";
import { unsafeBrand, type ModuleSlug } from "../src/util/brand.ts";
import type { ReviewBundle } from "../src/synthesis/bundle.ts";
import type { DocBody } from "../src/sources/firefox-docs.ts";

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

  test("mentions the target module slug in the trailing instruction", () => {
    const slug = unsafeBrand<ModuleSlug>("my-module");
    const prompt = buildPrompt(sampleBundle, slug);
    const instruction = prompt.messages[0]?.content?.[1]?.text ?? "";
    expect(instruction).toContain("my-module");
  });

  test("tells the model not to emit a `name` field", () => {
    const slug = unsafeBrand<ModuleSlug>("my-module");
    const prompt = buildPrompt(sampleBundle, slug);
    const instruction = prompt.messages[0]?.content?.[1]?.text ?? "";
    expect(instruction.toLowerCase()).toContain("no `name`");
  });

  test("system prompt defines the required skill sections", () => {
    expect(SYSTEM_PROMPT).toContain("Module Scope");
    expect(SYSTEM_PROMPT).toContain("Standing Conventions");
    expect(SYSTEM_PROMPT).toContain("Active Campaigns");
    expect(SYSTEM_PROMPT).toContain("Checklist");
  });

  test("system prompt pushes abstraction over verbatim quotes", () => {
    expect(SYSTEM_PROMPT).toMatch(/ABSTRACT|abstract/);
    expect(SYSTEM_PROMPT).toContain("two distinct reviewer comments");
    expect(SYSTEM_PROMPT).toContain("standing conventions");
  });

  test("system prompt explains how to use house style references", () => {
    expect(SYSTEM_PROMPT).toContain("House style references");
    expect(SYSTEM_PROMPT).toContain("Mozilla-wide baseline");
  });

  test("includes a docs block when references are provided", () => {
    const slug = unsafeBrand<ModuleSlug>("url-bar");
    const docs: DocBody[] = [
      {
        guide: {
          id: "css",
          title: "CSS Guidelines",
          url: "https://example.test/css.html",
          triggerExtensions: [".css"],
        },
        text: "Use design tokens.",
      },
    ];
    const prompt = buildPrompt(sampleBundle, slug, docs);
    const blocks = prompt.messages[0]?.content ?? [];
    expect(blocks.length).toBe(3);
    expect(blocks[0]?.text).toContain("House style references");
    expect(blocks[0]?.text).toContain("CSS Guidelines");
    expect(blocks[0]?.text).toContain("Use design tokens.");
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("omits the docs block when no references are provided", () => {
    const slug = unsafeBrand<ModuleSlug>("url-bar");
    const prompt = buildPrompt(sampleBundle, slug);
    const blocks = prompt.messages[0]?.content ?? [];
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toContain("URL Bar");
  });
});
