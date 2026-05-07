import { describe, test, expect } from "bun:test";
import {
  collectModuleExtensions,
  extensionsFromIncludes,
  extensionsFromPaths,
  extractMainContent,
  fetchDocBody,
  FIREFOX_DOC_REGISTRY,
  resolveRelevantDocs,
} from "../src/sources/firefox-docs.ts";
import type {
  CachedResponse,
  FetchFn,
} from "../src/util/http-cache.ts";
import type { Module } from "../src/sources/mots.ts";

const makeModule = (includes: string[]): Module => ({
  name: "Test",
  machineName: "test",
  description: "",
  includes,
  excludes: [],
  bugzillaComponents: [],
  owners: [],
  peers: [],
  reviewGroup: null,
});

describe("extensionsFromIncludes", () => {
  test("extracts extensions from explicit-extension globs", () => {
    const result = extensionsFromIncludes([
      "src/**/*.css",
      "src/**/*.mjs",
      "src/**/*.SVG",
    ]);
    expect(result).toEqual(new Set([".css", ".mjs", ".svg"]));
  });

  test("returns empty set for catch-all globs", () => {
    expect(extensionsFromIncludes(["browser/themes/**/*"])).toEqual(new Set());
  });
});

describe("extensionsFromPaths", () => {
  test("extracts extensions from file paths", () => {
    const result = extensionsFromPaths([
      "browser/themes/shared/foo.css",
      "browser/themes/shared/bar.svg",
      "scripts/build.py",
    ]);
    expect(result).toEqual(new Set([".css", ".svg", ".py"]));
  });

  test("ignores paths without extensions", () => {
    expect(extensionsFromPaths(["Makefile", "src/CHANGELOG"])).toEqual(
      new Set(),
    );
  });
});

describe("collectModuleExtensions", () => {
  test("falls back to corpus paths when includes are catch-all", () => {
    const module_ = makeModule(["browser/themes/**/*"]);
    const result = collectModuleExtensions(module_, [
      "browser/themes/shared/tab.css",
      "browser/themes/shared/icons/foo.svg",
    ]);
    expect(result).toEqual(new Set([".css", ".svg"]));
  });

  test("unions includes-derived and corpus-derived extensions", () => {
    const module_ = makeModule(["src/**/*.mjs", "src/**/*"]);
    const result = collectModuleExtensions(module_, ["src/styles/foo.css"]);
    expect(result.has(".mjs")).toBe(true);
    expect(result.has(".css")).toBe(true);
  });
});

describe("resolveRelevantDocs", () => {
  test("returns CSS, SVG, and RTL guides for a CSS extension set", () => {
    const ids = resolveRelevantDocs(new Set([".css"])).map((g) => g.id);
    expect(ids).toContain("css");
    expect(ids).toContain("svg");
    expect(ids).toContain("rtl");
  });

  test("returns JS guide for a JavaScript extension set", () => {
    const ids = resolveRelevantDocs(new Set([".mjs"])).map((g) => g.id);
    expect(ids).toContain("javascript");
    expect(ids).not.toContain("css");
  });

  test("returns Fluent guide for a localization extension set", () => {
    const ids = resolveRelevantDocs(new Set([".ftl"])).map((g) => g.id);
    expect(ids).toContain("fluent");
  });

  test("returns multiple guides when extension set spans languages", () => {
    const ids = resolveRelevantDocs(
      new Set([".css", ".mjs", ".ftl"]),
    ).map((g) => g.id);
    expect(ids).toContain("css");
    expect(ids).toContain("javascript");
    expect(ids).toContain("fluent");
  });

  test("returns no guides when no extensions are recognized", () => {
    expect(resolveRelevantDocs(new Set([".md", ".txt"]))).toHaveLength(0);
  });

  test("registry has unique IDs and well-formed URLs", () => {
    const ids = FIREFOX_DOC_REGISTRY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const guide of FIREFOX_DOC_REGISTRY) {
      expect(guide.url).toMatch(/^https:\/\/firefox-source-docs\.mozilla\.org\//);
    }
  });
});

describe("extractMainContent", () => {
  test("extracts the role=main region and strips tags", () => {
    const html = `<html><head><title>x</title><script>bad</script></head>
<body>
<nav>nav stuff</nav>
<div role="main" class="document">
<h1>Title</h1>
<p>Hello <strong>world</strong>.</p>
</div>
<footer>footer junk</footer>
</body></html>`;
    const text = extractMainContent(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("nav stuff");
    expect(text).not.toContain("footer junk");
    expect(text).not.toContain("bad");
    expect(text).not.toContain("<");
  });

  test("decodes common HTML entities", () => {
    const html = `<div role="main">a &amp; b &lt; c &gt; d &quot;e&quot;</div>`;
    expect(extractMainContent(html)).toBe(`a & b < c > d "e"`);
  });

  test("falls back to whole document when role=main missing", () => {
    const html = `<p>just a paragraph</p>`;
    expect(extractMainContent(html)).toContain("just a paragraph");
  });
});

describe("fetchDocBody", () => {
  test("fetches a guide and extracts content", async () => {
    const guide = FIREFOX_DOC_REGISTRY[0]!;
    const fetchFn: FetchFn = async (): Promise<CachedResponse> => ({
      status: 200,
      headers: {},
      body: '<div role="main"><h1>CSS</h1><p>Use tokens.</p></div>',
      fetchedAt: Date.now(),
    });
    const result = await fetchDocBody(guide, {
      cacheDir: "/tmp/firefox-docs-test-cache-not-used",
      mode: "no-cache",
      fetchFn,
      ttlMs: 0,
    });
    expect(result.guide).toBe(guide);
    expect(result.text).toContain("CSS");
    expect(result.text).toContain("Use tokens.");
  });

  test("throws on non-200 status", async () => {
    const guide = FIREFOX_DOC_REGISTRY[0]!;
    const fetchFn: FetchFn = async (): Promise<CachedResponse> => ({
      status: 404,
      headers: {},
      body: "not found",
      fetchedAt: Date.now(),
    });
    await expect(
      fetchDocBody(guide, {
        cacheDir: "/tmp/x",
        mode: "no-cache",
        fetchFn,
        ttlMs: 0,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
