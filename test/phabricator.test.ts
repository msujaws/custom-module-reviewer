import { describe, test, expect } from "bun:test";
import {
  filterCommentsByAuthors,
  resolveProjectInfoBySlug,
  resolveProjectsBySlugs,
  resolveRevisionsByIds,
  searchRevisionsByReviewer,
  fetchRevisionComments,
  PHABRICATOR_BASE_URL,
  type PhabricatorClient,
  type RevisionComments,
} from "../src/sources/phabricator.ts";
import {
  unsafeBrand,
  type DNumber,
  type ProjectPHID,
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

  test("requests reviewer attachment and parses reviewerPHIDs", async () => {
    const { fetchFn, calls } = recorder(() =>
      jsonResponse({
        result: {
          data: [
            {
              id: 7,
              phid: "PHID-DREV-7",
              fields: {
                title: "with reviewers",
                authorPHID: "PHID-USER-auth",
                uri: "https://phab/D7",
              },
              attachments: {
                reviewers: {
                  reviewers: [
                    { reviewerPHID: "PHID-PROJ-group" },
                    { reviewerPHID: "PHID-USER-bob" },
                  ],
                },
              },
            },
          ],
          cursor: { after: null },
        },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const ids = [unsafeBrand<DNumber>(7)];
    const map = await resolveRevisionsByIds(client, ids);
    expect(map.get(ids[0]!)?.reviewerPHIDs).toEqual([
      "PHID-PROJ-group",
      "PHID-USER-bob",
    ]);
    const body = calls[0]!.body as Record<string, string>;
    expect(body["attachments[reviewers]"]).toBe("1");
  });

  test("returns an empty reviewerPHIDs array when the attachment is missing", async () => {
    const { fetchFn } = recorder(() =>
      jsonResponse({
        result: {
          data: [
            {
              id: 8,
              phid: "PHID-DREV-8",
              fields: {
                title: "no attach",
                authorPHID: "PHID-USER-auth",
              },
            },
          ],
          cursor: { after: null },
        },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const ids = [unsafeBrand<DNumber>(8)];
    const map = await resolveRevisionsByIds(client, ids);
    expect(map.get(ids[0]!)?.reviewerPHIDs).toEqual([]);
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

describe("resolveProjectsBySlugs", () => {
  test("maps each requested slug to its PHID via fields.slug or attachments.slugs", async () => {
    const { fetchFn, calls } = recorder(() =>
      jsonResponse({
        result: {
          data: [
            {
              phid: "PHID-PROJ-theme",
              fields: { slug: "desktop-theme-reviewers" },
              attachments: { slugs: { slugs: ["desktop-theme-reviewers"] } },
            },
            {
              phid: "PHID-PROJ-urlbar",
              fields: { slug: null },
              attachments: { slugs: { slugs: ["urlbar-reviewers", "urlbar"] } },
            },
          ],
        },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const map = await resolveProjectsBySlugs(client, [
      "desktop-theme-reviewers",
      "urlbar-reviewers",
    ]);
    expect(map.get("desktop-theme-reviewers") as unknown as string).toBe(
      "PHID-PROJ-theme",
    );
    expect(map.get("urlbar-reviewers") as unknown as string).toBe(
      "PHID-PROJ-urlbar",
    );
    expect(calls[0]!.url).toBe(`${PHABRICATOR_BASE_URL}/project.search`);
    const body = calls[0]!.body as Record<string, string>;
    expect(body["constraints[slugs][0]"]).toBe("desktop-theme-reviewers");
    expect(body["constraints[slugs][1]"]).toBe("urlbar-reviewers");
    expect(body["attachments[slugs]"]).toBe("1");
  });

  test("omits slugs that did not match any returned project", async () => {
    const { fetchFn } = recorder(() =>
      jsonResponse({
        result: { data: [] },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const map = await resolveProjectsBySlugs(client, ["nonexistent"]);
    expect(map.size).toBe(0);
  });

  test("short-circuits when the slug list is empty", async () => {
    const { fetchFn, calls } = recorder(() =>
      jsonResponse({ result: { data: [] }, error_code: null }),
    );
    const client = makeClient(fetchFn);
    const map = await resolveProjectsBySlugs(client, []);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveProjectInfoBySlug", () => {
  test("returns the PHID and members from one project.search call", async () => {
    const { fetchFn, calls } = recorder(() =>
      jsonResponse({
        result: {
          data: [
            {
              phid: "PHID-PROJ-theme",
              fields: { slug: "desktop-theme-reviewers" },
              attachments: {
                slugs: { slugs: ["desktop-theme-reviewers"] },
                members: {
                  members: [
                    { phid: "PHID-USER-dao" },
                    { phid: "PHID-USER-emilio" },
                  ],
                },
              },
            },
          ],
        },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const info = await resolveProjectInfoBySlug(
      client,
      "desktop-theme-reviewers",
    );
    expect(info?.phid as unknown as string).toBe("PHID-PROJ-theme");
    expect(info?.memberPHIDs.size).toBe(2);
    expect(info?.memberPHIDs.has(unsafeBrand<UserPHID>("PHID-USER-dao"))).toBe(
      true,
    );
    expect(
      info?.memberPHIDs.has(unsafeBrand<UserPHID>("PHID-USER-emilio")),
    ).toBe(true);
    const body = calls[0]!.body as Record<string, string>;
    expect(body["constraints[slugs][0]"]).toBe("desktop-theme-reviewers");
    expect(body["attachments[slugs]"]).toBe("1");
    expect(body["attachments[members]"]).toBe("1");
  });

  test("returns null when no project matches the slug", async () => {
    const { fetchFn } = recorder(() =>
      jsonResponse({ result: { data: [] }, error_code: null }),
    );
    const client = makeClient(fetchFn);
    const info = await resolveProjectInfoBySlug(client, "nonexistent");
    expect(info).toBeNull();
  });

  test("returns an empty memberPHIDs set when the members attachment is absent", async () => {
    const { fetchFn } = recorder(() =>
      jsonResponse({
        result: {
          data: [
            {
              phid: "PHID-PROJ-x",
              fields: { slug: "empty-group" },
              attachments: { slugs: { slugs: ["empty-group"] } },
            },
          ],
        },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const info = await resolveProjectInfoBySlug(client, "empty-group");
    expect(info?.memberPHIDs.size).toBe(0);
  });
});

describe("searchRevisionsByReviewer", () => {
  test("posts the reviewerPHID and modifiedStart constraints", async () => {
    const { fetchFn, calls } = recorder(() =>
      jsonResponse({
        result: {
          data: [
            {
              id: 42,
              phid: "PHID-DREV-42",
              fields: {
                title: "T42",
                authorPHID: "PHID-USER-author",
                uri: "https://phab/D42",
              },
              attachments: {
                reviewers: {
                  reviewers: [{ reviewerPHID: "PHID-PROJ-group" }],
                },
              },
            },
          ],
          cursor: { after: null },
        },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const groupPhid = unsafeBrand<ProjectPHID>("PHID-PROJ-group");
    const revisions = await searchRevisionsByReviewer(client, groupPhid, 30);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.dNumber as unknown as number).toBe(42);
    expect(revisions[0]?.reviewerPHIDs).toEqual(["PHID-PROJ-group"]);
    const body = calls[0]!.body as Record<string, string>;
    expect(body["constraints[reviewerPHIDs][0]"]).toBe("PHID-PROJ-group");
    expect(body["attachments[reviewers]"]).toBe("1");
    expect(Number.parseInt(body["constraints[modifiedStart]"]!, 10)).toBeGreaterThan(
      0,
    );
  });

  test("paginates via cursor.after", async () => {
    let call = 0;
    const { fetchFn, calls } = recorder(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          result: {
            data: [
              {
                id: 1,
                phid: "PHID-DREV-1",
                fields: { title: "a", authorPHID: "PHID-USER-x" },
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
              id: 2,
              phid: "PHID-DREV-2",
              fields: { title: "b", authorPHID: "PHID-USER-y" },
            },
          ],
          cursor: { after: null },
        },
        error_code: null,
      });
    });
    const client = makeClient(fetchFn);
    const revisions = await searchRevisionsByReviewer(
      client,
      unsafeBrand<ProjectPHID>("PHID-PROJ-group"),
      7,
    );
    expect(revisions.map((r) => r.dNumber as unknown as number)).toEqual([
      1, 2,
    ]);
    expect(calls).toHaveLength(2);
    const secondBody = calls[1]!.body as Record<string, string>;
    expect(secondBody["after"]).toBe("PAGE2");
  });

  test("returns an empty array when the API returns no data", async () => {
    const { fetchFn } = recorder(() =>
      jsonResponse({
        result: { data: [], cursor: { after: null } },
        error_code: null,
      }),
    );
    const client = makeClient(fetchFn);
    const revisions = await searchRevisionsByReviewer(
      client,
      unsafeBrand<ProjectPHID>("PHID-PROJ-group"),
      30,
    );
    expect(revisions).toEqual([]);
  });
});

describe("filterCommentsByAuthors", () => {
  const revision = {
    dNumber: unsafeBrand<DNumber>(1),
    phid: unsafeBrand<RevisionPHID>("PHID-DREV-1"),
    title: "t",
    authorPHID: unsafeBrand<UserPHID>("PHID-USER-author"),
    url: "https://phab/D1",
    reviewerPHIDs: [],
  };
  const memberA = unsafeBrand<UserPHID>("PHID-USER-memberA");
  const memberB = unsafeBrand<UserPHID>("PHID-USER-memberB");
  const outsider = unsafeBrand<UserPHID>("PHID-USER-outsider");

  const rc: RevisionComments = {
    revision,
    inline: [
      { path: "a.css", line: 1, diffId: null, authorPHID: memberA, raw: "in-A" },
      {
        path: "b.css",
        line: 2,
        diffId: null,
        authorPHID: outsider,
        raw: "in-out",
      },
    ],
    general: [
      { authorPHID: memberB, raw: "gen-B" },
      { authorPHID: outsider, raw: "gen-out" },
    ],
  };

  test("keeps only comments authored by the allowed set", () => {
    const filtered = filterCommentsByAuthors(rc, new Set([memberA, memberB]));
    expect(filtered.inline).toHaveLength(1);
    expect(filtered.inline[0]?.raw).toBe("in-A");
    expect(filtered.general).toHaveLength(1);
    expect(filtered.general[0]?.raw).toBe("gen-B");
  });

  test("returns empty arrays when the allowed set is empty", () => {
    const filtered = filterCommentsByAuthors(rc, new Set());
    expect(filtered.inline).toEqual([]);
    expect(filtered.general).toEqual([]);
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
    reviewerPHIDs: [],
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
      reviewerPHIDs: [],
    };
    for (let i = 0; i < 5; i += 1) {
      await fetchRevisionComments(client, revisionTemplate);
    }
    expect(sleeps.filter((ms) => ms === 999_999)).toHaveLength(1);
  });
});
