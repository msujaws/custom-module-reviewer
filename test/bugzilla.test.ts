import { describe, test, expect } from "bun:test";
import {
  searchFixedBugs,
  getAttachments,
  extractPhabricatorDNumbers,
  type Attachment,
} from "../src/sources/bugzilla.ts";
import { unsafeBrand, type BugId, type DNumber } from "../src/util/brand.ts";
import type {
  CacheRequest,
  CachedResponse,
  FetchFn,
} from "../src/util/http-cache.ts";

const makeFetcher = (
  handler: (request: CacheRequest) => CachedResponse,
): { fetchFn: FetchFn; calls: CacheRequest[] } => {
  const calls: CacheRequest[] = [];
  const fetchFn: FetchFn = async (request) => {
    calls.push(request);
    return handler(request);
  };
  return { fetchFn, calls };
};

const jsonResponse = (body: unknown): CachedResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  fetchedAt: 0,
});

describe("searchFixedBugs", () => {
  test("queries Bugzilla with resolution=FIXED and chfieldfrom=-Nd", async () => {
    const { fetchFn, calls } = makeFetcher(() =>
      jsonResponse({ bugs: [{ id: 1, summary: "s", product: "Core", component: "DOM", resolution: "FIXED" }] }),
    );
    const bugs = await searchFixedBugs(
      { fetchFn, apiKey: "KEY" },
      [{ product: "Core", component: "DOM" }],
      14,
    );
    expect(bugs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/rest/bug");
    expect(url.searchParams.get("product")).toBe("Core");
    expect(url.searchParams.get("component")).toBe("DOM");
    expect(url.searchParams.get("resolution")).toBe("FIXED");
    expect(url.searchParams.get("chfield")).toBe("resolution");
    expect(url.searchParams.get("chfieldvalue")).toBe("FIXED");
    expect(url.searchParams.get("chfieldfrom")).toBe("-14d");
    expect(calls[0]!.headers?.["X-BUGZILLA-API-KEY"]).toBe("KEY");
  });

  test("dedupes bugs that appear under multiple components", async () => {
    let call = 0;
    const { fetchFn } = makeFetcher(() => {
      call += 1;
      return jsonResponse({
        bugs: [
          { id: 42, summary: "a", product: "Core", component: call === 1 ? "DOM" : "HTML", resolution: "FIXED" },
        ],
      });
    });
    const bugs = await searchFixedBugs(
      { fetchFn, apiKey: "KEY" },
      [
        { product: "Core", component: "DOM" },
        { product: "Core", component: "HTML" },
      ],
      90,
    );
    expect(bugs).toHaveLength(1);
    expect(bugs[0]?.id).toBe(unsafeBrand<BugId>(42));
  });

  test("returns empty when no components are passed", async () => {
    const { fetchFn, calls } = makeFetcher(() => jsonResponse({ bugs: [] }));
    const bugs = await searchFixedBugs(
      { fetchFn, apiKey: "KEY" },
      [],
      30,
    );
    expect(bugs).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("getAttachments", () => {
  test("keeps only text/x-phabricator-request attachments that are not obsolete", async () => {
    const attachments = [
      { id: 1, bug_id: 99, content_type: "text/x-phabricator-request", file_name: "phabricator-D123-url.txt", is_obsolete: 0, summary: "" },
      { id: 2, bug_id: 99, content_type: "text/x-phabricator-request", file_name: "phabricator-D456-url.txt", is_obsolete: 1, summary: "" },
      { id: 3, bug_id: 99, content_type: "text/plain", file_name: "patch.diff", is_obsolete: 0, summary: "" },
    ];
    const { fetchFn, calls } = makeFetcher(() =>
      jsonResponse({ bugs: { "99": attachments } }),
    );
    const result = await getAttachments(
      { fetchFn, apiKey: "KEY" },
      unsafeBrand<BugId>(99),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.fileName).toBe("phabricator-D123-url.txt");
    expect(calls[0]!.url).toContain("/rest/bug/99/attachment");
  });
});

describe("extractPhabricatorDNumbers", () => {
  test("parses D-numbers from phabricator attachments", () => {
    const attachments: Attachment[] = [
      { id: unsafeBrand(1), bugId: unsafeBrand<BugId>(99), fileName: "phabricator-D123-url.txt", contentType: "text/x-phabricator-request" },
      { id: unsafeBrand(2), bugId: unsafeBrand<BugId>(99), fileName: "phabricator-D456-url.txt", contentType: "text/x-phabricator-request" },
      { id: unsafeBrand(3), bugId: unsafeBrand<BugId>(99), fileName: "unrelated.txt", contentType: "text/x-phabricator-request" },
    ];
    const dNumbers = extractPhabricatorDNumbers(attachments);
    expect(dNumbers).toEqual([
      unsafeBrand<DNumber>(123),
      unsafeBrand<DNumber>(456),
    ]);
  });
});
