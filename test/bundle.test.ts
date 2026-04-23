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
            makeComments(rev2, [{ path: "a.ts", line: 1, raw: "nit" }], []),
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
    expect(bundle.stats.bugs).toBe(0);
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
              { path: "z.ts", line: 5, raw: "later" },
              { path: "a.ts", line: 2, raw: "earlier" },
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
    expect(a.body.indexOf("a.ts")).toBeLessThan(a.body.indexOf("z.ts"));
  });

  test("moduleHeader contains module scope info", () => {
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
    expect(bundle.moduleHeader).toContain("URL Bar");
    expect(bundle.moduleHeader).toContain("browser/components/urlbar");
    expect(bundle.moduleHeader).toContain("Firefox::Address Bar");
    expect(bundle.moduleHeader).toContain("alice");
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
                { path: "a.ts", line: 1, raw: "one" },
                { path: "b.ts", line: 2, raw: "two" },
              ],
              ["gen"],
            ),
          ],
        },
      ],
    });
    expect(bundle.stats).toEqual({
      bugs: 1,
      revisions: 1,
      inlineComments: 2,
      generalComments: 1,
    });
  });
});
