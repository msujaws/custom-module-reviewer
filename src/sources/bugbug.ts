import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  unsafeBrand,
  type DNumber,
  type RevisionPHID,
  type UserPHID,
} from "../util/brand.ts";
import type {
  GeneralComment,
  InlineComment,
  Revision,
  RevisionComments,
} from "./phabricator.ts";

export const BUGBUG_ARTIFACT_URL =
  "https://community-tc.services.mozilla.com/api/index/v1/task/project.bugbug.data_revisions.latest/artifacts/public/revisions.json.zst";

export const DEFAULT_ARTIFACT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const BugbugCommentSchema = z.object({
  content: z.object({ raw: z.string() }).optional(),
  authorPHID: z.string().optional(),
});

const BugbugTransactionSchema = z.object({
  type: z.string().nullable(),
  authorPHID: z.string().nullable(),
  dateCreated: z.number().optional(),
  fields: z
    .object({
      path: z.string().optional(),
      line: z.number().nullable().optional(),
      diff: z.object({ id: z.number() }).optional(),
    })
    .passthrough()
    .optional(),
  comments: z.array(BugbugCommentSchema).optional().default([]),
});

const BugbugRevisionSchema = z.object({
  id: z.number(),
  phid: z.string(),
  fields: z
    .object({
      title: z.string().optional().default(""),
      authorPHID: z.string(),
      uri: z.string().optional(),
      dateModified: z.number().optional(),
    })
    .passthrough(),
  transactions: z.array(BugbugTransactionSchema).optional().default([]),
});

export type BugbugRevision = z.infer<typeof BugbugRevisionSchema>;

export interface BugbugArtifact {
  zstPath: string;
  publishedAt: Date;
}

export type BugbugDownloader = (
  url: string,
  destination: string,
) => Promise<{ publishedAt: Date }>;

export interface BugbugClient {
  cacheDir: string;
  ttlMs?: number;
  artifactUrl?: string;
  downloader?: BugbugDownloader;
  now?: () => number;
}

interface ArtifactMeta {
  publishedAt: number;
  fetchedAt: number;
  sourceUrl: string;
}

const LINE_ID_PATTERN = /^{"id":(\d+),/;

export const parseBugbugLine = (line: string): BugbugRevision | null => {
  if (line.length === 0) {
    return null;
  }
  try {
    const raw = JSON.parse(line);
    return BugbugRevisionSchema.parse(raw);
  } catch {
    return null;
  }
};

export const bugbugToRevisionComments = (
  rev: BugbugRevision,
): RevisionComments => {
  const revision: Revision = {
    dNumber: unsafeBrand<DNumber>(rev.id),
    phid: unsafeBrand<RevisionPHID>(rev.phid),
    title: rev.fields.title ?? "",
    authorPHID: unsafeBrand<UserPHID>(rev.fields.authorPHID),
    url:
      rev.fields.uri ?? `https://phabricator.services.mozilla.com/D${rev.id}`,
  };
  const inline: InlineComment[] = [];
  const general: GeneralComment[] = [];
  for (const tx of rev.transactions) {
    if (tx.authorPHID === null) {
      continue;
    }
    if (tx.authorPHID === rev.fields.authorPHID) {
      continue;
    }
    const raw = tx.comments[0]?.content?.raw ?? "";
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
  return { revision, inline, general };
};

export const shouldRefetchLive = (
  rev: BugbugRevision,
  publishedAt: Date,
): boolean => {
  const dateModified = rev.fields.dateModified;
  if (dateModified === undefined) {
    return false;
  }
  return dateModified * 1000 > publishedAt.getTime();
};

export const parseRevisionsFromLines = async (
  lines: AsyncIterable<string>,
  wanted: Set<number>,
): Promise<Map<number, BugbugRevision>> => {
  const out = new Map<number, BugbugRevision>();
  for await (const line of lines) {
    const match = LINE_ID_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const id = Number(match[1]);
    if (!wanted.has(id)) {
      continue;
    }
    const parsed = parseBugbugLine(line);
    if (parsed) {
      out.set(id, parsed);
    }
  }
  return out;
};

export const streamRevisionsMatching = async (
  zstPath: string,
  wanted: Set<number>,
): Promise<Map<number, BugbugRevision>> => {
  const child = spawn("zstd", ["-dc", zstPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (!child.stdout) {
    throw new Error("zstd subprocess has no stdout");
  }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const map = await parseRevisionsFromLines(rl, wanted);
  const code = await exitPromise;
  if (code !== 0) {
    throw new Error(`zstd exited with code ${code} for ${zstPath}`);
  }
  return map;
};

const readArtifactMeta = async (
  metaPath: string,
  zstPath: string,
): Promise<ArtifactMeta | null> => {
  try {
    const contents = await readFile(metaPath, "utf8");
    const meta = JSON.parse(contents) as ArtifactMeta;
    await stat(zstPath);
    return meta;
  } catch {
    return null;
  }
};

const defaultDownloader: BugbugDownloader = async (url, destination) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `bugbug artifact download failed: HTTP ${response.status} on ${url}`,
    );
  }
  const lastModified = response.headers.get("last-modified");
  const publishedAt = lastModified ? new Date(lastModified) : new Date();
  const bytes = await response.arrayBuffer();
  await Bun.write(destination, bytes);
  return { publishedAt };
};

export const downloadBugbugArtifact = async (
  client: BugbugClient,
): Promise<BugbugArtifact> => {
  const zstPath = path.join(client.cacheDir, "bugbug-revisions.json.zst");
  const metaPath = path.join(client.cacheDir, "bugbug-revisions.meta.json");
  const ttlMs = client.ttlMs ?? DEFAULT_ARTIFACT_TTL_MS;
  const now = (client.now ?? Date.now)();

  const cached = await readArtifactMeta(metaPath, zstPath);
  if (cached && now - cached.fetchedAt < ttlMs) {
    return { zstPath, publishedAt: new Date(cached.publishedAt) };
  }

  await mkdir(client.cacheDir, { recursive: true });
  const url = client.artifactUrl ?? BUGBUG_ARTIFACT_URL;
  const downloader = client.downloader ?? defaultDownloader;
  const { publishedAt } = await downloader(url, zstPath);

  const meta: ArtifactMeta = {
    publishedAt: publishedAt.getTime(),
    fetchedAt: now,
    sourceUrl: url,
  };
  await writeFile(metaPath, JSON.stringify(meta), "utf8");
  return { zstPath, publishedAt };
};

export interface BugbugClassification<D> {
  covered: Map<number, BugbugRevision>;
  needsLive: D[];
}

export const classifyByBugbugCoverage = <D extends { valueOf(): number }>(
  wanted: D[],
  bugbugResults: Map<number, BugbugRevision>,
  publishedAt: Date,
): BugbugClassification<D> => {
  const covered = new Map<number, BugbugRevision>();
  const needsLive: D[] = [];
  for (const d of wanted) {
    const id = d as unknown as number;
    const rev = bugbugResults.get(id);
    if (!rev) {
      needsLive.push(d);
      continue;
    }
    if (shouldRefetchLive(rev, publishedAt)) {
      needsLive.push(d);
      continue;
    }
    covered.set(id, rev);
  }
  return { covered, needsLive };
};
