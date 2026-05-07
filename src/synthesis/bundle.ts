import picomatch from "picomatch";
import type { Bug } from "../sources/bugzilla.ts";
import type { Module } from "../sources/mots.ts";
import type {
  InlineComment,
  RevisionComments,
} from "../sources/phabricator.ts";

export interface BundleEntry {
  bug: Bug | null;
  revisionComments: RevisionComments[];
}

export interface BundleInput {
  module: Module;
  entries: BundleEntry[];
}

export interface BundleStats {
  entries: number;
  revisions: number;
  inlineComments: number;
  generalComments: number;
}

export interface ReviewBundle {
  moduleHeader: string;
  body: string;
  stats: BundleStats;
}

const formatHeader = (module_: Module): string =>
  `# Module: ${module_.name}`;

type PathMatcher = (path: string) => boolean;

const buildScopeMatcher = (module_: Module): PathMatcher => {
  if (module_.includes.length === 0) {
    return () => true;
  }
  const matcher = picomatch(module_.includes, {
    ignore: module_.excludes,
    dot: true,
  });
  return (path: string): boolean => {
    if (!path) {
      return false;
    }
    return matcher(path);
  };
};

const filterInlineByScope = (
  inline: InlineComment[],
  matches: PathMatcher,
): InlineComment[] => inline.filter((i) => matches(i.path));

const sortInline = (a: InlineComment, b: InlineComment): number => {
  if (a.path !== b.path) {
    return a.path.localeCompare(b.path);
  }
  return (a.line ?? 0) - (b.line ?? 0);
};

interface ScopedRevision {
  revision: RevisionComments["revision"];
  inline: InlineComment[];
  general: RevisionComments["general"];
}

const scopeRevision = (
  rc: RevisionComments,
  matches: PathMatcher,
): ScopedRevision => ({
  revision: rc.revision,
  inline: filterInlineByScope(rc.inline, matches),
  general: rc.general,
});

const keepScoped = (rc: ScopedRevision): boolean =>
  rc.inline.length > 0 || rc.general.length > 0;

const formatEntry = (
  entry: BundleEntry,
  scoped: ScopedRevision[],
): string => {
  if (scoped.length === 0) {
    return "";
  }
  const revSections = [...scoped]
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
  if (entry.bug === null) {
    return revSections.join("\n");
  }
  return [`Bug ${entry.bug.id}: ${entry.bug.summary}`, ...revSections].join("\n");
};

export const buildBundle = (input: BundleInput): ReviewBundle => {
  const matches = buildScopeMatcher(input.module);

  const withKept = input.entries
    .map((entry) => ({
      entry,
      keptRevisions: entry.revisionComments
        .map((rc) => scopeRevision(rc, matches))
        .filter((rc) => keepScoped(rc)),
    }))
    .filter((x) => x.keptRevisions.length > 0);

  const sortKey = (x: typeof withKept[number]): [number, number] => {
    const bugId = x.entry.bug
      ? (x.entry.bug.id as unknown as number)
      : Number.POSITIVE_INFINITY;
    const dNumber = x.keptRevisions[0]?.revision.dNumber as unknown as number ?? 0;
    return [bugId, dNumber];
  };
  const sorted = [...withKept].sort((a, b) => {
    const [aBug, aD] = sortKey(a);
    const [bBug, bD] = sortKey(b);
    if (aBug !== bBug) return aBug - bBug;
    return aD - bD;
  });

  const body = sorted
    .map(({ entry, keptRevisions }) => formatEntry(entry, keptRevisions))
    .filter((s) => s.length > 0)
    .join("\n\n");

  const stats: BundleStats = {
    entries: withKept.length,
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
