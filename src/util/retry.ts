export class RetryableError extends Error {
  public readonly retryAfterSeconds: number | undefined;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "RetryableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const parseRetryAfter = (
  header: string | undefined,
  now: number,
): number | undefined => {
  if (!header) {
    return undefined;
  }
  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  const httpDate = Date.parse(header);
  if (Number.isFinite(httpDate)) {
    return Math.max(0, (httpDate - now) / 1000);
  }
  return undefined;
};

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const withRetry = async <T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const retries = options.retries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof RetryableError) || attempt === retries) {
        throw error;
      }
      const delayMs =
        error.retryAfterSeconds === undefined
          ? Math.min(
              baseDelayMs * 2 ** attempt + random() * baseDelayMs,
              maxDelayMs,
            )
          : error.retryAfterSeconds * 1000;
      await sleep(delayMs);
    }
  }
  throw new Error("withRetry: unreachable");
};
