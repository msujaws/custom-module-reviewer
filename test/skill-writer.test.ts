import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSkill } from "../src/synthesis/skill-writer.ts";
import {
  unsafeBrand,
  type ModuleName,
  type ModuleSlug,
} from "../src/util/brand.ts";

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(path.join(tmpdir(), "skill-writer-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const slug = unsafeBrand<ModuleSlug>("url-bar");
const name = unsafeBrand<ModuleName>("URL Bar");

describe("writeSkill", () => {
  test("writes SKILL.md under <outDir>/<slug>-review/", async () => {
    const skillPath = await writeSkill({
      markdown: "---\nname: url-bar-review\ndescription: x\n---\n\nBody",
      moduleSlug: slug,
      moduleName: name,
      outputDir: outDir,
    });
    expect(skillPath).toBe(path.join(outDir, "url-bar-review", "SKILL.md"));
    expect(readFileSync(skillPath, "utf8")).toContain("Body");
  });

  test("prepends frontmatter when the synthesized markdown does not begin with '---'", async () => {
    const skillPath = await writeSkill({
      markdown: "# URL Bar Review\n\nBody text",
      moduleSlug: slug,
      moduleName: name,
      outputDir: outDir,
    });
    const contents = readFileSync(skillPath, "utf8");
    expect(contents.startsWith("---\n")).toBe(true);
    expect(contents).toContain("name: url-bar-review");
    expect(contents).toContain('description: Module-specific code review guidance for the URL Bar module.');
    expect(contents).toContain("Body text");
  });

  test("strips an outer ```markdown fence and keeps Claude's frontmatter", async () => {
    const skillPath = await writeSkill({
      markdown: "```markdown\n---\nname: url-bar-review\ndescription: Claude-authored specific description\n---\n\nBody text\n```",
      moduleSlug: slug,
      moduleName: name,
      outputDir: outDir,
    });
    const contents = readFileSync(skillPath, "utf8");
    expect(contents.startsWith("---\n")).toBe(true);
    expect(contents).toContain("Claude-authored specific description");
    expect(contents).not.toContain("```markdown");
    expect(contents).not.toContain("Module-specific code review guidance");
  });

  test("does not double-add frontmatter when one is already present", async () => {
    const markdown =
      "---\nname: url-bar-review\ndescription: Something specific\n---\n\nBody";
    const skillPath = await writeSkill({
      markdown,
      moduleSlug: slug,
      moduleName: name,
      outputDir: outDir,
    });
    const contents = readFileSync(skillPath, "utf8");
    const firstMatch = contents.indexOf("---");
    const secondMatch = contents.indexOf("---", firstMatch + 3);
    const thirdMatch = contents.indexOf("---", secondMatch + 3);
    expect(thirdMatch).toBe(-1);
  });
});
