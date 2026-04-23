import { z } from "zod";
import pLimit from "p-limit";
import {
  cachedFetch,
  type CacheOptions,
  type FetchFn,
} from "../util/http-cache.ts";
import {
  unsafeBrand,
  type AttachmentId,
  type BugId,
  type DNumber,
} from "../util/brand.ts";
import { parseDNumber } from "../util/dnumber.ts";
import type { BugzillaComponent } from "./mots.ts";

export const BUGZILLA_BASE_URL = "https://bugzilla.mozilla.org";

export interface BugzillaClient {
  fetchFn: FetchFn;
  apiKey: string;
  baseUrl?: string;
  cache?: Omit<CacheOptions, "fetchFn">;
  concurrency?: number;
}

const BugSchema = z.object({
  id: z.number(),
  summary: z.string(),
  product: z.string(),
  component: z.string(),
  resolution: z.string(),
  last_change_time: z.string().optional(),
  cf_last_resolved: z.string().optional(),
});

const BugSearchResponseSchema = z.object({
  bugs: z.array(BugSchema),
});

const AttachmentSchema = z.object({
  id: z.number(),
  bug_id: z.number(),
  content_type: z.string(),
  file_name: z.string(),
  is_obsolete: z.number(),
  summary: z.string().optional().default(""),
});

const AttachmentsResponseSchema = z.object({
  bugs: z.record(z.string(), z.array(AttachmentSchema)),
});

export interface Bug {
  id: BugId;
  summary: string;
  product: string;
  component: string;
  resolution: string;
  lastChangeTime: string | undefined;
}

export interface Attachment {
  id: AttachmentId;
  bugId: BugId;
  fileName: string;
  contentType: string;
}

const runFetch = async (
  client: BugzillaClient,
  url: string,
): Promise<string> => {
  const request = {
    method: "GET" as const,
    url,
    headers: { "X-BUGZILLA-API-KEY": client.apiKey },
  };
  if (client.cache) {
    const response = await cachedFetch(request, {
      ...client.cache,
      fetchFn: client.fetchFn,
    });
    return response.body;
  }
  const response = await client.fetchFn(request);
  return response.body;
};

export const searchFixedBugs = async (
  client: BugzillaClient,
  components: BugzillaComponent[],
  sinceDays: number,
): Promise<Bug[]> => {
  if (components.length === 0) {
    return [];
  }
  const baseUrl = client.baseUrl ?? BUGZILLA_BASE_URL;
  const limit = pLimit(client.concurrency ?? 2);
  const seen = new Map<number, Bug>();

  const fetchOne = async (component: BugzillaComponent): Promise<Bug[]> => {
    const url = new URL("/rest/bug", baseUrl);
    url.searchParams.set("product", component.product);
    url.searchParams.set("component", component.component);
    url.searchParams.set("resolution", "FIXED");
    url.searchParams.set("chfield", "resolution");
    url.searchParams.set("chfieldvalue", "FIXED");
    url.searchParams.set("chfieldfrom", `-${sinceDays}d`);
    url.searchParams.set(
      "include_fields",
      "id,summary,product,component,resolution,last_change_time,cf_last_resolved",
    );
    const body = await runFetch(client, url.toString());
    const parsed = BugSearchResponseSchema.parse(JSON.parse(body));
    return parsed.bugs.map((b) => ({
      id: unsafeBrand<BugId>(b.id),
      summary: b.summary,
      product: b.product,
      component: b.component,
      resolution: b.resolution,
      lastChangeTime: b.last_change_time,
    }));
  };

  const results = await Promise.all(
    components.map((c) => limit(() => fetchOne(c))),
  );
  for (const bugs of results) {
    for (const bug of bugs) {
      seen.set(bug.id as unknown as number, bug);
    }
  }
  return [...seen.values()].sort(
    (a, b) => (a.id as unknown as number) - (b.id as unknown as number),
  );
};

export const getAttachments = async (
  client: BugzillaClient,
  bugId: BugId,
): Promise<Attachment[]> => {
  const baseUrl = client.baseUrl ?? BUGZILLA_BASE_URL;
  const url = new URL(`/rest/bug/${bugId}/attachment`, baseUrl);
  url.searchParams.set(
    "include_fields",
    "id,bug_id,content_type,file_name,is_obsolete,summary",
  );
  const body = await runFetch(client, url.toString());
  const parsed = AttachmentsResponseSchema.parse(JSON.parse(body));
  const list = parsed.bugs[String(bugId)] ?? [];
  return list
    .filter(
      (a) =>
        a.content_type === "text/x-phabricator-request" && a.is_obsolete === 0,
    )
    .map<Attachment>((a) => ({
      id: unsafeBrand<AttachmentId>(a.id),
      bugId: unsafeBrand<BugId>(a.bug_id),
      fileName: a.file_name,
      contentType: a.content_type,
    }));
};

export const extractPhabricatorDNumbers = (
  attachments: Attachment[],
): DNumber[] => {
  const out: DNumber[] = [];
  const seen = new Set<number>();
  for (const a of attachments) {
    const d = parseDNumber(a.fileName);
    if (d !== null && !seen.has(d as unknown as number)) {
      seen.add(d as unknown as number);
      out.push(d);
    }
  }
  return out;
};
