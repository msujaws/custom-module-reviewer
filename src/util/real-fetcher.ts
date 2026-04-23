import type { CacheRequest, CachedResponse, FetchFn } from "./http-cache.ts";
import {
  RetryableError,
  parseRetryAfter,
  withRetry,
  type RetryOptions,
} from "./retry.ts";

const DEFAULT_429_COOLDOWN_SECONDS = 30 * 60;

export const realFetcher: FetchFn = async (
  request: CacheRequest,
): Promise<CachedResponse> => {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method === "POST") {
    if (typeof request.body === "string") {
      init.body = request.body;
    } else if (request.body) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(request.body)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            params.append(key, item);
          }
        } else {
          params.append(key, value);
        }
      }
      init.body = params.toString();
    }
  }
  const response = await fetch(request.url, init);
  const body = await response.text();
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    headers[key] = value;
  }
  return {
    status: response.status,
    headers,
    body,
    fetchedAt: Date.now(),
  };
};

export const retryingFetcher = (
  inner: FetchFn,
  options?: RetryOptions,
): FetchFn => {
  return async (request) =>
    withRetry(async () => {
      const response = await inner(request);
      if (response.status === 429 || response.status >= 500) {
        const headerSeconds = parseRetryAfter(
          response.headers["retry-after"],
          Date.now(),
        );
        const retryAfterSeconds =
          response.status === 429
            ? headerSeconds ?? DEFAULT_429_COOLDOWN_SECONDS
            : headerSeconds;
        throw new RetryableError(
          `HTTP ${response.status} on ${request.url}`,
          retryAfterSeconds,
        );
      }
      if (response.status >= 400) {
        throw new Error(
          `HTTP ${response.status} on ${request.url}: ${response.body.slice(0, 200)}`,
        );
      }
      return response;
    }, options);
};
