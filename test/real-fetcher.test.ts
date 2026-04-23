import { afterEach, describe, test, expect } from "bun:test";
import { realFetcher, retryingFetcher } from "../src/util/real-fetcher.ts";
import type { CachedResponse, FetchFn } from "../src/util/http-cache.ts";

const ok = (body = "ok"): CachedResponse => ({
  status: 200,
  headers: {},
  body,
  fetchedAt: 0,
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("realFetcher", () => {
  test("issues a GET with provided headers and returns status+body+headers", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;
    const response = await realFetcher({
      method: "GET",
      url: "https://example.com/x",
      headers: { "X-Test": "1" },
    });
    expect(seenUrl).toBe("https://example.com/x");
    expect(seenInit?.method).toBe("GET");
    expect(response.status).toBe(200);
    expect(response.body).toBe("hello");
    expect(response.headers["content-type"]).toBe("text/plain");
  });

  test("form-encodes a POST body object with array values repeated", async () => {
    let capturedBody = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await realFetcher({
      method: "POST",
      url: "https://example.com/api",
      body: { a: "1", b: ["2", "3"] },
    });
    const parsed = new URLSearchParams(capturedBody);
    expect(parsed.get("a")).toBe("1");
    expect(parsed.getAll("b")).toEqual(["2", "3"]);
  });

  test("passes through a pre-encoded string POST body unchanged", async () => {
    let capturedBody = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await realFetcher({
      method: "POST",
      url: "https://example.com/api",
      body: "raw=payload",
    });
    expect(capturedBody).toBe("raw=payload");
  });
});

describe("retryingFetcher", () => {
  test("passes through 2xx responses", async () => {
    const inner: FetchFn = async () => ok("body");
    const wrapped = retryingFetcher(inner);
    const result = await wrapped({ method: "GET", url: "https://x" });
    expect(result.body).toBe("body");
  });

  test("retries on 429 with Retry-After", async () => {
    let call = 0;
    const inner: FetchFn = async () => {
      call += 1;
      if (call === 1) {
        return {
          status: 429,
          headers: { "retry-after": "0" },
          body: "",
          fetchedAt: 0,
        };
      }
      return ok("done");
    };
    const wrapped = retryingFetcher(inner, {
      retries: 2,
      baseDelayMs: 0,
      sleep: async () => {},
    });
    const result = await wrapped({ method: "GET", url: "https://x" });
    expect(result.body).toBe("done");
    expect(call).toBe(2);
  });

  test("throws non-retryable error on 4xx (other than 429)", async () => {
    const inner: FetchFn = async () => ({
      status: 404,
      headers: {},
      body: "not found",
      fetchedAt: 0,
    });
    const wrapped = retryingFetcher(inner, { sleep: async () => {} });
    await expect(
      wrapped({ method: "GET", url: "https://x" }),
    ).rejects.toThrow(/404/);
  });

  test("on 429 without Retry-After, backs off a full 30 minutes", async () => {
    let call = 0;
    const sleeps: number[] = [];
    const inner: FetchFn = async () => {
      call += 1;
      if (call === 1) {
        return {
          status: 429,
          headers: {},
          body: "",
          fetchedAt: 0,
        };
      }
      return ok("ok");
    };
    const wrapped = retryingFetcher(inner, {
      retries: 2,
      baseDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await wrapped({ method: "GET", url: "https://x" });
    expect(sleeps).toEqual([30 * 60 * 1000]);
  });
});
