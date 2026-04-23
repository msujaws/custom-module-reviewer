import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  fetchedAt: number;
}

export interface CacheRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string | Record<string, string | string[]>;
}

export type FetchFn = (request: CacheRequest) => Promise<CachedResponse>;

export type CacheMode = "normal" | "no-cache" | "refresh";

export interface CacheOptions {
  cacheDir: string;
  ttlMs: number;
  mode: CacheMode;
  fetchFn: FetchFn;
  now?: () => number;
}

const canonicalizeUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  const pairs = [...url.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  url.search = new URLSearchParams(pairs).toString();
  return url.toString();
};

const canonicalizeBody = (body: CacheRequest["body"]): string => {
  if (body === undefined) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  const sortedEntries = Object.entries(body).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const normalized = sortedEntries.map(([key, value]) => {
    const list = Array.isArray(value) ? [...value].sort() : [value];
    return [key, list];
  });
  return JSON.stringify(normalized);
};

const hashRequest = (request: CacheRequest): string => {
  const url = canonicalizeUrl(request.url);
  const body = canonicalizeBody(request.body);
  const material = [request.method, url, body].join("\n");
  return createHash("sha256").update(material).digest("hex");
};

const cachePath = (cacheDir: string, key: string): string =>
  path.join(cacheDir, key.slice(0, 2), `${key}.json`);

const readCache = async (filePath: string): Promise<CachedResponse | null> => {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents) as CachedResponse;
  } catch {
    return null;
  }
};

const writeCache = async (
  filePath: string,
  response: CachedResponse,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(response), "utf8");
};

export const cachedFetch = async (
  request: CacheRequest,
  options: CacheOptions,
): Promise<CachedResponse> => {
  const key = hashRequest(request);
  const filePath = cachePath(options.cacheDir, key);
  const now = (options.now ?? Date.now)();

  if (options.mode === "normal") {
    const cached = await readCache(filePath);
    if (cached && now - cached.fetchedAt < options.ttlMs) {
      return cached;
    }
  }

  const fetched = await options.fetchFn(request);
  const stamped: CachedResponse = { ...fetched, fetchedAt: now };

  if (options.mode !== "no-cache") {
    await writeCache(filePath, stamped);
  }

  return stamped;
};
