import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { cachedFetch, type CacheOptions } from "../util/http-cache.ts";
import type { ModuleName } from "../util/brand.ts";

export const MOTS_URL =
  "https://raw.githubusercontent.com/mozilla-firefox/firefox/main/mots.yaml";

const PersonSchema = z.object({
  bmo_id: z.number().nullable().optional(),
  name: z.string().optional().default(""),
  nick: z.string(),
});

const MetaSchema = z
  .object({
    components: z.array(z.string()).optional().default([]),
    review_group: z.string().optional(),
    group: z.string().optional(),
  })
  .partial()
  .nullable()
  .optional();

interface RawModuleEntry {
  name?: string | undefined;
  machine_name?: string | undefined;
  description: string;
  includes: string[];
  excludes: string[];
  owners: z.infer<typeof PersonSchema>[];
  peers: z.infer<typeof PersonSchema>[];
  meta?: z.infer<typeof MetaSchema> | undefined;
  submodules: RawModuleEntry[];
}

const nullableArray = <T extends z.ZodTypeAny>(item: T) =>
  z
    .preprocess(
      (value) => (value === null ? [] : value),
      z.array(item).optional().default([]),
    );

const RawModuleEntrySchema: z.ZodType<RawModuleEntry, z.ZodTypeDef, unknown> =
  z.lazy(() =>
    z.object({
      name: z.string().nullable().optional().transform((v) => v ?? undefined),
      machine_name: z
        .string()
        .nullable()
        .optional()
        .transform((v) => v ?? undefined),
      description: z
        .preprocess(
          (v) => (v === null ? "" : v),
          z.string().optional().default(""),
        ),
      includes: nullableArray(z.string()),
      excludes: nullableArray(z.string()),
      owners: nullableArray(PersonSchema),
      peers: nullableArray(PersonSchema),
      meta: MetaSchema,
      submodules: nullableArray(RawModuleEntrySchema),
    }),
  );

const RawMotsDocSchema = z.object({
  modules: z.array(z.unknown()),
});

export interface Person {
  bmoId: number | null;
  name: string;
  nick: string;
}

export interface BugzillaComponent {
  product: string;
  component: string;
}

export interface Module {
  name: string;
  machineName: string;
  description: string;
  includes: string[];
  excludes: string[];
  bugzillaComponents: BugzillaComponent[];
  owners: Person[];
  peers: Person[];
}

export interface MotsDoc {
  modules: Module[];
}

const parseComponent = (raw: string): BugzillaComponent | null => {
  const match = /^\s*(.+?)\s*::\s*(.+?)\s*$/.exec(raw);
  if (!match) {
    return null;
  }
  return { product: match[1] ?? "", component: match[2] ?? "" };
};

const normalizePerson = (p: z.infer<typeof PersonSchema>): Person => ({
  bmoId: p.bmo_id ?? null,
  name: p.name ?? "",
  nick: p.nick,
});

const flatten = (entries: RawModuleEntry[]): Module[] => {
  const out: Module[] = [];
  for (const entry of entries) {
    const name = entry.name ?? entry.machine_name ?? "";
    if (name) {
      out.push({
        name,
        machineName: entry.machine_name ?? "",
        description: entry.description ?? "",
        includes: entry.includes ?? [],
        excludes: entry.excludes ?? [],
        bugzillaComponents: (entry.meta?.components ?? [])
          .map((c) => parseComponent(c))
          .filter((c): c is BugzillaComponent => c !== null),
        owners: (entry.owners ?? []).map((p) => normalizePerson(p)),
        peers: (entry.peers ?? []).map((p) => normalizePerson(p)),
      });
    }
    if (entry.submodules?.length) {
      out.push(...flatten(entry.submodules));
    }
  }
  return out;
};

export const parseMotsYaml = (yamlText: string): MotsDoc => {
  const raw = parseYaml(yamlText) as unknown;
  const validated = RawMotsDocSchema.parse(raw);
  const entries = validated.modules
    .filter((entry) => entry !== null && typeof entry === "object")
    .map((entry) => RawModuleEntrySchema.parse(entry));
  return { modules: flatten(entries) };
};

export const fetchMotsYaml = async (cache: CacheOptions): Promise<MotsDoc> => {
  const response = await cachedFetch(
    { method: "GET", url: MOTS_URL },
    cache,
  );
  return parseMotsYaml(response.body);
};

const levenshtein = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) {
    return bLen;
  }
  if (bLen === 0) {
    return aLen;
  }
  let previous = Array.from({ length: bLen + 1 }, (_, i) => i);
  for (let i = 1; i <= aLen; i += 1) {
    const current = [i];
    for (let j = 1; j <= bLen; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min(
          (current[j - 1] ?? 0) + 1,
          (previous[j] ?? 0) + 1,
          (previous[j - 1] ?? 0) + cost,
        ),
      );
    }
    previous = current;
  }
  return previous[bLen] ?? 0;
};

export type ResolveResult =
  | { kind: "hit"; module: Module }
  | { kind: "miss"; input: string; suggestions: string[] };

export const resolveModule = (
  doc: MotsDoc,
  input: ModuleName,
): ResolveResult => {
  const needle = input.toLowerCase();
  const exact = doc.modules.find(
    (m) =>
      m.name.toLowerCase() === needle ||
      m.machineName.toLowerCase() === needle,
  );
  if (exact) {
    return { kind: "hit", module: exact };
  }
  const suggestions = [...doc.modules]
    .map((m) => ({ name: m.name, d: levenshtein(m.name.toLowerCase(), needle) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.name);
  return { kind: "miss", input, suggestions };
};
