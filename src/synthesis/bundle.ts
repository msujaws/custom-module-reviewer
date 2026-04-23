import type { Bug } from "../sources/bugzilla.ts";
import type { Module } from "../sources/mots.ts";
import type { RevisionComments } from "../sources/phabricator.ts";

export interface BundleEntry {
  bug: Bug;
  revisionComments: RevisionComments[];
}

export interface BundleInput {
  module: Module;
  entries: BundleEntry[];
}

export interface BundleStats {
  bugs: number;
  revisions: number;
  inlineComments: number;
  generalComments: number;
}

export interface ReviewBundle {
  moduleHeader: string;
  body: string;
  stats: BundleStats;
}

const formatHeader = (module_: Module): string => {
  const components = module_.bugzillaComponents
    .map((c) => `${c.product}::${c.component}`)
    .join(", ");
  const owners = module_.owners.map((p) => p.nick || p.name).join(", ");
  const peers = module_.peers.map((p) => p.nick || p.name).join(", ");
  const paths = module_.includes.join(", ");
  return [
    `# Module: ${module_.name}`,
    module_.description ? `Description: ${module_.description}` : "",
    `Paths: ${paths}`,
    `Bugzilla components: ${components || "(none)"}`,
    `Owners: ${owners || "(none)"}`,
    `Peers: ${peers || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");
};

const keepRevision = (rc: RevisionComments): boolean =>
  rc.inline.length > 0 || rc.general.length > 0;

const sortInline = (a: RevisionComments["inline"][number], b: RevisionComments["inline"][number]): number => {
  if (a.path !== b.path) {
    return a.path.localeCompare(b.path);
  }
  return (a.line ?? 0) - (b.line ?? 0);
};

const formatEntry = (entry: BundleEntry): string => {
  const kept = entry.revisionComments.filter((rc) => keepRevision(rc));
  if (kept.length === 0) {
    return "";
  }
  const revSections = [...kept]
    .sort((a, b) => (a.revision.dNumber as unknown as number) - (b.revision.dNumber as unknown as number))
    .map((rc) => {
      const inlineLines = [...rc.inline].sort(sortInline).map(
        (i) =>
          `  - ${i.path}:${i.line ?? "?"} — ${i.raw.replaceAll(/\s+/g, " ").trim()}`,
      );
      const generalLines = rc.general.map(
        (g) => `  * ${g.raw.replaceAll(/\s+/g, " ").trim()}`,
      );
      const parts = [`  D${rc.revision.dNumber}: ${rc.revision.title}`];
      if (inlineLines.length > 0) {
        parts.push("  Inline comments:", ...inlineLines);
      }
      if (generalLines.length > 0) {
        parts.push("  General comments:", ...generalLines);
      }
      return parts.join("\n");
    });
  return [`Bug ${entry.bug.id}: ${entry.bug.summary}`, ...revSections].join("\n");
};

export const buildBundle = (input: BundleInput): ReviewBundle => {
  const withKept = input.entries
    .map((entry) => ({
      entry,
      keptRevisions: entry.revisionComments.filter((rc) => keepRevision(rc)),
    }))
    .filter((x) => x.keptRevisions.length > 0);

  const sorted = [...withKept].sort(
    (a, b) =>
      (a.entry.bug.id as unknown as number) -
      (b.entry.bug.id as unknown as number),
  );

  const body = sorted
    .map(({ entry }) => formatEntry(entry))
    .filter((s) => s.length > 0)
    .join("\n\n");

  const stats: BundleStats = {
    bugs: withKept.length,
    revisions: withKept.reduce((sum, x) => sum + x.keptRevisions.length, 0),
    inlineComments: withKept.reduce(
      (sum, x) =>
        sum + x.keptRevisions.reduce((s, rc) => s + rc.inline.length, 0),
      0,
    ),
    generalComments: withKept.reduce(
      (sum, x) =>
        sum + x.keptRevisions.reduce((s, rc) => s + rc.general.length, 0),
      0,
    ),
  };

  return {
    moduleHeader: formatHeader(input.module),
    body,
    stats,
  };
};
