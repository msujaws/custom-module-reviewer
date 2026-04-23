import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cachedFetch,
  type CacheRequest,
  type CacheOptions,
  type CachedResponse,
  type FetchFn,
} from "../src/util/http-cache.ts";

const makeFetcher = (
  response: CachedResponse,
): { fetchFn: FetchFn; calls: CacheRequest[] } => {
  const calls: CacheRequest[] = [];
  const fetchFn: FetchFn = async (request) => {
    calls.push(request);
    return response;
  };
  return { fetchFn, calls };
};

const response = (body: string): CachedResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body,
  fetchedAt: 1_700_000_000_000,
});

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), "http-cache-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

const baseOptions = (
  fetchFn: FetchFn,
  overrides: Partial<CacheOptions> = {},
): CacheOptions => ({
  cacheDir,
  ttlMs: 60_000,
  mode: "normal",
  fetchFn,
  now: () => 1_700_000_100_000,
  ...overrides,
});

const getRequest = (url: string): CacheRequest => ({ method: "GET", url });

describe("cachedFetch", () => {
  test("calls the fetcher on cache miss and writes the response to disk", async () => {
    const { fetchFn, calls } = makeFetcher(response("hello"));
    const result = await cachedFetch(getRequest("https://x/a"), baseOptions(fetchFn));
    expect(calls).toHaveLength(1);
    expect(result.body).toBe("hello");
  });

  test("returns cached response on hit without calling the fetcher", async () => {
    const { fetchFn: f1 } = makeFetcher(response("first"));
    await cachedFetch(getRequest("https://x/a"), baseOptions(f1));
    const { fetchFn: f2, calls } = makeFetcher(response("second"));
    const result = await cachedFetch(getRequest("https://x/a"), baseOptions(f2));
    expect(calls).toHaveLength(0);
    expect(result.body).toBe("first");
  });

  test("treats entries older than TTL as misses", async () => {
    const { fetchFn: f1 } = makeFetcher(response("first"));
    await cachedFetch(
      getRequest("https://x/a"),
      baseOptions(f1, { now: () => 1_000_000 }),
    );
    const { fetchFn: f2, calls } = makeFetcher(response("second"));
    const result = await cachedFetch(
      getRequest("https://x/a"),
      baseOptions(f2, { now: () => 1_000_000 + 60_001 }),
    );
    expect(calls).toHaveLength(1);
    expect(result.body).toBe("second");
  });

  test("keys different URLs separately", async () => {
    const { fetchFn: f1 } = makeFetcher(response("a"));
    await cachedFetch(getRequest("https://x/a"), baseOptions(f1));
    const { fetchFn: f2, calls } = makeFetcher(response("b"));
    const result = await cachedFetch(getRequest("https://x/b"), baseOptions(f2));
    expect(calls).toHaveLength(1);
    expect(result.body).toBe("b");
  });

  test("normalizes query parameter order when hashing", async () => {
    const { fetchFn: f1 } = makeFetcher(response("first"));
    await cachedFetch(
      getRequest("https://x/a?b=2&a=1"),
      baseOptions(f1),
    );
    const { fetchFn: f2, calls } = makeFetcher(response("second"));
    const result = await cachedFetch(
      getRequest("https://x/a?a=1&b=2"),
      baseOptions(f2),
    );
    expect(calls).toHaveLength(0);
    expect(result.body).toBe("first");
  });

  test("mode=no-cache always hits the fetcher and skips writes", async () => {
    const { fetchFn: f1, calls: c1 } = makeFetcher(response("one"));
    await cachedFetch(
      getRequest("https://x/a"),
      baseOptions(f1, { mode: "no-cache" }),
    );
    const { fetchFn: f2, calls: c2 } = makeFetcher(response("two"));
    const result = await cachedFetch(
      getRequest("https://x/a"),
      baseOptions(f2, { mode: "no-cache" }),
    );
    expect(c1).toHaveLength(1);
    expect(c2).toHaveLength(1);
    expect(result.body).toBe("two");

    const { fetchFn: f3, calls: c3 } = makeFetcher(response("three"));
    const afterNormal = await cachedFetch(
      getRequest("https://x/a"),
      baseOptions(f3, { mode: "normal" }),
    );
    expect(c3).toHaveLength(1);
    expect(afterNormal.body).toBe("three");
  });

  test("mode=refresh ignores cached hits but writes the new response", async () => {
    const { fetchFn: f1 } = makeFetcher(response("one"));
    await cachedFetch(getRequest("https://x/a"), baseOptions(f1));
    const { fetchFn: f2, calls: c2 } = makeFetcher(response("two"));
    await cachedFetch(
      getRequest("https://x/a"),
      baseOptions(f2, { mode: "refresh" }),
    );
    expect(c2).toHaveLength(1);

    const { fetchFn: f3, calls: c3 } = makeFetcher(response("three"));
    const final = await cachedFetch(
      getRequest("https://x/a"),
      baseOptions(f3, { mode: "normal" }),
    );
    expect(c3).toHaveLength(0);
    expect(final.body).toBe("two");
  });

  test("includes POST body in the cache key", async () => {
    const post = (body: Record<string, string>): CacheRequest => ({
      method: "POST",
      url: "https://x/api",
      body,
    });
    const { fetchFn: f1 } = makeFetcher(response("a"));
    await cachedFetch(post({ id: "1" }), baseOptions(f1));
    const { fetchFn: f2, calls } = makeFetcher(response("b"));
    const result = await cachedFetch(post({ id: "2" }), baseOptions(f2));
    expect(calls).toHaveLength(1);
    expect(result.body).toBe("b");
  });
});
