# Changelog

> **Versioning plan:** Patch bumps per issue, minor bumps at phase milestones.
> See LEARNING_LOG.md Entry 8 for the full dependency map and version targets.
>
> v0.2.0 = Phase 1 (Code Awareness) | v0.3.0 = Phase 2 (Safety) | v0.4.0 = Phase 3 (CLI/Tests)
> v0.5.0 = Phase 4 (Intelligence) | v0.6.0 = Phase 5 (Resilience) | v0.7.0 = Phase 6 (Webhooks)
> v0.8.0 = Phase 7 (Deployment) | v1.0.0 = Phase 8 (Reviewer Bot)

---

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
- **`list_repo_files` tool** (Issue #1) — lists all files in the repository with path and size info
- Path prefix filtering (e.g., `"src/"` to list only source files)
- Branch parameter for listing files on non-default branches
- Truncation warning when GitHub API truncates large repos

### Changed
- System prompt updated to guide the agent to use `list_repo_files` during analysis
- Agent now has 5 custom GitHub tools (was 4)

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
