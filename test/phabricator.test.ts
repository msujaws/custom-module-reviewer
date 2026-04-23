import { describe, test, expect } from "bun:test";
import {
  resolveRevisionsByIds,
  fetchRevisionComments,
  PHABRICATOR_BASE_URL,
  type PhabricatorClient,
} from "../src/sources/phabricator.ts";
import {
  unsafeBrand,
  type DNumber,
  type RevisionPHID,
  type UserPHID,
} from "../src/util/brand.ts";
import type {
  CacheRequest,
  CachedResponse,
  FetchFn,
} from "../src/util/http-cache.ts";

const jsonResponse = (body: unknown): CachedResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  fetchedAt: 0,
});

const recorder = (
  handler: (request: CacheRequest) => CachedResponse,
): { fetchFn: FetchFn; calls: CacheRequest[] } => {
  const calls: CacheRequest[] = [];
  const fetchFn: FetchFn = async (request) => {
    calls.push(request);
    return handler(request);
  };
  return { fetchFn, calls };
};

const makeClient = (fetchFn: FetchFn): PhabricatorClient => ({
  fetchFn,
  apiToken: "tok",
});

describe("resolveRevisionsByIds", () => {
  test("posts form-encoded body and maps ids to revisions", async () => {
    const { fetchFn, calls } = recorder(() =>
      jsonResponse({
        result: {
          data: [
            {
              id: 123,
              phid: "PHID-DREV-123",
              fields: {
                title: "Bug 1: thing",
                authorPHID: "PHID-USER-auth",
                uri: "https://phab/D123",
              },
            },
          ],
          cursor: { after: null },
        },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const ids = [unsafeBrand<DNumber>(123)];
    const map = await resolveRevisionsByIds(client, ids);
    const revision = map.get(ids[0]!);
    expect(revision?.phid).toBe(unsafeBrand<RevisionPHID>("PHID-DREV-123"));
    expect(revision?.title).toBe("Bug 1: thing");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${PHABRICATOR_BASE_URL}/differential.revision.search`);
    const body = calls[0]!.body as Record<string, string>;
    expect(body["api.token"]).toBe("tok");
    expect(body["constraints[ids][0]"]).toBe("123");
  });

  test("batches ids in groups of 100", async () => {
    const { fetchFn, calls } = recorder(() =>
      jsonResponse({ result: { data: [], cursor: { after: null } }, error_code: null }),
    );
    const client = makeClient(fetchFn);
    const ids = Array.from({ length: 250 }, (_, i) =>
      unsafeBrand<DNumber>(i + 1),
    );
    await resolveRevisionsByIds(client, ids);
    expect(calls).toHaveLength(3);
  });
});

describe("fetchRevisionComments", () => {
  const revisionAuthor = unsafeBrand<UserPHID>("PHID-USER-author");
  const reviewer = unsafeBrand<UserPHID>("PHID-USER-reviewer");
  const revision = {
    dNumber: unsafeBrand<DNumber>(1),
    phid: unsafeBrand<RevisionPHID>("PHID-DREV-1"),
    title: "t",
    authorPHID: revisionAuthor,
    url: "https://phab/D1",
  };

  test("keeps inline + comment from reviewers, drops other types and author replies", async () => {
    const page = {
      result: {
        data: [
          {
            phid: "PHID-XACT-1",
            type: "inline",
            authorPHID: reviewer,
            fields: { path: "src/foo.ts", line: 10, diff: { id: 99 } },
            comments: [{ content: { raw: "Nit: rename this" } }],
          },
          {
            phid: "PHID-XACT-2",
            type: "comment",
            authorPHID: reviewer,
            fields: {},
            comments: [{ content: { raw: "LGTM overall" } }],
          },
          {
            phid: "PHID-XACT-3",
            type: "accept",
            authorPHID: reviewer,
            fields: {},
            comments: [],
          },
          {
            phid: "PHID-XACT-4",
            type: "inline",
            authorPHID: revisionAuthor,
            fields: { path: "src/foo.ts", line: 12 },
            comments: [{ content: { raw: "I reply to myself" } }],
          },
        ],
        cursor: { after: null },
      },
      error_code: null,
    };
    const { fetchFn } = recorder(() => jsonResponse(page));
    const client = makeClient(fetchFn);
    const result = await fetchRevisionComments(client, revision);
    expect(result.inline).toHaveLength(1);
    expect(result.inline[0]?.raw).toBe("Nit: rename this");
    expect(result.inline[0]?.path).toBe("src/foo.ts");
    expect(result.inline[0]?.line).toBe(10);
    expect(result.general).toHaveLength(1);
    expect(result.general[0]?.raw).toBe("LGTM overall");
  });

  test("follows the after cursor across pages", async () => {
    let call = 0;
    const { fetchFn, calls } = recorder(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          result: {
            data: [
              {
                phid: "PHID-XACT-A",
                type: "comment",
                authorPHID: reviewer,
                fields: {},
                comments: [{ content: { raw: "one" } }],
              },
            ],
            cursor: { after: "PAGE2" },
          },
          error_code: null,
        });
      }
      return jsonResponse({
        result: {
          data: [
            {
              phid: "PHID-XACT-B",
              type: "comment",
              authorPHID: reviewer,
              fields: {},
              comments: [{ content: { raw: "two" } }],
            },
          ],
          cursor: { after: null },
        },
        error_code: null,
      });
    });
    const client = makeClient(fetchFn);
    const result = await fetchRevisionComments(client, revision);
    expect(result.general.map((g) => g.raw)).toEqual(["one", "two"]);
    expect(calls).toHaveLength(2);
    const secondBody = calls[1]!.body as Record<string, string>;
    expect(secondBody["after"]).toBe("PAGE2");
  });

  test("throws when Phabricator returns an error_code", async () => {
    const { fetchFn } = recorder(() =>
      jsonResponse({ result: null, error_code: "ERR-CONDUIT-CORE", error_info: "nope" }),
    );
    const client = makeClient(fetchFn);
    await expect(fetchRevisionComments(client, revision)).rejects.toThrow(
      /ERR-CONDUIT-CORE/,
    );
  });
});

describe("rate-limit throttling", () => {
  test("enforces a minimum interval between network calls when throttleState is provided", async () => {
    const sleeps: number[] = [];
    let clock = 1000;
    const { fetchFn } = recorder(() =>
      jsonResponse({
        result: { data: [], cursor: { after: null } },
        error_code: null,
      }),
    );
    const { createThrottleState } = await import(
      "../src/sources/phabricator.ts"
    );
    const client: PhabricatorClient = {
      fetchFn,
      apiToken: "tok",
      throttleState: createThrottleState(),
      minIntervalMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    };
    await resolveRevisionsByIds(client, [
      unsafeBrand<DNumber>(1),
    ]);
    await resolveRevisionsByIds(client, [
      unsafeBrand<DNumber>(2),
    ]);
    expect(sleeps).toEqual([5000]);
  });

  test("emits a cooldown sleep after every N transaction.search calls", async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const { fetchFn } = recorder(() =>
      jsonResponse({
        result: { data: [], cursor: { after: null } },
        error_code: null,
      }),
    );
    const { createThrottleState } = await import(
      "../src/sources/phabricator.ts"
    );
    const client: PhabricatorClient = {
      fetchFn,
      apiToken: "tok",
      throttleState: createThrottleState(),
      minIntervalMs: 1,
      txCooldownEvery: 3,
      txCooldownMs: 999_999,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    };
    const revisionTemplate = {
      dNumber: unsafeBrand<DNumber>(1),
      phid: unsafeBrand<RevisionPHID>("PHID-DREV-1"),
      title: "t",
      authorPHID: unsafeBrand<UserPHID>("PHID-USER-author"),
      url: "https://phab/D1",
    };
    for (let i = 0; i < 5; i += 1) {
      await fetchRevisionComments(client, revisionTemplate);
    }
    expect(sleeps.filter((ms) => ms === 999_999)).toHaveLength(1);
  });
});
