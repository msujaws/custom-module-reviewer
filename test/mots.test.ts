import { describe, test, expect } from "bun:test";
import {
  parseMotsYaml,
  resolveModule,
  fetchMotsYaml,
} from "../src/sources/mots.ts";
import {
  unsafeBrand,
  type ModuleName,
} from "../src/util/brand.ts";
import type { CacheOptions, FetchFn } from "../src/util/http-cache.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const asName = (s: string) => unsafeBrand<ModuleName>(s);

const FIXTURE = `---
modules:
  - name: 'Core: Document Object Model'
    description: DOM core
    machine_name: core_document_object_model
    includes:
      - dom/**/*
    excludes: []
    meta:
      components:
        - Core::DOM
        - 'Core::DOM: Core & HTML'
    owners:
      - bmo_id: 101
        name: Alice Owner
        nick: aowner
    peers:
      - bmo_id: 202
        name: Bob Peer
        nick: bpeer

  - name: firefox-toplevel
    description: Top level
    machine_name: _firefoxtoplevel
    includes:
      - README.md
    owners: []
    peers: []
    submodules:
      - name: Security Architecture
        machine_name: security_architecture
        description: Security reviews
        meta:
          components:
            - 'Testing :: Code Coverage'
        owners:
          - bmo_id: 303
            name: Carol Sec
            nick: csec
        peers: []

  - machine_name: url_bar
    name: URL Bar
    description: The Firefox URL bar
    includes:
      - browser/components/urlbar/**/*
    meta:
      components:
        - 'Firefox::Address Bar'
    owners:
      - bmo_id: 404
        name: Dan UrlBar
        nick: durl
    peers: []
`;

describe("parseMotsYaml", () => {
  test("flattens submodules and extracts components into product/component pairs", () => {
    const doc = parseMotsYaml(FIXTURE);
    const names = doc.modules.map((m) => m.name);
    expect(names).toContain("Core: Document Object Model");
    expect(names).toContain("Security Architecture");
    expect(names).toContain("URL Bar");

    const dom = doc.modules.find(
      (m) => m.name === "Core: Document Object Model",
    )!;
    expect(dom.includes).toEqual(["dom/**/*"]);
    expect(dom.bugzillaComponents).toEqual([
      { product: "Core", component: "DOM" },
      { product: "Core", component: "DOM: Core & HTML" },
    ]);
    expect(dom.owners).toEqual([
      { bmoId: 101, name: "Alice Owner", nick: "aowner" },
    ]);
    expect(dom.peers[0]?.nick).toBe("bpeer");
  });

  test("handles spaces around :: in component strings", () => {
    const doc = parseMotsYaml(FIXTURE);
    const sec = doc.modules.find((m) => m.name === "Security Architecture")!;
    expect(sec.bugzillaComponents).toEqual([
      { product: "Testing", component: "Code Coverage" },
    ]);
  });

  test("defaults optional fields", () => {
    const doc = parseMotsYaml(FIXTURE);
    const urlBar = doc.modules.find((m) => m.name === "URL Bar")!;
    expect(urlBar.excludes).toEqual([]);
    expect(urlBar.peers).toEqual([]);
  });
});

describe("resolveModule", () => {
  test("resolves by name (case-insensitive)", () => {
    const doc = parseMotsYaml(FIXTURE);
    const result = resolveModule(doc, asName("url bar"));
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      expect(result.module.name).toBe("URL Bar");
    }
  });

  test("resolves by machine_name", () => {
    const doc = parseMotsYaml(FIXTURE);
    const result = resolveModule(doc, asName("core_document_object_model"));
    expect(result.kind).toBe("hit");
  });

  test("returns fuzzy suggestions on miss", () => {
    const doc = parseMotsYaml(FIXTURE);
    const result = resolveModule(doc, asName("URL Barr"));
    expect(result.kind).toBe("miss");
    if (result.kind === "miss") {
      expect(result.suggestions).toContain("URL Bar");
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("fetchMotsYaml", () => {
  test("fetches and parses via the injected cache fetcher", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "mots-"));
    try {
      const fetchFn: FetchFn = async () => ({
        status: 200,
        headers: {},
        body: FIXTURE,
        fetchedAt: 0,
      });
      const cache: CacheOptions = {
        cacheDir,
        ttlMs: 60_000,
        mode: "normal",
        fetchFn,
      };
      const doc = await fetchMotsYaml(cache);
      expect(doc.modules.length).toBeGreaterThan(0);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
