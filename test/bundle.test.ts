import { describe, test, expect } from "bun:test";
import { buildBundle } from "../src/synthesis/bundle.ts";
import type { Module } from "../src/sources/mots.ts";
import type { Bug } from "../src/sources/bugzilla.ts";
import type {
  Revision,
  RevisionComments,
} from "../src/sources/phabricator.ts";
import {
  unsafeBrand,
  type BugId,
  type DNumber,
  type RevisionPHID,
  type UserPHID,
} from "../src/util/brand.ts";

const module_: Module = {
  name: "URL Bar",
  machineName: "url_bar",
  description: "Firefox URL bar",
  includes: ["browser/components/urlbar/**/*"],
  excludes: [],
  bugzillaComponents: [{ product: "Firefox", component: "Address Bar" }],
  owners: [{ bmoId: 1, name: "Alice", nick: "alice" }],
  peers: [{ bmoId: 2, name: "Bob", nick: "bob" }],
  reviewGroup: "urlbar-reviewers",
};

const makeBug = (id: number, summary: string): Bug => ({
  id: unsafeBrand<BugId>(id),
  summary,
  product: "Firefox",
  component: "Address Bar",
  resolution: "FIXED",
  lastChangeTime: undefined,
});

const makeRevision = (id: number): Revision => ({
  dNumber: unsafeBrand<DNumber>(id),
  phid: unsafeBrand<RevisionPHID>(`PHID-DREV-${id}`),
  title: `Revision ${id}`,
  authorPHID: unsafeBrand<UserPHID>("PHID-USER-author"),
  url: `https://phab/D${id}`,
  reviewerPHIDs: [],
});

const makeComments = (
  revision: Revision,
  inline: Array<{ path: string; line: number | null; raw: string }>,
  general: string[],
): RevisionComments => ({
  revision,
  inline: inline.map((i) => ({
    path: i.path,
    line: i.line,
    diffId: null,
    authorPHID: unsafeBrand<UserPHID>("PHID-USER-reviewer"),
    raw: i.raw,
  })),
  general: general.map((raw) => ({
    authorPHID: unsafeBrand<UserPHID>("PHID-USER-reviewer"),
    raw,
  })),
});

describe("buildBundle", () => {
  test("drops revisions with no inline or general comments", () => {
    const rev1 = makeRevision(100);
    const rev2 = makeRevision(200);
    const bundle = buildBundle({
      module: module_,
      entries: [
        {
          bug: makeBug(1, "first"),
          revisionComments: [
            makeComments(rev1, [], []),
            makeComments(
              rev2,
              [
                {
                  path: "browser/components/urlbar/UrlbarInput.sys.mjs",
                  line: 1,
                  raw: "nit",
                },
              ],
              [],
            ),
          ],
        },
      ],
    });
    expect(bundle.stats.revisions).toBe(1);
    expect(bundle.body).toContain("D200");
    expect(bundle.body).not.toContain("D100");
  });

  test("drops bugs whose revisions all had zero comments", () => {
    const bundle = buildBundle({
      module: module_,
      entries: [
        {
          bug: makeBug(1, "empty"),
          revisionComments: [makeComments(makeRevision(100), [], [])],
        },
      ],
    });
    expect(bundle.stats.entries).toBe(0);
    expect(bundle.body.trim()).toBe("");
  });

  test("produces stable output across runs (snapshot)", () => {
    const entries = [
      {
        bug: makeBug(2, "second bug"),
        revisionComments: [
          makeComments(
            makeRevision(300),
            [
              {
                path: "browser/components/urlbar/z.sys.mjs",
                line: 5,
                raw: "later",
              },
              {
                path: "browser/components/urlbar/a.sys.mjs",
                line: 2,
                raw: "earlier",
              },
            ],
            ["big picture"],
          ),
        ],
      },
      {
        bug: makeBug(1, "first bug"),
        revisionComments: [
          makeComments(makeRevision(100), [], ["needs tests"]),
        ],
      },
    ];
    const a = buildBundle({ module: module_, entries });
    const b = buildBundle({ module: module_, entries });
    expect(a.body).toBe(b.body);
    expect(a.body.indexOf("Bug 1")).toBeLessThan(a.body.indexOf("Bug 2"));
    expect(a.body.indexOf("/a.sys.mjs")).toBeLessThan(
      a.body.indexOf("/z.sys.mjs"),
    );
  });

  test("moduleHeader is just the module name as a markdown H1", () => {
    const bundle = buildBundle({
      module: module_,
      entries: [
        {
          bug: makeBug(1, "s"),
          revisionComments: [
            makeComments(makeRevision(100), [], ["lgtm"]),
          ],
        },
      ],
    });
    expect(bundle.moduleHeader).toBe("# Module: URL Bar");
    expect(bundle.moduleHeader).not.toContain("browser/components/urlbar");
    expect(bundle.moduleHeader).not.toContain("alice");
    expect(bundle.moduleHeader).not.toContain("urlbar-reviewers");
  });

  test("counts stats correctly", () => {
    const bundle = buildBundle({
      module: module_,
      entries: [
        {
          bug: makeBug(1, "s"),
          revisionComments: [
            makeComments(
              makeRevision(100),
              [
                {
                  path: "browser/components/urlbar/a.sys.mjs",
                  line: 1,
                  raw: "one",
                },
                {
                  path: "browser/components/urlbar/b.sys.mjs",
                  line: 2,
                  raw: "two",
                },
              ],
              ["gen"],
            ),
          ],
        },
      ],
    });
    expect(bundle.stats).toEqual({
      entries: 1,
      revisions: 1,
      inlineComments: 2,
      generalComments: 1,
    });
  });

  test("filters inline comments by module includes/excludes globs", () => {
    const cssOnly: Module = {
      ...module_,
      includes: ["**/*.css"],
      excludes: ["**/vendor/**"],
    };
    const bundle = buildBundle({
      module: cssOnly,
      entries: [
        {
          bug: makeBug(1, "mixed"),
          revisionComments: [
            makeComments(
              makeRevision(100),
              [
                { path: "src/foo.css", line: 1, raw: "css comment" },
                { path: "src/bar.js", line: 2, raw: "js comment" },
                { path: "src/vendor/baz.css", line: 3, raw: "vendor css" },
              ],
              [],
            ),
          ],
        },
      ],
    });
    expect(bundle.stats.inlineComments).toBe(1);
    expect(bundle.body).toContain("foo.css");
    expect(bundle.body).not.toContain("bar.js");
    expect(bundle.body).not.toContain("vendor/baz.css");
  });

  test("keeps revisions whose only signal is a general comment after scoping", () => {
    const cssOnly: Module = {
      ...module_,
      includes: ["**/*.css"],
      excludes: [],
    };
    const bundle = buildBundle({
      module: cssOnly,
      entries: [
        {
          bug: makeBug(1, "general only"),
          revisionComments: [
            makeComments(
              makeRevision(200),
              [{ path: "src/bar.js", line: 1, raw: "out of scope" }],
              ["overall direction is fine"],
            ),
          ],
        },
      ],
    });
    expect(bundle.stats.revisions).toBe(1);
    expect(bundle.stats.inlineComments).toBe(0);
    expect(bundle.stats.generalComments).toBe(1);
    expect(bundle.body).toContain("D200");
    expect(bundle.body).not.toContain("bar.js");
  });

  test("drops revisions where every inline was filtered AND no general comments", () => {
    const cssOnly: Module = {
      ...module_,
      includes: ["**/*.css"],
      excludes: [],
    };
    const bundle = buildBundle({
      module: cssOnly,
      entries: [
        {
          bug: makeBug(1, "all out of scope"),
          revisionComments: [
            makeComments(
              makeRevision(300),
              [{ path: "src/bar.js", line: 1, raw: "out of scope" }],
              [],
            ),
          ],
        },
      ],
    });
    expect(bundle.stats.entries).toBe(0);
    expect(bundle.body.trim()).toBe("");
  });

  test("accepts entries with bug: null and emits revision-only output", () => {
    const bundle = buildBundle({
      module: module_,
      entries: [
        {
          bug: null,
          revisionComments: [
            makeComments(
              makeRevision(500),
              [
                {
                  path: "browser/components/urlbar/x.sys.mjs",
                  line: 1,
                  raw: "nit",
                },
              ],
              [],
            ),
          ],
        },
      ],
    });
    expect(bundle.body).not.toContain("Bug ");
    expect(bundle.body).toContain("D500");
    expect(bundle.stats.entries).toBe(1);
  });

  test("sorts null-bug entries by D-number", () => {
    const bundle = buildBundle({
      module: module_,
      entries: [
        {
          bug: null,
          revisionComments: [
            makeComments(makeRevision(900), [], ["later D"]),
          ],
        },
        {
          bug: null,
          revisionComments: [
            makeComments(makeRevision(100), [], ["earlier D"]),
          ],
        },
      ],
    });
    expect(bundle.body.indexOf("D100")).toBeLessThan(bundle.body.indexOf("D900"));
  });
});
