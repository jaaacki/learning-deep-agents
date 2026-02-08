# Changelog

> **Versioning plan:** Patch bumps per issue, minor bumps at phase milestones.
> See LEARNING_LOG.md Entry 8 for the full dependency map and version targets.
>
> v0.2.0 = Phase 1 (Code Awareness) | v0.3.0 = Phase 2 + 3 (Safety + CLI/Tests)
> v0.4.0 = Phase 4 (Intelligence) | v0.5.0 = Phase 5 (Resilience) | v0.6.0 = Phase 6 (Webhooks)
> v0.7.0 = Phase 7 (Deployment) | v1.0.0 = Phase 8 (Reviewer Bot)

---

## v0.4.0 — 2026-02-08

**Milestone: Phase 4 (Intelligence) complete.** Issues go through triage (cheap/fast) then deep analysis (thorough) with triage context passed through.

### Changed
- **Triage-to-analysis handoff** (Issue #4) — triage results are now passed to the analysis agent as context
- `buildUserMessage()` accepts optional `triageResults` parameter (5th argument)
- When triage context is available, the user message includes issue type, complexity, relevant files, and summary
- `PollState` gains optional `triageResults` field to persist triage data across runs
- `runPollCycle()` collects triage results and passes them to `buildUserMessage()`, also saves them in poll state
- System prompt in `agent.ts` updated to instruct the agent to use triage context (skip `list_repo_files` when triage already identified relevant files)
- 13 new tests for triage-to-analysis handoff in `tests/core.test.ts`

---

## v0.3.7 — 2026-02-08

### Changed
- **Enriched action tracking metadata** (Issue #31) — `IssueActions` now stores full API response metadata instead of simple booleans
- `comment` field: `{ id, html_url }` (was `commented: boolean`)
- `branch` field: `{ name, sha }` (was `branch: string | null`)
- `commits` field: `Array<{ path, sha, commit_sha }>` (new)
- `pr` field: `{ number, html_url }` (was `pr: number | null`)
- `extractIssueActions()` now correlates tool calls with responses using pending-state tracking
- `migratePollState()` handles 3 format generations: pre-v0.2.10, v0.2.10 boolean, v0.3.7+ enriched
- `buildUserMessage()` and `showStatus()` updated to use enriched field names
- 12 new enriched metadata tests + existing tests updated

---

## v0.3.6 — 2026-02-08

### Added
- **Graceful shutdown** (Issue #22) — SIGTERM/SIGINT handlers save poll state before exiting
- `requestShutdown()`, `isShuttingDown()`, `resetShutdown()` exported from `src/core.ts`
- Signal handlers registered in both `src/index.ts` and `src/cli.ts`
- Shutdown checks at three points in `runPollCycle()`: between triage iterations, after triage phase, before analysis phase
- 4 new unit tests in `tests/core.test.ts` (`describe('graceful shutdown', ...)`)

### Changed
- `process.exit(1)` replaced with `process.exitCode = 1` in entry point error handlers (allows pending I/O to flush)
- `process.exit(2)` replaced with `process.exitCode = 2` for circuit breaker exit (same rationale)

---

## v0.3.5 — 2026-02-08

### Added
- **HTTP webhook listener** (Issue #12) — Express server to receive GitHub webhook events
- New `src/listener.ts` with `createWebhookApp()` and `startWebhookServer()` factories
- POST `/webhook` endpoint with HMAC-SHA256 signature verification (`X-Hub-Signature-256`)
- GET `/health` health check endpoint
- Event type parsing from `X-GitHub-Event` header with delivery ID tracking
- `webhook` config section: `{ port, secret }` with validation in `config.ts`
- `deepagents webhook` CLI subcommand to start the listener
- `pnpm webhook` script shorthand
- 20 new unit tests (15 listener + 5 config) covering signature verification, endpoint behavior, config validation
- `express` added as production dependency, `@types/express` as dev dependency

### Changed
- `config.json.example` updated with `webhook` section placeholder

---

## v0.3.4 — 2026-02-08

### Added
- **Retry with exponential backoff** (Issue #17) — all GitHub API calls now retry on transient failures
- New `src/utils.ts` with `withRetry()` utility, `isRetryableError()` classifier, `getRetryAfterMs()` helper
- Retries on: HTTP 5xx, 429 (rate limit with Retry-After header), network errors (ECONNRESET, ETIMEDOUT, etc.)
- Does NOT retry 4xx client errors (except 429)
- Default: 3 retries with exponential backoff (1s, 2s, 4s)
- All Octokit API calls in `github-tools.ts` wrapped with `withRetry()`
- 18 new tests in `tests/utils.test.ts`

### Changed
- `tests/github-tools.test.ts` branch error test uses 403 (non-retryable) instead of 500

---

## v0.3.3 — 2026-02-08

### Added
- **Structured logging for tool calls** (Issue #33) — every tool invocation logs name, arguments, timing, and circuit breaker headroom
- New `src/logger.ts` with `wrapWithLogging()` composable wrapper function
- Log format: `[HH:MM:SS] TOOL #N/M | tool_name | { args } | Xms`
- Errors logged to stderr with context before re-throwing
- 9 new unit tests in `tests/logger.test.ts`

### Changed
- `src/agent.ts` applies logging wrapper as outermost layer on all 7 tools
- `src/triage-agent.ts` applies logging wrapper on all 3 read-only tools

---

## v0.3.2 — 2026-02-08

### Added
- **Triage agent** (Issue #3) — first phase of the two-phase agent pipeline
- New `src/triage-agent.ts` with `createTriageAgent()` factory, read-only tools only
- `TriageOutput` interface: issueType, complexity, relevantFiles, shouldAnalyze, skipReason, summary
- `parseTriageOutput()` parses LLM JSON response with validation and fallback
- `triageLlm` optional config field for using a cheaper model for triage
- `deepagents triage --issue N` CLI subcommand for standalone triage
- Triage pre-filter wired into `runPollCycle()` — issues are triaged before full analysis
- `fetchSingleIssue()` and `runTriageSingle()` exported from core for reuse
- 24 new unit tests (19 triage + 5 config) — total 113

### Changed
- `runPollCycle()` now fetches issues and runs triage before invoking the analysis agent
- `config.json.example` updated with `triageLlm` field placeholder

---

## v0.3.1 — 2026-02-08

### Added
- **`create_or_update_file` tool** (Issue #25) — commits files to branches via GitHub Contents API
- Agent can now push proposed code changes to feature branches, producing PRs with actual diffs
- Dry-run stub for the new tool
- Circuit breaker wraps the new tool
- **Self-review step** (Issue #27) — agent reads back committed files and sanity-checks before opening PR
- Agent workflow expanded from 5 to 7 steps: analyze → comment → document → branch → commit → self-review → PR

### Changed
- System prompt updated with code quality guidelines (soft, not hard constraints)
- Agent now produces PRs with real file changes instead of empty branches

---

## v0.3.0 — 2026-02-08

**Milestone: Phase 2 (Safety & Idempotency) + Phase 3 (CLI & Testing) complete.**

The bot is now safe for unattended operation. All write operations are idempotent, resource usage is bounded, and there's a CLI for development and debugging with 67 unit tests.

### Phase 2 — Safety & Idempotency (Issues #5, #6, #7, #8, #9, #10, #11)
- Max issues per run — code-enforced in tool constructor
- Duplicate comment prevention via HTML marker detection
- Duplicate branch prevention via getRef check
- Duplicate PR prevention via pulls.list check
- Circuit breaker — kills run after N tool calls
- True --dry-run mode — swaps write tools with logging stubs
- Per-issue action tracking in poll state with migration
- Cron lock file in poll.sh

### Phase 3 — CLI & Testing (Issues #23, #24)
- CLI wrapper with subcommands: poll, analyze, status, dry-run, help
- Core logic extracted to src/core.ts
- 67 unit tests across 4 files (vitest)

---

## v0.2.10 — 2026-02-08

### Added
- **Per-issue action tracking** (Issue #11) — poll state now records which workflow steps completed per issue
- `IssueActions` interface: `{ commented, branch, pr }` per issue number
- `extractIssueActions()` scans agent tool calls to build action records
- `migratePollState()` upgrades old poll state format (no `issues` field) to new format
- Agent message includes partially-processed issue status so it can resume incomplete work
- `deepagents status` now shows per-issue action breakdown

### Changed
- `PollState` interface adds optional `issues` field (backwards-compatible)
- `buildUserMessage()` accepts optional `issueActions` parameter
- `showStatus()` displays per-issue action details and maxToolCallsPerRun

## v0.2.9 — 2026-02-08

### Added
- **Circuit breaker** (Issue #6) — caps total tool calls per agent run to prevent runaway loops
- `maxToolCallsPerRun` config option (default: 30)
- `--max-tool-calls N` CLI flag to override at runtime
- `ToolCallCounter` class with shared counter across all tools
- `wrapWithCircuitBreaker()` utility wraps any LangChain tool with counting
- `CircuitBreakerError` custom error class with `callCount` and `callLimit` properties
- Agent saves poll state before exiting on circuit break (partially-processed issues are preserved)
- Process exits with code 2 when circuit breaker trips (distinguishable from normal errors)

## v0.2.8 — 2026-02-08

### Added
- **True dry-run mode** (Issue #7) — `--dry-run` flag skips all GitHub write operations
- Dry-run tool wrappers for `comment_on_issue`, `create_branch`, `create_pull_request`
- Write tools log what they WOULD do and return fake success (`{ dry_run: true }`)
- Read tools (`fetch_github_issues`, `list_repo_files`, `read_repo_file`) still execute normally
- Local file writes (`write_file` for `./issues/`) still execute normally
- Poll state is NOT saved in dry-run mode

### Changed
- `--no-save` and `--dry-run` are now separate flags (`--dry-run` implies `--no-save`)
- `runPollCycle` options split into `noSave` (skip state save) and `dryRun` (skip GitHub writes + state save)

## v0.2.7 — 2026-02-08

### Changed
- **Cron lock file** — `poll.sh` now uses `mkdir`-based lock to prevent overlapping cron runs
- **maxIssuesPerRun enforced in tool** — `fetch_github_issues` now clamps the `limit` parameter to `maxIssuesPerRun` at the code level, not just in the prompt

## v0.2.6 — 2026-02-08

### Added
- **Test infrastructure** (Issue #23) — vitest setup with unit tests for all modules
- `vitest` added as dev dependency with `vitest.config.ts`
- `pnpm test` runs all tests, `pnpm run test:watch` for watch mode
- 4 test files covering: `core.ts`, `github-tools.ts`, `model.ts`, `config.ts`
- Mock patterns: Octokit mock factory, `vi.mock` for LLM constructors, `fs` spies, `process.exit` interception
- Tests cover: idempotency logic (comment/branch/PR), config validation, provider routing, pure functions, file truncation

## v0.2.5 — 2026-02-08

### Added
- **CLI wrapper** (Issue #24) — proper subcommand interface for all agent operations
- New `src/cli.ts` entry point with subcommands: `poll`, `analyze`, `status`, `help`
- New `src/core.ts` extracts reusable functions from `index.ts` (shared by both entry points)
- `--dry-run` flag for poll command (no poll state written)
- `--max-issues N` flag to override config at runtime
- `--issue N` flag for single-issue analysis (`deepagents analyze --issue 42`)
- `dry-run` shorthand command (equivalent to `poll --dry-run`)
- `bin` field in package.json for CLI usage
- `pnpm run cli` script for development

### Changed
- `src/index.ts` is now a thin backwards-compatible wrapper that delegates to `core.ts`
- `maxIssuesPerRun` validated with type check and positivity guard (addresses Critic Finding #7)

## v0.2.4 — 2026-02-08

### Changed
- **Prevent duplicate PRs** (Issue #10) — `create_pull_request` is now idempotent
- Checks for existing open PR on the same head branch before creating
- Returns `{ skipped: true }` with existing PR URL if one already exists

## v0.2.3 — 2026-02-08

### Changed
- **Prevent duplicate branches** (Issue #9) — `create_branch` is now idempotent
- Checks if branch already exists before creating (uses `getRef` with 404 detection)
- Returns `{ skipped: true }` with branch URL if branch already exists

## v0.2.2 — 2026-02-08

### Changed
- **Prevent duplicate comments** (Issue #8) — `comment_on_issue` is now idempotent
- Checks for existing bot comment (hidden HTML marker) before posting
- Returns `{ skipped: true }` if analysis comment already exists
- Uses `<!-- deep-agent-analysis -->` marker pattern (standard in GitHub bots)

## v0.2.1 — 2026-02-08

### Added
- **Max issues per run** (Issue #5) — caps how many issues the agent processes per invocation
- `maxIssuesPerRun` config option in `config.json` (default: 5)
- Limit displayed at startup for operator visibility

### Changed
- User message to the agent now includes the issue limit explicitly

## v0.2.0 — 2026-02-08 — Phase 1 Complete: Code Awareness

**Milestone:** The agent can now read actual source code, not just issue descriptions. Analysis quality jumps from guessing to code-aware.

### Phase 1 Summary
- Two new read-only tools give the agent full codebase visibility
- `list_repo_files` traverses Git's object model (ref -> commit -> tree) to enumerate all files
- `read_repo_file` uses the Content API to fetch and decode individual file contents
- Together they enable the **browse-then-read** pattern: list files, identify relevant ones, read them
- See LEARNING_LOG Entries 9-11 for the full teaching narrative and Critic review

### Added (v0.1.2)
- **`list_repo_files` tool** (Issue #1) — lists all files in the repository with path and size info
- Path prefix filtering (e.g., `"src/"` to list only source files)
- Branch parameter for listing files on non-default branches
- Truncation warning when GitHub API truncates large repos

### Added (v0.1.3)
- **`read_repo_file` tool** (Issue #2) — reads a single file's contents from the repository
- Decodes base64 content from GitHub API to UTF-8 text
- Returns file path, size, SHA, and full content
- Files over 500 lines are truncated with metadata (prevents LLM context flooding)
- Handles edge cases: directories, symlinks, files over 1MB

### Changed
- System prompt updated to guide the agent to list and read relevant source files during analysis
- Agent now has 6 custom GitHub tools (was 4)

## v0.1.1 — 2026-02-08

### Added
- **Multi-provider LLM support** via new `src/model.ts` — supports Anthropic, OpenAI, Ollama, and any OpenAI-compatible API
- `baseUrl` config field for custom API endpoints (LM Studio, Together, Groq, etc.)
- Ollama shorthand provider — defaults to `localhost:11434/v1`
- API key validation skips local providers (ollama, openai-compatible)

### Changed
- Extracted model creation from `agent.ts` into dedicated `model.ts`
- Updated `config.json.example` with `baseUrl` field

## v0.1.0 — 2026-02-08

Initial release: cron-based GitHub issue poller with AI analysis.

### Features
- **Poll GitHub issues** via cron (`poll.sh`) with state tracking (`last_poll.json`)
- **Analyze issues** using a Deep Agent (LangChain + Anthropic Claude)
- **Comment on issues** with high-level findings summary
- **Write detailed analysis** to `./issues/issue_<number>.md`
- **Create feature branches** (`issue-<number>-<description>`)
- **Open draft PRs** linked to issues via `Closes #N`

### Tools
- `fetch_github_issues` — fetch open issues with `since` polling support
- `comment_on_issue` — post analysis comment on GitHub issue
- `create_branch` — create feature branch from default branch
- `create_pull_request` — open draft PR (never auto-merges)

### Documentation
- `LEARNING_LOG.md` — 7-entry learning narrative covering architecture, implementation, and review
- `README.md` — setup guide, testing instructions, troubleshooting
- `CLAUDE.md` — project objectives and conventions
