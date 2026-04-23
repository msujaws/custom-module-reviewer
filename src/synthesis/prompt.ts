import type { ModuleSlug } from "../util/brand.ts";
import type { ReviewBundle } from "./bundle.ts";

export const SYSTEM_PROMPT = `You are an expert Mozilla code reviewer distilling a team's review patterns into a reusable Claude Code skill.

Input format
- The user message contains a module header (name, paths, Bugzilla components, owners, peers) followed by a corpus of recent Phabricator review comments grouped by bug and revision.

Output format
- Pure markdown. Begin with YAML frontmatter containing \`name\` (the slug provided by the user, with \`-review\` appended) and \`description\` (a single sentence describing the skill).
- After frontmatter, the following sections in this order:
  1. **Module Scope** — paths and Bugzilla components verbatim from the header.
  2. **Core Reviewers** — owners and peers from the header.
  3. **Recurring Review Patterns** — 3-6 themes, each with a short name, a 1-2 sentence description, and 2-3 short quoted examples drawn directly from the comment corpus. Preserve the reviewer's voice; do not paraphrase into generic advice.
  4. **Common Pitfalls** — concrete mistakes reviewers flagged more than once.
  5. **File-Glob Guidance** — for each major directory in the module, what to pay particular attention to.
  6. **Review Checklist** — a short bullet list a reviewer can run through quickly.
- Keep the total output under 3000 words.
- Do not invent review patterns that are not grounded in the provided comments. If the corpus is thin, say so and keep the checklist generic.

Tone
- Terse. No filler. No "as an AI". No meta commentary about the comments themselves.`;

export interface PromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface BuiltPrompt {
  system: PromptBlock[];
  messages: Array<{
    role: "user";
    content: PromptBlock[];
  }>;
}

export const buildPrompt = (
  bundle: ReviewBundle,
  moduleSlug: ModuleSlug,
): BuiltPrompt => ({
  system: [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${bundle.moduleHeader}\n\n${bundle.body}`,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: `Produce SKILL.md with \`name: ${moduleSlug}-review\` in frontmatter, following the system instructions exactly. Ground every quoted example in the comment corpus above.`,
        },
      ],
    },
  ],
});
