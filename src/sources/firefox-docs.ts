import { cachedFetch, type CacheOptions } from "../util/http-cache.ts";
import type { Module } from "./mots.ts";

export interface DocGuide {
  id: string;
  title: string;
  url: string;
  triggerExtensions: ReadonlyArray<string>;
}

export interface DocBody {
  guide: DocGuide;
  text: string;
}

const EXTENSION_FROM_GLOB = /\*\.([\da-z]+)/gi;
const EXTENSION_FROM_PATH = /\.([\da-z]+)$/i;

export const extensionsFromIncludes = (
  includes: ReadonlyArray<string>,
): Set<string> => {
  const out = new Set<string>();
  for (const glob of includes) {
    for (const match of glob.matchAll(EXTENSION_FROM_GLOB)) {
      const extension = match[1];
      if (extension) {
        out.add(`.${extension.toLowerCase()}`);
      }
    }
  }
  return out;
};

export const extensionsFromPaths = (
  paths: ReadonlyArray<string>,
): Set<string> => {
  const out = new Set<string>();
  for (const p of paths) {
    const match = EXTENSION_FROM_PATH.exec(p);
    if (match?.[1]) {
      out.add(`.${match[1].toLowerCase()}`);
    }
  }
  return out;
};

export const FIREFOX_DOC_REGISTRY: DocGuide[] = [
  {
    id: "css",
    title: "CSS Guidelines",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/css_guidelines.html",
    triggerExtensions: [".css", ".scss"],
  },
  {
    id: "svg",
    title: "SVG Guidelines",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/svg_guidelines.html",
    triggerExtensions: [".svg", ".css", ".scss"],
  },
  {
    id: "rtl",
    title: "RTL Guidelines",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/rtl_guidelines.html",
    triggerExtensions: [".css", ".scss", ".html", ".xhtml", ".xul"],
  },
  {
    id: "javascript",
    title: "JavaScript Coding Style",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/coding_style_js.html",
    triggerExtensions: [".js", ".mjs", ".jsx", ".ts", ".tsx"],
  },
  {
    id: "python",
    title: "Python Coding Style",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/coding_style_python.html",
    triggerExtensions: [".py"],
  },
  {
    id: "cpp",
    title: "C++ Coding Style",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/coding_style_cpp.html",
    triggerExtensions: [".cpp", ".cc", ".h", ".hpp", ".cxx"],
  },
  {
    id: "cpp-firefox",
    title: "Using C++ in Firefox Code",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/using_cxx_in_firefox_code.html",
    triggerExtensions: [".cpp", ".cc", ".h", ".hpp", ".cxx"],
  },
  {
    id: "java",
    title: "Java Coding Style",
    url: "https://firefox-source-docs.mozilla.org/code-quality/coding-style/coding_style_java.html",
    triggerExtensions: [".java"],
  },
  {
    id: "fluent",
    title: "Fluent Localization Tutorial",
    url: "https://firefox-source-docs.mozilla.org/l10n/fluent/tutorial.html",
    triggerExtensions: [".ftl", ".properties", ".dtd"],
  },
];

export const resolveRelevantDocs = (
  extensions: ReadonlySet<string>,
): DocGuide[] => {
  return FIREFOX_DOC_REGISTRY.filter((g) =>
    g.triggerExtensions.some((extension) => extensions.has(extension)),
  );
};

export const collectModuleExtensions = (
  module_: Module,
  corpusPaths: ReadonlyArray<string> = [],
): Set<string> => {
  const fromIncludes = extensionsFromIncludes(module_.includes);
  const fromCorpus = extensionsFromPaths(corpusPaths);
  return new Set([...fromIncludes, ...fromCorpus]);
};

const MAIN_CONTENT_PATTERN = /<div role="main"[^>]*>([\S\s]*)$/i;
const SCRIPT_PATTERN = /<script[^>]*>[\S\s]*?<\/script>/gi;
const STYLE_PATTERN = /<style[^>]*>[\S\s]*?<\/style>/gi;
const NAV_PATTERN = /<(nav|footer|header)[^>]*>[\S\s]*?<\/\1>/gi;
const TAG_PATTERN = /<[^>]+>/g;
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/g, " "],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&#x27;/g, "'"],
];

export const extractMainContent = (html: string): string => {
  const main = MAIN_CONTENT_PATTERN.exec(html);
  const body = main?.[1] ?? html;
  let stripped = body
    .replaceAll(SCRIPT_PATTERN, "")
    .replaceAll(STYLE_PATTERN, "")
    .replaceAll(NAV_PATTERN, "")
    .replaceAll(TAG_PATTERN, " ");
  for (const [pattern, replacement] of ENTITIES) {
    stripped = stripped.replaceAll(pattern, replacement);
  }
  return stripped.replaceAll(/[\t ]+/g, " ").replaceAll(/\n{3,}/g, "\n\n").trim();
};

export interface DocsCacheOptions extends Omit<CacheOptions, "fetchFn"> {
  fetchFn: CacheOptions["fetchFn"];
}

export const fetchDocBody = async (
  guide: DocGuide,
  cacheOptions: DocsCacheOptions,
): Promise<DocBody> => {
  const response = await cachedFetch(
    { method: "GET", url: guide.url },
    cacheOptions,
  );
  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch ${guide.url}: HTTP ${response.status}`,
    );
  }
  return { guide, text: extractMainContent(response.body) };
};

export const fetchRelevantDocs = async (
  module_: Module,
  cacheOptions: DocsCacheOptions,
  corpusPaths: ReadonlyArray<string> = [],
): Promise<DocBody[]> => {
  const extensions = collectModuleExtensions(module_, corpusPaths);
  const guides = resolveRelevantDocs(extensions);
  return Promise.all(guides.map((g) => fetchDocBody(g, cacheOptions)));
};
