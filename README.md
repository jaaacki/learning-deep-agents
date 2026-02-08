# Deep Agents GitHub Issue Poller

A learning project for understanding Deep Agents / LangGraph patterns. An AI agent polls a GitHub repo for open issues, analyzes them, comments findings, writes detailed analysis files, and opens draft PRs.

## What It Does

```
cron  -->  poll.sh  -->  pnpm start  -->  Triage (cheap/fast)
                                              |
                                              +--> Skip irrelevant issues
                                              |
                                              +--> Analysis Agent (thorough)
                                                    |
                                                    +--> 1. Fetch open issues (since last poll)
                                                    +--> 2. List repo files + read relevant source
                                                    +--> 3. Comment summary on the issue
                                                    +--> 4. Write analysis to ./issues/issue_<N>.md
                                                    +--> 5. Create branch + commit proposed fix
                                                    +--> 6. Self-review committed changes
                                                    +--> 7. Open draft PR
                                                              |
                                                              +--> Reviewer Agent (automatic)
                                                                    +--> Fetch PR diff
                                                                    +--> Read source files for context
                                                                    +--> Post review (COMMENT only)
```

The agent never merges PRs. It only proposes fixes as drafts. The reviewer agent posts a COMMENT review -- it never approves or requests changes.

Alternatively, use the webhook listener for real-time processing:
```
GitHub  --webhook-->  deepagents webhook  -->  issues.opened  --> Triage + Analysis
                                          -->  pull_request.opened --> Reviewer Agent
```

## CLI Usage

The project provides a CLI with subcommands:

```bash
# Run a poll cycle (fetch + analyze + comment + branch + PR)
pnpm run cli poll

# Dry run: skip GitHub writes (comments, branches, PRs) -- safe for testing
pnpm run cli poll --dry-run

# No-save: run normally but don't persist poll state
pnpm run cli poll --no-save

# Override max issues from config
pnpm run cli poll --max-issues 3

# Analyze a single issue by number
pnpm run cli analyze --issue 42

# Triage a single issue (cheap/fast classification)
pnpm run cli triage --issue 42

# Review a pull request (fetch diff, analyze, post review comment)
pnpm run cli review --pr 10

# Retract all agent actions on an issue (close PR, delete branch, delete comment)
pnpm run cli retract --issue 42

# Start webhook listener (real-time, replaces cron)
pnpm run cli webhook

# Show current polling state
pnpm run cli status

# Show help
pnpm run cli help
```

The original `pnpm start` still works and runs a single poll cycle.

## Prerequisites

- Node.js 24+
- [pnpm](https://pnpm.io/) package manager
- A GitHub account with a [Personal Access Token](https://github.com/settings/tokens) (scopes: `repo`)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jaaacki/learning-deep-agents.git
cd learning-deep-agents
pnpm install
```

### 2. Create your config

```bash
cp config.json.example config.json
```

Edit `config.json`:

```json
{
  "github": {
    "owner": "your-github-username",
    "repo": "your-repo-name",
    "token": "ghp_your_token_here"
  },
  "llm": {
    "provider": "anthropic",
    "apiKey": "sk-ant-your_key_here",
    "model": "claude-sonnet-4-20250514",
    "baseUrl": null
  },
  "maxIssuesPerRun": 5,
  "maxToolCallsPerRun": 30
}
```

`maxIssuesPerRun` caps how many issues the agent processes per invocation (default: 5). Lower this for busy repos or higher LLM costs.

`maxToolCallsPerRun` is a circuit breaker that caps total tool calls per run (default: 30). If the agent enters a loop, this stops it from burning unlimited API credits. The process exits with code 2 when tripped.

#### Other LLM providers

```json
// OpenAI
{ "provider": "openai", "apiKey": "sk-...", "model": "gpt-4", "baseUrl": null }

// Ollama (local)
{ "provider": "ollama", "apiKey": null, "model": "llama3", "baseUrl": null }

// OpenAI-compatible (LM Studio, Together, Groq, etc.)
{ "provider": "openai-compatible", "apiKey": "key-or-null", "model": "my-model", "baseUrl": "http://localhost:1234/v1" }
```

**Tip:** Point it at a repo you own that has a few open issues. If you don't have one, create a test repo with 2-3 dummy issues.

### 3. Test a single run

```bash
pnpm start
```

You should see output like:

```
🤖 Deep Agents GitHub Issue Poller

✅ Config loaded: your-username/your-repo

🆕 First poll run -- no previous state found.

⚙️  Creating Deep Agent...
✅ Agent ready!

🚀 Running agent to analyze GitHub issues...

============================================================
📥 Fetching open issues from your-username/your-repo...
📂 Listing files in your-username/your-repo...
📖 Reading src/index.ts from your-username/your-repo (main)...
💬 Commenting on issue #1 in your-username/your-repo...
🌿 Creating branch 'issue-1-fix-something' from 'main'...
📝 Creating draft PR 'Fix #1: Fix something' in your-username/your-repo...
============================================================

✅ Agent completed!

💾 Poll state saved to /path/to/last_poll.json
   Processed issues: 1
```

After the run, check:
- **GitHub issue** — should have a new comment with the agent's analysis
- **`./issues/`** folder — should have `issue_1.md` with detailed findings
- **GitHub PRs** — should have a new draft PR titled "Fix #1: ..."
- **`last_poll.json`** — should exist with the timestamp and processed issue numbers

### 4. Test a second run (polling)

Run `pnpm start` again. This time the agent should skip already-processed issues:

```
📅 Last poll: 2026-02-08T07:30:00.000Z
📋 Previously processed issues: 1

🆕 No new issues to process.
```

### 5. Set up cron (optional)

Make `poll.sh` executable and edit the PATH line for your system:

```bash
chmod +x poll.sh
```

Open `poll.sh` and uncomment the right PATH line:
- Intel Mac: `export PATH="/usr/local/bin:$PATH"`
- Apple Silicon: `export PATH="/opt/homebrew/bin:$PATH"`
- nvm users: uncomment the nvm line

Test it:

```bash
./poll.sh
cat poll.log
```

Then add to crontab:

```bash
crontab -e
```

Add this line (polls every 15 minutes):

```
*/15 * * * * /Users/your-name/Dev/deepagents/poll.sh
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `config.json not found` | Run `cp config.json.example config.json` and fill in credentials |
| `Missing LLM API key` | Add your Anthropic key to `config.json` |
| `Error fetching issues: HttpError` | Check your GitHub token has `repo` scope |
| `Error creating branch: Not Found` | Make sure the repo has a `main` branch (not `master`) |
| `Error creating pull request: Validation Failed` | Branch might already exist from a previous run |
| Agent doesn't comment/create PR | Check console output for API errors; token might lack permissions |
| `poll.sh: pnpm: command not found` | Uncomment the correct PATH line in `poll.sh` |

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode (re-runs on file changes)
pnpm run test:watch
```

246 tests across 9 test files using [vitest](https://vitest.dev/) with mocked external dependencies (Octokit, LLM constructors, filesystem). No real API calls are made during testing.

## File Structure

```
deepagents/
  src/
    cli.ts            -- CLI entry point (subcommands: poll, analyze, triage, review, webhook, status)
    core.ts           -- Shared logic (poll cycle, state management, graceful shutdown)
    index.ts          -- Original entry point (thin wrapper, backwards-compatible)
    config.ts         -- Loads and validates config.json (GitHub + LLM + webhook)
    model.ts          -- LLM provider factory (Anthropic, OpenAI, Ollama, etc.)
    github-tools.ts   -- GitHub API tools (fetch, list files, comment, branch, PR, commit, review)
    agent.ts          -- Creates the analysis agent with tools + system prompt
    triage-agent.ts   -- Triage agent (cheap model, read-only tools, issue classification)
    reviewer-agent.ts -- PR reviewer agent (diff reader, source context, review submitter)
    logger.ts         -- Structured logging wrapper for tool calls
    utils.ts          -- Retry with exponential backoff for API calls
    listener.ts       -- Express webhook server with HMAC-SHA256 verification
  tests/
    core.test.ts      -- Unit tests for core logic, state, graceful shutdown
    github-tools.test.ts -- Idempotency and tool tests (mocked Octokit)
    model.test.ts     -- Provider routing tests (mocked LLM constructors)
    config.test.ts    -- Config validation tests (mocked fs, process.exit)
    triage-agent.test.ts -- Triage agent parsing and config tests
    reviewer-agent.test.ts -- PR review tool and diff tool tests
    logger.test.ts    -- Structured logging wrapper tests
    utils.test.ts     -- Retry logic and error classification tests
    listener.test.ts  -- Webhook endpoint and signature verification tests
  issues/             -- Generated: detailed analysis files
  config.json         -- Your credentials (git-ignored)
  config.json.example -- Template for config.json
  last_poll.json      -- Generated: polling state (git-ignored)
  poll.sh             -- Cron wrapper script
  poll.log            -- Generated: cron run logs (git-ignored)
  LEARNING_LOG.md     -- Project learning narrative
  CLAUDE.md           -- Claude Code project instructions
  Dockerfile          -- Container image definition
  docker-compose.yml  -- Bot + Caddy reverse proxy stack
  Caddyfile           -- Caddy reverse proxy config (TLS termination)
  .dockerignore       -- Files excluded from Docker build context
```

## Docker Deployment

Run the webhook listener behind Caddy with automatic HTTPS.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A domain name with DNS pointing to your server
- `config.json` with valid credentials (see Setup above)

### 1. Configure your domain

Edit `Caddyfile` and replace `yourdomain.com` with your actual domain:

```
yourdomain.com {
    reverse_proxy bot:3000
}
```

Caddy will automatically provision a TLS certificate from Let's Encrypt.

### 2. Create runtime files

The bot needs `last_poll.json` and `issues/` to exist before mounting:

```bash
touch last_poll.json
mkdir -p issues
```

### 3. Build and start

```bash
docker compose up -d --build
```

This starts two containers:
- **bot** -- the webhook listener on port 3000 (internal only)
- **caddy** -- reverse proxy on ports 80/443 with automatic TLS

### 4. Verify

```bash
# Check container health
docker compose ps

# View bot logs
docker compose logs -f bot

# Test health endpoint
curl https://yourdomain.com/health
```

### 5. Point GitHub webhook

In your GitHub repo settings, add a webhook:
- **Payload URL:** `https://yourdomain.com/webhook`
- **Content type:** `application/json`
- **Secret:** same value as `webhook.secret` in your `config.json`
- **Events:** select "Issues" and "Pull requests"

### Stopping

```bash
docker compose down
```

Caddy's TLS certificates persist in the `caddy_data` volume across restarts.

## How to Reset

To re-analyze all issues from scratch:

```bash
rm last_poll.json
pnpm start
```

To clean up generated files:

```bash
rm -rf issues/ last_poll.json poll.log
```

## Learning More

Read `LEARNING_LOG.md` for a step-by-step narrative of how this project was designed and built, including:
- Why each technology was chosen
- How tools work (schema + description + implementation)
- The ReAct agent loop explained
- Architecture decisions and trade-offs
- Edge cases and what could go wrong
