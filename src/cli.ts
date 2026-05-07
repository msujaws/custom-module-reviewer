import { Command } from "commander";
import pLimit from "p-limit";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "./config.ts";
import {
  unsafeBrand,
  type DNumber,
  type ModuleName,
} from "./util/brand.ts";
import { toModuleSlug } from "./util/slug.ts";
import {
  type CacheMode,
  type CacheOptions,
} from "./util/http-cache.ts";
import { realFetcher, retryingFetcher } from "./util/real-fetcher.ts";
import {
  fetchMotsYaml,
  resolveModule,
} from "./sources/mots.ts";
import {
  searchFixedBugs,
  getAttachments,
  extractPhabricatorDNumbers,
  type Bug,
  type BugzillaClient,
} from "./sources/bugzilla.ts";
import {
  createThrottleState,
  fetchRevisionComments,
  filterCommentsByAuthors,
  resolveProjectInfoBySlug,
  resolveProjectsBySlugs,
  resolveRevisionsByIds,
  searchRevisionsByReviewer,
  type PhabricatorClient,
  type ProjectInfo,
  type Revision,
  type RevisionComments,
} from "./sources/phabricator.ts";
import {
  bugbugToRevisionComments,
  classifyByBugbugCoverage,
  downloadBugbugArtifact,
  streamRevisionsMatching,
} from "./sources/bugbug.ts";
import { fetchRelevantDocs } from "./sources/firefox-docs.ts";
import { buildBundle } from "./synthesis/bundle.ts";
import { synthesizeSkill } from "./synthesis/claude.ts";
import { writeSkill } from "./synthesis/skill-writer.ts";

const HOUR_MS = 60 * 60 * 1000;
const CACHE_DIR = "./.cache";

interface CliOptions {
  module: string;
  days: number;
  outputDir: string;
  dryRun: boolean;
  cacheMode: CacheMode;
  concurrency: number;
  skipBugzilla: boolean;
}

export const parseOptions = (argv: string[]): CliOptions => {
  const program = new Command();
  program
    .name("custom-module-reviewer")
    .requiredOption("--module <name>", "Module name or machine_name from mots.yaml")
    .option("--days <n>", "Lookback window in days", "365")
    .option("--output-dir <path>", "Output directory", "./output")
    .option("--dry-run", "Skip the Claude synthesis step", false)
    .option("--no-cache", "Disable HTTP cache (read+write)")
    .option("--refresh", "Ignore cached entries but write new ones", false)
    .option("--concurrency <n>", "Parallel API calls", "4")
    .option(
      "--skip-bugzilla",
      "Skip Bugzilla; query Phabricator directly by reviewer group and keep only comments authored by current group members. With this flag, --days is measured against Phabricator revision modification time, not bug close time.",
      false,
    );
  program.parse(argv);
  const opts = program.opts();
  const cacheMode: CacheMode = opts.cache === false
    ? "no-cache"
    : opts.refresh
      ? "refresh"
      : "normal";
  return {
    module: opts.module,
    days: Number.parseInt(opts.days, 10),
    outputDir: opts.outputDir,
    dryRun: Boolean(opts.dryRun),
    cacheMode,
    concurrency: Number.parseInt(opts.concurrency, 10),
    skipBugzilla: Boolean(opts.skipBugzilla),
  };
};

export const run = async (argv: string[]): Promise<number> => {
  const cli = parseOptions(argv);
  const env = loadEnv(process.env, { dryRun: cli.dryRun });

  const fetchFn = retryingFetcher(realFetcher, {
    retries: 10,
    baseDelayMs: 2000,
    maxDelayMs: 180_000,
  });
  const cacheBase = { cacheDir: CACHE_DIR, mode: cli.cacheMode, fetchFn };

  const motsCache: CacheOptions = { ...cacheBase, ttlMs: 6 * HOUR_MS };
  process.stderr.write("Fetching mots.yaml...\n");
  const motsDoc = await fetchMotsYaml(motsCache);

  const resolved = resolveModule(motsDoc, unsafeBrand<ModuleName>(cli.module));
  if (resolved.kind === "miss") {
    process.stderr.write(
      `Module "${cli.module}" not found in mots.yaml.\nDid you mean:\n`,
    );
    for (const s of resolved.suggestions) {
      process.stderr.write(`  - ${s}\n`);
    }
    return 1;
  }
  const module_ = resolved.module;
  const slug = toModuleSlug(unsafeBrand<ModuleName>(module_.name));

  if (!module_.reviewGroup) {
    process.stderr.write(
      `Module "${module_.name}" has no meta.review_group in mots.yaml. ` +
        `This tool's review-group + scope filter requires one — add a review_group to ` +
        `the module's meta block, or run against a module that already declares one.\n`,
    );
    return 1;
  }

  const phabricatorClient: PhabricatorClient = {
    fetchFn,
    apiToken: env.PHABRICATOR_API_TOKEN,
    cache: { cacheDir: CACHE_DIR, mode: cli.cacheMode, ttlMs: 30 * 24 * HOUR_MS },
    throttleState: createThrottleState(),
    onCooldown: (durationMs, callsSoFar) => {
      process.stderr.write(
        `  Proactive cooldown: ${Math.round(durationMs / 1000)}s after ${callsSoFar} transaction.search calls.\n`,
      );
    },
  };

  let withAttachments: Array<{ bug: Bug; dNumbers: DNumber[] }> | null = null;
  let uniqueDNumbers: DNumber[];
  let projectInfo: ProjectInfo | null = null;
  let groupPhid: string;
  const seedRevisionMeta = new Map<number, Revision>();

  if (cli.skipBugzilla) {
    process.stderr.write(
      `Resolving Phabricator review group "${module_.reviewGroup}" (with members)...\n`,
    );
    projectInfo = await resolveProjectInfoBySlug(
      phabricatorClient,
      module_.reviewGroup,
    );
    if (!projectInfo) {
      process.stderr.write(
        `  No Phabricator project matched slug "${module_.reviewGroup}". ` +
          `Check that the slug exists on phabricator.services.mozilla.com.\n`,
      );
      return 1;
    }
    if (projectInfo.memberPHIDs.size === 0) {
      process.stderr.write(
        `  Phabricator review group #${module_.reviewGroup} has no members; ` +
          `nothing to filter against.\n`,
      );
      return 1;
    }
    groupPhid = projectInfo.phid as unknown as string;
    process.stderr.write(
      `  Group PHID: ${groupPhid} (${projectInfo.memberPHIDs.size} member(s)).\n`,
    );

    process.stderr.write(
      `Searching Phabricator for revisions where #${module_.reviewGroup} reviewed in the last ${cli.days} day(s)...\n`,
    );
    const revs = await searchRevisionsByReviewer(
      phabricatorClient,
      projectInfo.phid,
      cli.days,
    );
    process.stderr.write(`  ${revs.length} revision(s) found.\n`);
    if (revs.length === 0) {
      process.stderr.write("Nothing to do.\n");
      return 0;
    }
    uniqueDNumbers = revs.map((r) => r.dNumber);
    for (const rev of revs) {
      seedRevisionMeta.set(rev.dNumber as unknown as number, rev);
    }
  } else {
    if (module_.bugzillaComponents.length === 0) {
      process.stderr.write(
        `Module "${module_.name}" has no meta.components in mots.yaml; cannot search Bugzilla.\n`,
      );
      return 1;
    }

    const bugzillaClient: BugzillaClient = {
      fetchFn,
      apiKey: env.BUGZILLA_API_KEY,
      cache: { cacheDir: CACHE_DIR, mode: cli.cacheMode, ttlMs: HOUR_MS },
      concurrency: Math.min(cli.concurrency, 2),
    };

    process.stderr.write(
      `Searching Bugzilla for FIXED bugs in ${module_.bugzillaComponents.length} component(s), last ${cli.days} days...\n`,
    );
    const bugs = await searchFixedBugs(
      bugzillaClient,
      module_.bugzillaComponents,
      cli.days,
    );
    process.stderr.write(`  ${bugs.length} bug(s) found.\n`);
    if (bugs.length === 0) {
      process.stderr.write("Nothing to do.\n");
      return 0;
    }

    const attachmentLimit = pLimit(cli.concurrency);
    process.stderr.write("Fetching attachments...\n");
    withAttachments = await Promise.all(
      bugs.map((bug) =>
        attachmentLimit(async () => {
          const atts = await getAttachments(bugzillaClient, bug.id);
          return { bug, dNumbers: extractPhabricatorDNumbers(atts) };
        }),
      ),
    );

    const dn: DNumber[] = [];
    const seenD = new Set<number>();
    for (const { dNumbers } of withAttachments) {
      for (const d of dNumbers) {
        const n = d as unknown as number;
        if (!seenD.has(n)) {
          seenD.add(n);
          dn.push(d);
        }
      }
    }
    uniqueDNumbers = dn;
    process.stderr.write(`  ${uniqueDNumbers.length} unique Phabricator revision(s).\n`);

    process.stderr.write(
      `Resolving Phabricator review group "${module_.reviewGroup}"...\n`,
    );
    const projectMap = await resolveProjectsBySlugs(phabricatorClient, [
      module_.reviewGroup,
    ]);
    const phid = projectMap.get(module_.reviewGroup);
    if (!phid) {
      process.stderr.write(
        `  No Phabricator project matched slug "${module_.reviewGroup}". ` +
          `Check that the slug exists on phabricator.services.mozilla.com.\n`,
      );
      return 1;
    }
    groupPhid = phid as unknown as string;
    process.stderr.write(`  Group PHID: ${groupPhid}\n`);
  }

  process.stderr.write("Downloading bugbug revisions artifact...\n");
  const artifact = await downloadBugbugArtifact({ cacheDir: CACHE_DIR });
  process.stderr.write(
    `  Artifact published ${artifact.publishedAt.toISOString()}.\n`,
  );

  const wantedIds = new Set(
    uniqueDNumbers.map((d) => d as unknown as number),
  );
  process.stderr.write(
    `Scanning artifact for ${wantedIds.size} revision(s)...\n`,
  );
  const bugbugMatches = await streamRevisionsMatching(
    artifact.zstPath,
    wantedIds,
  );
  const { covered, needsLive } = classifyByBugbugCoverage(
    uniqueDNumbers,
    bugbugMatches,
    artifact.publishedAt,
  );
  process.stderr.write(
    `  ${covered.size} covered by bugbug, ${needsLive.length} need live Phabricator fetch.\n`,
  );

  const bugbugComments = new Map<number, RevisionComments>();
  for (const [id, rev] of covered) {
    bugbugComments.set(id, bugbugToRevisionComments(rev));
  }

  const revisionMeta = new Map<number, Revision>();
  for (const [id, rc] of bugbugComments) {
    revisionMeta.set(id, rc.revision);
  }
  for (const [id, rev] of seedRevisionMeta) {
    if (!revisionMeta.has(id)) {
      revisionMeta.set(id, rev);
    }
  }

  const needLiveMeta: DNumber[] = [];
  for (const d of uniqueDNumbers) {
    const id = d as unknown as number;
    const existing = revisionMeta.get(id);
    if (!existing || existing.reviewerPHIDs.length === 0) {
      needLiveMeta.push(d);
    }
  }
  if (needLiveMeta.length > 0) {
    process.stderr.write(
      `Resolving revisions via Phabricator (reviewer metadata for ${needLiveMeta.length} revision(s))...\n`,
    );
    const liveMap = await resolveRevisionsByIds(
      phabricatorClient,
      needLiveMeta,
    );
    for (const [, rev] of liveMap) {
      revisionMeta.set(rev.dNumber as unknown as number, rev);
    }
  }

  let survivingIds: DNumber[];
  if (cli.skipBugzilla) {
    survivingIds = uniqueDNumbers;
  } else {
    survivingIds = uniqueDNumbers.filter((d) => {
      const rev = revisionMeta.get(d as unknown as number);
      return rev !== undefined && rev.reviewerPHIDs.includes(groupPhid);
    });
    process.stderr.write(
      `  ${survivingIds.length} of ${uniqueDNumbers.length} revision(s) had #${module_.reviewGroup} as a reviewer.\n`,
    );
  }

  const survivingNeedsLive = survivingIds.filter((d) => {
    const id = d as unknown as number;
    return !bugbugComments.has(id);
  });

  const commentsByDNumber = new Map<number, RevisionComments>();
  for (const d of survivingIds) {
    const id = d as unknown as number;
    const cached = bugbugComments.get(id);
    if (cached) {
      commentsByDNumber.set(id, cached);
    }
  }

  if (survivingNeedsLive.length > 0) {
    const commentLimit = pLimit(1);
    process.stderr.write(
      `Fetching comments for ${survivingNeedsLive.length} live revision(s)...\n`,
    );
    const commentList = await Promise.all(
      survivingNeedsLive.map((d) =>
        commentLimit(async () => {
          const rev = revisionMeta.get(d as unknown as number);
          if (!rev) {
            return null;
          }
          return fetchRevisionComments(phabricatorClient, rev);
        }),
      ),
    );
    for (const rc of commentList) {
      if (rc) {
        commentsByDNumber.set(rc.revision.dNumber as unknown as number, rc);
      }
    }
  }

  if (cli.skipBugzilla && projectInfo) {
    for (const [id, rc] of commentsByDNumber) {
      commentsByDNumber.set(
        id,
        filterCommentsByAuthors(rc, projectInfo.memberPHIDs),
      );
    }
  }

  const entries = cli.skipBugzilla
    ? survivingIds
        .map((d) => commentsByDNumber.get(d as unknown as number))
        .filter((rc): rc is RevisionComments => rc !== undefined)
        .map((rc) => ({ bug: null, revisionComments: [rc] }))
    : (withAttachments ?? []).map(({ bug, dNumbers }) => ({
        bug,
        revisionComments: dNumbers
          .map((d) => commentsByDNumber.get(d as unknown as number))
          .filter((rc): rc is RevisionComments => rc !== undefined),
      }));
  const bundle = buildBundle({ module: module_, entries });

  process.stderr.write(
    `Bundle stats: ${bundle.stats.entries} entries, ${bundle.stats.revisions} revisions, ${bundle.stats.inlineComments} inline, ${bundle.stats.generalComments} general.\n`,
  );

  if (bundle.stats.entries === 0) {
    process.stderr.write(
      "No entries with review comments survived filtering. Nothing to synthesize.\n",
    );
    return 0;
  }

  process.stderr.write("Resolving Firefox house style references...\n");
  const corpusPaths: string[] = [];
  for (const rc of commentsByDNumber.values()) {
    for (const inline of rc.inline) {
      if (inline.path) {
        corpusPaths.push(inline.path);
      }
    }
  }
  const docs = await fetchRelevantDocs(
    module_,
    {
      cacheDir: CACHE_DIR,
      mode: cli.cacheMode,
      ttlMs: 30 * 24 * HOUR_MS,
      fetchFn,
    },
    corpusPaths,
  );
  if (docs.length > 0) {
    const titles = docs.map((d) => d.guide.title).join(", ");
    process.stderr.write(`  ${docs.length} reference(s): ${titles}\n`);
  } else {
    process.stderr.write("  no language-specific references matched.\n");
  }

  if (cli.dryRun) {
    process.stderr.write("--dry-run set; skipping Claude synthesis.\n");
    return 0;
  }

  process.stderr.write("Calling Claude Opus 4.7...\n");
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const markdown = await synthesizeSkill(
    bundle,
    slug,
    async (params) => {
      const response = await anthropic.messages.create(
        params as unknown as Parameters<typeof anthropic.messages.create>[0],
      );
      return {
        content: ((response as { content?: unknown }).content ?? []) as Array<{
          type: string;
          text?: string;
        }>,
      };
    },
    docs,
  );

  const outPath = await writeSkill({
    markdown,
    moduleSlug: slug,
    moduleName: unsafeBrand<ModuleName>(module_.name),
    outputDir: cli.outputDir,
  });
  process.stdout.write(`${outPath}\n`);
  return 0;
};
