# custom-module-reviewer

Generate module-specific Claude Code review skills from Bugzilla + Phabricator history.

Given a Firefox module name and a lookback window, this CLI:

1. Resolves the module's file path globs and Bugzilla components from `mots.yaml` (mozilla-central).
2. Finds bugs resolved FIXED in that module's components within the last N days (Bugzilla REST).
3. Fetches review comments (inline + general) from the attached Phabricator revisions (Conduit API).
4. Synthesizes a module-specific code review skill via Claude Opus 4.7.
5. Writes `output/<slug>-review/SKILL.md` — a shareable artifact for team review.

## Setup

```bash
bun install
cp .env.example .env   # fill in BUGZILLA_API_KEY, PHABRICATOR_API_TOKEN, ANTHROPIC_API_KEY
```

## Usage

```bash
bun run start --module "DOM: Core & HTML" --days 90
bun run start --module "URL Bar" --days 30 --dry-run   # skip Claude call, just gather data
```

Flags: `--module <name>`, `--days <N>` (default 90), `--output-dir <path>` (default `./output`),
`--dry-run`, `--no-cache`, `--refresh`, `--concurrency <n>`.

## Development

```bash
bun run check          # lint + typecheck + tests with coverage (≥60%)
bun run lint
bun run typecheck
bun test --coverage
```

TDD: every production file has a spec landed in the same commit. Coverage floor is 60% on
lines/functions/statements.
