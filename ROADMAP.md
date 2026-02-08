# Roadmap

A phased plan for evolving this project from a learning exercise into a standalone GitHub issue bot.

---

## Vision

An autonomous bot that watches a GitHub repository, analyzes new issues with AI, documents findings, proposes fixes as draft PRs, and triggers a reviewer bot before humans make the final merge decision. Deployed as a Docker stack (Caddy + Node + PostgreSQL) with a CLI for development and manual operations.

---

## Phase 1 — Code Awareness ✓ (v0.2.0)

> The agent can read the actual codebase, not just issue descriptions.

| # | Issue | Status |
|---|-------|--------|
| [#1](../../issues/1) | Add `list_repo_files` tool (repo map) | ✓ v0.1.2 |
| [#2](../../issues/2) | Add `read_repo_file` tool (code reading) | ✓ v0.1.3 |

**Milestone:** Agent reads relevant source files when analyzing an issue. Analysis quality jumps from guessing to code-aware.

---

## Phase 2 — Safety & Idempotency ✓ (v0.3.0)

> The bot can run unattended without spamming, duplicating, or going rogue.

| # | Issue | Status |
|---|-------|--------|
| [#5](../../issues/5) | Max issues per run | ✓ v0.2.1 |
| [#8](../../issues/8) | Prevent duplicate comments | ✓ v0.2.2 |
| [#9](../../issues/9) | Prevent duplicate branches | ✓ v0.2.3 |
| [#10](../../issues/10) | Prevent duplicate PRs | ✓ v0.2.4 |
| [#11](../../issues/11) | Track actions per issue in poll state | ✓ v0.2.10 |
| [#6](../../issues/6) | Circuit breaker (max tool calls) | ✓ v0.2.9 |
| [#7](../../issues/7) | Dry run mode | ✓ v0.2.8 |

**Milestone:** Safe to run on a real repo via cron. Idempotent operations, bounded resource usage, testable without side effects.

---

## Phase 3 — CLI & Testing ✓ (v0.3.0)

> Developer experience: test, debug, and operate the bot from the command line.

| # | Issue | Status |
|---|-------|--------|
| [#24](../../issues/24) | CLI wrapper (poll, analyze, dry-run, status, webhook) | ✓ v0.2.5 |
| [#23](../../issues/23) | Test infrastructure (vitest, mocks, unit tests) | ✓ v0.2.6 |
| [#25](../../issues/25) | `create_or_update_file` tool (commit to branches) | ✓ v0.3.1 |
| [#27](../../issues/27) | Self-review step (catch hallucinated code) | ✓ v0.3.1 |

**Milestone:** `deepagents poll`, `deepagents analyze --issue 5`, `deepagents dry-run` all work. Tests cover core logic with mocked APIs. Agent commits real code to branches and self-reviews before opening PRs.

---

## Phase 4 — Intelligence

> Smarter analysis with two-phase agent architecture.

| # | Issue | Status |
|---|-------|--------|
| [#3](../../issues/3) | Triage agent (phase 1 — scope the issue) | ✓ v0.3.2 |
| [#4](../../issues/4) | Analysis agent (phase 2 — deep code-aware analysis) | Open |

**Milestone:** Issues go through triage (cheap/fast) then deep analysis (thorough). Each phase can use a different model. LangGraph StateGraph pattern in use.

---

## Phase 5 — Resilience

> The bot recovers from failures and handles load gracefully. Actions can be undone.

| # | Issue | Status |
|---|-------|--------|
| [#17](../../issues/17) | Error handling with retry and backoff | Open |
| [#22](../../issues/22) | Graceful shutdown (SIGTERM handling) | Open |
| [#31](../../issues/31) | Enrich action tracking with full response metadata | Open |
| [#32](../../issues/32) | Retract command (`deepagents retract --issue N`) | Open |
| [#33](../../issues/33) | Structured logging (tool calls, timing, workflow steps) | Open |

**Milestone:** Transient API failures are retried. Container stops don't lose work. Agent actions can be retracted by humans via CLI. Tool calls are logged with arguments and timing.

---

## Phase 6 — Webhook & Real-Time

> Replace cron polling with real-time GitHub webhook processing.

| # | Issue | Status |
|---|-------|--------|
| [#12](../../issues/12) | HTTP webhook listener | Open |
| [#13](../../issues/13) | Handle `issues.opened` event | Open |
| [#14](../../issues/14) | Handle `pull_request.opened` event | Open |
| [#18](../../issues/18) | Persistent job queue (PostgreSQL) | Open |

**Milestone:** Issues are processed in real-time. Events are queued in PostgreSQL and processed one at a time. Cron mode still works as a fallback.

---

## Phase 7 — Deployment

> Production-ready Docker stack with proper identity and monitoring.

| # | Issue | Status |
|---|-------|--------|
| [#21](../../issues/21) | Docker + Caddy deployment setup | Open |
| [#20](../../issues/20) | Health check endpoint | Open |
| [#19](../../issues/19) | Migrate from PAT to GitHub App | Open |

**Milestone:** Three-container stack (Caddy + Node + PostgreSQL). Bot has its own GitHub App identity. Health checks for monitoring.

**Architecture:**
```
                    ┌─────────────────────────────────┐
                    │         Docker Compose           │
                    │                                  │
GitHub ──webhook──► │  [Caddy :443] ──► [Node :3000]  │
                    │                       │          │
                    │                  [PostgreSQL]    │
                    │                   (job queue)    │
                    └─────────────────────────────────┘
```

---

## Phase 8 — Reviewer Bot (Separate Project)

> A second bot that reviews PRs created by the analyzer bot. Lives in its own repo.

| # | Issue | Status |
|---|-------|--------|
| [#15](../../issues/15) | PR review agent | Open |
| [#16](../../issues/16) | `submit_pr_review` tool | Open |

**Milestone:** Draft PRs are automatically reviewed. Humans see both the analysis and the review before deciding to merge. The reviewer bot is a separate project with its own deployment.

**Pipeline:**
```
Issue opened
  → Analyzer bot (this project)
      → Comments on issue
      → Creates draft PR
          → Reviewer bot (separate project)
              → Posts PR review
                  → Human merges (or not)
```

---

## Guiding Principles

1. **Learning first** — every feature is an opportunity to understand a pattern (ReAct, tool composition, LangGraph, event-driven architecture)
2. **Incremental** — each phase builds on the last, nothing is thrown away
3. **Simple file structure** — flat, minimal directories, no over-organization
4. **CLI as the wrapper** — every feature gets a CLI subcommand, same core code as webhook mode
5. **Humans decide** — the bot proposes, comments, and reviews. It never merges, approves, or takes destructive actions
6. **GitHub as the event bus** — no custom pub/sub infrastructure, use GitHub's native webhook events
