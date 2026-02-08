# Deep Agents GitHub Issue Poller

A learning project for understanding Deep Agents / LangGraph patterns. An AI agent polls a GitHub repo for open issues, analyzes them, comments findings, writes detailed analysis files, and opens draft PRs.

## What It Does

```
cron  -->  poll.sh  -->  npm start  -->  Agent runs
                                           |
                                           +--> 1. Fetch open issues (since last poll)
                                           +--> 2. List repo files to understand codebase structure
                                           +--> 3. Read relevant source files for code-aware analysis
                                           +--> 4. Comment summary on the issue
                                           +--> 5. Write detailed analysis to ./issues/issue_<N>.md
                                           +--> 6. Create branch + open draft PR
```

The agent never merges PRs. It only proposes fixes as drafts.

## Prerequisites

- Node.js 18+
- A GitHub account with a [Personal Access Token](https://github.com/settings/tokens) (scopes: `repo`)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jaaacki/learning-deep-agents.git
cd learning-deep-agents
npm install
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
  }
}
```

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
npm start
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

Run `npm start` again. This time the agent should skip already-processed issues:

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
| `poll.sh: npm: command not found` | Uncomment the correct PATH line in `poll.sh` |

## File Structure

```
deepagents/
  src/
    index.ts          -- Entry point, polling state management
    config.ts         -- Loads and validates config.json
    model.ts          -- LLM provider factory (Anthropic, OpenAI, Ollama, etc.)
    github-tools.ts   -- GitHub API tools (fetch, list files, comment, branch, PR)
    agent.ts          -- Creates the agent with tools + system prompt
  issues/             -- Generated: detailed analysis files
  config.json         -- Your credentials (git-ignored)
  config.json.example -- Template for config.json
  last_poll.json      -- Generated: polling state (git-ignored)
  poll.sh             -- Cron wrapper script
  poll.log            -- Generated: cron run logs (git-ignored)
  LEARNING_LOG.md     -- Project learning narrative
  CLAUDE.md           -- Claude Code project instructions
```

## How to Reset

To re-analyze all issues from scratch:

```bash
rm last_poll.json
npm start
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
