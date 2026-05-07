import { z } from "zod";
import {
  unsafeBrand,
  type DNumber,
  type ProjectPHID,
  type RevisionPHID,
  type UserPHID,
} from "../util/brand.ts";
import {
  cachedFetch,
  type CacheOptions,
  type FetchFn,
} from "../util/http-cache.ts";

export const PHABRICATOR_BASE_URL =
  "https://phabricator.services.mozilla.com/api";

export const DEFAULT_MIN_INTERVAL_MS = 5000;
export const DEFAULT_TX_COOLDOWN_EVERY = 50;
export const DEFAULT_TX_COOLDOWN_MS = 30 * 60 * 1000;

export interface ThrottleState {
  nextAllowedAt: number;
  transactionSearchCalls: number;
}

export const createThrottleState = (): ThrottleState => ({
  nextAllowedAt: 0,
  transactionSearchCalls: 0,
});

export interface PhabricatorClient {
  fetchFn: FetchFn;
  apiToken: string;
  baseUrl?: string;
  cache?: Omit<CacheOptions, "fetchFn">;
  throttleState?: ThrottleState;
  minIntervalMs?: number;
  txCooldownEvery?: number;
  txCooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onCooldown?: (durationMs: number, callsSoFar: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const throttleBeforeNetworkCall = async (
  client: PhabricatorClient,
  method: string,
): Promise<void> => {
  if (!client.throttleState) {
    return;
  }
  const sleep = client.sleep ?? defaultSleep;
  const now = client.now ?? Date.now;
  const minIntervalMs = client.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const cooldownEvery = client.txCooldownEvery ?? DEFAULT_TX_COOLDOWN_EVERY;
  const cooldownMs = client.txCooldownMs ?? DEFAULT_TX_COOLDOWN_MS;

  if (
    method === "transaction.search" &&
    client.throttleState.transactionSearchCalls > 0 &&
    client.throttleState.transactionSearchCalls % cooldownEvery === 0
  ) {
    client.onCooldown?.(
      cooldownMs,
      client.throttleState.transactionSearchCalls,
    );
    await sleep(cooldownMs);
  }

  const waitMs = client.throttleState.nextAllowedAt - now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  client.throttleState.nextAllowedAt = now() + minIntervalMs;
  if (method === "transaction.search") {
    client.throttleState.transactionSearchCalls += 1;
  }
};

const throttledFetchFn =
  (client: PhabricatorClient, method: string): FetchFn =>
  async (request) => {
    await throttleBeforeNetworkCall(client, method);
    return client.fetchFn(request);
  };

const ConduitEnvelopeSchema = z.object({
  result: z.unknown(),
  error_code: z.string().nullable().optional(),
  error_info: z.string().nullable().optional(),
});

const ReviewerAttachmentSchema = z
  .object({
    reviewers: z
      .object({
        reviewers: z
          .array(
            z.object({
              reviewerPHID: z.string(),
            }),
          )
          .optional()
          .default([]),
      })
      .optional(),
  })
  .optional();

const RevisionSchema = z.object({
  id: z.number(),
  phid: z.string(),
  fields: z.object({
    title: z.string().optional().default(""),
    authorPHID: z.string(),
    uri: z.string().optional(),
  }),
  attachments: ReviewerAttachmentSchema,
});

const RevisionSearchResultSchema = z.object({
  data: z.array(RevisionSchema),
  cursor: z
    .object({ after: z.string().nullable().optional() })
    .optional(),
});

const TransactionSchema = z.object({
  phid: z.string(),
  type: z.string().nullable(),
  authorPHID: z.string().nullable(),
  fields: z
    .object({
      path: z.string().optional(),
      line: z.number().nullable().optional(),
      diff: z.object({ id: z.number() }).optional(),
    })
    .catchall(z.unknown())
    .optional(),
  comments: z
    .array(
      z.object({
        content: z.object({ raw: z.string() }),
      }),
    )
    .optional()
    .default([]),
});

const TransactionSearchResultSchema = z.object({
  data: z.array(TransactionSchema),
  cursor: z
    .object({ after: z.string().nullable().optional() })
    .optional(),
});

export interface Revision {
  dNumber: DNumber;
  phid: RevisionPHID;
  title: string;
  authorPHID: UserPHID;
  url: string;
  reviewerPHIDs: string[];
}

export interface InlineComment {
  path: string;
  line: number | null;
  diffId: number | null;
  authorPHID: UserPHID;
  raw: string;
}

export interface GeneralComment {
  authorPHID: UserPHID;
  raw: string;
}

export interface RevisionComments {
  revision: Revision;
  inline: InlineComment[];
  general: GeneralComment[];
}

const conduitPost = async (
  client: PhabricatorClient,
  method: string,
  params: Record<string, string>,
): Promise<unknown> => {
  const baseUrl = client.baseUrl ?? PHABRICATOR_BASE_URL;
  const request = {
    method: "POST" as const,
    url: `${baseUrl}/${method}`,
    body: { "api.token": client.apiToken, ...params },
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
  const fetchFn = throttledFetchFn(client, method);
  const response = client.cache
    ? await cachedFetch(request, { ...client.cache, fetchFn })
    : await fetchFn(request);
  const envelope = ConduitEnvelopeSchema.parse(JSON.parse(response.body));
  if (envelope.error_code) {
    throw new Error(
      `Phabricator ${method} failed: ${envelope.error_code} ${envelope.error_info ?? ""}`,
    );
  }
  return envelope.result;
};

const BATCH_SIZE = 100;

export const resolveRevisionsByIds = async (
  client: PhabricatorClient,
  ids: DNumber[],
): Promise<Map<DNumber, Revision>> => {
  const out = new Map<DNumber, Revision>();
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const batch = ids.slice(start, start + BATCH_SIZE);
    const params: Record<string, string> = {
      "attachments[reviewers]": "1",
    };
    for (const [i, id] of batch.entries()) {
      params[`constraints[ids][${i}]`] = String(id);
    }
    const result = RevisionSearchResultSchema.parse(
      await conduitPost(client, "differential.revision.search", params),
    );
    for (const raw of result.data) {
      const dNumber = unsafeBrand<DNumber>(raw.id);
      const reviewerPHIDs = (raw.attachments?.reviewers?.reviewers ?? []).map(
        (r) => r.reviewerPHID,
      );
      out.set(dNumber, {
        dNumber,
        phid: unsafeBrand<RevisionPHID>(raw.phid),
        title: raw.fields.title,
        authorPHID: unsafeBrand<UserPHID>(raw.fields.authorPHID),
        url: raw.fields.uri ?? `https://phabricator.services.mozilla.com/D${raw.id}`,
        reviewerPHIDs,
      });
    }
  }
  return out;
};

const ProjectSearchResultSchema = z.object({
  data: z.array(
    z.object({
      phid: z.string(),
      fields: z
        .object({
          slug: z.string().nullable().optional(),
        })
        .catchall(z.unknown())
        .optional(),
      attachments: z
        .object({
          slugs: z
            .object({
              slugs: z.array(z.string()).optional().default([]),
            })
            .optional(),
          members: z
            .object({
              members: z
                .array(z.object({ phid: z.string() }))
                .optional()
                .default([]),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
});

export const resolveProjectsBySlugs = async (
  client: PhabricatorClient,
  slugs: string[],
): Promise<Map<string, ProjectPHID>> => {
  const out = new Map<string, ProjectPHID>();
  if (slugs.length === 0) {
    return out;
  }
  const params: Record<string, string> = {
    "attachments[slugs]": "1",
  };
  for (const [i, slug] of slugs.entries()) {
    params[`constraints[slugs][${i}]`] = slug;
  }
  const result = ProjectSearchResultSchema.parse(
    await conduitPost(client, "project.search", params),
  );
  const wanted = new Set(slugs);
  for (const project of result.data) {
    const phid = unsafeBrand<ProjectPHID>(project.phid);
    const projectSlugs = new Set<string>();
    if (project.fields?.slug) {
      projectSlugs.add(project.fields.slug);
    }
    for (const s of project.attachments?.slugs?.slugs ?? []) {
      projectSlugs.add(s);
    }
    for (const s of projectSlugs) {
      if (wanted.has(s)) {
        out.set(s, phid);
      }
    }
  }
  return out;
};

export interface ProjectInfo {
  phid: ProjectPHID;
  memberPHIDs: Set<UserPHID>;
}

export const resolveProjectInfoBySlug = async (
  client: PhabricatorClient,
  slug: string,
): Promise<ProjectInfo | null> => {
  const params: Record<string, string> = {
    "constraints[slugs][0]": slug,
    "attachments[slugs]": "1",
    "attachments[members]": "1",
  };
  const result = ProjectSearchResultSchema.parse(
    await conduitPost(client, "project.search", params),
  );
  for (const project of result.data) {
    const projectSlugs = new Set<string>();
    if (project.fields?.slug) {
      projectSlugs.add(project.fields.slug);
    }
    for (const s of project.attachments?.slugs?.slugs ?? []) {
      projectSlugs.add(s);
    }
    if (!projectSlugs.has(slug)) {
      continue;
    }
    const memberPHIDs = new Set<UserPHID>();
    for (const m of project.attachments?.members?.members ?? []) {
      memberPHIDs.add(unsafeBrand<UserPHID>(m.phid));
    }
    return {
      phid: unsafeBrand<ProjectPHID>(project.phid),
      memberPHIDs,
    };
  }
  return null;
};

export const searchRevisionsByReviewer = async (
  client: PhabricatorClient,
  reviewerPHID: ProjectPHID,
  sinceDays: number,
): Promise<Revision[]> => {
  const sinceUnix = Math.floor(
    (Date.now() - sinceDays * 86_400_000) / 1000,
  );
  const out: Revision[] = [];
  let after: string | null = null;
  do {
    const params: Record<string, string> = {
      "constraints[reviewerPHIDs][0]": reviewerPHID as unknown as string,
      "constraints[modifiedStart]": String(sinceUnix),
      "attachments[reviewers]": "1",
      "order": "newest",
      "limit": "100",
    };
    if (after) {
      params["after"] = after;
    }
    const result = RevisionSearchResultSchema.parse(
      await conduitPost(client, "differential.revision.search", params),
    );
    for (const raw of result.data) {
      const reviewerPHIDs = (raw.attachments?.reviewers?.reviewers ?? []).map(
        (r) => r.reviewerPHID,
      );
      out.push({
        dNumber: unsafeBrand<DNumber>(raw.id),
        phid: unsafeBrand<RevisionPHID>(raw.phid),
        title: raw.fields.title,
        authorPHID: unsafeBrand<UserPHID>(raw.fields.authorPHID),
        url:
          raw.fields.uri ??
          `https://phabricator.services.mozilla.com/D${raw.id}`,
        reviewerPHIDs,
      });
    }
    after = result.cursor?.after ?? null;
  } while (after);
  return out;
};

export const filterCommentsByAuthors = (
  rc: RevisionComments,
  allowedAuthors: Set<UserPHID>,
): RevisionComments => ({
  revision: rc.revision,
  inline: rc.inline.filter((c) => allowedAuthors.has(c.authorPHID)),
  general: rc.general.filter((c) => allowedAuthors.has(c.authorPHID)),
});

export const fetchRevisionComments = async (
  client: PhabricatorClient,
  revision: Revision,
): Promise<RevisionComments> => {
  const inline: InlineComment[] = [];
  const general: GeneralComment[] = [];
  let after: string | null = null;

  do {
    const params: Record<string, string> = {
      objectIdentifier: revision.phid,
    };
    if (after) {
      params["after"] = after;
    }
    const result = TransactionSearchResultSchema.parse(
      await conduitPost(client, "transaction.search", params),
    );
    for (const tx of result.data) {
      if (tx.authorPHID === null) {
        continue;
      }
      if (tx.authorPHID === (revision.authorPHID as unknown as string)) {
        continue;
      }
      if (tx.comments.length === 0) {
        continue;
      }
      const raw = tx.comments[0]?.content.raw ?? "";
      if (!raw.trim()) {
        continue;
      }
      if (tx.type === "inline") {
        inline.push({
          path: tx.fields?.path ?? "",
          line: tx.fields?.line ?? null,
          diffId: tx.fields?.diff?.id ?? null,
          authorPHID: unsafeBrand<UserPHID>(tx.authorPHID),
          raw,
        });
      } else if (tx.type === "comment") {
        general.push({
          authorPHID: unsafeBrand<UserPHID>(tx.authorPHID),
          raw,
        });
      }
    }
    after = result.cursor?.after ?? null;
  } while (after);

  return { revision, inline, general };
};
