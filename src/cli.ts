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
  type BugzillaClient,
} from "./sources/bugzilla.ts";
import {
  fetchRevisionComments,
  resolveRevisionsByIds,
  type PhabricatorClient,
  type RevisionComments,
} from "./sources/phabricator.ts";
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
}

const parseOptions = (argv: string[]): CliOptions => {
  const program = new Command();
  program
    .name("custom-module-reviewer")
    .requiredOption("--module <name>", "Module name or machine_name from mots.yaml")
    .option("--days <n>", "Lookback window in days", "90")
    .option("--output-dir <path>", "Output directory", "./output")
    .option("--dry-run", "Skip the Claude synthesis step", false)
    .option("--no-cache", "Disable HTTP cache (read+write)")
    .option("--refresh", "Ignore cached entries but write new ones", false)
    .option("--concurrency <n>", "Parallel API calls", "4");
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
  };
};

export const run = async (argv: string[]): Promise<number> => {
  const cli = parseOptions(argv);
  const env = loadEnv(process.env, { dryRun: cli.dryRun });

  const fetchFn = retryingFetcher(realFetcher);
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
  const withAttachments = await Promise.all(
    bugs.map((bug) =>
      attachmentLimit(async () => {
        const atts = await getAttachments(bugzillaClient, bug.id);
        return { bug, dNumbers: extractPhabricatorDNumbers(atts) };
      }),
    ),
  );

  const uniqueDNumbers: DNumber[] = [];
  const seenD = new Set<number>();
  for (const { dNumbers } of withAttachments) {
    for (const d of dNumbers) {
      const n = d as unknown as number;
      if (!seenD.has(n)) {
        seenD.add(n);
        uniqueDNumbers.push(d);
      }
    }
  }
  process.stderr.write(`  ${uniqueDNumbers.length} unique Phabricator revision(s).\n`);

  const phabricatorClient: PhabricatorClient = {
    fetchFn,
    apiToken: env.PHABRICATOR_API_TOKEN,
  };

  process.stderr.write("Resolving revisions...\n");
  const revisionMap = await resolveRevisionsByIds(
    phabricatorClient,
    uniqueDNumbers,
  );
  process.stderr.write(`  ${revisionMap.size} revision(s) resolved.\n`);

  const commentLimit = pLimit(cli.concurrency);
  process.stderr.write("Fetching comments...\n");
  const commentList = await Promise.all(
    [...revisionMap.values()].map((rev) =>
      commentLimit(() => fetchRevisionComments(phabricatorClient, rev)),
    ),
  );

  const commentsByDNumber = new Map<number, RevisionComments>(
    commentList.map((rc) => [
      rc.revision.dNumber as unknown as number,
      rc,
    ]),
  );

  const entries = withAttachments.map(({ bug, dNumbers }) => ({
    bug,
    revisionComments: dNumbers
      .map((d) => commentsByDNumber.get(d as unknown as number))
      .filter((rc): rc is RevisionComments => rc !== undefined),
  }));
  const bundle = buildBundle({ module: module_, entries });

  process.stderr.write(
    `Bundle stats: ${bundle.stats.bugs} bugs, ${bundle.stats.revisions} revisions, ${bundle.stats.inlineComments} inline, ${bundle.stats.generalComments} general.\n`,
  );

  if (bundle.stats.bugs === 0) {
    process.stderr.write(
      "No bugs with review comments survived filtering. Nothing to synthesize.\n",
    );
    return 0;
  }

  if (cli.dryRun) {
    process.stderr.write("--dry-run set; skipping Claude synthesis.\n");
    return 0;
  }

  process.stderr.write("Calling Claude Opus 4.7...\n");
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const markdown = await synthesizeSkill(bundle, slug, async (params) => {
    const response = await anthropic.messages.create(
      params as unknown as Parameters<typeof anthropic.messages.create>[0],
    );
    return {
      content: ((response as { content?: unknown }).content ?? []) as Array<{
        type: string;
        text?: string;
      }>,
    };
  });

  const outPath = await writeSkill({
    markdown,
    moduleSlug: slug,
    moduleName: unsafeBrand<ModuleName>(module_.name),
    outputDir: cli.outputDir,
  });
  process.stdout.write(`${outPath}\n`);
  return 0;
};
