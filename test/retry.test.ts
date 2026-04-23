import { describe, test, expect } from "bun:test";
import {
  RetryableError,
  parseRetryAfter,
  withRetry,
} from "../src/util/retry.ts";

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-04-23T00:00:00Z");

  test("parses integer seconds", () => {
    expect(parseRetryAfter("42", now)).toBe(42);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  test("parses HTTP-date and returns seconds until that moment", () => {
    const future = new Date(now + 120_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(120);
  });

  test("returns 0 for a past HTTP-date (never negative)", () => {
    const past = new Date(now - 10_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  test("returns undefined for missing or unparsable headers", () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
  });
});

const recordingSleep = () => {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { delays, sleep };
};

describe("withRetry", () => {
  test("returns the first successful result without sleeping", async () => {
    const { delays, sleep } = recordingSleep();
    const result = await withRetry(async () => "ok", { sleep });
    expect(result).toBe("ok");
    expect(delays).toEqual([]);
  });

  test("retries after RetryableError until success", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new RetryableError("transient");
        }
        return "ok";
      },
      { baseDelayMs: 100, sleep },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });

  test("honors Retry-After seconds from RetryableError", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new RetryableError("429", 7);
        }
        return "ok";
      },
      { baseDelayMs: 100, sleep },
    );
    expect(delays).toEqual([7000]);
  });

  test("rethrows after exhausting retries", async () => {
    const { sleep } = recordingSleep();
    const attempt = async (): Promise<string> => {
      throw new RetryableError("always fails");
    };
    await expect(
      withRetry(attempt, { retries: 2, baseDelayMs: 10, sleep }),
    ).rejects.toThrow("always fails");
  });

  test("does not retry on non-RetryableError", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    const attempt = async (): Promise<string> => {
      attempts += 1;
      throw new Error("fatal");
    };
    await expect(
      withRetry(attempt, { retries: 5, baseDelayMs: 10, sleep }),
    ).rejects.toThrow("fatal");
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("uses real sleep when none is injected (smoke test)", async () => {
    const start = Date.now();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new RetryableError("once");
        }
        return "ok";
      },
      { baseDelayMs: 5, retries: 2 },
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });

  test("caps backoff at maxDelayMs", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 6) {
          throw new RetryableError("slow");
        }
        return "ok";
      },
      { baseDelayMs: 1000, maxDelayMs: 2000, sleep },
    );
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });
});
