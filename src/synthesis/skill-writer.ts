import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModuleName, ModuleSlug } from "../util/brand.ts";

export interface WriteSkillOptions {
  markdown: string;
  moduleSlug: ModuleSlug;
  moduleName: ModuleName;
  outputDir: string;
}

const FENCE_PATTERN = /^```[a-z]*\n([\S\s]*?)\n```\s*$/i;

const stripOuterFence = (markdown: string): string => {
  const match = FENCE_PATTERN.exec(markdown.trim());
  return match ? (match[1] ?? markdown) : markdown;
};

const ensureFrontmatter = (
  markdown: string,
  slug: ModuleSlug,
  name: ModuleName,
): string => {
  const unwrapped = stripOuterFence(markdown).trimStart();
  if (unwrapped.startsWith("---\n")) {
    return unwrapped;
  }
  const frontmatter = [
    "---",
    `name: ${slug}-review`,
    `description: Module-specific code review guidance for the ${name} module.`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}\n${unwrapped}`;
};

export const writeSkill = async (
  options: WriteSkillOptions,
): Promise<string> => {
  const skillDir = path.join(options.outputDir, `${options.moduleSlug}-review`);
  await mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  const contents = ensureFrontmatter(
    options.markdown,
    options.moduleSlug,
    options.moduleName,
  );
  await writeFile(skillPath, contents, "utf8");
  return skillPath;
};
