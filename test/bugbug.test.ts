import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bugbugToRevisionComments,
  classifyByBugbugCoverage,
  downloadBugbugArtifact,
  parseBugbugLine,
  parseRevisionsFromLines,
  shouldRefetchLive,
  type BugbugRevision,
} from "../src/sources/bugbug.ts";
import { unsafeBrand, type DNumber } from "../src/util/brand.ts";

const AUTHOR = "PHID-USER-author";
const REVIEWER = "PHID-USER-reviewer";
const BOT = null;

const makeRevision = (overrides: Partial<BugbugRevision> = {}): BugbugRevision => ({
  id: 100,
  phid: "PHID-DREV-xyz",
  fields: {
    title: "Example revision",
    authorPHID: AUTHOR,
    dateModified: 1_700_000_000,
  },
  transactions: [],
  ...overrides,
});

const asyncIterLines = async function* (lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
};

describe("parseBugbugLine", () => {
  test("parses a minimal valid revision", () => {
    const line = JSON.stringify({
      id: 5,
      phid: "PHID-DREV-5",
      fields: { authorPHID: AUTHOR, dateModified: 123 },
    });
    const result = parseBugbugLine(line);
    expect(result?.id).toBe(5);
    expect(result?.transactions).toEqual([]);
  });

  test("returns null on malformed JSON", () => {
    expect(parseBugbugLine("{not json")).toBeNull();
  });

  test("returns null on schema mismatch", () => {
    expect(parseBugbugLine(JSON.stringify({ id: "nope" }))).toBeNull();
  });

  test("returns null on empty line", () => {
    expect(parseBugbugLine("")).toBeNull();
  });
});

describe("bugbugToRevisionComments", () => {
  test("extracts inline and general comments", () => {
    const rev = makeRevision({
      transactions: [
        {
          type: "inline",
          authorPHID: REVIEWER,
          comments: [{ content: { raw: "nit: rename this" } }],
          fields: { path: "src/a.ts", line: 42, diff: { id: 7 } },
        },
        {
          type: "comment",
          authorPHID: REVIEWER,
          comments: [{ content: { raw: "overall looks great" } }],
        },
      ],
    });
    const rc = bugbugToRevisionComments(rev);
    expect(rc.inline).toHaveLength(1);
    expect(rc.inline[0]).toMatchObject({
      path: "src/a.ts",
      line: 42,
      diffId: 7,
      raw: "nit: rename this",
    });
    expect(rc.general).toHaveLength(1);
    expect(rc.general[0]?.raw).toBe("overall looks great");
  });

  test("skips transactions authored by the revision author", () => {
    const rev = makeRevision({
      transactions: [
        {
          type: "comment",
          authorPHID: AUTHOR,
          comments: [{ content: { raw: "self comment" } }],
        },
      ],
    });
    expect(bugbugToRevisionComments(rev).general).toHaveLength(0);
  });

  test("skips bot transactions with null authorPHID", () => {
    const rev = makeRevision({
      transactions: [
        {
          type: "comment",
          authorPHID: BOT,
          comments: [{ content: { raw: "linted" } }],
        },
      ],
    });
    expect(bugbugToRevisionComments(rev).general).toHaveLength(0);
  });

  test("skips non-comment transactions (close, status, etc.)", () => {
    const rev = makeRevision({
      transactions: [
        { type: "close", authorPHID: REVIEWER, comments: [] },
        { type: "accept", authorPHID: REVIEWER, comments: [] },
        { type: "status", authorPHID: REVIEWER, comments: [] },
      ],
    });
    const rc = bugbugToRevisionComments(rev);
    expect(rc.inline).toHaveLength(0);
    expect(rc.general).toHaveLength(0);
  });

  test("skips transactions with blank comment text", () => {
    const rev = makeRevision({
      transactions: [
        {
          type: "comment",
          authorPHID: REVIEWER,
          comments: [{ content: { raw: "   " } }],
        },
      ],
    });
    expect(bugbugToRevisionComments(rev).general).toHaveLength(0);
  });

  test("populates revision url from fields.uri when present", () => {
    const rev = makeRevision({
      fields: {
        authorPHID: AUTHOR,
        title: "t",
        uri: "https://phabricator.services.mozilla.com/D100",
        dateModified: 1,
      },
    });
    const rc = bugbugToRevisionComments(rev);
    expect(rc.revision.url).toBe("https://phabricator.services.mozilla.com/D100");
  });

  test("synthesizes revision url when uri missing", () => {
    const rev = makeRevision({
      id: 9999,
      fields: { authorPHID: AUTHOR, title: "t", dateModified: 1 },
    });
    expect(bugbugToRevisionComments(rev).revision.url).toBe(
      "https://phabricator.services.mozilla.com/D9999",
    );
  });

  test("populates reviewerPHIDs from attachments when present", () => {
    const rev = makeRevision({
      attachments: {
        reviewers: {
          reviewers: [
            { reviewerPHID: "PHID-PROJ-group" },
            { reviewerPHID: "PHID-USER-bob" },
          ],
        },
      },
    });
    expect(bugbugToRevisionComments(rev).revision.reviewerPHIDs).toEqual([
      "PHID-PROJ-group",
      "PHID-USER-bob",
    ]);
  });

  test("defaults reviewerPHIDs to [] when bugbug snapshot omits attachments", () => {
    const rev = makeRevision();
    expect(bugbugToRevisionComments(rev).revision.reviewerPHIDs).toEqual([]);
  });
});

describe("shouldRefetchLive", () => {
  test("true when revision modified after artifact publish", () => {
    const rev = makeRevision({
      fields: { authorPHID: AUTHOR, title: "t", dateModified: 2000 },
    });
    expect(shouldRefetchLive(rev, new Date(1_000_000))).toBe(true);
  });

  test("false when revision modified before publish", () => {
    const rev = makeRevision({
      fields: { authorPHID: AUTHOR, title: "t", dateModified: 1 },
    });
    expect(shouldRefetchLive(rev, new Date(1_000_000_000))).toBe(false);
  });

  test("false when dateModified is missing (conservative)", () => {
    const rev = makeRevision({
      fields: { authorPHID: AUTHOR, title: "t" },
    });
    expect(shouldRefetchLive(rev, new Date(0))).toBe(false);
  });
});

describe("parseRevisionsFromLines", () => {
  test("returns only lines whose id is in the wanted set", async () => {
    const lines = [
      JSON.stringify({ id: 1, phid: "p1", fields: { authorPHID: AUTHOR } }),
      JSON.stringify({ id: 2, phid: "p2", fields: { authorPHID: AUTHOR } }),
      JSON.stringify({ id: 3, phid: "p3", fields: { authorPHID: AUTHOR } }),
    ];
    const result = await parseRevisionsFromLines(
      asyncIterLines(lines),
      new Set([1, 3]),
    );
    expect([...result.keys()].sort()).toEqual([1, 3]);
  });

  test("ignores lines that don't match the id fast-path", async () => {
    const lines = ["not a json line", "{}", ""];
    const result = await parseRevisionsFromLines(
      asyncIterLines(lines),
      new Set([1]),
    );
    expect(result.size).toBe(0);
  });
});

describe("classifyByBugbugCoverage", () => {
  const publishedAt = new Date(1_500_000 * 1000);

  test("routes unseen ids to needsLive", () => {
    const wanted = [unsafeBrand<DNumber>(1), unsafeBrand<DNumber>(2)];
    const results = new Map<number, BugbugRevision>();
    const { covered, needsLive } = classifyByBugbugCoverage(
      wanted,
      results,
      publishedAt,
    );
    expect(covered.size).toBe(0);
    expect(needsLive).toHaveLength(2);
  });

  test("routes stale revs to needsLive and keeps fresh ones in covered", () => {
    const wanted = [unsafeBrand<DNumber>(1), unsafeBrand<DNumber>(2)];
    const fresh = makeRevision({ id: 1, fields: { authorPHID: AUTHOR, title: "t", dateModified: 1_000_000 } });
    const stale = makeRevision({ id: 2, fields: { authorPHID: AUTHOR, title: "t", dateModified: 2_000_000 } });
    const results = new Map([
      [1, fresh],
      [2, stale],
    ]);
    const { covered, needsLive } = classifyByBugbugCoverage(
      wanted,
      results,
      publishedAt,
    );
    expect([...covered.keys()]).toEqual([1]);
    expect(needsLive).toHaveLength(1);
    expect(needsLive[0] as unknown as number).toBe(2);
  });
});

describe("downloadBugbugArtifact", () => {
  test("writes the artifact and meta, returns publishedAt from downloader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bugbug-test-"));
    const published = new Date(1_700_000_000_000);
    let downloaderCalls = 0;
    const result = await downloadBugbugArtifact({
      cacheDir: dir,
      now: () => 0,
      artifactUrl: "https://example.test/artifact.zst",
      downloader: async (_url, destination) => {
        downloaderCalls += 1;
        await writeFile(destination, "fake zst bytes");
        return { publishedAt: published };
      },
    });
    expect(downloaderCalls).toBe(1);
    expect(result.publishedAt.getTime()).toBe(published.getTime());
    const meta = JSON.parse(
      await readFile(path.join(dir, "bugbug-revisions.meta.json"), "utf8"),
    );
    expect(meta.publishedAt).toBe(published.getTime());
  });

  test("uses cached artifact within TTL and skips downloader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bugbug-test-"));
    await writeFile(path.join(dir, "bugbug-revisions.json.zst"), "stale bytes");
    await writeFile(
      path.join(dir, "bugbug-revisions.meta.json"),
      JSON.stringify({
        publishedAt: 1,
        fetchedAt: 100,
        sourceUrl: "https://example.test/artifact.zst",
      }),
    );
    let downloaderCalls = 0;
    const result = await downloadBugbugArtifact({
      cacheDir: dir,
      ttlMs: 1000,
      now: () => 500,
      artifactUrl: "https://example.test/artifact.zst",
      downloader: async () => {
        downloaderCalls += 1;
        return { publishedAt: new Date() };
      },
    });
    expect(downloaderCalls).toBe(0);
    expect(result.publishedAt.getTime()).toBe(1);
  });

  test("re-downloads when cached meta is older than TTL", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bugbug-test-"));
    await writeFile(path.join(dir, "bugbug-revisions.json.zst"), "stale");
    await writeFile(
      path.join(dir, "bugbug-revisions.meta.json"),
      JSON.stringify({
        publishedAt: 1,
        fetchedAt: 0,
        sourceUrl: "https://example.test/artifact.zst",
      }),
    );
    let downloaderCalls = 0;
    await downloadBugbugArtifact({
      cacheDir: dir,
      ttlMs: 100,
      now: () => 1000,
      artifactUrl: "https://example.test/artifact.zst",
      downloader: async (_url, destination) => {
        downloaderCalls += 1;
        await writeFile(destination, "fresh");
        return { publishedAt: new Date(12_345) };
      },
    });
    expect(downloaderCalls).toBe(1);
  });
});
