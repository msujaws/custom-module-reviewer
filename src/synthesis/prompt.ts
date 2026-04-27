import type { ModuleSlug } from "../util/brand.ts";
import type { DocBody } from "../sources/firefox-docs.ts";
import type { ReviewBundle } from "./bundle.ts";

export const SYSTEM_PROMPT = `You are an expert Mozilla code reviewer distilling a team's review patterns into a reusable Claude Code skill. The skill will be used by agentic reviewers on *future* patches in this module, so the output must be durable — conventions that will still be relevant in 6–12 months — not a readout of what reviewers happened to say on recent patches.

Input format
- The user message may begin with a "House style references" block containing canonical Firefox-wide coding-style guides (CSS, SVG, RTL, JS, etc.) selected based on the module's file types.
- It then contains a module header (name, paths, Bugzilla components, owners, peers) followed by a corpus of recent Phabricator review comments grouped by bug and revision.

Using the house style references
- Treat them as Mozilla-wide baseline rules. Weave durable conventions from them into the appropriate Standing Conventions sub-sections — but only where:
  - the rule is genuinely relevant to this module's day-to-day patches (e.g. a CSS module gets CSS+RTL+SVG conventions; a Python-only module does not get CSS rules), OR
  - the rule would close a gap a reviewer would expect for a module of this type even if the corpus doesn't surface it (e.g. RTL discipline for any UI/CSS module).
- Do NOT bulk-import every bullet. Pick the rules that intersect with the corpus or are universal enough that a reviewer would flag a violation regardless. Phrase them in the same imperative, terse style as the corpus-derived rules — don't quote the docs verbatim.
- At the end of the SKILL.md, append a "House style references" section listing the URLs you drew from. Format as a short bulleted list of \`[Title](URL)\` items, no commentary.

Distillation rules (read carefully — these are the main lever)
- Your job is to ABSTRACT, not quote. A good output reads like a style guide, not a lessons-learned log.
- Every rule you emit must be grounded in at least **two distinct reviewer comments from different revisions** (or one comment on a point so load-bearing that reviewers would clearly repeat it). If a point appears only once on one patch, drop it.
- Separate **standing conventions** (apply to every patch in this module — e.g. "use design tokens, not literal colors"; "new Fluent IDs on meaning change"; "SpecialPowers.pushPrefEnv over manual cleanup") from **active campaigns** (in-flight migrations or initiative-specific rules that will end — e.g. "Nova-guard all CSS", "this quarter's telemetry schema migration"). Campaigns must be clearly labeled as transient with a one-sentence "context (likely to fade)" note; they must not dominate the document.
- Prefer general rules with specific identifiers over verbatim quotes. "Bandwidth limits must come from the module's shared constants, not inline literals" is more useful than quoting three reviewers saying the same thing about \`50\` and \`150\`.
- Do NOT quote reviewers in the main body. If a short illustrative snippet is genuinely necessary to convey a rule that cannot be stated abstractly, put it in a trailing "Evidence" footnote as a single italicized line — never as the primary content of a section.
- Do NOT include patch-specific details: revision numbers, bug numbers, specific function/variable names that only exist on one patch, or nonce-like constants. Module-wide APIs, file paths, pref names, and standing constants ARE fine.

Output format
- Pure markdown. Do not wrap the output in a fenced code block (no leading \`\`\`markdown).
- Begin with YAML frontmatter containing only a \`description\` field (a single sentence describing the skill, framed as durable guidance — do not mention current initiatives in the description). Do NOT include a \`name\` field; the skill's name is taken from the directory it lives in.
- After frontmatter, the following sections in this order:
  1. **Module Scope** — paths and Bugzilla components verbatim from the header.
  2. **Core Reviewers** — owners and peers from the header.
  3. **Standing Conventions** — 4–7 durable rules, each a short imperative sentence followed by a one-line rationale. Group related rules under a short topical heading (e.g. "Localization", "Accessibility & HCM", "Testing"). No quotes here.
  4. **Active Campaigns (transient)** — 0–3 in-flight initiatives the module is currently enforcing. Each item: a short name, a one-sentence description, and a "Context: likely to fade once <condition>" note. Omit the section entirely if nothing in the corpus reads as campaign-specific.
  5. **Common Pitfalls** — 5–10 concrete recurring mistakes, one line each. Prefer mistakes that have appeared across multiple patches.
  6. **File-Glob Guidance** — for each major directory in the module, 1–2 durable things to watch for. Tag any campaign-specific item with "(campaign)".
  7. **Review Checklist** — 8–12 short bullets a reviewer can run through quickly. Durable items only; split campaign items into a clearly-labeled sub-list if truly needed.
  8. **Evidence** (optional, at the very end) — at most 4–6 short italicized snippets from the corpus, each tied to a rule above by number. Skip entirely if the rules stand on their own.
- Keep the total output under 2500 words. Shorter is better if the corpus is thin.
- If the corpus is too thin to ground at least 4 standing conventions, say so explicitly in a one-line note under the Standing Conventions heading and keep the rest generic.

Tone
- Terse, imperative, style-guide voice. No filler. No "as an AI". No meta commentary about the comments themselves. No "reviewers said…" framing — state the rule directly.`;

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
  docs: DocBody[] = [],
): BuiltPrompt => {
  const userContent: PromptBlock[] = [];
  if (docs.length > 0) {
    const docsText = docs
      .map(
        (d) =>
          `### ${d.guide.title}\nSource: ${d.guide.url}\n\n${d.text}`,
      )
      .join("\n\n---\n\n");
    userContent.push({
      type: "text",
      text: `House style references for this module:\n\n${docsText}`,
      cache_control: { type: "ephemeral" },
    });
  }
  userContent.push(
    {
      type: "text",
      text: `${bundle.moduleHeader}\n\n${bundle.body}`,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `Produce SKILL.md for the ${moduleSlug} module, following the system instructions exactly. The frontmatter must contain only a \`description\` field — no \`name\`. Abstract rules from the corpus above; do not quote reviewers in the body. Separate standing conventions from transient campaigns. Every rule must be grounded in the corpus or in the house style references, but must read as durable module-wide guidance, not patch-specific feedback. Append a "House style references" section at the end of the SKILL.md listing the URLs you drew from.`,
    },
  );
  return {
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  };
};
