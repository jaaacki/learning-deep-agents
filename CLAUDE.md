# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

A **learning project** for understanding and implementing Deep Agents / LangGraph patterns. The goal is hands-on experience with agentic workflows, tool creation, and GitHub API integration — not production use.

## Project Objective

Build an autonomous agent that polls a GitHub repository's issues on a schedule and performs end-to-end analysis:

1. **Poll** — Cron-triggered polling of open issues from a configured GitHub repo (no webhook/listener required). Each run fetches new/updated issues since the last poll.
2. **Analyze** — The agent studies each issue (code context, labels, description) to understand the problem
3. **Comment** — Post a high-level summary of findings as a comment on the GitHub issue (keeps analysis visible and linked to the issue)
4. **Document** — Write detailed (but not verbose) findings to a local file: `./issues/issue_<number>.md`
5. **Propose Fix** — Create a branch and open a draft Pull Request referencing the issue (do NOT merge)

### Polling Strategy

- One-shot process invoked by cron via `poll.sh`
- `last_poll.json` in project root tracks the last poll timestamp to avoid re-processing
- Each run: fetch issues since last poll → analyze new ones → update timestamp
- Future: replace cron with GitHub webhooks for real-time

### Git Workflow for Linking Issues to PRs

- Branch naming convention: `issue-<number>-<short-description>`
- PR title references the issue: `Fix #<number>: <short description>`
- PR body includes `Closes #<number>` to auto-link the issue to the PR
- PRs are opened as **draft** — never auto-merged
- The issue comment includes a link back to the PR for traceability

This approach uses GitHub's native issue-PR linking (`Closes #N`) which is the standard mechanism — it automatically cross-references the PR in the issue timeline, providing full bidirectional traceability without needing manual comment-based linking.

## Success Criteria

The project is considered successful when the agent can:
- [ ] Poll open issues from a GitHub repo (cron-triggered, one-shot process)
- [ ] Track polling state to avoid re-processing issues
- [ ] Analyze each issue with meaningful findings
- [ ] Post a high-level comment on the issue with findings summary
- [ ] Write detailed analysis to `./issues/issue_<number>.md`
- [ ] Create a feature branch and open a draft PR referencing the issue
- [ ] Maintain proper issue-PR linkage via GitHub conventions

## Commands

```bash
npm start       # Run a single poll cycle (tsx src/index.ts)
npm run dev     # Run in watch mode for development (tsx watch src/index.ts)
npm install     # Install dependencies
```

### Cron Setup

Single script: `poll.sh` — sets up env, runs `npm start`, logs output. Just point cron at it:

```bash
*/15 * * * * /path/to/deepagents/poll.sh
```

No test runner, linter, or formatter is configured.

## Configuration

Copy `config.json.example` to `config.json` and fill in GitHub credentials (owner, repo, token) and LLM credentials (provider, apiKey, model). The config is loaded/validated by `src/config.ts`. Never commit `config.json`.

The GitHub token needs these scopes: `repo` (full), `issues:write`, `pull_requests:write`.

## Architecture

- **`src/index.ts`** — Entry point: loads config, creates agent, invokes it with a user request, prints results
- **`src/config.ts`** — Reads and validates `config.json` (GitHub + LLM settings)
- **`src/github-tools.ts`** — Creates an Octokit client and LangChain-compatible GitHub tools with Zod schema validation
- **`src/agent.ts`** — Factory function that wires up the LLM (Anthropic or OpenAI), GitHub tools, and a system prompt into a `deepagents` agent

### Tools (Current & Planned)

| Tool | Status | Purpose |
|------|--------|---------|
| `fetch_github_issues` | Implemented | Fetch open issues from repo |
| `comment_on_issue` | Planned | Post analysis summary as issue comment |
| `create_branch` | Planned | Create feature branch for a fix |
| `create_pull_request` | Planned | Open draft PR linked to issue |
| `read_file` | Built-in | Read local files |
| `write_file` | Built-in | Write analysis to `./issues/` |
| `write_todos` | Built-in | Plan agent's approach |

### Output

`./issues/issue_<number>.md` — one file per issue with metadata, analysis, suggested approach, and PR link.

## Key Patterns

- ESM project (`"type": "module"` in package.json) — use `.js` extensions in imports even for TypeScript files
- TypeScript strict mode enabled, targeting ES2022
- Async-first: all agent invocations and tool calls are promise-based
- Tool inputs validated with Zod schemas (see `github-tools.ts`)
- LLM provider is configurable: Anthropic is fully wired; OpenAI is stubbed but throws
