# Deep Agents Learning Log

This is a running document that tracks how this project evolves and why. Each entry connects to previous ones so you can follow the narrative from start to finish.

---

<!-- New entries are added below this line -->

## Entry 1: Project Overview -- What We Have and Why It Exists

**Date:** 2026-02-08
**Author:** Architect Agent

### What is this project?

This is a learning project that explores **agentic AI patterns** -- specifically the idea of giving an LLM access to tools so it can take actions autonomously. Instead of just chatting with an AI, we build an AI *agent* that can read GitHub issues, analyze them, comment with findings, write files, create branches, and open pull requests.

The concrete use case: an agent that **polls a GitHub repository** on a schedule, finds new issues, analyzes each one, and documents its findings -- all without a human in the loop.

### Why these specific technologies?

| Technology | Role | Why we chose it |
|---|---|---|
| **TypeScript (ESM)** | Language | Type safety catches bugs at compile time. ESM (ECMAScript Modules) is the modern standard -- `import/export` instead of `require`. We use `"type": "module"` in package.json to tell Node.js this is an ESM project. |
| **deepagents** | Agent framework | Provides the `createDeepAgent()` factory that wires together an LLM, tools, and a system prompt into a runnable agent. It also gives us built-in tools (`read_file`, `write_file`, `write_todos`). |
| **LangChain** | Tool abstraction | LangChain's `tool()` function lets us define tools with a name, description, Zod schema for inputs, and an async function for the implementation. The LLM reads the tool descriptions and decides when to call them. |
| **@langchain/anthropic** | LLM binding | Wraps Anthropic's Claude API in LangChain's `ChatModel` interface so the agent framework can call it uniformly. |
| **Octokit** | GitHub API client | The official GitHub SDK for JavaScript. Handles authentication, rate limiting, and provides typed methods for every GitHub REST API endpoint. |
| **Zod** | Schema validation | Validates tool inputs at runtime. When the LLM calls a tool, its arguments are parsed through the Zod schema before reaching our code -- if the LLM passes bad arguments, we get a clear error instead of a silent bug. |
| **tsx** | Runner | Executes TypeScript directly without a build step. Great for development; `tsx watch` auto-restarts on file changes. |

### How the code is organized

The project has four source files, each with a single responsibility:

```
src/
  index.ts        -- Entry point: load config, create agent, run it
  config.ts       -- Read and validate config.json
  github-tools.ts -- GitHub API tools the agent can call
  agent.ts        -- Wire LLM + tools + system prompt into an agent
```

**Why this structure?** Separation of concerns. Each file answers one question:
- `config.ts`: "Where are my credentials and which repo am I targeting?"
- `github-tools.ts`: "What actions can the agent take on GitHub?"
- `agent.ts`: "How do I assemble the agent from its parts?"
- `index.ts`: "What happens when you run `pnpm start`?"

### Key concept: How a tool works

This is the core pattern you will see throughout the project. A **tool** is a function that the LLM can invoke by name. It has three parts:

1. **Schema** (Zod) -- Defines what arguments the tool accepts. The LLM reads this to know what inputs to provide.
2. **Description** (string) -- Tells the LLM what the tool does and when to use it.
3. **Implementation** (async function) -- The actual code that runs when the tool is called.

Here is the existing `fetch_github_issues` tool as an example (`src/github-tools.ts`):

```typescript
tool(
  async ({ state, limit }) => {
    // Implementation: call GitHub API, return formatted JSON
    const { data: issues } = await octokit.rest.issues.listForRepo({ ... });
    return JSON.stringify(formattedIssues, null, 2);
  },
  {
    name: 'fetch_github_issues',
    description: 'Fetch issues from a GitHub repository',
    schema: z.object({
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().optional().default(5),
    }),
  }
);
```

**Why return JSON strings?** Tools communicate with the LLM through text. The agent sends tool results back to the LLM as message content, so we serialize to JSON. The LLM then reads and interprets the structured data.

### Key concept: The agent loop

When we call `agent.invoke()`, here is what happens under the hood:

1. The LLM receives the system prompt + user message
2. The LLM decides which tool to call (or responds directly)
3. If a tool is called, the framework executes it and sends the result back to the LLM
4. The LLM reads the result and decides what to do next (call another tool, or respond)
5. This loop continues until the LLM responds with a final text message (no more tool calls)

This is the **ReAct pattern** (Reason + Act): the LLM reasons about what to do, acts by calling a tool, observes the result, and repeats.

### Key concept: The system prompt

The system prompt (`src/agent.ts` lines 33-48) is how we give the agent its "personality" and instructions. It tells the agent:
- What its role is ("You are a GitHub issue analyzer bot")
- What tools it has available
- What it should do with those tools
- What repository to target

The system prompt is the steering wheel of the entire agent. When we add new tools and expand the agent's capabilities, the system prompt must be updated to tell the agent about them and when to use them.

### Current state vs. target state

**What works today:**
- Load config from `config.json`
- Create an agent with one custom tool (`fetch_github_issues`)
- Ask the agent to analyze issues and it does so, printing results to the console

**What needs to be built (covered in Entry 2):**
- `comment_on_issue` tool -- post analysis as a comment on the GitHub issue
- `create_branch` tool -- create a feature branch for a proposed fix
- `create_pull_request` tool -- open a draft PR linked to the issue
- Polling state management (`last_poll.json`) -- track what we have already processed
- `poll.sh` script -- cron-friendly wrapper to trigger a polling run
- Updated system prompt to orchestrate the full workflow

### Connection to next entry

Entry 2 will design the architecture for all the new tools and the polling mechanism. We will sketch out the Octokit API calls, Zod schemas, and how the pieces fit together before any code is written.

---

## Entry 2: Architecture Design -- New Tools, Polling, and the Full Workflow

**Date:** 2026-02-08
**Author:** Architect Agent
**Builds on:** Entry 1

### Overview

We need to extend the agent from "fetch and analyze" to a full pipeline: fetch -> analyze -> comment -> document -> branch -> PR. This entry designs each new component, explains the GitHub API calls involved, and shows how they all connect.

### Design principle: Keep tools in one file

All GitHub tools live in `src/github-tools.ts`. Why? Because they all share the same Octokit client (same auth token, same owner/repo). Keeping them together avoids passing credentials around and makes it easy to see all the actions our agent can take in one place.

Each tool-creation function follows the same pattern established in Entry 1:
1. Accept `owner`, `repo`, `token` parameters
2. Create an Octokit client (or accept a shared one)
3. Return a LangChain `tool()` with name, description, Zod schema, and async implementation

**Improvement for this iteration:** Instead of each tool creating its own Octokit client, we will create the client once and pass it into each tool factory. This avoids creating multiple Octokit instances with the same token.

### Tool 1: `comment_on_issue`

**Purpose:** Post the agent's analysis summary as a comment on the GitHub issue. This keeps findings visible and linked to the issue.

**GitHub API:** `octokit.rest.issues.createComment()`

**Why `issues.createComment` and not something else?** In GitHub's API, issue comments and PR comments share the same endpoint. Every PR is also an issue. The `issues.createComment` method works for both.

**Zod schema:**

```typescript
z.object({
  issue_number: z.number().describe('The issue number to comment on'),
  body: z.string().describe('The comment body (Markdown supported)'),
})
```

**Implementation sketch:**

```typescript
export function createCommentOnIssueTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ issue_number, body }) => {
      try {
        const { data: comment } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number,
          body,
        });
        return JSON.stringify({
          id: comment.id,
          html_url: comment.html_url,
          created_at: comment.created_at,
        });
      } catch (error) {
        return `Error commenting on issue #${issue_number}: ${error}`;
      }
    },
    {
      name: 'comment_on_issue',
      description: 'Post a comment on a GitHub issue. Use this to share analysis findings directly on the issue.',
      schema: z.object({
        issue_number: z.number().describe('The issue number to comment on'),
        body: z.string().describe('The comment body (Markdown supported)'),
      }),
    }
  );
}
```

**Key decisions:**
- We return the comment URL so the agent can reference it later (e.g., in the PR body)
- Error handling returns a string (not throws) because tool errors should be messages the LLM can read and react to, not crashes that kill the process
- The description tells the LLM *when* to use it, not just what it does

### Tool 2: `create_branch`

**Purpose:** Create a feature branch from the repo's default branch. This is a prerequisite for opening a PR.

**GitHub API:** Two calls are needed:
1. `octokit.rest.git.getRef()` -- Get the SHA of the default branch's HEAD
2. `octokit.rest.git.createRef()` -- Create a new ref (branch) pointing to that SHA

**Why two calls?** A Git branch is just a pointer (ref) to a commit. To create a new branch, we need to know which commit to point it at. We get the latest commit SHA from the default branch, then create a new ref.

**Why not just use the branch name?** GitHub's Refs API works with full ref paths like `refs/heads/main`. This is how Git stores branches internally -- in a `refs/heads/` namespace.

**Zod schema:**

```typescript
z.object({
  branch_name: z.string().describe('Name for the new branch (e.g., "issue-42-fix-login")'),
  from_branch: z.string().optional().default('main').describe('Branch to create from (default: main)'),
})
```

**Implementation sketch:**

```typescript
export function createBranchTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ branch_name, from_branch = 'main' }) => {
      try {
        // Step 1: Get the SHA of the source branch
        const { data: ref } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${from_branch}`,
        });
        const sha = ref.object.sha;

        // Step 2: Create the new branch pointing to that SHA
        const { data: newRef } = await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch_name}`,
          sha,
        });

        return JSON.stringify({
          branch: branch_name,
          sha,
          url: `https://github.com/${owner}/${repo}/tree/${branch_name}`,
        });
      } catch (error) {
        return `Error creating branch '${branch_name}': ${error}`;
      }
    },
    {
      name: 'create_branch',
      description: 'Create a new Git branch in the repository. Used to prepare a feature branch before opening a pull request.',
      schema: z.object({
        branch_name: z.string().describe('Name for the new branch (e.g., "issue-42-fix-login")'),
        from_branch: z.string().optional().default('main').describe('Branch to create from (default: main)'),
      }),
    }
  );
}
```

**Key decisions:**
- We default `from_branch` to `'main'` -- but this could be `'master'` or something else. A more robust version would query the repo's default branch. For this learning project, `'main'` is fine and keeps the code simple.
- Branch naming convention from CLAUDE.md: `issue-<number>-<short-description>`. The system prompt will guide the agent to follow this pattern.

### Tool 3: `create_pull_request`

**Purpose:** Open a draft pull request that references the issue. The PR is never auto-merged -- it is a proposal for human review.

**GitHub API:** `octokit.rest.pulls.create()`

**Zod schema:**

```typescript
z.object({
  title: z.string().describe('PR title (e.g., "Fix #42: Resolve login timeout")'),
  body: z.string().describe('PR description with analysis and approach. Include "Closes #N" to link the issue.'),
  head: z.string().describe('The branch containing changes (e.g., "issue-42-fix-login")'),
  base: z.string().optional().default('main').describe('The branch to merge into (default: main)'),
})
```

**Implementation sketch:**

```typescript
export function createPullRequestTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ title, body, head, base = 'main' }) => {
      try {
        const { data: pr } = await octokit.rest.pulls.create({
          owner,
          repo,
          title,
          body,
          head,
          base,
          draft: true,  // Always draft -- never auto-merge
        });

        return JSON.stringify({
          number: pr.number,
          html_url: pr.html_url,
          state: pr.state,
          draft: pr.draft,
        });
      } catch (error) {
        return `Error creating pull request: ${error}`;
      }
    },
    {
      name: 'create_pull_request',
      description: 'Open a draft pull request. The PR should reference the issue number in the title and body. Always creates a draft PR -- never auto-merges.',
      schema: z.object({
        title: z.string().describe('PR title (e.g., "Fix #42: Resolve login timeout")'),
        body: z.string().describe('PR description with analysis and approach. Include "Closes #N" to link the issue.'),
        head: z.string().describe('The branch containing changes (e.g., "issue-42-fix-login")'),
        base: z.string().optional().default('main').describe('The branch to merge into (default: main)'),
      }),
    }
  );
}
```

**Key decisions:**
- `draft: true` is hardcoded. This is a safety measure -- the agent should never merge code without human review.
- The description tells the agent to include `Closes #N` in the body. This is GitHub's native issue-linking mechanism: when the PR is eventually merged, it will automatically close the referenced issue. Even as a draft, it creates a visible cross-reference in the issue timeline.
- We return `html_url` so the agent can include a link to the PR in its issue comment.

### Wiring the tools together in `agent.ts`

Currently `agent.ts` creates one tool. We need to update it to create all four tools from a shared Octokit client:

```typescript
// In agent.ts -- updated tool creation
import {
  createGitHubClient,
  createGitHubIssuesTool,
  createCommentOnIssueTool,
  createBranchTool,
  createPullRequestTool,
} from './github-tools.js';

// Create one shared client
const octokit = createGitHubClient(config.github.token);

// Create all tools with the shared client
const tools = [
  createGitHubIssuesTool(owner, repo, octokit),
  createCommentOnIssueTool(owner, repo, octokit),
  createBranchTool(owner, repo, octokit),
  createPullRequestTool(owner, repo, octokit),
];
```

**Why a shared client?** Each Octokit instance carries its own auth token, rate-limit tracking, and retry logic. Sharing one client means we share one set of rate-limit counters and avoid unnecessary object creation.

**Migration note:** The existing `createGitHubIssuesTool` creates its own client internally. We need to refactor it to accept an Octokit instance instead. The `createGitHubClient` function already exists and can be reused.

### Polling state management: `last_poll.json`

**The problem:** Without state, every run would re-process all open issues. We need to remember *when* we last polled so we only process new or updated issues.

**The solution:** A simple JSON file in the project root that stores the timestamp of the last successful poll.

**File format:**

```json
{
  "lastPollTimestamp": "2026-02-08T10:30:00Z",
  "lastPollIssueNumbers": [42, 43, 44]
}
```

**Why track issue numbers too?** As a safety net. If an issue was updated but its `updated_at` timestamp did not change (edge case), we can still check if we have seen it before. This is belt-and-suspenders defensive programming.

**Where does this logic live?** In `src/index.ts` (the entry point), not in the tools. The polling state is an orchestration concern -- it decides *which* issues to process -- while the tools are about *how* to interact with GitHub.

**Implementation sketch for `src/index.ts`:**

```typescript
import fs from 'fs';
import path from 'path';

const POLL_STATE_FILE = path.resolve('./last_poll.json');

interface PollState {
  lastPollTimestamp: string;
  lastPollIssueNumbers: number[];
}

function loadPollState(): PollState | null {
  if (!fs.existsSync(POLL_STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf-8'));
}

function savePollState(state: PollState): void {
  fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2));
}
```

**The updated main flow:**

```typescript
async function main() {
  const config = loadConfig();
  const agent = createDeepAgentWithGitHub(config);

  // Load polling state
  const pollState = loadPollState();
  const sinceDate = pollState?.lastPollTimestamp ?? null;

  // Build the user message with polling context
  const userMessage = sinceDate
    ? `Fetch open issues updated since ${sinceDate} and analyze any new ones. ` +
      `Previously processed issues: ${pollState!.lastPollIssueNumbers.join(', ')}. ` +
      `Skip those unless they have been updated.`
    : `Fetch all open issues and analyze them. This is the first poll run.`;

  // Add the full workflow instructions
  const fullMessage = userMessage + `

For each new/updated issue:
1. Analyze the issue
2. Post a summary comment on the issue
3. Write detailed analysis to ./issues/issue_<number>.md
4. Create a branch named issue-<number>-<short-description>
5. Open a draft PR with title "Fix #<number>: <description>" and body containing "Closes #<number>"`;

  const result = await agent.invoke({
    messages: [{ role: 'user', content: fullMessage }],
  });

  // Save updated poll state
  // (extract processed issue numbers from agent result -- details TBD)
  savePollState({
    lastPollTimestamp: new Date().toISOString(),
    lastPollIssueNumbers: [...(pollState?.lastPollIssueNumbers ?? []), ...newIssueNumbers],
  });
}
```

**Why put polling logic in index.ts and not in a tool?** Polling state is *orchestration* -- it controls what the agent works on. Tools are *capabilities* -- they let the agent do things. Mixing orchestration into tools would make the agent responsible for its own scheduling, which breaks separation of concerns. The entry point decides "what to work on," and the agent decides "how to analyze and respond."

### Updating `fetch_github_issues` for polling

The existing tool needs a new optional parameter `since` so the entry point can pass the polling timestamp:

```typescript
schema: z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  limit: z.number().optional().default(5),
  since: z.string().optional().describe('ISO 8601 timestamp. Only issues updated after this date are returned.'),
})
```

And in the implementation:

```typescript
const { data: issues } = await octokit.rest.issues.listForRepo({
  owner, repo, state,
  per_page: limit,
  sort: 'updated',      // Changed from 'created' to 'updated' for polling
  direction: 'desc',
  since,                 // Pass through the ISO timestamp
});
```

**Why change sort from 'created' to 'updated'?** When polling, we care about changes since the last run. An issue might have been created weeks ago but updated today. Sorting by `updated` ensures we see recently-changed issues first. The `since` parameter filters server-side, so we get only relevant issues.

### The `poll.sh` script

**Purpose:** A simple shell script that cron can invoke. It sets up the environment, runs the agent, and logs output.

**Why a shell script and not just `pnpm start` in cron?** Cron runs with a minimal environment -- it does not load your shell profile, so `node` and `pnpm` might not be on the PATH. The script ensures the right Node.js version is available and the working directory is correct.

```bash
#!/usr/bin/env bash
# poll.sh -- Cron-friendly wrapper for the Deep Agents poller
# Usage: */15 * * * * /path/to/deepagents/poll.sh

set -euo pipefail

# Change to project directory (where config.json and node_modules live)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Log file for debugging cron issues
LOG_FILE="./poll.log"

echo "=== Poll started at $(date -u +"%Y-%m-%dT%H:%M:%SZ") ===" >> "$LOG_FILE"

# Run the agent
pnpm start >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "=== Poll finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ") (exit: $EXIT_CODE) ===" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

exit $EXIT_CODE
```

**Key details:**
- `set -euo pipefail` -- Exit on any error, treat unset variables as errors, and propagate failures through pipes. This is defensive scripting.
- `SCRIPT_DIR` -- Resolves the script's own directory, so the script works regardless of where cron runs it from.
- `LOG_FILE` -- Appends output to `poll.log` so you can debug without looking at cron mail.
- We capture `pnpm start`'s exit code and pass it through, so cron knows if the run failed.

### Updated system prompt design

The system prompt needs to evolve from "analyze and report" to "analyze, comment, document, branch, and PR." Here is the design:

```
You are a GitHub issue analysis agent for the repository {owner}/{repo}.

When given issues to analyze, follow this workflow for EACH issue:

1. ANALYZE the issue:
   - Read the title, body, and labels carefully
   - Identify the type of problem (bug, feature, docs, etc.)
   - Determine severity and complexity
   - Think about what a fix would involve

2. COMMENT on the issue:
   - Use comment_on_issue to post a summary on the GitHub issue
   - Include: problem summary, affected areas, suggested approach, complexity estimate
   - Keep it concise -- this is a high-level summary, not the full analysis

3. DOCUMENT your findings:
   - Use write_file to create ./issues/issue_<number>.md
   - Include: full metadata, detailed analysis, step-by-step fix approach, related files/areas
   - This is the detailed version of your analysis

4. CREATE a branch:
   - Use create_branch with name: issue-<number>-<short-description>
   - Use lowercase, hyphens for spaces, keep it short but descriptive

5. OPEN a draft PR:
   - Use create_pull_request with:
     - title: "Fix #<number>: <short description>"
     - body: Include "Closes #<number>" on its own line, plus your analysis summary
     - head: the branch you just created
   - This links the PR to the issue automatically

IMPORTANT:
- Always create the branch BEFORE the PR (the PR needs the branch to exist)
- Use write_todos at the start to plan your approach for all issues
- Process issues one at a time, completing all 5 steps before moving to the next
- Never merge PRs -- always open them as drafts

Available tools:
- fetch_github_issues: Fetch issues from the repo (supports 'since' for polling)
- comment_on_issue: Post a comment on a GitHub issue
- create_branch: Create a new branch in the repo
- create_pull_request: Open a draft PR
- write_file: Write analysis files to ./issues/
- read_file: Read local files
- write_todos: Plan your approach
```

**Why this level of detail in the prompt?** The system prompt is the only way to tell the agent *how* to sequence its actions. Without explicit ordering (branch before PR), the agent might try to create a PR on a non-existent branch. Without the naming conventions, every run would use different formats. The prompt is the agent's playbook.

### Data flow diagram

Here is how the full pipeline flows:

```
Cron (every 15 min)
  |
  v
poll.sh
  |
  v
pnpm start -> src/index.ts
  |
  |-- loadConfig()           -> config.json
  |-- loadPollState()        -> last_poll.json (or null if first run)
  |-- createDeepAgentWithGitHub(config)
  |-- agent.invoke(userMessage with since/skip info)
  |     |
  |     |-- [Agent ReAct Loop]
  |     |   1. fetch_github_issues(since=lastPoll)  -> GitHub API
  |     |   2. For each issue:
  |     |      a. write_todos(plan)                  -> agent internals
  |     |      b. comment_on_issue(#N, summary)      -> GitHub API
  |     |      c. write_file(./issues/issue_N.md)    -> local filesystem
  |     |      d. create_branch(issue-N-desc)        -> GitHub API
  |     |      e. create_pull_request(draft)          -> GitHub API
  |     |
  |     v
  |-- savePollState()        -> last_poll.json (update timestamp + issue list)
  |
  v
Exit (cron waits for next interval)
```

### File changes summary

| File | Change type | What changes |
|---|---|---|
| `src/github-tools.ts` | Modify + extend | Refactor to accept shared Octokit client. Add `comment_on_issue`, `create_branch`, `create_pull_request` tools. Add `since` param to `fetch_github_issues`. |
| `src/agent.ts` | Modify | Create shared Octokit client. Wire all four tools. Update system prompt. |
| `src/index.ts` | Modify | Add polling state load/save. Build polling-aware user message. Extract processed issue numbers from result. |
| `poll.sh` | New file | Cron-friendly shell wrapper. |
| `last_poll.json` | Runtime (gitignored) | Created/updated at runtime by `src/index.ts`. |
| `.gitignore` | Modify (if exists) | Add `last_poll.json` and `poll.log`. |

### Connection to next entries

The builder agents will use this architecture document to implement:
- Entry 3: Polling state management in `src/index.ts`
- Entry 4: `comment_on_issue` tool in `src/github-tools.ts`
- Entry 5: `create_branch` and `create_pull_request` tools in `src/github-tools.ts`

Each entry should reference back to this architecture for the API details and design decisions.

---

## Entry 3: Critic's Review -- What Could Go Wrong?

**Date:** 2026-02-08
**Author:** Architect Agent (Critic role)
**Builds on:** Entries 1 and 2

### Why review our own design?

Before writing code, it pays to ask "what assumptions are baked in?" and "what will break first?" This is not pessimism -- it is how you build systems that are robust in practice, not just on a whiteboard. Each item below is a learning opportunity about real-world system design.

### Assumption 1: The default branch is named `main`

**Where this appears:** The `create_branch` and `create_pull_request` tools both default `from_branch` / `base` to `'main'`.

**What could go wrong:** Many repositories use `master`, `develop`, or custom default branch names. If the target repo uses `master`, every branch creation and PR will fail with a 404 ("ref not found").

**Learning moment:** Hard-coding defaults is fine for a learning project, but production tools would query the repo's default branch first:

```typescript
const { data: repo } = await octokit.rest.repos.get({ owner, repo });
const defaultBranch = repo.default_branch; // "main", "master", etc.
```

**Recommendation for now:** Keep the `'main'` default but add a note in config.json.example where users can set their repo's default branch. This is a conscious trade-off: simplicity now, extensibility later.

### Assumption 2: The GitHub token has all required permissions

**Where this appears:** CLAUDE.md says the token needs `repo`, `issues:write`, `pull_requests:write`. But nothing in the code validates this.

**What could go wrong:** If the token lacks permission, the first `createComment` or `createRef` call will fail with a 403 ("Resource not accessible by integration"). The agent will see an error string and might keep retrying or give a confusing response.

**Learning moment:** API permissions are an "invisible dependency." Your code compiles and runs, but fails at runtime because of an external configuration issue. This is common in real-world integrations.

**Recommendation:** Log a clear message early in the process when a 403 is encountered. The error-string return pattern in our tools already handles this gracefully -- the agent sees the error and can report it. No code change needed, but the system prompt could include guidance like "If you receive a permission error, report it clearly and stop processing that issue."

### Assumption 3: The agent will follow the system prompt instructions exactly

**Where this appears:** The system prompt says "create the branch BEFORE the PR" and "process issues one at a time."

**What could go wrong:** LLMs are probabilistic. The agent *might*:
- Try to create a PR before the branch (the PR will fail, and the agent should recover by reading the error)
- Skip the comment step if it gets excited about creating the branch
- Process multiple issues in parallel tool calls (most agent frameworks execute sequentially, but it depends on the framework)
- Generate a branch name that does not match the convention

**Learning moment:** System prompts are *guidance*, not *guarantees*. The more complex the workflow, the more likely the agent drifts from the instructions. This is a fundamental characteristic of LLM-based agents -- they are not deterministic programs.

**Mitigation strategies:**
1. Keep the prompt clear and numbered (we already do this)
2. Test with a few real issues and observe what the agent actually does
3. If ordering is critical, consider enforcing it in code (e.g., a state machine in `index.ts` that calls tools in sequence, rather than relying on the agent to decide the order)

### Assumption 4: The `since` parameter prevents all duplicate processing

**Where this appears:** Entry 2's polling design uses `since` (ISO timestamp) to filter issues.

**What could go wrong:**
- **Clock skew:** If the server clock and the machine running the agent differ, we might miss issues updated in the gap or re-process ones.
- **Race condition:** An issue updated *during* a poll run might be missed if we save the timestamp at the start of the run. Our design saves it at the end, which is better, but an issue updated between "fetch" and "save" could still be missed.
- **GitHub API caching:** GitHub's API has caching layers. A `since` query might return stale data if the CDN cache has not been invalidated yet.

**Learning moment:** Polling is inherently imprecise. The `since` + `lastPollIssueNumbers` belt-and-suspenders approach from Entry 2 mitigates most issues. For a learning project, this is more than sufficient. Production systems typically use webhooks (push-based) instead of polling (pull-based) to avoid these timing issues entirely.

**Recommendation:** No code change needed. Just be aware that on rare occasions, an issue might be processed twice. Since our tools are "create comment" and "create PR," duplicates would be visible and harmless (a second comment, a branch-already-exists error).

### Assumption 5: Tool errors will not crash the process

**Where this appears:** Every tool implementation wraps its body in try/catch and returns an error string.

**What could go wrong:** Unhandled errors *outside* the try/catch -- for example:
- Network timeout before the try block executes
- Zod validation failure (if the LLM passes an argument with the wrong type)
- JSON.stringify failure on circular references (unlikely with GitHub API responses, but possible)

**Learning moment:** Error handling has layers. Our tools handle API errors, but the agent framework and Node.js runtime also have error boundaries. The `main().catch()` in `index.ts` is the outermost safety net -- if anything escapes the tools' try/catch, it lands there.

**Recommendation:** This is already well-handled. The existing pattern is good. One enhancement: the tools could distinguish between recoverable errors (e.g., "branch already exists" -- just skip and continue) and fatal errors (e.g., "invalid token" -- stop processing entirely). But for a learning project, the simple string return is fine.

### Assumption 6: `poll.sh` will find `pnpm` on the PATH

**Where this appears:** The `poll.sh` script calls `pnpm start`.

**What could go wrong:** Cron uses a minimal environment. On macOS, `pnpm` installed via Homebrew or nvm might not be on cron's PATH. The script will fail with "pnpm: command not found."

**Learning moment:** This is one of the most common cron debugging issues. It catches everyone at least once.

**Recommendation:** Add a PATH setup line to `poll.sh`:

```bash
# If using nvm, source it so node/pnpm are available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

Or hardcode the path to pnpm:

```bash
/usr/local/bin/pnpm start >> "$LOG_FILE" 2>&1
```

### Assumption 7: The `issues/` directory exists before `write_file` is called

**Where this appears:** The agent writes to `./issues/issue_<number>.md`.

**What could go wrong:** If the `issues/` directory does not exist, `write_file` (the built-in deepagents tool) might fail -- depending on whether the framework creates intermediate directories or not.

**Recommendation:** Add a `mkdir -p issues` in `poll.sh` or at the top of `main()` in `index.ts`:

```typescript
import { mkdirSync } from 'fs';
mkdirSync('./issues', { recursive: true });
```

This is a one-liner that prevents a class of "it works on my machine" issues.

### Assumption 8: The growing `lastPollIssueNumbers` array

**Where this appears:** Entry 2's polling state appends new issue numbers to the array on every run.

**What could go wrong:** Over time, this array grows without bound. After months of polling, `last_poll.json` could contain thousands of issue numbers. This is not a performance problem (JSON parsing thousands of numbers is fast), but it is a data hygiene issue.

**Learning moment:** Stateful systems accumulate cruft. The question is whether the cruft matters.

**Recommendation:** For this learning project, it does not matter. A production system might keep only the last N runs, or rely solely on the timestamp (since GitHub's `since` parameter is reliable enough). But tracking issue numbers is a good safety net for learning, since it makes debugging easier -- you can open `last_poll.json` and see exactly which issues have been processed.

### Summary: Risk vs. complexity trade-offs

| Risk | Severity | Recommended action |
|---|---|---|
| Default branch name mismatch | Medium | Document; optionally make configurable |
| Missing token permissions | Medium | Rely on existing error handling |
| Agent not following prompt order | Low-Medium | Test and observe; prompt is well-structured |
| Polling timing edge cases | Low | Accept; belt-and-suspenders approach mitigates |
| Tool error escaping try/catch | Low | Existing `main().catch()` handles it |
| pnpm not on cron PATH | Medium | Add PATH setup to `poll.sh` |
| Missing `issues/` directory | Medium | Add `mkdirSync` in `index.ts` |
| Growing issue numbers array | Very Low | Accept for learning project |

The architecture from Entry 2 is solid for a learning project. The risks identified above are things to be *aware* of, not blockers. Most of them are addressed by the existing error handling pattern or require only minor adjustments.

### Connection to next entries

The builder agents should note these risks as they implement:
- Add `mkdirSync('./issues', { recursive: true })` to `index.ts` (easy win)
- Consider adding PATH setup to `poll.sh`
- Watch for the agent not following prompt order during testing
- Keep the error-string return pattern in all new tools

---

## Entry 4: Implementing Polling State Management

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entries 1, 2, 3

### What just happened?

We added polling state management to `src/index.ts` so the agent only processes new or updated issues on each run. We also created `poll.sh` (a cron-friendly wrapper) and `.gitignore`.

### The pattern: Stateful polling with a JSON checkpoint file

The core pattern is straightforward: before the agent runs, we load a JSON file (`last_poll.json`) containing the timestamp of the last successful poll and the list of already-processed issue numbers. After the agent finishes, we save an updated version.

```typescript
// Load state (returns null on first run)
const pollState = loadPollState();
const sinceDate = pollState?.lastPollTimestamp ?? null;

// ... agent runs ...

// Save state with current timestamp + accumulated issue numbers
savePollState({
  lastPollTimestamp: new Date().toISOString(),
  lastPollIssueNumbers: [...processedNumbers],
});
```

**Why this works:** The `since` parameter is passed to the agent's user message, which tells the agent to call `fetch_github_issues(since=...)`. GitHub's API filters server-side, so we only get back issues updated after our last poll. The issue numbers list is a safety net for edge cases (Entry 3 covers the timing risks).

**Why state lives in index.ts, not in a tool:** Polling is *orchestration* -- it decides what the agent works on. Tools are *capabilities* -- they let the agent do things. This separation keeps each file focused on answering one question: "What to process?" (index.ts) vs. "How to interact with GitHub?" (github-tools.ts).

### Extracting processed issue numbers from agent results

The trickiest part was figuring out which issues the agent actually processed. We use two heuristics:

1. **Tool call arguments:** If the agent called `comment_on_issue({ issue_number: 42, ... })`, we know it processed issue #42.
2. **JSON content in tool results:** The `fetch_github_issues` tool returns JSON with `"number": 42` fields.

```typescript
for (const msg of result.messages) {
  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      if (call.args?.issue_number) {
        processedNumbers.add(call.args.issue_number);
      }
    }
  }
  if (typeof msg.content === 'string') {
    const issueMatches = msg.content.matchAll(/"number":\s*(\d+)/g);
    for (const match of issueMatches) {
      processedNumbers.add(parseInt(match[1], 10));
    }
  }
}
```

**Alternative considered:** Having the agent explicitly return a structured list of processed issues. This would be cleaner but requires the agent to follow another instruction reliably (Entry 3 warns about prompt drift). The heuristic approach works without agent cooperation.

### The `fetch_github_issues` tool got two changes

1. **New `since` parameter:** An optional ISO 8601 timestamp that passes through to GitHub's API. When present, only issues updated after that timestamp are returned.
2. **Sort changed from `'created'` to `'updated'`:** For polling, we care about *changes* since last run, not *creation date*. An issue created a month ago but updated today should appear in our results.

### poll.sh and the cron PATH problem

`poll.sh` is a thin wrapper: it `cd`s to the project directory, runs `pnpm start`, and logs output. The Entry 3 critic flagged that cron's minimal PATH might not include `pnpm`. We added commented-out PATH setup lines for common Node.js installations (Homebrew Intel, Homebrew Apple Silicon, nvm). Users uncomment the one that matches their setup.

### The `issues/` directory problem

Entry 3 also flagged that the agent writes to `./issues/issue_<number>.md` but the directory might not exist. We added `fs.mkdirSync('./issues', { recursive: true })` at the top of `main()`. The `{ recursive: true }` flag means it silently succeeds if the directory already exists -- no need for an existence check.

---

## Entry 5: Implementing the comment_on_issue Tool

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entries 1, 2, 3

### What just happened?

We added a `comment_on_issue` tool to `src/github-tools.ts` and wired it into the agent in `src/agent.ts`. The agent can now post analysis summaries directly on GitHub issues.

### The pattern: Wrapping a single API call as a LangChain tool

This is the simplest tool pattern in the project. One API call, two inputs, one JSON result:

```typescript
export function createCommentOnIssueTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ issue_number, body }) => {
      const { data: comment } = await octokit.rest.issues.createComment({
        owner, repo, issue_number, body,
      });
      return JSON.stringify({ id: comment.id, html_url: comment.html_url, ... });
    },
    {
      name: 'comment_on_issue',
      description: 'Post a comment on a GitHub issue. Use this to share analysis findings directly on the issue.',
      schema: z.object({
        issue_number: z.number().describe('The issue number to comment on'),
        body: z.string().describe('The comment body (Markdown supported)'),
      }),
    }
  );
}
```

**Why `issues.createComment` and not something else?** In GitHub's API, "issues" and "pull requests" share the same comment endpoint. Every PR is an issue. So `issues.createComment` works for both. This is a GitHub API design choice that simplifies our code.

### The shared Octokit client refactor

Previously, `createGitHubIssuesTool` accepted a `token` string and created its own Octokit client internally. Now all tool factories accept an `Octokit` instance. The client is created once in `agent.ts`:

```typescript
const octokit = createGitHubClient(token);
const githubIssuesTool = createGitHubIssuesTool(owner, repo, octokit);
const commentTool = createCommentOnIssueTool(owner, repo, octokit);
// ... etc
```

**Why this matters:** Each Octokit instance tracks its own rate limits and retry state. Sharing one client means consistent rate-limit behavior across all tools. It also avoids creating four identical HTTP clients.

**Alternative considered:** Dependency injection via a context object (e.g., `{ octokit, owner, repo }`). This is more flexible but adds a layer of indirection. For four tools in one file, simple function parameters are clearer.

### The tool description guides the agent's behavior

Notice the description: *"Post a comment on a GitHub issue. **Use this to share analysis findings directly on the issue.**"* The second sentence tells the LLM *when* to use this tool, not just what it does. This is important because the agent has seven tools and needs to pick the right one for each step.

---

## Entry 6: Implementing create_branch and create_pull_request Tools

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entries 1, 2, 3

### What just happened?

We added `create_branch` and `create_pull_request` tools to `src/github-tools.ts`. Together with `comment_on_issue` (Entry 5), the agent now has the full pipeline: fetch -> analyze -> comment -> document -> branch -> PR.

### The pattern: Multi-step API calls in a single tool

`create_branch` is the most interesting tool because it requires *two* sequential GitHub API calls:

```typescript
// Step 1: Get the SHA of the source branch
const { data: ref } = await octokit.rest.git.getRef({
  owner, repo, ref: `heads/${from_branch}`,
});
const sha = ref.object.sha;

// Step 2: Create a new branch pointing to that SHA
await octokit.rest.git.createRef({
  owner, repo, ref: `refs/heads/${branch_name}`, sha,
});
```

**Why two calls?** A Git branch is a pointer (ref) to a commit SHA. To create a new branch, we need to know which commit to point it at. We fetch the latest commit SHA from the source branch, then create a new ref pointing there.

**Why `heads/` vs `refs/heads/`?** The `getRef` API expects the short form (`heads/main`), while `createRef` expects the full form (`refs/heads/branch-name`). This is a Git internal naming convention -- branches live under `refs/heads/` in the Git object store. The Octokit API mirrors this distinction.

### The `draft: true` safety pattern

`create_pull_request` hardcodes `draft: true`:

```typescript
const { data: pr } = await octokit.rest.pulls.create({
  owner, repo, title, body, head, base,
  draft: true,  // Always draft -- never auto-merge
});
```

**Why hardcode it?** This is a safety measure. The agent should never merge code without human review. By making it a constant rather than a parameter, we remove the possibility of the LLM passing `draft: false`. The Zod schema does not even expose a `draft` field.

**Alternative considered:** Making `draft` a parameter with a default of `true`. This would be more flexible but introduces risk -- the LLM could decide to set it to `false`. In a learning project about agentic patterns, demonstrating the principle of "constrain what the agent can do" is more valuable than maximum flexibility.

### The updated system prompt orchestrates the full workflow

The system prompt in `agent.ts` now contains explicit 5-step instructions for processing each issue. The key ordering constraint is: *"Always create the branch BEFORE the PR."* Without this, the agent might try to open a PR on a non-existent branch and get a 422 error from GitHub.

The system prompt also lists all seven available tools (four custom GitHub tools + three built-in deepagents tools). This gives the LLM a complete picture of its capabilities. Without this list, the agent might not discover tools it has access to.

### How `Closes #N` creates issue-PR cross-references

The system prompt tells the agent to include `Closes #<number>` in the PR body. This is a GitHub keyword that:
1. Immediately creates a visible cross-reference in the issue's timeline
2. When the PR is eventually merged, automatically closes the referenced issue

Even as a draft PR (which cannot auto-close issues until merged), the cross-reference is valuable because it connects the analysis to the issue in GitHub's UI.

---

## Entry 7: Critic's Full Review -- Architecture Assumptions and Implementation Edge Cases

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviews:** Entries 1-6 (Architecture design + all Builder implementations)

### Purpose of this entry

Entry 3 (Architect's self-review) covers high-level design risks: default branch names, token permissions, prompt compliance, PATH issues. This entry goes deeper into the *actual code* that the Builder implemented (Entries 4-6), cross-referencing the architecture (Entries 1-2) to find gaps between design and implementation. Every finding is framed as a learning moment.

**Why separate from Entry 3?** Entry 3 reviews the *design* before code was written. This entry reviews the *code* after implementation. Different phases catch different problems. Reviewing after implementation lets us check: did the design translate correctly? Did new issues emerge during coding? Were Entry 3's recommendations acted on?

---

### Status check: What did Entry 3 recommend, and what was addressed?

| Entry 3 recommendation | Addressed? | Where |
|---|---|---|
| Document default branch assumption | Yes | Entry 2 notes it; schema has `.default('main')` |
| Rely on error handling for missing permissions | Yes | All tools return error strings |
| Add PATH setup to `poll.sh` | Yes | `poll.sh:12-15` has commented-out PATH options |
| Add `mkdirSync` for `issues/` directory | Yes | `index.ts:33` |
| Keep error-string return pattern | Yes | All four tools use try/catch with string returns |

The Builder addressed every recommendation from Entry 3. Good. Now let us look at what Entry 3 did *not* catch.

---

### Finding 1: Config path resolution uses relative `./` (unchanged from original)

**File:** `src/config.ts:7` -- `const configPath = './config.json';`
**Also:** `src/index.ts:15` -- `path.resolve('./last_poll.json')` and `src/index.ts:33` -- `fs.mkdirSync('./issues', ...)`

**What could go wrong?** The `./` prefix resolves against the *current working directory* of the Node.js process, not the directory where the source file lives. `poll.sh` does `cd "$SCRIPT_DIR"` to work around this, but it creates an undocumented runtime requirement. If anyone runs `pnpm start` from a different directory (common during development: `cd ~ && node ~/Dev/deepagents/src/index.ts`), three things silently break: config loading, poll state, and issue file writes.

**Why this was missed:** Entry 3 did not review the existing code in `config.ts` -- it focused on the new designs in Entry 2.

**What you will learn:** In ESM modules, use `import.meta.url` to resolve paths relative to the module file:

```typescript
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '..', 'config.json');
```

**Impact:** High -- silent failure when not using `poll.sh`.
**Fix effort:** Small -- three lines changed across two files.

---

### Finding 2: `JSON.parse` returns `any`, making `Config` type meaningless

**File:** `src/config.ts:15` -- `const config = JSON.parse(configFile);`
**File:** `src/config.ts:31` -- `export type Config = ReturnType<typeof loadConfig>;`

**What could go wrong?** `JSON.parse` returns `any`. The `Config` type is therefore `any`. This means TypeScript's strict mode is completely bypassed for all code that uses `config`. You could write `config.github.nonExistentField.deeply.nested` and TypeScript would not flag it.

The validation on lines 18-26 checks for field *presence* (`!config.github.owner`) but not *types*. If config.json contains `"token": 123` instead of a string, the code accepts it and Octokit crashes later with an unhelpful error.

**What you will learn:** The project already uses Zod for tool input validation (`github-tools.ts`). The same pattern works at the config boundary:

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    token: z.string().min(1),
  }),
  llm: z.object({
    provider: z.enum(['anthropic', 'openai']),
    apiKey: z.string().min(1),
    model: z.string().optional(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
```

This gives you runtime validation *and* compile-time types from a single source. It is consistent with the tool pattern -- "validate at the boundary, trust internally."

**Impact:** Medium -- type errors manifest as confusing runtime crashes.
**Fix effort:** Small -- replaces the manual validation that already exists.

---

### Finding 3: API key leaked in error message

**File:** `src/agent.ts:28` -- `throw new Error(\`Unsupported provider: ${config.llm}\`);`

**What is happening:** This logs the entire `config.llm` object, which includes `apiKey`. When `poll.sh` captures output via `2>&1`, the API key ends up in `poll.log`. If `poll.log` is ever committed, shared, or viewed by someone who should not have the key, it is a credential leak.

**The fix:** Change `${config.llm}` to `${config.llm.provider}`.

**What you will learn:** Always review error messages for accidental credential exposure. This is a common security issue -- error paths are rarely tested, so sensitive data slips through. The pattern is: log the *identifier* (provider name), never the *credential* (API key).

**Impact:** Medium -- credential exposure in logs.
**Fix effort:** Trivial -- one word changed.

---

### Finding 4: `process.exit(1)` in config.ts prevents cleanup

**File:** `src/config.ts:11` and `src/config.ts:25` -- `process.exit(1);`

**What could go wrong?** `process.exit()` terminates the Node.js process immediately, bypassing `finally` blocks, `process.on('exit')` handlers, and any resource cleanup. Today this is harmless, but once lock files are added to `poll.sh` (see Finding 6), a `process.exit` during config validation would skip lock cleanup, leaving a stale lock file that blocks all future cron runs.

**What you will learn:** Library modules should throw errors, not call `process.exit()`. The entry point (`index.ts:121-124`) already has `main().catch()` that handles errors and calls `process.exit(1)`. Let that be the single exit point.

**Impact:** Medium -- blocks future cleanup additions; inconsistent error handling pattern.
**Fix effort:** Trivial -- replace `process.exit(1)` with `throw new Error(...)`.

---

### Finding 5: Labels mapping assumes object type (unchanged from original)

**File:** `src/github-tools.ts:48` -- `labels: issue.labels.map((l) => l.name)`

**What could go wrong?** The GitHub API returns labels as either objects (`{ id, name, color }`) or plain strings, depending on context. If a label comes back as a string, `l.name` evaluates to `undefined`, and the agent sees a label list with undefined entries.

**The fix:** `labels: issue.labels.map((l) => typeof l === 'string' ? l : l.name)`

**What you will learn:** APIs that return union types require defensive handling. TypeScript's GitHub API types define labels as `(string | { name?: string })[]`, but since `config` is `any`, the type checker cannot help here. This connects to Finding 2 -- better input types would make this issue visible at compile time.

**Impact:** Low -- cosmetic bug in issue data sent to the LLM.
**Fix effort:** Trivial -- one line.

---

### Finding 6: No cron overlap protection in poll.sh

**File:** `poll.sh` -- no lock file mechanism.

**What could go wrong?** If a polling run takes longer than 15 minutes (the cron interval), a second instance starts while the first is still running. Both instances read the same `last_poll.json`, process the same issues, and:
- Post duplicate comments on every issue
- Try to create the same branches (second run gets "reference already exists" error)
- Try to create duplicate PRs

With an LLM in the loop (network latency, multi-step tool calls, retries), exceeding 15 minutes is plausible for repos with many open issues.

**What you will learn:** This is the classic "cron overlap" problem. The standard Unix solution is an atomic lock directory:

```bash
LOCKFILE="$SCRIPT_DIR/.poll.lock"

if ! mkdir "$LOCKFILE" 2>/dev/null; then
  echo "Another poll is running. Skipping." >> "$LOG_FILE"
  exit 0
fi

trap 'rmdir "$LOCKFILE"' EXIT
```

`mkdir` is atomic -- two processes cannot both succeed. The `trap` ensures cleanup even on error. Using a directory instead of a file avoids the race condition inherent in "check-then-create" with regular files.

**Impact:** High -- duplicate comments and failed operations when runs overlap.
**Fix effort:** Small -- 5 lines added to `poll.sh`.

---

### Finding 7: No idempotency check for comments

**File:** `src/github-tools.ts:72-103` -- `createCommentOnIssueTool`

**What could go wrong?** If the agent crashes *after* commenting on issue #42 but *before* `savePollState()` runs at `index.ts:112`, the next run re-processes issue #42 and posts a duplicate comment. Over multiple failures (or with cron overlap from Finding 6), an issue accumulates identical analysis comments.

**What you will learn:** **Idempotency** means performing an operation multiple times produces the same result as performing it once. GitHub bots commonly achieve this with a hidden HTML marker:

```typescript
// Before posting, check if we already commented
const { data: existingComments } = await octokit.rest.issues.listComments({
  owner, repo, issue_number, per_page: 100,
});
const marker = '<!-- deep-agent-analysis -->';
const alreadyCommented = existingComments.some(c => c.body?.includes(marker));
if (alreadyCommented) {
  return JSON.stringify({ skipped: true, reason: 'Analysis comment already exists' });
}

// Include the marker in the comment body
const markedBody = `${marker}\n${body}`;
await octokit.rest.issues.createComment({ owner, repo, issue_number, body: markedBody });
```

This pattern is used by Dependabot, Renovate, and most production GitHub bots.

**Impact:** High -- comment spam on issues.
**Fix effort:** Small -- ~10 lines added to the comment tool.

---

### Finding 8: Poll state writes are not atomic

**File:** `src/index.ts:22-24` -- `savePollState` uses `fs.writeFileSync`

**What could go wrong?** If the process is killed mid-write (OOM, SIGTERM, power loss), `last_poll.json` can be partially written. The next run calls `JSON.parse` on truncated JSON and crashes with an unrecoverable error.

**What you will learn:** The **write-then-rename** pattern makes file writes atomic:

```typescript
function savePollState(state: PollState): void {
  const tempPath = POLL_STATE_FILE + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, POLL_STATE_FILE);
}
```

`rename` is atomic on POSIX filesystems -- the file is either the old version or the new version, never a partial write.

Additionally, `loadPollState` should handle corrupted files gracefully:

```typescript
function loadPollState(): PollState | null {
  if (!fs.existsSync(POLL_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf-8'));
  } catch {
    console.warn('Warning: last_poll.json is corrupted, treating as first run.');
    return null;
  }
}
```

**Impact:** Medium -- crash loop if the file is corrupted.
**Fix effort:** Small -- 3 lines changed.

---

### Finding 9: Tool errors are invisible to the operator

**File:** All tool catch blocks in `src/github-tools.ts` (lines 52-54, 90-92, 138-140, 181-182)

**What could go wrong?** Errors are returned as strings to the LLM but not logged to stderr. The tool "succeeds" (it returned a value), so the process exits with code 0. `poll.sh` records exit code 0, and cron thinks everything is fine. An auth failure or rate-limit error at 3 AM goes unnoticed until someone manually reads the LLM's response.

**What you will learn:** Errors have two audiences: the LLM (needs the error as a string to reason about it) and the operator (needs it in logs to monitor and alert). Serve both:

```typescript
catch (error) {
  console.error(`[comment_on_issue] Failed on issue #${issue_number}:`, error);
  return `Error commenting on issue #${issue_number}: ${error}`;
}
```

`console.error` writes to stderr, which `poll.sh` captures via `2>&1` into `poll.log`. This makes errors searchable in logs regardless of what the LLM does with the error string.

**Impact:** Medium -- silent failures in unattended operation.
**Fix effort:** Small -- add one `console.error` line to each of the four catch blocks.

---

### Finding 10: The `since` parameter depends on LLM compliance

**File:** `src/index.ts:56-60` -- the `since` timestamp is embedded in the user message, relying on the LLM to pass it through to `fetch_github_issues`.

**What could go wrong?** The LLM might forget the `since` parameter, pass a different value, or call `fetch_github_issues` without it. Result: old issues are re-fetched and potentially re-processed.

**What you will learn:** When correctness is critical, enforce it in code, not in prompts. A safer approach: bake `since` into the tool at construction time:

```typescript
export function createGitHubIssuesTool(owner, repo, octokit, since?: string) {
  return tool(
    async ({ state, limit }) => {
      // 'since' is captured from the closure, not from the LLM
      const params = { owner, repo, state, per_page: limit, sort: 'updated', direction: 'desc' };
      if (since) params.since = since;
      // ...
    },
    // schema does NOT include 'since'
  );
}
```

The LLM controls *what* to fetch (state, limit) but not the time window. The orchestrator in `index.ts` controls the time window.

**Impact:** Low -- the LLM usually follows instructions, but correctness should not depend on "usually."
**Fix effort:** Small -- move one parameter from schema to constructor.

---

### Finding 11: Issue number extraction is fragile

**File:** `src/index.ts:91-108` -- extracting processed issue numbers from agent results.

**What could go wrong?** Two issues with the extraction logic:

1. **Regex matching on content** (line 104): The pattern `/"number":\s*(\d+)/g` matches any JSON field named "number" -- including PR numbers, comment IDs, or any tool result that contains a "number" field. If the `create_pull_request` result includes `"number": 7` (the PR number), it gets added to the processed issues list even though issue #7 might not have been processed.

2. **Tool call args check** (line 97): `call.args?.issue_number` only finds issue numbers from `comment_on_issue` calls. If the agent skips commenting but still creates a branch and PR for an issue, that issue number is missed in the tool_calls path and only caught (unreliably) by the regex.

**What you will learn:** Parsing structured information out of LLM conversations is inherently fragile. A more robust approach:
- Only count issues from `fetch_github_issues` results (these are the issues the agent was asked to process)
- Or add a dedicated tool like `mark_issue_processed(issue_number)` that the system prompt instructs the agent to call after completing all steps for an issue

Entry 4 acknowledges this challenge ("The trickiest part was figuring out which issues the agent actually processed") and chose the heuristic approach explicitly. For a learning project this is fine, but the fragility is worth understanding.

**Impact:** Low -- the `lastPollIssueNumbers` list is a safety net, not the primary filter (that is `since`).
**Fix effort:** Medium -- would require rethinking the extraction approach.

---

### Finding 12: `set -euo pipefail` in poll.sh conflicts with exit code capture

**File:** `poll.sh:5` and `poll.sh:24`

**What could go wrong?** `set -e` causes the script to exit immediately on any command failure. On line 23, `pnpm start >> "$LOG_FILE" 2>&1` runs the agent. If it fails (non-zero exit), `set -e` would terminate the script immediately -- but line 24 tries to capture `$?`. In bash, `set -e` does *not* trigger on the line before `$?` is captured, so this actually works. However, it is a subtle behavior that confuses many developers.

The real issue: if the `echo` on line 20 fails (e.g., disk full, `$LOG_FILE` path invalid), the script exits silently before running the agent, and the cron entry shows no output. With `set -e`, debugging "why did the poll not run?" is harder because there is no error message.

**What you will learn:** `set -e` is a blunt instrument. It is good practice for simple scripts, but for scripts with error handling logic, it can mask problems. An alternative is to use explicit error checks on critical commands:

```bash
pnpm start >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
```

For this learning project, the current `set -euo pipefail` is fine. Just know that it has these edge cases.

**Impact:** Very Low -- edge case only triggered by disk-full or permission errors.
**Fix effort:** N/A -- documenting for awareness.

---

### Finding 13: The `issues/` directory is created with a relative path

**File:** `src/index.ts:33` -- `fs.mkdirSync('./issues', { recursive: true });`

This has the same relative-path problem as Finding 1. If the process is started from a different directory, `./issues` is created in the wrong location. The fix is the same: use `import.meta.url` to resolve the path.

This is listed separately because it was added by the Builder in response to Entry 3's recommendation -- showing that even when addressing a known issue, the underlying path resolution problem can propagate into new code.

**Impact:** Same as Finding 1 -- included for completeness.

---

### Priority summary for improvements

| Priority | Finding | File | Effort | What it prevents |
|---|---|---|---|---|
| **High** | #6 Cron overlap protection | `poll.sh` | Small | Duplicate comments, failed branches |
| **High** | #7 Comment idempotency | `github-tools.ts` | Small | Comment spam on issues |
| **High** | #1, #13 Path resolution | `config.ts`, `index.ts` | Small | Silent failures outside poll.sh |
| **Medium** | #2 Zod config validation | `config.ts` | Small | Runtime type confusion |
| **Medium** | #3 API key in error msg | `agent.ts` | Trivial | Credential leak in logs |
| **Medium** | #8 Atomic poll state writes | `index.ts` | Small | Crash loop on corruption |
| **Medium** | #9 stderr logging in tools | `github-tools.ts` | Small | Invisible errors in cron |
| **Medium** | #4 process.exit -> throw | `config.ts` | Trivial | Stale locks, skipped cleanup |
| **Low** | #5 Label type guard | `github-tools.ts` | Trivial | Undefined labels |
| **Low** | #10 Bake `since` into tool | `github-tools.ts`, `index.ts` | Small | Polling reliability |
| **Low** | #11 Issue extraction fragility | `index.ts` | Medium | Incorrect processed-issues list |
| **Info** | #12 set -e edge case | `poll.sh` | N/A | Awareness only |

---

### Overall assessment

**What the team did well:**
- The Builder addressed every recommendation from Entry 3 (mkdir for issues/, PATH setup in poll.sh, error-string returns in all tools). This shows good design-to-implementation traceability.
- The shared Octokit client refactor (Entry 5) was done cleanly -- all tools accept the client as a parameter, created once in `agent.ts`.
- The `draft: true` hardcoding (Entry 6) is a good example of constraining agent capabilities through code rather than prompts.
- The system prompt is well-structured with explicit ordering and naming conventions.
- The issue number extraction heuristic (Entry 4) is pragmatic -- it acknowledges the fragility explicitly and justifies the approach.
- The teaching notes in Entries 4-6 are clear and connect to Entry 1's foundational concepts (tool pattern, shared client, separation of orchestration and capability).

**What was missed:**
- The original code problems (Findings 1-5) were not touched during implementation. The Builder focused on adding new code, not fixing existing issues. This is natural -- the task descriptions said "implement X," not "also fix pre-existing bugs." But it means the API key leak and type safety issues carry forward.
- Cron overlap (Finding 6) and comment idempotency (Finding 7) are the highest-impact gaps. Both are standard patterns in production bots and would be valuable additions to the learning narrative.
- Tool error logging (Finding 9) is the easiest high-value fix -- one line per tool.

**The learning takeaway:** Building the happy path is the first 80% of the work. Handling failure modes (crashes, overlaps, corruption, silent errors) is the remaining 20% of the work that determines whether your system is reliable in unattended operation. Every finding above is a case where the happy path works fine but an edge case would cause problems. Learning to anticipate these is what makes the difference between a prototype and a dependable tool.

### Connection to future work

If the team wants to address these findings, the recommended order is:
1. Fix the trivials first: API key leak (#3), process.exit (#4), label guard (#5)
2. Add cron overlap protection (#6) and comment idempotency (#7) -- these prevent real-world problems
3. Improve path resolution (#1, #13) and add Zod config validation (#2) -- these prevent "works on my machine" issues
4. Add stderr logging (#9) and atomic writes (#8) -- these improve operational visibility

---

## Entry 8: Dependency Map -- Why the 8 Phases Are Ordered This Way

**Date:** 2026-02-08
**Author:** Architect Agent
**Builds on:** Entries 1-7

### Purpose

This entry maps the dependencies between all 8 phases of the ROADMAP and explains why they are ordered the way they are. Each phase teaches a specific set of patterns relevant to building autonomous agents. If you are learning agent architecture, this map tells you *what to learn in what order* and *why that order matters*.

### The 8 phases at a glance

| Phase | Name | Issues | Core pattern taught |
|-------|------|--------|---------------------|
| 1 | Code Awareness | #1, #2 | **Tool composition** -- giving the agent new capabilities by adding tools |
| 2 | Safety & Idempotency | #5, #6, #7, #8, #9, #10, #11 | **Defensive agent design** -- bounding behavior so the agent is safe to run unattended |
| 3 | CLI & Testing | #23, #24 | **Developer experience** -- testing and operating the agent outside of production |
| 4 | Intelligence | #3, #4 | **Multi-agent architecture** -- LangGraph StateGraph, triage/analysis split |
| 5 | Resilience | #17, #22 | **Error recovery** -- retry, backoff, graceful shutdown |
| 6 | Webhook & Real-Time | #12, #13, #14, #18 | **Event-driven architecture** -- replacing polling with push-based processing |
| 7 | Deployment | #19, #20, #21 | **Production infrastructure** -- Docker, identity, monitoring |
| 8 | Reviewer Bot | #15, #16 | **Multi-bot pipeline** -- a second agent that reviews the first agent's output |

### Why this order? The dependency chain

```
Phase 1: Code Awareness
    |
    v
Phase 2: Safety & Idempotency
    |
    v
Phase 3: CLI & Testing
    |
    v
Phase 4: Intelligence ──────────────────────┐
    |                                        |
    v                                        |
Phase 5: Resilience                          |
    |                                        |
    v                                        |
Phase 6: Webhook & Real-Time                 |
    |                                        |
    v                                        |
Phase 7: Deployment                          |
    |                                        |
    v                                        v
Phase 8: Reviewer Bot (separate project, needs Phases 4+7)
```

Each arrow means: "The phase above must be complete (or mostly complete) before the phase below makes sense." Here is why for each transition.

### Phase 1 -> Phase 2: You need tools before you can constrain them

**Phase 1 (Code Awareness)** adds `list_repo_files` (#1) and `read_repo_file` (#2) -- two new tools that let the agent see the actual codebase, not just issue descriptions. This is **tool composition**: the same `tool()` factory pattern from Entry 1, applied to new capabilities.

**Why Phase 2 depends on Phase 1:** Phase 2's safety features (max issues per run, duplicate prevention, circuit breakers) are about *constraining* how the agent uses its tools. You cannot meaningfully constrain an agent that only has one read-only tool. Once the agent has tools that create branches, post comments, and open PRs (v0.1.0) *and* read the codebase (Phase 1), the constraint problem becomes real -- the agent could spam comments, create hundreds of branches, or make overlapping PRs. Phase 2 is the answer to "what if the agent goes rogue?"

**Issue-level dependencies within Phase 1:**
- **#1 (list_repo_files)** and **#2 (read_repo_file)** are independent -- they can be implemented in parallel. Neither requires the other. But together they form a complete picture: #1 lets the agent see *what files exist*, #2 lets it *read a specific file*. The agent's typical workflow will be: list files -> find relevant files -> read them -> incorporate into analysis.

### Phase 2 -> Phase 3: Safety first, then testing

**Phase 2 (Safety & Idempotency)** adds seven protective features:

| Issue | What it does | Why it matters |
|-------|-------------|----------------|
| #5 Max issues per run | Caps how many issues the agent processes per invocation | Prevents runaway API usage and LLM costs |
| #8 Prevent duplicate comments | Checks for an existing bot comment before posting | Prevents comment spam (the hidden-marker pattern from Entry 7) |
| #9 Prevent duplicate branches | Checks if a branch already exists before creating | Prevents "reference already exists" errors |
| #10 Prevent duplicate PRs | Checks if an open PR already exists for the branch | Prevents PR spam |
| #11 Track actions per issue | Records which steps completed for each issue | Enables crash recovery -- resume where you left off |
| #6 Circuit breaker | Limits total tool calls per agent invocation | Prevents infinite loops where the agent keeps calling tools |
| #7 Dry run mode | Runs the full pipeline but skips write operations | Enables safe testing without side effects |

**Issue-level dependencies within Phase 2:**
- **#5, #8, #9, #10** are independent -- each protects a different action
- **#11** (action tracking) logically comes after #8, #9, #10 because it tracks the *completion* of those idempotent actions
- **#6** (circuit breaker) is independent -- it operates at the agent framework level
- **#7** (dry run) should come last -- it needs all the other tools to exist so it can wrap them

**Why Phase 3 depends on Phase 2:** You cannot write meaningful tests for a bot that has no safety constraints. Phase 2 gives us deterministic, idempotent operations -- which are *testable*. Dry run mode (#7) is specifically designed for Phase 3's test infrastructure: tests run in dry-run mode so they never hit the real GitHub API.

### Phase 3 -> Phase 4: Test infrastructure enables confident refactoring

**Phase 3 (CLI & Testing)** adds:
- **#24 CLI wrapper** -- `deepagents poll`, `deepagents analyze --issue 5`, `deepagents dry-run`, `deepagents status`
- **#23 Test infrastructure** -- vitest setup, mocks for GitHub API and LLM, unit tests for core logic

**The CLI pattern:** Every feature gets a CLI subcommand that uses the same core code as the cron/webhook mode. This means `src/index.ts` evolves into a library of functions that the CLI calls, not a monolithic script. The CLI is both a developer tool and a stepping stone to the webhook handler (Phase 6).

**Why Phase 4 depends on Phase 3:** Phase 4 restructures the agent from a single ReAct loop into a two-phase pipeline (triage -> analysis). This is a significant refactor. Without test coverage from Phase 3, you are refactoring blind -- any regression goes unnoticed until a user discovers it. Tests make the Phase 4 refactor safe.

### Phase 4: The intelligence leap -- LangGraph StateGraph

**Phase 4 (Intelligence)** is the biggest conceptual jump in the project:
- **#3 Triage agent** -- a lightweight, fast agent that classifies and scopes each issue
- **#4 Analysis agent** -- a thorough, expensive agent that produces deep code-aware analysis

**The LangGraph pattern:** Instead of one agent doing everything, we use a **StateGraph** -- a directed graph where nodes are agent steps and edges are transitions. The graph looks like:

```
[Fetch Issues] --> [Triage Agent] --> [Analysis Agent] --> [Post Results]
                        |                                       ^
                        |-- (skip low-priority) ------> [Log & Skip]
```

**Why this teaches you something new:**
- **ReAct** (Entries 1-3): one agent, one loop, decides everything
- **StateGraph** (Phase 4): multiple agents, explicit transitions, each step has a defined role

The triage agent can use a cheap/fast model (Haiku, GPT-3.5). The analysis agent uses an expensive/thorough model (Opus, GPT-4). This is the **model routing** pattern -- use the right model for the right job.

**Why Phase 4 comes after Phase 3, not earlier:** The two-agent architecture is more complex to debug. Having the CLI (`deepagents analyze --issue 5`) and test infrastructure means you can test each agent independently before wiring them together in the StateGraph.

### Phase 5: Making it reliable

**Phase 5 (Resilience)** adds:
- **#17 Error handling with retry and backoff** -- exponential backoff for transient API failures (rate limits, network timeouts)
- **#22 Graceful shutdown** -- SIGTERM handling so container stops do not lose work

**The retry pattern:** Wrap tool API calls in a retry loop with exponential backoff: wait 1s, then 2s, then 4s, up to a maximum. This handles GitHub API rate limits (403 with `Retry-After` header) and transient network errors without manual intervention.

**The graceful shutdown pattern:** When the process receives SIGTERM (from Docker, systemd, or Ctrl+C), it finishes the current issue, saves poll state, and then exits. Without this, killing the process mid-run leaves `last_poll.json` in an inconsistent state (Entry 7, Finding 8).

**Why Phase 5 depends on Phase 4:** Retry logic applies to the multi-step pipeline from Phase 4. If the triage agent fails mid-run, we need to know whether to retry triage or skip to analysis. The StateGraph makes this explicit -- each node can have its own retry policy. Without the StateGraph, retry logic would be ad-hoc.

### Phase 6: From polling to events

**Phase 6 (Webhook & Real-Time)** replaces the cron-based polling with real-time event processing:
- **#12 HTTP webhook listener** -- an Express/Fastify server that receives GitHub webhook payloads
- **#13 Handle `issues.opened` event** -- trigger analysis when a new issue is created
- **#14 Handle `pull_request.opened` event** -- trigger analysis when a PR is opened
- **#18 Persistent job queue (PostgreSQL)** -- queue events and process them one at a time

**The event-driven pattern:** Instead of asking GitHub "any new issues?" every 15 minutes, GitHub *tells us* when something happens. This is push vs. pull. Benefits: instant response, no polling waste, no timing edge cases (Entry 3).

**Why the job queue:** Webhooks arrive in bursts. If 10 issues are opened simultaneously, we do not want 10 parallel agent runs (cost, rate limits, race conditions). A PostgreSQL job queue serializes processing: events are enqueued immediately, then dequeued and processed one at a time.

**Why Phase 6 depends on Phase 5:** The webhook listener must handle failures gracefully. If the agent crashes mid-analysis, the job should be retried (Phase 5's retry logic). If the server receives SIGTERM, in-flight jobs should be re-queued (Phase 5's graceful shutdown). Without resilience, the webhook system would lose events on every failure.

### Phase 7: Production deployment

**Phase 7 (Deployment)** makes it production-ready:
- **#21 Docker + Caddy** -- three-container stack: Caddy (reverse proxy + TLS), Node (the bot), PostgreSQL (job queue)
- **#20 Health check endpoint** -- `/health` endpoint that returns status (useful for Docker healthchecks and monitoring)
- **#19 GitHub App migration** -- replace Personal Access Token with a GitHub App (proper identity, fine-grained permissions, installation-level auth)

**Why Docker + Caddy:** Caddy handles TLS certificates automatically (Let's Encrypt). This is required for webhooks -- GitHub sends webhook payloads over HTTPS. The three-container architecture separates concerns: Caddy handles networking, Node handles logic, PostgreSQL handles state.

**Why GitHub App:** A Personal Access Token is tied to a human user. A GitHub App has its own identity (shows up as "bot" in comments), can be installed on specific repos, and has fine-grained permissions. This is the production-appropriate way to authenticate a bot.

**Why Phase 7 depends on Phase 6:** The Docker stack exists to host the webhook listener from Phase 6. Without webhooks, there is nothing to deploy -- the cron-based system runs on any machine with `crontab`.

### Phase 8: The second bot

**Phase 8 (Reviewer Bot)** is a separate project:
- **#15 PR review agent** -- a second agent that reads draft PRs and posts review comments
- **#16 `submit_pr_review` tool** -- wraps `octokit.rest.pulls.createReview()`

**The multi-bot pipeline:**

```
Issue opened
  -> Analyzer bot (this project)
      -> Comments on issue
      -> Creates draft PR
          -> Reviewer bot (Phase 8, separate project)
              -> Posts PR review
                  -> Human merges (or not)
```

**Why this is a separate project:** The reviewer bot has a different concern (code review vs. issue analysis), potentially different tools, and could use a different model. Keeping it separate demonstrates the **micro-agent** pattern -- small, focused agents that communicate through shared infrastructure (GitHub).

**Why Phase 8 depends on Phases 4 and 7:** The reviewer bot needs draft PRs to review (created by Phase 4's analysis agent) and a deployment platform to run on (Phase 7's Docker stack). It also needs the `pull_request.opened` webhook event from Phase 6 to trigger automatically.

### Issue dependency graph (all 24 issues)

```
Phase 1 (Code Awareness):
  #1 list_repo_files ─┐
  #2 read_repo_file  ─┤ (independent, implement in parallel)
                      │
Phase 2 (Safety):     v
  #5  max issues ─────┐
  #8  dup comments ───┤
  #9  dup branches ───┤── (independent, implement in any order)
  #10 dup PRs ────────┤
  #6  circuit breaker ┤
                      │
  #11 action tracking ┤── (depends on #8, #9, #10)
  #7  dry run ────────┘── (depends on all above)
                      │
Phase 3 (CLI/Test):   v
  #23 test infra ─────┤── (independent)
  #24 CLI wrapper ────┘── (independent, but benefits from #23)
                      │
Phase 4 (Intelligence): v
  #3 triage agent ────┐
                      v
  #4 analysis agent ──┘── (#4 depends on #3: triage runs first)
                      │
Phase 5 (Resilience): v
  #17 retry/backoff ──┤── (independent)
  #22 graceful shutdown┘── (independent)
                      │
Phase 6 (Webhooks):   v
  #12 HTTP listener ──┐
                      v
  #13 issues.opened ──┤── (depends on #12)
  #14 PR.opened ──────┤── (depends on #12)
                      v
  #18 job queue ──────┘── (depends on #12, #13, #14)
                      │
Phase 7 (Deploy):     v
  #21 Docker+Caddy ───┐
  #20 health check ───┤── (#20 depends on #21 for container context)
  #19 GitHub App ─────┘── (independent, can be done anytime)
                      │
Phase 8 (Reviewer):   v
  #15 PR review agent ┐
  #16 submit_pr_review┘── (#16 is the tool for #15)
```

### What each phase teaches about agent architecture

| Phase | Agent architecture concept | Real-world parallel |
|-------|---------------------------|---------------------|
| 1 | **Tool composition** -- adding capabilities by adding tools | Giving an employee new software access |
| 2 | **Guardrails** -- bounding agent behavior programmatically | Setting spending limits on a corporate card |
| 3 | **Observability** -- CLI/tests let you inspect what the agent does | QA and staging environments |
| 4 | **Multi-agent orchestration** -- LangGraph StateGraph | Assembly line with specialized stations |
| 5 | **Fault tolerance** -- retry, recovery, graceful degradation | Circuit breakers in electrical systems |
| 6 | **Event-driven processing** -- webhook + job queue | Notification systems, message brokers |
| 7 | **Deployment** -- containers, identity, monitoring | DevOps, infrastructure-as-code |
| 8 | **Agent-to-agent communication** -- one bot reviews another | Peer review, separation of duties |

### Versioning plan

The project is currently at **v0.1.1** (multi-provider LLM support). Going forward:

- **Patch bumps** (v0.1.2, v0.1.3, ...) for each issue completed within a phase
- **Minor bumps** at phase milestones:
  - v0.2.0 -- Phase 1 complete (code-aware agent)
  - v0.3.0 -- Phase 2 complete (safe to run unattended)
  - v0.4.0 -- Phase 3 complete (CLI + tests)
  - v0.5.0 -- Phase 4 complete (two-agent pipeline)
  - v0.6.0 -- Phase 5 complete (resilient operations)
  - v0.7.0 -- Phase 6 complete (real-time webhooks)
  - v0.8.0 -- Phase 7 complete (production deployment)
  - v1.0.0 -- Phase 8 complete (full pipeline with reviewer bot)

Each patch bump gets a CHANGELOG entry. Each minor bump is a milestone moment that warrants a LEARNING_LOG summary entry reflecting on what was learned in that phase.

### Connection to next entries

The Builder agents will now implement Phase 1:
- Entry 9: Implementing `list_repo_files` tool (#1) -- extends the tool composition pattern from Entry 1
- Entry 10: Implementing `read_repo_file` tool (#2) -- same pattern, different API calls

After Phase 1, we will write a Phase 1 retrospective entry before moving to Phase 2.

---

## Entry 9: Implementing `list_repo_files` Tool (Issue #1)

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entries 1, 2, 8
**Issue:** #1 — Add `list_repo_files` tool (repo map)
**Version:** v0.1.2

### What just happened?

We added a `list_repo_files` tool to `src/github-tools.ts` and wired it into the agent in `src/agent.ts`. The agent can now see the repository's file structure -- a prerequisite for code-aware analysis.

### The pattern: Multi-step API calls to traverse Git's object model

This tool requires **three** sequential GitHub API calls, making it the most API-intensive tool in the project so far. Understanding *why* three calls are needed teaches you how Git stores data internally.

```
Branch name ("main")
    |
    v
[git.getRef] --> commit SHA
    |
    v
[git.getCommit] --> tree SHA
    |
    v
[git.getTree(recursive)] --> list of all files
```

**Why three calls?** Git stores data as a hierarchy of objects:
1. A **ref** (branch) points to a **commit**
2. A **commit** points to a **tree** (the root directory)
3. A **tree** contains **blobs** (files) and nested **trees** (subdirectories)

To list files, we need the tree SHA. To get the tree SHA, we need the commit. To get the commit, we start from the branch ref. Each step resolves one level of Git's indirection.

**Contrast with `create_branch`:** That tool (Entry 6) uses only two calls (getRef + createRef) because creating a branch only needs the commit SHA, not the tree. The difference shows how different operations need different depths of the Git object graph.

### The `recursive: 'true'` parameter

`octokit.rest.git.getTree()` accepts a `recursive` parameter. Without it, you only get the top-level directory entries (including sub-tree objects). With `recursive: 'true'`, GitHub flattens the entire tree into a single list of all files at all depths. This saves us from having to manually traverse sub-trees.

**The catch:** GitHub truncates recursive trees at around 100,000 entries. For enormous monorepos, the result may be incomplete. We detect this with `tree.truncated` and include a warning in the response. For normal repositories, this is never hit.

```typescript
if (tree.truncated) {
  return JSON.stringify({
    files,
    warning: 'Tree was truncated by GitHub API (repo has too many files). Results may be incomplete.',
    total: files.length,
  }, null, 2);
}
```

### Path prefix filtering

The tool accepts an optional `path` parameter (e.g., `"src/"`) that filters results client-side. Why not server-side? The GitHub Tree API does not support filtering -- it returns the entire tree. We filter after fetching.

```typescript
const prefix = path ? (path.endsWith('/') ? path : path + '/') : '';
const files = tree.tree
  .filter((item) => item.type === 'blob')
  .filter((item) => !prefix || item.path?.startsWith(prefix))
```

**Design choice:** We normalize the prefix to always end with `/`. This prevents `"src"` from matching `"srcutils/helper.ts"`. A small detail, but important for correctness.

**Alternative considered:** Fetching only the sub-tree for the given path (using `git.getTree` with the sub-tree's SHA). This would be more efficient for deeply nested paths but adds another API call to resolve the sub-tree SHA, and complicates the code for a marginal performance gain. For a learning project, simplicity wins.

### Why this tool matters for the agent

Before this tool, the agent analyzed issues purely from their title and description. It was guessing about code structure. Now the agent can:
1. Call `list_repo_files()` to see the complete file tree
2. Identify which files are likely relevant to the issue
3. Reference specific file paths in its analysis and PR descriptions

This is the first half of **code awareness** (Phase 1). The second half -- `read_repo_file` (Entry 10) -- will let the agent read actual file contents. Together, they transform the agent from "reading the summary" to "reading the code."

### Wiring into the agent

The tool is added to the imports in `agent.ts`, instantiated with the shared Octokit client, and included in the tools array. The system prompt is updated to tell the agent to use `list_repo_files` during the analysis step:

```
1. ANALYZE the issue:
   - ...
   - Use list_repo_files to see the repo structure and identify relevant files
   - ...
```

This prompt change is subtle but important. Without it, the agent might never discover or use the tool. The system prompt is the agent's playbook -- new capabilities must be announced there.

### The "aha moment"

**Git's object model is a content-addressable tree, and every API that touches Git operates on this tree.** The branch -> commit -> tree -> blob chain is not an API design quirk -- it mirrors how Git itself stores data. Once you internalize this model, every Git API call makes sense: you are always navigating the same tree structure, just starting from different points.

This is why `create_branch` needs two calls (branch -> commit -> create new branch pointing to same commit), and `list_repo_files` needs three calls (branch -> commit -> tree -> enumerate blobs). The number of API calls directly corresponds to how deep into the object graph you need to go.

### Connection to next entry

Entry 10 will implement `read_repo_file` (#2) -- the companion tool that reads a specific file's content. Together with `list_repo_files`, this completes Phase 1 (Code Awareness). The agent will be able to navigate and read the codebase, making its analysis genuinely code-aware.

---

## Entry 10: Implementing `read_repo_file` Tool (Issue #2)

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entries 1, 2, 8, 9
**Issue:** #2 -- Add `read_repo_file` tool (code reading)
**Version:** v0.1.3

### What just happened?

We added a `read_repo_file` tool to `src/github-tools.ts` and wired it into the agent. Together with `list_repo_files` (Entry 9), this completes Phase 1 -- the agent is now **code-aware**. It can list the repository's file structure, then read individual files to understand the actual code before analyzing issues.

### The pattern: Content API with base64 decoding

Unlike `list_repo_files` (which traverses Git's object model via the Tree API), `read_repo_file` uses GitHub's higher-level **Content API** (`repos.getContent`). This is a convenience endpoint that combines the steps of resolving a path to a blob and fetching the blob's content.

```typescript
const { data } = await octokit.rest.repos.getContent({
  owner, repo, path, ref: branch,
});
```

**Why the Content API instead of the Blob API?** The Blob API (`git.getBlob`) requires the blob's SHA. To get the SHA, you would need to traverse the tree (like `list_repo_files` does), find the blob entry for the given path, and extract its SHA. The Content API accepts a human-readable file path and does the lookup internally. One API call instead of three.

**The trade-off:** The Content API has a **1MB file size limit**. Files larger than 1MB return metadata but no content. The Blob API does not have this limit (it can fetch up to 100MB). For this learning project, 1MB is sufficient -- most source files are well under this limit. A production tool might fall back to the Blob API for large files.

### Line truncation: protecting LLM context

Even under 1MB, a file can be thousands of lines long. Sending all of that to the LLM wastes context tokens and can push important information out of the context window. We truncate files over 500 lines:

```typescript
const MAX_LINES = 500;
const lines = fullContent.split('\n');
const truncated = lines.length > MAX_LINES;
const content = truncated ? lines.slice(0, MAX_LINES).join('\n') : fullContent;
```

When truncation occurs, the response includes metadata telling the agent what happened:

```json
{ "truncated": true, "total_lines": 1200, "shown_lines": 500,
  "note": "File has 1200 lines. Only the first 500 are shown." }
```

**Why 500 lines?** It is a practical middle ground. Most source files in well-structured projects are under 500 lines. Files over 500 lines are often generated code, large configs, or modules that should be split. The agent can still understand the file's structure from the first 500 lines.

**Why truncate in the tool, not in the prompt?** The prompt could say "only read the first 500 lines" but the LLM might ignore that. Truncating in code guarantees the limit is enforced -- this follows the Phase 2 principle of "constrain in code, not in prompts" (Entry 8).

### Base64 decoding

GitHub returns file content as a base64-encoded string. This is because the API response is JSON, and JSON cannot safely contain binary data or certain control characters. Base64 encoding ensures the content is valid JSON text regardless of what the file contains.

```typescript
// Decode base64 content to UTF-8 string
const content = Buffer.from(data.content, 'base64').toString('utf-8');
```

**Why `Buffer.from` and not `atob`?** In Node.js, `Buffer.from(str, 'base64')` is the standard way to decode base64. The `atob` function exists in browsers but was only added to Node.js in v16 and handles Unicode differently. `Buffer` is more reliable for server-side base64 work.

### Handling the Content API's union return type

`repos.getContent` can return four different things depending on what `path` points to:

| Path points to | Return type | Our response |
|----------------|-------------|--------------|
| A file | Object with `content` and `encoding` | Decode and return content |
| A directory | Array of file entries | Return error: "use list_repo_files" |
| A symlink | Object with `type: 'symlink'` | Return error: not a file |
| A submodule | Object with `type: 'submodule'` | Return error: not a file |

```typescript
if (Array.isArray(data)) {
  return `Error: '${path}' is a directory, not a file. Use list_repo_files to browse directories.`;
}
if (data.type !== 'file') {
  return `Error: '${path}' is a ${data.type}, not a file.`;
}
```

**Why check `Array.isArray` first?** The directory case returns an array, while the file/symlink/submodule cases return an object. Checking for the array distinguishes directories from everything else. Then we check `data.type` to handle non-file objects.

**The error messages guide the agent.** Notice that the directory error says "Use list_repo_files to browse directories." This teaches the LLM the correct tool to use, reducing the chance it retries `read_repo_file` with the same path.

### How `list_repo_files` and `read_repo_file` work together

These two tools form a **browse-then-read** pattern:

```
Agent's mental model:
  1. "What files does this repo have?" --> list_repo_files()
  2. "Let me look at the relevant file"  --> read_repo_file("src/index.ts")
  3. "Now I understand the code"         --> code-aware analysis
```

This mirrors how a human developer works: you open the file explorer, find the file, then open it. The system prompt guides the agent to follow this pattern:

```
1. ANALYZE the issue:
   - ...
   - Use list_repo_files to see the repo structure and identify relevant files
   - Use read_repo_file to read the source code of files related to the issue
   - ...
   - Think about what a fix would involve based on actual code
```

### What changes from "guessing" to "code-aware"

Before Phase 1, the agent's analysis looked like:
> "Based on the issue description, this bug is probably in the authentication module. The fix would likely involve changing the token validation logic."

After Phase 1, the analysis can look like:
> "I read `src/auth.ts` (lines 42-58) and found that `validateToken()` does not check for expired tokens. The fix involves adding an expiry check after the signature verification on line 47."

This is the difference between a summary and an analysis. The agent now has evidence.

### The "aha moment"

**The Content API is a convenience wrapper, not a fundamental primitive.** Every operation the Content API does (resolve path to blob, fetch blob content, decode) can be done manually with the lower-level Git APIs we used in `list_repo_files`. The Content API bundles them into one call with a friendlier interface.

This is a common pattern in APIs: low-level primitives give you maximum flexibility (Git Tree/Blob APIs), while high-level convenience endpoints handle common cases more easily (Content API). Know both layers -- use the convenience API for simple cases, fall back to primitives when you need more control.

### Phase 1 complete

With `list_repo_files` (v0.1.2) and `read_repo_file` (v0.1.3), Phase 1 is done. The agent now has six custom tools:

| Tool | Entry | API Pattern |
|------|-------|-------------|
| `fetch_github_issues` | Entry 1 | Single API call |
| `comment_on_issue` | Entry 5 | Single API call |
| `create_branch` | Entry 6 | Two sequential API calls |
| `create_pull_request` | Entry 6 | Single API call |
| `list_repo_files` | Entry 9 | Three sequential API calls |
| `read_repo_file` | Entry 10 | Single API call (convenience) |

Each tool added complexity in a different dimension: more API calls, different return types, different error modes. Together they show the full spectrum of the tool composition pattern.

### Connection to next entries

With Phase 1 complete, the Critic will review both tools against the guiding principles (Task #4). After that review, Phase 2 (Safety & Idempotency) begins -- adding guardrails so the agent can run unattended without causing problems.

---

## Entry 11: Critic's Phase 1 Review -- Code Awareness Tools, Edge Cases, and Version Bump

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviews:** Entries 8, 9, 10 (Architect dependency map + Builder Phase 1 implementations)
**Files reviewed:** `src/github-tools.ts` (lines 197-327), `src/agent.ts`, `CHANGELOG.md`, `README.md`, `package.json`

### Purpose of this entry

This is the Phase 1 gate review. Entry 7 reviewed the v0.1.0 base implementation. This entry reviews the Phase 1 additions (`list_repo_files` and `read_repo_file`) against the project's guiding principles, pressure-tests edge cases, evaluates teaching notes, and makes a version bump recommendation.

---

### Guiding principles check

The ROADMAP lists six guiding principles. Here is how Phase 1 measures up:

| Principle | Verdict | Notes |
|---|---|---|
| 1. Learning first | Pass | Entries 9-10 explain Git's object model, base64 encoding, and Content vs. Blob API trade-offs. Good teaching value. |
| 2. Incremental | Pass | Two tools added, each with its own patch bump (v0.1.2, v0.1.3). No existing code was broken. |
| 3. Simple file structure | Pass | Both tools live in `github-tools.ts` alongside the existing four tools. No new files created. |
| 4. CLI as the wrapper | N/A | Phase 3 concern. No CLI exists yet. |
| 5. Humans decide | Pass | Neither tool takes any write action. Both are read-only. The agent reads code but never modifies it. |
| 6. GitHub as the event bus | Pass | Both tools use GitHub's native API (Git Tree, Content API). No custom infrastructure. |

**Overall:** Phase 1 is well-aligned with all applicable guiding principles.

---

### Finding 1: `list_repo_files` returns the entire tree to the LLM -- token cost risk

**File:** `src/github-tools.ts:238-244`

**What happens:** The tool fetches the full recursive tree and sends every file path + size to the LLM as JSON. For a small learning repo (20-50 files), this is fine. For a real project (thousands of files), the JSON response could be 50-100KB of text, consuming a significant portion of the LLM's context window.

**What could go wrong at scale:**
- A repo with 5,000 files generates ~200KB of JSON. At ~4 chars per token, that is ~50,000 tokens. Claude's context can handle this, but it consumes expensive input tokens on *every issue analyzed*.
- The path prefix filter helps (`path: "src/"`) but depends on the LLM choosing to use it. The system prompt does not tell the agent to filter by path -- it just says "use list_repo_files to see the repo structure."

**The learning moment:** Tool responses are LLM input. Every byte of a tool response costs tokens. When designing tools for LLM agents, consider: "What is the maximum possible size of this response, and is the LLM actually going to use all of it?"

**Concrete improvement:** Add a `max_files` parameter (defaulting to, say, 200) that truncates the result with a warning. And update the system prompt to suggest using path filtering for large repos.

**Impact:** Low for this learning project (small repos). High if pointed at a real production repo.
**Effort:** Small -- one schema parameter, one filter, one prompt line.

---

### Finding 2: `read_repo_file` sends raw file content to the LLM -- no size guard

**File:** `src/github-tools.ts:306-313`

**What happens:** The tool decodes the full file content and returns it inside a JSON object. The 1MB GitHub API limit is mentioned in the docstring and handled in the error case (line 301-303), but files *under* 1MB are returned in full.

**What could go wrong:**
- A 500KB minified JavaScript file or a 300KB CSV would be sent to the LLM verbatim. The LLM cannot usefully analyze a minified file, so those tokens are wasted.
- The agent might call `read_repo_file` on every file in the repo, one by one. Without a guard, a multi-file reading spree on moderately-sized files could consume 100K+ tokens.

**The learning moment:** This is directly related to Finding 1 but on a per-file basis. Both tools need to consider: "Is the response size proportional to its usefulness?"

**Concrete improvement:** Truncate content at a sensible limit (e.g., 50KB / ~12,000 tokens) and return a warning when truncated.

**Impact:** Medium -- one large file read can dominate the context window.
**Effort:** Small -- ~8 lines.

---

### Finding 3: Binary files decoded as UTF-8 produce garbage

**File:** `src/github-tools.ts:306` -- `Buffer.from(data.content, 'base64').toString('utf-8')`

**What happens:** If the agent calls `read_repo_file("logo.png")`, the base64 content is decoded as UTF-8 text. The result is garbage characters that consume tokens and confuse the LLM.

**Why the agent might do this:** The `list_repo_files` tool returns *all* blobs, including images, fonts, and compiled files. The LLM sees `logo.png` in the file list and might read it if the issue mentions the logo.

**The fix:** Check if the file is likely binary before decoding. A simple heuristic: check the file extension against a known list of binary extensions and return a descriptive message like `"(binary file -- content not shown)"` instead.

**Impact:** Low -- the LLM typically does not read binary files, but there is no guardrail if it does.
**Effort:** Small -- ~6 lines.

---

### Finding 4: Empty repositories cause unhandled 404

**File:** `src/github-tools.ts:213-217` -- `git.getRef` in `list_repo_files`

**What happens:** If `list_repo_files` is called on a repository that is completely empty (no commits, no branches), the `git.getRef` call returns a 404. The try/catch returns a generic error string.

**Why it matters:** A user following the README might create a fresh empty repo and see a confusing error.

**Concrete improvement:** Detect 404 in the catch block and return a targeted message like "Branch 'main' not found. The repository may be empty or the branch name may be incorrect."

**Impact:** Low -- edge case for new users.
**Effort:** Trivial -- 3 lines.

---

### Finding 5: Three API calls per `list_repo_files` invocation -- rate limit awareness

**File:** `src/github-tools.ts:213-234`

**What is happening:** The tool calls `getRef` -> `getCommit` -> `getTree` every time. If the agent calls `list_repo_files` multiple times per issue (once unfiltered, then filtered by `"src/"`, then by `"test/"`), that is 9 API calls just for file listing.

**Not a recommended fix for now.** Caching the tree SHA would reduce subsequent calls from 3 to 1, but adds complexity (cache invalidation, closure state). GitHub's rate limit is 5,000 requests/hour for authenticated requests, so this is not a bottleneck for a learning project. Mentioning it for awareness because Phase 2 will add more tools that make API calls.

**Impact:** Low.
**Effort:** Medium.

---

### Finding 6: `list_repo_files` and `create_branch` share `getRef` pattern -- teaching opportunity

**File:** `src/github-tools.ts:118-122` (create_branch) and `src/github-tools.ts:213-218` (list_repo_files)

Both tools start with the exact same `getRef` call to resolve a branch name to a commit SHA. This is not a bug -- four lines of duplication in a 327-line file is not worth abstracting. But Entry 9 could strengthen the teaching by noting: "Notice this is the same `git.getRef()` call as `create_branch` (Entry 6). Both operations begin by resolving a branch name to a commit SHA -- the first step in navigating Git's object model."

**Impact:** None (informational).

---

### Teaching notes accuracy check (Entries 8, 9, 10)

| Claim | Accurate? | Notes |
|---|---|---|
| Entry 8: "currently at v0.1.1" | Stale | Project is now at v0.1.3. The version plan itself is correct. Minor inconsistency. |
| Entry 9: recursive trees truncate at ~100,000 entries | Correct | GitHub documents this. Code handles it with `tree.truncated`. |
| Entry 9: client-side filtering (Tree API has no server-side filter) | Correct | |
| Entry 9: normalizing prefix to always end with `/` | Correct | `github-tools.ts:237` does this. |
| Entry 10: Content API 1MB limit | Correct | Code checks for missing content (line 301). |
| Entry 10: `Buffer.from` vs `atob` | Correct | |
| Entry 10: Content API union return type (4 cases) | Correct | Code checks array (directory), type !== 'file', and missing content. |
| Entry 10: browse-then-read pattern | Correct and well-explained | Good parallel to human developer workflow. |

**Overall:** Teaching notes are accurate. Entry 9's Git object model explanation and Entry 10's Content API union type handling are particularly clear.

---

### Version bump assessment: Should 0.1.3 become 0.2.0?

**The case for 0.2.0:**
- Phase 1 is complete. The ROADMAP says Phase 1 is "Code Awareness" with issues #1 and #2, both now implemented.
- Entry 8's versioning plan explicitly maps v0.2.0 to Phase 1 completion.
- The CHANGELOG header echoes this: "v0.2.0 = Phase 1 (Code Awareness)."
- This is a meaningful capability milestone: the agent went from guessing about code to reading actual source files.

**The case against 0.2.0:**
- None. The project's own versioning plan says v0.2.0 = Phase 1 complete. Phase 1 is complete.

**Recommendation:** Bump to v0.2.0. This is not a "bigger than a patch" challenge -- the Architect's versioning plan in Entry 8 explicitly reserves v0.2.0 for this moment. Shipping Phase 1 as v0.1.3 contradicts the documented plan.

---

### Comparison with Entry 7 findings: what is still open?

| Entry 7 finding | Status | Notes |
|---|---|---|
| #1, #13 Path resolution (relative `./`) | **Still open** | Affects config.ts, index.ts |
| #2 Config type safety (JSON.parse -> any) | **Still open** | |
| #3 API key in error message | **Fixed** | model.ts refactor resolved this |
| #4 process.exit in config.ts | **Still open** | |
| #5 Labels map type guard | **Still open** | github-tools.ts:48 |
| #6 Cron overlap protection | **Still open** | Addressed by Phase 2 |
| #7 Comment idempotency | **Still open** | Addressed by Phase 2 (ROADMAP #8) |
| #8 Atomic poll state writes | **Still open** | |
| #9 stderr logging in tool catch blocks | **Still open** | |
| #10 Bake `since` into tool | **Still open** | |
| #11 Issue number extraction fragility | **Still open** | |
| #12 set -e edge case | **Still open** | Info only |

12 of 13 findings remain open. Findings #6 and #7 are directly addressed by Phase 2 tasks.

---

### Overall assessment

**What the team did well:**
- Both tools are correctly implemented. `list_repo_files` properly traverses Git's object model (ref -> commit -> tree). `read_repo_file` correctly handles the Content API's union return type.
- The truncation warning for large trees (`tree.truncated`) shows awareness of API limits.
- Error messages in `read_repo_file` guide the LLM to the correct tool ("Use list_repo_files to browse directories").
- The system prompt was updated with the correct ordering (list first, then read).
- Teaching notes are accurate and well-connected to previous entries.
- README updated with new workflow steps and example output.

**What could be improved:**
- Token cost awareness is the main gap. Both tools return unbounded text to the LLM. Response size limits would improve cost and reliability.
- Binary file handling is missing.
- Version should be bumped to v0.2.0 per the project's own versioning plan.

**The learning takeaway:** Phase 1 demonstrates **tool composition** cleanly -- two new read-only tools added without changing existing code. The deeper lesson is about *response design*: a tool's return value is LLM input, and its size directly affects cost and quality. Designing tools for LLM agents requires thinking about both the *action* (what the tool does) and the *observation* (what the LLM receives back).

### Connection to next work

Phase 2 (Safety & Idempotency) begins after this review. Key items that Phase 2 addresses:
- Comment idempotency (Entry 7 #7 -> ROADMAP #8)
- Duplicate branch prevention (ROADMAP #9)
- Duplicate PR prevention (ROADMAP #10)
- Max issues per run (ROADMAP #5) -- also addresses token cost concerns from this entry

Response size limits from Findings #1 and #2 could be addressed as quick patches before Phase 2 or folded into Phase 2's "bounded resource usage" theme.

---

## Entry 12: Implementing Max Issues Per Run (Issue #5)

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entries 8, 11
**Issue:** #5 -- Max issues per run
**Version:** v0.2.1

### What just happened?

We added a configurable cap on how many issues the agent processes per invocation. This is the first Phase 2 feature -- a **guardrail** that bounds the agent's resource consumption.

### The pattern: Orchestration-level constraints

This is not a tool change -- it is an orchestration change in `src/index.ts`. The `fetch_github_issues` tool already has a `limit` parameter, but it was controlled by the LLM. Now the orchestrator passes the limit explicitly in the user message:

```typescript
const maxIssues: number = config.maxIssuesPerRun ?? DEFAULT_MAX_ISSUES_PER_RUN;

const pollingContext = sinceDate
  ? `Fetch open issues updated since ${sinceDate} (limit: ${maxIssues}) ...`
  : `Fetch open issues (limit: ${maxIssues}) ...`;
```

**Why in the user message, not baked into the tool?** The `fetch_github_issues` tool's `limit` parameter has a general purpose -- it controls how many issues are returned from the API. The "max issues per run" is an orchestration concern: it controls how much *work* the agent does in one session. These are different concepts. The tool limit says "show me N issues." The run limit says "only process N issues total." They happen to align here because we want to fetch at most N issues, but in the future the agent might need to fetch 100 issues, filter to 5 relevant ones, and process only those.

**Why also configurable?** The default of 5 is conservative. A user with a low-traffic repo might want 20. A user watching a busy repo might want 3 to keep costs down. The `maxIssuesPerRun` field in `config.json` lets them choose.

### Why this matters for unattended operation

Without this cap, the agent processes *all* open issues on every run. Consider a scenario:
- The repo has 50 open issues
- First poll run fetches all 50
- Each issue triggers: fetch -> list files -> read files -> comment -> branch -> PR
- That is 50 x (5+ API calls + LLM inference) = 250+ API calls + 50 LLM completions
- At $0.03/1K tokens, analyzing 50 issues could cost $5-10 per run
- With a 15-minute cron, that is $480-960/day

The cap prevents this. With `maxIssuesPerRun: 5`, the worst case is 5 issues per run. Unprocessed issues are handled in the next cron cycle.

### The "aha moment"

**Guardrails are not about limiting the agent's intelligence -- they are about limiting its blast radius.** The agent is still free to analyze each issue as thoroughly as it wants. The guardrail only controls *how many* issues it works on. This is the difference between constraining *quality* (bad) and constraining *scope* (good). Phase 2 is all about scope constraints.

### Connection to next entries

The next entry implements idempotency checks for the agent's write operations: duplicate comment prevention (#8), duplicate branch prevention (#9), and duplicate PR prevention (#10). These are *tool-level* guardrails, complementing this *orchestration-level* guardrail.

---

## Entry 13: Making Write Tools Idempotent (Issues #8, #9, #10)

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entries 5, 6, 7, 12
**Issues:** #8 (duplicate comments), #9 (duplicate branches), #10 (duplicate PRs)
**Versions:** v0.2.2, v0.2.3, v0.2.4

### What just happened?

We made all three write tools idempotent: `comment_on_issue`, `create_branch`, and `create_pull_request`. Each tool now checks for the existence of its output before creating it, and returns `{ skipped: true }` if the output already exists. This means the agent can safely be re-run against the same issues without creating duplicates.

### What is idempotency and why it matters for agents?

An operation is **idempotent** if performing it multiple times produces the same result as performing it once. `GET /issues` is naturally idempotent -- fetching issues twice gives you the same issues. `POST /comments` is not -- posting twice creates two comments.

For an agent running on a cron schedule, idempotency is critical because:
1. **Crash recovery:** If the agent crashes after commenting but before saving poll state, the next run re-processes the same issue. Without idempotency, the issue gets a duplicate comment.
2. **Cron overlap:** If a run takes longer than the cron interval, two runs process the same issues simultaneously (Entry 7, Finding #6).
3. **Manual re-runs:** A developer running `pnpm start` twice for debugging should not cause duplicate side effects.

### Three different idempotency patterns

Each tool uses a different technique suited to its API:

#### Pattern 1: Hidden HTML marker (comments)

```typescript
const BOT_COMMENT_MARKER = '<!-- deep-agent-analysis -->';

// Check existing comments for our marker
const { data: existingComments } = await octokit.rest.issues.listComments({...});
const alreadyCommented = existingComments.some(c => c.body?.includes(BOT_COMMENT_MARKER));

if (alreadyCommented) return { skipped: true, reason: '...' };

// Include marker in new comments
const markedBody = `${BOT_COMMENT_MARKER}\n${body}`;
```

**Why HTML comments?** GitHub's Markdown renderer hides HTML comments (`<!-- -->`). Users never see the marker, but our code can find it. This is the standard pattern used by Dependabot, Renovate, and other GitHub bots.

**Why not check by author?** The bot posts under the token owner's account (a human user), not a dedicated bot account. Filtering by author would skip the human's own comments. The hidden marker is more specific -- it only matches comments that our code created.

#### Pattern 2: Existence check with 404 detection (branches)

```typescript
try {
  await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch_name}` });
  // Branch exists -- skip
  return { skipped: true, reason: '...' };
} catch (e) {
  if ((e as { status?: number }).status !== 404) throw e;
  // 404 = branch does not exist -- proceed to create
}
```

**Why try/catch instead of a list query?** The GitHub Refs API has no "check if ref exists" endpoint. The only way to check is to try to fetch it. A 404 means it does not exist (proceed), any other error is a real failure (re-throw).

**Why check for the specific 404 status?** Other errors (401 unauthorized, 403 rate limited, 500 server error) should not be silently swallowed. We only catch the "not found" case and let everything else propagate to the outer try/catch.

#### Pattern 3: List query with filter (PRs)

```typescript
const { data: existingPRs } = await octokit.rest.pulls.list({
  owner, repo,
  head: `${owner}:${head}`,
  base,
  state: 'open',
});

if (existingPRs.length > 0) {
  return { skipped: true, existing: existingPRs[0].html_url };
}
```

**Why list instead of try/catch?** Unlike branches, PRs can be queried by head branch. The `pulls.list` API supports filtering by `head` (the source branch) and `state`. This is cleaner than catching errors from `pulls.create`.

**Why filter by `state: 'open'`?** A closed or merged PR for the same branch should not prevent creating a new one. The issue might have been reopened with new information, warranting a fresh analysis and PR.

**The `owner:branch` format:** The `head` filter requires the full `owner:branch` format (e.g., `jaaacki:issue-42-fix-login`). This is because PRs can come from forks, so the owner prefix disambiguates.

### The `{ skipped: true }` return pattern

All three tools return the same structure when skipping:

```json
{
  "skipped": true,
  "reason": "Human-readable explanation",
  // Plus relevant context (branch URL, PR number, etc.)
}
```

**Why a structured response instead of an error?** Skipping is not an error -- it is correct behavior. The agent should see "already done" and move on to the next step, not treat it as a failure to recover from. The `reason` field helps the LLM understand what happened and include it in its analysis report.

### Cost of idempotency: extra API calls

Each idempotency check adds one API call per tool invocation:
- `comment_on_issue`: +1 call (`listComments`) per issue
- `create_branch`: +1 call (`getRef`) per issue
- `create_pull_request`: +1 call (`pulls.list`) per issue

For 5 issues per run, that is 15 extra API calls. Against GitHub's 5,000/hour rate limit, this is negligible. The cost is worth the safety -- preventing duplicate comments, branches, and PRs is more important than saving 15 API calls.

### The "aha moment"

**Idempotency is not a single pattern -- it is a principle that adapts to each API's capabilities.** Comments use markers (no native dedup mechanism). Branches use existence checks (the only query available). PRs use list-and-filter (the API supports it natively). The common thread is: *check before you write, and return gracefully if the work is already done.*

This is the tool-level complement to Entry 12's orchestration-level guardrail (max issues per run). Together, they form a defense-in-depth: the orchestrator limits *how many* issues are processed, and the tools ensure *each issue* is processed safely.

### Connection to next work

With these four Phase 2 features (max issues, idempotent comments, idempotent branches, idempotent PRs), the agent is significantly safer for unattended operation. The remaining Phase 2 issues (#11 action tracking, #6 circuit breaker, #7 dry run) add further layers of protection.

---

## Entry 14: Critic's Phase 2 Review -- Safety, Idempotency, and What Can Still Go Wrong

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviews:** Entries 12-13 (Builder Phase 2 implementations: #5, #8, #9, #10)
**Files reviewed:** `src/github-tools.ts` (idempotency checks), `src/index.ts` (maxIssuesPerRun), `src/agent.ts` (system prompt), `config.json.example`, `CHANGELOG.md`, `README.md`, `package.json`

### Purpose of this entry

Phase 2 is about making the bot safe to run unattended. This review pressure-tests the four implemented safety features by asking: "Can the bot still cause problems despite these checks?" Every finding is a scenario where the guardrails might not hold.

---

### Guiding principles check

| Principle | Verdict | Notes |
|---|---|---|
| 1. Learning first | Pass | Entry 13's three-pattern comparison (marker, 404, list-filter) is excellent teaching. Entry 12's "scope vs. quality" distinction is clear. |
| 2. Incremental | Pass | Four features, each with its own patch bump (v0.2.1-v0.2.4). Existing behavior preserved for new issues. |
| 3. Simple file structure | Pass | All changes in existing files. No new source files created. |
| 4. CLI as the wrapper | N/A | Phase 3 concern. |
| 5. Humans decide | Pass | Idempotency checks prevent automated spam. The agent still proposes, never merges. |
| 6. GitHub as the event bus | Pass | All checks use GitHub's native APIs. No custom state beyond `last_poll.json`. |

**Overall:** Well-aligned with guiding principles. The idempotency pattern is the right approach for a bot that writes to GitHub.

---

### Bonus: Entry 11 Finding #2 addressed

The Builder added 500-line truncation to `read_repo_file` (`github-tools.ts:378-398`). This addresses my Entry 11 Finding #2 (no content size guard). The implementation is clean -- truncated files include `total_lines`, `shown_lines`, and a `note` guiding the agent to find smaller files. The v0.2.0 CHANGELOG was updated to reflect this. Good responsiveness to review feedback.

---

### Finding 1: `maxIssuesPerRun` does not actually bound the agent -- it is a suggestion

**File:** `src/index.ts:44,66-69`

**What happens:** The limit is embedded in the user message as text: `"Fetch open issues (limit: 5)"`. The agent is expected to pass `limit: 5` to `fetch_github_issues`. But the agent controls the `limit` parameter -- nothing prevents it from calling `fetch_github_issues({ limit: 100 })` or calling the tool multiple times.

**What could go wrong:**
- The LLM ignores the limit in the user message and fetches all issues
- The LLM calls `fetch_github_issues` twice (once for open, once for closed)
- The LLM processes more issues than the limit because the limit only applies to *fetching*, not to *processing*

**The learning moment:** This is the same class of problem as Entry 7 Finding #10 (the `since` parameter depends on LLM compliance). Entry 12 acknowledges the distinction between "fetch limit" and "run limit" but does not enforce the run limit in code.

**What would actually bound the agent:** Bake the limit into the tool at construction time, the same way `owner` and `repo` are baked in:

```typescript
export function createGitHubIssuesTool(owner, repo, octokit, maxIssues?: number) {
  return tool(async ({ state, limit }) => {
    const effectiveLimit = maxIssues ? Math.min(limit ?? 5, maxIssues) : (limit ?? 5);
    // ...
  });
}
```

This enforces the cap regardless of what the LLM requests.

**Impact:** Medium -- the guardrail can be bypassed by the very entity it is meant to constrain.
**Effort:** Small -- one parameter, one `Math.min`.

---

### Finding 2: Comment idempotency check has a pagination gap

**File:** `src/github-tools.ts:85-89`

**What happens:** The tool fetches comments with `per_page: 100`. If an issue has more than 100 comments, the marker check only scans the first 100. A bot comment on page 2+ would be missed, and a duplicate would be posted.

**How realistic is this?** Most issues have fewer than 100 comments. But long-running issues in active repos (e.g., tracking issues, meta-discussions) can accumulate hundreds of comments. If the bot is pointed at such a repo, this gap becomes real.

**The fix options:**
1. **Paginate all comments** -- use `octokit.paginate()` to fetch all pages. Simple but adds latency for high-comment issues.
2. **Search from newest** -- the API supports `direction: 'desc'` and `sort: 'created'`. If the bot comment was recent, it will be in the first page. But this misses old bot comments from a previous deployment.
3. **Acceptable risk** -- document the 100-comment limit and move on. For a learning project, this is reasonable.

**The learning moment:** Pagination is the silent assumption behind most "check before write" patterns. When you call `listComments({ per_page: 100 })`, you are implicitly saying "I only care about the first 100." Always ask: "What if there are more?"

**Impact:** Low -- rare edge case (100+ comments).
**Effort:** Small -- change to `octokit.paginate()` or add `direction: 'desc'`.

---

### Finding 3: Deleting `last_poll.json` defeats maxIssuesPerRun but NOT idempotency

**Question from team lead:** "Can the bot still spam if last_poll.json is deleted?"

**Answer:** No -- and this is the key value of tool-level idempotency over orchestration-level state.

If `last_poll.json` is deleted:
- The orchestrator treats it as a first run and tells the agent to fetch all issues
- The agent processes up to `maxIssuesPerRun` issues (if the LLM obeys the limit)
- For each issue, `comment_on_issue` checks for the HTML marker -- if a comment already exists, it skips
- `create_branch` checks if the branch exists -- if so, it skips
- `create_pull_request` checks for an existing open PR -- if so, it skips

**Result:** The agent re-analyzes issues but does not create duplicate side effects. This is exactly the defense-in-depth pattern that Entry 13 describes. The orchestration-level state (`last_poll.json`) is the first line of defense, and the tool-level idempotency checks are the second.

**One exception:** `write_file` (the built-in deepagents tool) is NOT idempotent. If `last_poll.json` is deleted, the agent will overwrite `./issues/issue_N.md` files. This is harmless for this project (the new analysis replaces the old one), but worth noting that the local filesystem writes are not covered by the idempotency pattern.

**Impact:** None -- the design handles this correctly.

---

### Finding 4: Cron overlap is still not prevented

**Question from team lead:** "Can cron overlap cause duplicates despite the checks?"

**Answer:** The idempotency checks reduce the damage significantly but do not eliminate the race condition.

**The race window:** Two cron instances start simultaneously. Both call `comment_on_issue` for issue #42 at the same time.

```
Instance A: listComments() -> no marker found -> createComment()
Instance B: listComments() -> no marker found -> createComment()  // B reads before A writes
```

Both instances see "no marker found" because the check and the write are not atomic. Both post comments. This is a classic **TOCTOU** (Time-Of-Check-Time-Of-Use) race condition.

The same race exists for branches (two `getRef` calls return 404 simultaneously, both call `createRef`) and PRs (two `pulls.list` calls return empty, both call `pulls.create`).

**How likely is this?** The race window is small (milliseconds between check and write), and the LLM inference adds seconds of delay that naturally separates the two instances' API calls. In practice, this race is unlikely but not impossible.

**What prevents it:** The lock file mechanism from Entry 7 Finding #6. This was flagged 6 entries ago and is still not implemented. Adding `mkdir "$LOCKFILE"` to `poll.sh` would eliminate cron overlap entirely, making the TOCTOU race impossible.

**The learning moment:** Idempotency checks protect against *sequential* re-runs (crash recovery, manual re-runs, state file deletion). They do NOT protect against *concurrent* runs. For concurrent safety, you need a mutex (lock file, database lock, or atomic API operations).

**Impact:** Medium -- idempotency reduces damage but does not eliminate cron overlap risk.
**Effort:** Small -- 5 lines in `poll.sh` (Entry 7 Finding #6).

---

### Finding 5: Edited or deleted marker comments break idempotency

**Question from team lead:** "Is the marker string detection reliable?"

**Scenario 1: Comment edited.** A human edits the bot's comment and accidentally removes the `<!-- deep-agent-analysis -->` marker. The next run does not find the marker and posts a duplicate comment.

**Scenario 2: Comment deleted.** A human deletes the bot's comment entirely. The next run does not find any marker and posts a new comment. This is arguably correct behavior -- if the comment was deliberately deleted, re-posting might be desired. But it depends on the user's intent.

**How realistic is this?**
- Editing: unlikely. HTML comments are invisible in GitHub's rendered view, so users would not see or interact with them. But raw-editing the comment in GitHub's Markdown editor would expose and potentially break the marker.
- Deleting: more likely. A user might delete a stale or incorrect analysis comment and expect the bot to re-analyze on the next run.

**The learning moment:** Marker-based idempotency is robust against automated re-runs but fragile against human intervention. This is acceptable for a bot comment (the human can always re-trigger by deleting), but would be problematic for more critical resources (you would not want a financial transaction to re-execute because someone deleted a marker).

**Impact:** Low -- human editing the marker is rare; deletion is arguably correct behavior.
**Effort:** N/A -- acceptable trade-off.

---

### Finding 6: The `{ skipped: true }` response adds noise to the LLM context

**File:** All three idempotency checks in `github-tools.ts`

**What happens:** When a tool skips, it returns a JSON response like `{ skipped: true, reason: "..." }`. The LLM reads this as a tool result and must process it. On a re-run where all issues are already processed, the agent receives N skip responses per issue (comment, branch, PR) -- that is 3 x N tool results containing "already exists" messages.

**What could go wrong:** The LLM might:
- Misinterpret "skipped" as an error and retry
- Include verbose "I skipped this because..." explanations in its output, wasting tokens
- Get confused about whether it actually completed its task

**Why this is acceptable:** The tool descriptions were updated to say "Automatically skips if ... already exists (idempotent)." This tells the LLM upfront that skipping is expected behavior. The `reason` field gives the LLM enough context to understand and move on. In practice, well-prompted LLMs handle skip responses gracefully.

**A minor improvement:** The system prompt could explicitly say: "If a tool returns `skipped: true`, this is normal -- the work was already done. Move to the next step." This would reduce the chance of the LLM treating skips as problems.

**Impact:** Low.
**Effort:** Trivial -- one line in the system prompt.

---

### Finding 7: `maxIssuesPerRun` is not validated

**File:** `src/index.ts:44` -- `const maxIssues: number = config.maxIssuesPerRun ?? DEFAULT_MAX_ISSUES_PER_RUN;`

**What happens:** If `config.json` contains `"maxIssuesPerRun": -1` or `"maxIssuesPerRun": "banana"`, the code uses the value as-is. A negative limit would pass `limit: -1` to `fetch_github_issues`, which would be sent to GitHub's API as `per_page: -1`. GitHub would likely ignore it or return its default (30 issues), bypassing the intended cap.

**The fix:** Validate in `index.ts`:

```typescript
const rawMax = config.maxIssuesPerRun;
const maxIssues = (typeof rawMax === 'number' && rawMax > 0) ? rawMax : DEFAULT_MAX_ISSUES_PER_RUN;
```

This connects to Entry 7 Finding #2 (Config is untyped `any`). The root cause is the same: `JSON.parse` returns `any`, so runtime validation is needed at every access point. Zod config validation would solve this class of problem once.

**Impact:** Low -- users who intentionally write bad config values are not the target audience.
**Effort:** Trivial -- one line.

---

### Finding 8: Duplicate PR check only looks at `state: 'open'` -- closed+reopened issue edge case

**File:** `src/github-tools.ts:215-221`

**What happens:** The PR idempotency check filters by `state: 'open'`. If a PR was previously created, then closed (not merged), and the issue is still open, the next run will:
1. Create a new branch (which may already exist -- branch check catches this)
2. Create a new PR (the old one is closed, so the check passes)

**Is this correct?** Entry 13 says: "A closed or merged PR for the same branch should not prevent creating a new one." This is a reasonable design decision -- if the old PR was deliberately closed, creating a new one is appropriate.

**The edge case:** If the branch still exists (from the old PR) and has no new commits, the new PR is identical to the closed one. This is not harmful but may confuse human reviewers who see a "new" PR with the same content as the closed one.

**Impact:** Very Low -- correct behavior by design; edge case is cosmetic.

---

### Finding 9: System prompt does not mention idempotency to the agent

**File:** `src/agent.ts:33-83`

**What is missing:** The system prompt was not updated to tell the agent about the idempotency behavior. The tool descriptions mention it ("Automatically skips if..."), but the system prompt's step-by-step workflow still says "Use comment_on_issue to post a summary" without noting that it might skip.

**Why this matters:** If a tool returns `{ skipped: true }`, the agent might think step 2 failed and abort the remaining steps for that issue. Or it might retry the comment with different wording, hoping the "skip" was a transient issue.

**Concrete improvement:** Add to the IMPORTANT section of the system prompt:

```
- All write tools (comment, branch, PR) are idempotent. If they return { skipped: true },
  the work was already done -- move to the next step without retrying.
```

**Impact:** Medium -- affects agent behavior on re-runs.
**Effort:** Trivial -- two lines in the system prompt.

---

### Teaching notes accuracy check (Entries 12-13)

| Claim | Accurate? | Notes |
|---|---|---|
| Entry 12: "The tool limit says 'show me N issues.' The run limit says 'only process N issues total.'" | Conceptually correct | But the implementation does not enforce the run limit in code (Finding 1). |
| Entry 12: Cost estimate "50 issues could cost $5-10 per run" | Plausible | Depends on model, issue complexity, and file sizes. Reasonable order of magnitude. |
| Entry 13: "GitHub's Markdown renderer hides HTML comments" | Correct | Standard HTML comment behavior. |
| Entry 13: "The bot posts under the token owner's account" | Correct | PAT-based auth uses the human's identity. GitHub App would have a separate bot identity (Phase 7). |
| Entry 13: "`head` filter requires `owner:branch` format" | Correct | GitHub API documentation confirms this. |
| Entry 13: "15 extra API calls for 5 issues" (idempotency cost) | Correct | 3 checks x 5 issues = 15. |
| Entry 13: Three idempotency patterns comparison | Correct and well-structured | The marker/404/list-filter distinction is a useful mental model. |

**Overall:** Teaching notes are accurate and well-structured. Entry 13's three-pattern comparison is one of the best teaching sections in the entire LEARNING_LOG.

---

### Version bump assessment: Should 0.2.4 become 0.3.0?

**The versioning plan:** v0.3.0 = Phase 2 complete (Safety & Idempotency).

**Phase 2 status:** ROADMAP lists 7 issues for Phase 2: #5, #6, #7, #8, #9, #10, #11. Of these, 4 are implemented (#5, #8, #9, #10). Three remain: #6 (circuit breaker), #7 (dry run), #11 (action tracking per issue).

**Recommendation:** Do NOT bump to v0.3.0. Phase 2 is not complete. The remaining three issues (#6, #7, #11) are substantive -- circuit breaker and dry run are critical safety features, and action tracking enables crash recovery. The current v0.2.4 correctly reflects "Phase 1 complete + partial Phase 2."

When all 7 Phase 2 issues are done, then bump to v0.3.0.

---

### Priority summary for improvements

| Priority | Finding | Effort | What it prevents |
|---|---|---|---|
| **High** | #4 Cron overlap still not prevented | Small (5 lines in poll.sh) | TOCTOU race on all write tools |
| **Medium** | #1 maxIssuesPerRun not enforced in code | Small | LLM ignoring the issue cap |
| **Medium** | #9 System prompt lacks idempotency guidance | Trivial (2 lines) | Agent confusion on skipped tools |
| **Low** | #2 Comment check pagination gap | Small | Duplicate on 100+ comment issues |
| **Low** | #6 Skip responses add LLM context noise | Trivial | Agent misinterpreting skips |
| **Low** | #7 maxIssuesPerRun not validated | Trivial | Bad config values |
| **Info** | #3 last_poll.json deletion | N/A | Design handles this correctly |
| **Info** | #5 Edited marker breaks detection | N/A | Acceptable trade-off |
| **Info** | #8 Closed PR + same branch | N/A | Correct by design |

---

### Cumulative open findings from Entries 7, 11, and 14

| Source | Finding | Status |
|---|---|---|
| Entry 7 #1, #13 | Path resolution (relative `./`) | **Still open** |
| Entry 7 #2 | Config type safety (any) | **Still open** |
| Entry 7 #4 | process.exit in config.ts | **Still open** |
| Entry 7 #5 | Labels map type guard | **Still open** |
| Entry 7 #6 | Cron overlap / lock file | **Still open** -- reinforced by Entry 14 Finding #4 |
| Entry 7 #8 | Atomic poll state writes | **Still open** |
| Entry 7 #9 | stderr logging in tool catch blocks | **Still open** |
| Entry 7 #10 | Bake `since` into tool | **Still open** |
| Entry 7 #11 | Issue number extraction fragility | **Still open** |
| Entry 11 #1 | list_repo_files response size | **Still open** |
| Entry 11 #2 | read_repo_file size guard | **Fixed** (500-line truncation added) |
| Entry 11 #3 | Binary file garbage | **Still open** |
| Entry 14 #1 | maxIssuesPerRun not enforced | **New** |
| Entry 14 #4 | Cron overlap TOCTOU | **New** (extends Entry 7 #6) |
| Entry 14 #9 | System prompt idempotency guidance | **New** |

---

### Overall assessment

**What the team did well:**
- All three idempotency patterns are correctly implemented. The hidden marker, 404 detection, and list-filter approaches are all standard patterns used by production GitHub bots.
- The `{ skipped: true }` return convention is consistent across all three tools and well-designed for LLM consumption.
- Entry 13's teaching notes are excellent -- the three-pattern comparison is clear and the cost analysis (15 extra API calls) is concrete.
- `maxIssuesPerRun` is configurable and defaults to a conservative value.
- The 500-line truncation added to `read_repo_file` shows responsiveness to review feedback (Entry 11 Finding #2).
- Tool descriptions were updated to mention idempotency, which helps the LLM understand skip behavior.

**What needs attention:**
- The cron overlap problem (Entry 7 Finding #6) has now been flagged in three separate entries (7, 11, 14) and remains unaddressed. It is the highest-impact open issue. The idempotency checks reduce but do not eliminate the TOCTOU race.
- `maxIssuesPerRun` is a prompt-based constraint, not a code-enforced one. This matches the `since` parameter problem from Entry 7 Finding #10. The pattern of "tell the LLM via text, hope it complies" is a recurring theme that should be addressed systematically.
- The system prompt was not updated for Phase 2 behavior. The agent does not know that tools can return `{ skipped: true }`.

**The learning takeaway:** Phase 2 demonstrates **defense-in-depth**: orchestration-level constraints (max issues) and tool-level idempotency work together. Neither alone is sufficient. The orchestrator prevents excessive work; the tools prevent duplicate side effects. But both layers have gaps: the orchestrator relies on LLM compliance, and the tools have TOCTOU races under concurrency. The missing third layer is infrastructure-level protection (lock files, atomic operations) -- which is exactly what the remaining Phase 2 issues (#6 circuit breaker, #7 dry run, #11 action tracking) and Entry 7's lock file recommendation address.

### Connection to next work

Three Phase 2 issues remain: #6 (circuit breaker), #7 (dry run), #11 (action tracking). These address the gaps found in this review:
- Circuit breaker (#6) adds a hard stop on total tool calls, independent of LLM compliance
- Dry run (#7) enables testing without side effects
- Action tracking (#11) enables crash recovery by recording which steps completed per issue

The cron lock file (Entry 7 Finding #6) should be included as a prerequisite or parallel task -- it complements the tool-level idempotency with infrastructure-level concurrency protection.

---

## Entry 15: CLI Wrapper -- Separating Interface from Logic (Issue #24)

**Date:** 2026-02-08
**Author:** Builder Agent
**Implements:** Issue #24 (CLI wrapper with subcommands)
**Version:** v0.2.5
**Files changed:** `src/cli.ts` (new), `src/core.ts` (new), `src/index.ts` (refactored), `package.json`

### The problem

Before this change, the project had a single entry point (`src/index.ts`) that mixed three concerns:
1. **State management** -- loading/saving `last_poll.json`, extracting processed issue numbers
2. **Orchestration** -- building user messages, creating the agent, invoking it
3. **Interface** -- console output, startup logic, error handling

This meant:
- You could only run a full poll cycle. No way to analyze a single issue, check status, or do a dry run.
- Adding features like `--dry-run` or `--max-issues` would require modifying the same monolithic function.
- Testing any of the core logic required running the whole entry point.

The Critic flagged two specific issues that a CLI would address:
- **Finding #1 (Entry 14):** `maxIssuesPerRun` is prompt-only. The CLI can pass it as a validated parameter.
- **Dry run mode (Entry 14):** Fits naturally as a CLI flag rather than a config option.

### The architecture decision: extract, then wrap

Rather than adding flags to `index.ts` and making it more complex, we split into three files:

```
src/core.ts    -- All reusable logic (the "library")
src/cli.ts     -- CLI entry point (the "interface")
src/index.ts   -- Original entry point (thin wrapper for backwards compatibility)
```

This is the **Extract-Wrap pattern**: take the logic out of the entry point, put it in a shared module, then create thin wrappers that call the shared module. Both `index.ts` and `cli.ts` call the same `runPollCycle()` function from `core.ts`.

### What went into `core.ts`

Every function that was in `index.ts` moved to `core.ts`, but with better interfaces:

| Function | Purpose | Key design choice |
|---|---|---|
| `loadPollState()` | Read `last_poll.json` | Returns `null` if file does not exist (no exceptions) |
| `savePollState()` | Write `last_poll.json` | Takes a `PollState` object, writes JSON |
| `extractProcessedIssues()` | Parse issue numbers from agent messages | Accepts existing numbers to merge with (additive) |
| `buildUserMessage()` | Build the prompt for a poll run | Takes maxIssues, sinceDate, previousIssues as parameters |
| `buildAnalyzeMessage()` | Build the prompt for single-issue analysis | Takes issueNumber |
| `getMaxIssues()` | Resolve effective max issues from config | Validates: `typeof raw === 'number' && raw > 0` (addresses Critic Finding #7) |
| `runPollCycle()` | Full poll cycle | Accepts `options: { dryRun?, maxIssues? }` |
| `runAnalyzeSingle()` | Analyze one issue | Takes config + issue number |
| `showStatus()` | Print polling state | Read-only, no agent invocation |

The key improvement: `getMaxIssues()` now validates the config value with a type check and positivity guard, falling back to `DEFAULT_MAX_ISSUES_PER_RUN` if the config is invalid. This directly addresses the Critic's Finding #7 from Entry 14.

### What went into `cli.ts`

The CLI uses manual `process.argv` parsing -- no external framework. This is a deliberate choice:

**Why not Commander.js or yargs?**
- They add dependencies for something achievable in ~60 lines
- The project has 4 commands and 3 flags -- that is not enough complexity to justify a framework
- Manual parsing teaches how CLIs actually work under the hood (this is a learning project)
- Less indirection makes debugging easier

The parser handles:
- Positional command (`poll`, `analyze`, `status`, `help`)
- Boolean flags (`--dry-run`)
- Value flags (`--max-issues N`, `--issue N`)
- Unknown option error with usage display

The CLI also adds a `dry-run` shorthand command -- `deepagents dry-run` is equivalent to `deepagents poll --dry-run`. This is a convenience for the most common testing workflow.

### The `bin` field and `npx`

Adding `"bin": { "deepagents": "./src/cli.ts" }` to `package.json` means:
- After `pnpm link`, you can run `deepagents poll` from anywhere
- With `npx`, you can run `npx deepagents poll` without global install
- The shebang (`#!/usr/bin/env node`) tells the OS to use Node.js

In practice, during development you use `pnpm run cli -- poll --dry-run` (the `--` separates pnpm's flags from the script's flags).

### Backwards compatibility

`src/index.ts` is now 20 lines. It imports `loadConfig` and `runPollCycle` from `core.ts` and calls them. This means:
- `pnpm start` still works exactly as before
- `pnpm dev` (watch mode) still works
- No existing workflow is broken
- The new CLI is additive, not a replacement

### What the Critic should check

1. **Does `core.ts` properly handle all edge cases from `index.ts`?** The extraction should not have lost any error handling or state management logic.
2. **Does the `--max-issues` validation in CLI match `getMaxIssues` in core?** The CLI validates the parsed integer (`isNaN || < 1`), and `getMaxIssues` validates the config value. Both paths are covered.
3. **Is the `dry-run` shorthand confusing?** Having both `deepagents dry-run` and `deepagents poll --dry-run` mean the same thing might surprise users. But it is documented and the help message is clear.
4. **Should `index.ts` pass `maxIssues` from config?** Currently `index.ts` calls `runPollCycle(config)` with no options, so it uses the config default. This matches the pre-CLI behavior.

### Connection to next work

The CLI architecture enables Task #14 (test infrastructure). With logic extracted into `core.ts`, we can unit test `buildUserMessage()`, `extractProcessedIssues()`, `getMaxIssues()`, and other pure functions without invoking the agent or touching the filesystem. The CLI also makes manual testing easier: `deepagents poll --dry-run` lets you verify the agent runs without writing poll state.

---

## Entry 16: Test Infrastructure -- What to Mock and Why (Issue #23)

**Date:** 2026-02-08
**Author:** Builder Agent
**Implements:** Issue #23 (test infrastructure with vitest)
**Version:** v0.2.6
**Files added:** `vitest.config.ts`, `tests/core.test.ts`, `tests/github-tools.test.ts`, `tests/model.test.ts`, `tests/config.test.ts`
**Files changed:** `package.json`

### Why vitest?

Three reasons:
1. **ESM-native.** This project uses `"type": "module"` and ESM imports. Jest requires transforms and configuration to handle ESM. Vitest supports it out of the box.
2. **Zero config for TypeScript.** Vitest uses esbuild internally, which handles `.ts` files without needing a separate compile step. No `ts-jest` or `babel` plugins needed.
3. **Same API as Jest.** `describe`, `it`, `expect`, `vi.fn()`, `vi.mock()` -- the test API is nearly identical to Jest, so the knowledge transfers both ways.

The config file (`vitest.config.ts`) is minimal -- it just tells vitest where to find test files:

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
```

### The test structure

Four test files, one per source module. Each tests a different category of behavior:

| Test file | Source file | What it tests | Mock strategy |
|---|---|---|---|
| `core.test.ts` | `core.ts` | Pure functions + state I/O | `vi.spyOn(fs, ...)` for file I/O |
| `github-tools.test.ts` | `github-tools.ts` | Tool logic + idempotency | Mock Octokit factory object |
| `model.test.ts` | `model.ts` | Provider routing | `vi.mock()` for LLM constructors |
| `config.test.ts` | `config.ts` | Validation + exit behavior | `vi.spyOn(fs, ...)` + `vi.spyOn(process, 'exit')` |

### Mock strategies explained

**1. Mock Octokit factory (github-tools.test.ts)**

The tool functions accept an Octokit instance as a parameter (dependency injection). Instead of mocking the `octokit` module, we create a plain object with the same shape:

```typescript
function createMockOctokit() {
  return {
    rest: {
      issues: { listComments: vi.fn(), createComment: vi.fn(), ... },
      git: { getRef: vi.fn(), createRef: vi.fn(), ... },
      pulls: { list: vi.fn(), create: vi.fn() },
    },
  } as any;
}
```

Why this works: the tool functions only use `octokit.rest.X.Y()`. They don't check `instanceof Octokit` or access any other properties. Dependency injection makes this mock trivial.

This is the cleanest mock pattern in the test suite because the production code was already designed for it -- the shared Octokit client pattern from Entry 5 means tools accept their dependencies as parameters.

**2. `vi.mock()` for module replacement (model.test.ts)**

The model module imports `ChatAnthropic` and `ChatOpenAI` at the top level. We can't inject these as parameters (they're used inside a function). Instead, we replace the entire module:

```typescript
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation((opts) => ({ _type: 'anthropic', ...opts })),
}));
```

This intercepts the import so `createModel()` gets our mock constructor instead of the real one. We can then assert which constructor was called and with what arguments.

**3. `vi.spyOn` for partial mocking (core.test.ts, config.test.ts)**

For `fs.existsSync` and `fs.readFileSync`, we don't want to replace the entire `fs` module. We spy on specific methods:

```typescript
vi.spyOn(fs, 'existsSync').mockReturnValue(true);
vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(config));
```

This leaves the rest of `fs` untouched while controlling the specific functions the code under test calls.

**4. `process.exit` interception (config.test.ts)**

`config.ts` calls `process.exit(1)` on validation failures. In a test, this would kill the test runner. The fix:

```typescript
vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit called');
});
```

This converts `process.exit` into a thrown error, which `expect(() => ...).toThrow()` can catch. The test verifies that validation failures trigger exit AND that the correct error message was logged.

### What the tests cover

**core.test.ts (25 tests):**
- `getMaxIssues`: valid numbers, zero, negative, string, null, undefined
- `buildUserMessage`: limit inclusion, first-run vs polling, previous issues, workflow instructions
- `buildAnalyzeMessage`: issue number inclusion, file path, workflow instructions
- `extractProcessedIssues`: tool calls, JSON content, merging, deduplication, empty messages
- `loadPollState`: file missing (returns null), file exists (returns parsed JSON)
- `savePollState`: writes JSON to file

**github-tools.test.ts (12 tests):**
- Comment idempotency: skip when marker exists, post when no marker, post when empty
- Branch idempotency: skip when branch exists, create on 404, re-throw non-404
- PR idempotency: skip when open PR exists, create when none, verify `owner:head` format
- Fetch issues: formatted output, `since` parameter passthrough, error string on failure
- Read file: base64 decoding, 500-line truncation, directory error

**model.test.ts (8 tests):**
- Provider routing: anthropic, openai, openai-compatible, ollama
- Default model fallbacks
- Error cases: missing baseUrl for openai-compatible, unknown provider

**config.test.ts (7 tests):**
- Valid config returns successfully
- Missing file triggers exit
- Missing owner/token triggers exit
- Missing API key triggers exit for cloud providers
- Missing API key is OK for ollama and openai-compatible

### What the tests do NOT cover

Intentionally excluded:
- **`agent.ts`** -- this is a thin wiring function that creates an agent with tools. Testing it would require mocking the entire `deepagents` library, which adds complexity without testing meaningful logic.
- **`cli.ts`** -- CLI argument parsing could be tested, but the value is low. The parser is 20 lines of straightforward `if/else` logic. The interesting behavior (calling `runPollCycle`) requires the agent, which we don't want to invoke in tests.
- **Integration tests** -- no tests make real GitHub API calls. This is deliberate: unit tests run fast and offline. Integration testing would require a test repo and real credentials, which is a Phase 7 (deployment) concern.

### What the Critic should check

1. **Are the Octokit mock shapes complete enough?** If a tool function accesses a property not in the mock, the test will throw `Cannot read property of undefined` -- which is actually a good thing (it catches unexpected API usage).
2. **Does the `process.exit` mock leak?** The spy is set up in `beforeEach` and restored in `afterEach`. If a test throws before `afterEach` runs, subsequent tests might see the mocked `process.exit`. Vitest's `afterEach` should still run on test failure, but this is worth verifying.
3. **Are the `vi.mock()` calls at the top level?** Vitest (like Jest) hoists `vi.mock()` calls to the top of the file. If they're inside a `describe` block, the behavior might differ. The current placement (top of file, before imports) is correct.

### Connection to next work

With tests in place, the Critic can review Phase 3 (Task #15). The test suite also serves as documentation -- each test file shows exactly what each module's contract is. Future phases can add tests alongside new features, following the patterns established here.

---

## Entry 17: Critic's Phase 3 Review -- CLI Architecture, Test Quality, and What Is Left Untested

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviews:** Entries 15-16 (Builder Phase 3 implementations: CLI wrapper #24, test infrastructure #23)
**Files reviewed:** `src/cli.ts`, `src/core.ts`, `src/index.ts`, `vitest.config.ts`, all 4 test files, `package.json`, `CHANGELOG.md`

### Purpose of this entry

Phase 3 is about developer experience: the ability to test, debug, and operate the bot from the command line. This review evaluates whether the CLI properly separates concerns, whether the 52 tests cover meaningful behavior, and whether the mock strategies are realistic enough to catch real bugs.

---

### Guiding principles check

| Principle | Verdict | Notes |
|---|---|---|
| 1. Learning first | Pass | Entry 15 explains Extract-Wrap pattern clearly. Entry 16's mock strategy comparison (factory vs. vi.mock vs. vi.spyOn) is excellent teaching material. |
| 2. Incremental | Pass | Two patch bumps (v0.2.5, v0.2.6). `index.ts` preserved for backwards compatibility. |
| 3. Simple file structure | Pass | Two new source files (`cli.ts`, `core.ts`), four test files in `tests/`. No over-organization. |
| 4. CLI as the wrapper | **Strong pass** | This is the principle's defining moment. Every feature now has a CLI subcommand. Same core code for cron and CLI. |
| 5. Humans decide | Pass | No new write actions. CLI adds read-only (`status`) and controlled (`--dry-run`) operations. |
| 6. GitHub as the event bus | N/A | No GitHub interaction changes. |

---

### The core.ts extraction: well done

The separation of concerns between `cli.ts`, `core.ts`, and `index.ts` is clean:

- **`core.ts`** -- all logic: state management, message building, agent orchestration. Every function is exported and independently callable. No console output formatting beyond progress messages.
- **`cli.ts`** -- all interface: argument parsing, input validation, command dispatch. No business logic.
- **`index.ts`** -- thin backwards-compatible wrapper. 20 lines, delegates entirely to `core.ts`.

**Why this matters:** Before the extraction, testing `buildUserMessage()` required running the entire entry point with a real agent. Now it is a pure function that takes three arguments and returns a string. The extraction enabled Phase 3's test infrastructure.

**One observation:** `core.ts` still contains console.log calls (`runPollCycle` lines 116-121, 128-131, etc.). These are progress messages, not interface concerns, so they belong here. But if testing ever needs to verify output, these will need to be captured or injected. For now, this is fine.

---

### Finding 1: `cli.ts` bin field points to TypeScript source, not compiled JS

**File:** `package.json:6-8` -- `"bin": { "deepagents": "./src/cli.ts" }`

**What happens:** The `bin` field points to `./src/cli.ts`, a TypeScript file. When a user runs `npx deepagents poll`, Node.js attempts to execute the `.ts` file directly. This works if `tsx` is available, but will fail with a syntax error if the user only has standard Node.js.

**Why this happens:** The project uses `tsx` as a dev dependency for running TypeScript directly. During development, `pnpm run cli` works because it uses `tsx`. But `npx deepagents` invokes the file directly with `node`, which does not understand TypeScript.

**The fix options:**
1. **Add a build step** that compiles `cli.ts` to `dist/cli.js` and point `bin` there. This is the production approach but adds complexity.
2. **Add a shell wrapper** that invokes `tsx src/cli.ts`. This is hacky but works for a learning project.
3. **Document that `pnpm run cli` is the supported interface.** The `bin` field is forward-looking for when a build step exists.

**For a learning project:** Option 3 is fine. But the README and CHANGELOG mention `npx deepagents` usage, which would fail. Either fix the bin field or update the docs to use `pnpm run cli`.

**Impact:** Medium -- documented feature does not work as advertised.
**Effort:** Small -- either fix bin or update docs.

---

### Finding 2: `--dry-run` does not skip write operations -- it only skips poll state saves

**File:** `src/core.ts:118-119,164-172`

**What happens:** The `--dry-run` flag controls only whether `savePollState()` is called. The agent still runs and executes all tools: it posts comments, creates branches, and opens PRs.

**What the CLI help says:** `"--dry-run   Run without saving poll state (no write operations skipped)"` -- the parenthetical is honest about the limitation, but the flag name `--dry-run` implies no side effects.

**What Entry 15 says:** "Dry run mode (Entry 14): Fits naturally as a CLI flag." But Entry 14's finding refers to ROADMAP Issue #7 (dry run mode), which is defined as "Runs the full pipeline but skips write operations." The current implementation only skips poll state writes, not GitHub write operations.

**The learning moment:** There are two levels of "dry run":
1. **Orchestration dry run** (implemented): skip saving poll state. The agent still writes to GitHub.
2. **Full dry run** (ROADMAP #7): wrap tools so write operations return mock results. The agent runs the full pipeline but nothing is written to GitHub.

The current implementation is level 1. Level 2 is ROADMAP Issue #7, which is still open (one of the three remaining Phase 2 issues). The naming is misleading because users expect `--dry-run` to mean "no side effects."

**Concrete improvement:** Rename the flag to `--no-save` or add a clear warning at startup:

```
DRY RUN: Poll state will NOT be saved.
NOTE: GitHub operations (comments, branches, PRs) WILL still execute.
For a full dry run without GitHub writes, use --dry-run (coming in Issue #7).
```

**Impact:** High -- users will misunderstand what `--dry-run` does and accidentally post real comments/branches/PRs.
**Effort:** Trivial -- rename flag or add warning message.

---

### Finding 3: `process.exit(1)` in `cli.ts` continues the pattern from `config.ts`

**File:** `src/cli.ts:58,85,98,103,126`

**What happens:** Five `process.exit(1)` calls in the CLI for input validation errors. This is acceptable in CLI code (the entry point is the right place to exit), unlike `config.ts` (a library module, per Entry 7 Finding #4).

**Why this is OK here:** CLI entry points are expected to call `process.exit`. The CLI is the outermost layer -- there is no caller to throw to. This is different from `config.ts`, which is called by both `cli.ts` and `index.ts` and should throw instead of exiting.

**The issue:** `config.ts` still calls `process.exit(1)` (Entry 7 Finding #4, still open). The config test (`config.test.ts:6-8`) has to work around this by mocking `process.exit` to throw. This is a test smell that confirms the underlying design issue. If `loadConfig()` threw an error instead, the test would be simpler: `expect(() => loadConfig()).toThrow('config.json not found')`.

**Impact:** Low (informational) -- the cli.ts usage is fine; the config.ts issue persists.

---

### Finding 4: `analyze` command does not update poll state

**File:** `src/core.ts:179-200` -- `runAnalyzeSingle`

**What happens:** When you run `deepagents analyze --issue 42`, the agent processes issue #42 (comment, branch, PR), but the issue number is not added to `lastPollIssueNumbers`. The next `deepagents poll` run will re-process issue #42.

**Is this correct?** It depends on user intent:
- If the user ran `analyze` for debugging, they probably do not want it to affect poll state.
- If the user ran `analyze` to process a specific issue ahead of schedule, they probably do want it to be tracked.

**The current behavior is reasonable** for a learning project -- `analyze` is a focused debugging tool, and keeping it separate from poll state avoids side effects. But it should be documented: "Note: `analyze` does not update poll state. The issue may be re-processed on the next `poll` run."

**Impact:** Low -- correct by design but should be documented.
**Effort:** Trivial -- one line in CLI help or README.

---

### Test quality assessment

The 52 tests across 4 files break down as:

| File | Tests | What they test | Quality |
|---|---|---|---|
| `core.test.ts` | 25 | Pure functions, state I/O | **Strong** -- tests edge cases (zero, negative, null, undefined), deduplication, merge behavior |
| `github-tools.test.ts` | 12 | Idempotency, API interaction | **Strong** -- tests happy path, skip path, and error propagation. Verifies marker prepend, `owner:head` format, `draft: true`. |
| `model.test.ts` | 8 | Provider routing | **Good** -- covers all 4 providers plus error cases. Default model fallback tested. |
| `config.test.ts` | 7 | Validation + exit behavior | **Good** -- covers all validation branches. Local provider API key exemption tested. |

**Are these meaningful tests or boilerplate?** These are meaningful tests. Specific observations:

1. **`getMaxIssues` tests (8 tests)** -- This function had zero validation in Entry 14 (my Finding #7). Now it has 8 tests covering every edge case. The tests drove the implementation: `typeof raw === 'number' && raw > 0` is exactly what the tests verify. This is test-driven validation.

2. **Idempotency tests (7 tests)** -- Each idempotency pattern (marker, 404, list-filter) has both a "skip" test and a "proceed" test. The branch test also verifies that non-404 errors are re-thrown (not silently swallowed). This catches the exact bug Entry 13 warned about.

3. **`extractProcessedIssues` tests (7 tests)** -- Tests the fragile regex extraction from Entry 7 Finding #11. Covers both extraction paths (tool_calls and content regex), deduplication, and empty inputs. Does NOT test the false-positive case (PR numbers being matched), which Entry 7 flagged. This is an honest gap.

4. **`process.exit` interception (config.test.ts:6-8)** -- Clever pattern: mock `process.exit` to throw, then use `expect().toThrow()` to catch it. This simultaneously tests that exit was called and prevents the test runner from dying.

---

### Finding 5: Octokit mocks do not simulate error response shapes

**File:** `tests/github-tools.test.ts:122,139`

**What happens:** The branch 404 test rejects with `{ status: 404 }`:

```typescript
octokit.rest.git.getRef.mockRejectedValueOnce({ status: 404 });
```

**The real Octokit error:** Octokit throws a `RequestError` object that has `status`, `message`, `response.data`, and `response.headers` properties. The mock only has `status`.

**Does this matter?** Currently no -- the code only checks `(e as { status?: number }).status`. But if the code is ever refactored to access `e.message` or `e.response`, the mock would not catch the change and the test would still pass while production fails.

**The learning moment:** Mocks should match the shape of the real dependency closely enough that test failures predict production failures. When the shape diverges, tests give false confidence. For this project, the current mocks are sufficient because the code's error handling is simple.

**Impact:** Low -- current code only accesses `.status`.
**Effort:** Small -- could add `message` and `response` properties to the mock for realism.

---

### Finding 6: No test for `list_repo_files` tool

**File:** `tests/github-tools.test.ts` -- no `createListRepoFilesTool` tests

**What is missing:** The test file covers `createCommentOnIssueTool`, `createBranchTool`, `createPullRequestTool`, `createGitHubIssuesTool`, and `createReadRepoFileTool`, but not `createListRepoFilesTool`. This is the tool with the most complex API chain (3 sequential calls: getRef -> getCommit -> getTree).

**Why this matters:** The 3-call chain has more failure modes than any other tool: the getCommit call could fail, the tree could be truncated, the path prefix filtering could have bugs. These are exactly the cases that benefit most from testing.

**What to test:**
- Happy path: returns filtered file list
- Truncation: `tree.truncated = true` includes warning
- Path prefix: `"src"` is normalized to `"src/"` (the trailing slash bug from Entry 9)
- Empty tree: returns `{ files: [], total: 0 }`

**Impact:** Medium -- the most complex tool is the least tested.
**Effort:** Small -- follows the existing mock pattern.

---

### Finding 7: `agent.ts` and `cli.ts` being untested -- is this a valid trade-off?

Entry 16 explicitly excludes `agent.ts` and `cli.ts` from testing and explains why. Let me evaluate:

**`agent.ts` (not tested):** This is a wiring function that creates an agent with tools and a system prompt. Testing it would require mocking `createDeepAgent`, which is from an external library. The function has no branching logic -- it is straight-line construction. **Verdict: valid trade-off.** The risk is a typo in the system prompt or a missing tool, both of which would be caught by a manual test run.

**`cli.ts` (not tested):** The argument parser has 6 branches (4 commands + 2 error cases) and 3 flag parsers. This is simple enough to verify by reading, but complex enough that a refactor could break it silently. **Verdict: borderline.** A few tests for the `parseArgs` function would be low-effort and high-value. The function is already exported (it is a private function, but could be exported for testing). Even 3-4 tests covering basic commands and error cases would prevent regressions.

**Impact:** Low for agent.ts, Medium for cli.ts.

---

### Finding 8: CHANGELOG duplicate v0.1.1 entry was cleaned up

The team lead asked me to check this. The previous CHANGELOG had two `## v0.1.1` headers. The current file has only one (line 99). This has been fixed.

---

### Teaching notes accuracy check (Entries 15-16)

| Claim | Accurate? | Notes |
|---|---|---|
| Entry 15: "Extract-Wrap pattern" | Correct term, well-explained | Split logic into shared module, wrap with thin entry points |
| Entry 15: "No external CLI framework -- 60 lines" | Correct | `parseArgs` is 22 lines, the CLI is 69 lines total |
| Entry 15: "bin field means npx works" | **Partially incorrect** | bin points to .ts file, which fails without tsx (Finding 1) |
| Entry 15: "`getMaxIssues` validates with type check" | Correct | `typeof raw === 'number' && raw > 0` in core.ts:103-104 |
| Entry 16: "ESM-native" as reason for vitest | Correct | Jest ESM support requires experimental flags and transforms |
| Entry 16: "vi.mock() is hoisted to top of file" | Correct | Vitest hoists vi.mock calls, matching Jest behavior |
| Entry 16: "process.exit mock converts exit to thrown error" | Correct | config.test.ts:6-8 implements this exactly |
| Entry 16: "52 tests" | Needs verification | I count 25 + 12 + 8 + 7 = 52. Correct. |
| Entry 16: "Dependency injection makes Octokit mock trivial" | Correct and insightful | This is the payoff of Entry 5's shared client refactor |

---

### Version discussion: Phase 3 and the v0.3.0 question

**Current state:** v0.2.6 (Phase 1 complete + partial Phase 2 + Phase 3 complete).

**The versioning plan says:** v0.3.0 = Phase 2 complete, v0.4.0 = Phase 3 complete.

**The problem:** Phase 3 is done before Phase 2 is finished (3 of 7 Phase 2 issues remain: #6, #7, #11). The versioning plan assumes phases complete in order. Skipping ahead to v0.4.0 would be misleading because Phase 2 is not finished.

**My recommendation:** Stay at v0.2.x until Phase 2 is complete, then bump to v0.3.0. Phase 3 features (CLI, tests) are already captured in v0.2.5 and v0.2.6. When Phase 2 finishes, bump to v0.3.0 and note in the CHANGELOG that it includes both Phase 2 and Phase 3 completions. This avoids out-of-order version semantics.

---

### Priority summary for improvements

| Priority | Finding | Effort | What it prevents |
|---|---|---|---|
| **High** | #2 `--dry-run` misleading (does not skip GitHub writes) | Trivial | Users accidentally posting real comments/branches/PRs |
| **Medium** | #1 bin field points to .ts (npx fails) | Small | Documented feature not working |
| **Medium** | #6 No tests for `list_repo_files` | Small | Most complex tool untested |
| **Low** | #4 `analyze` does not update poll state | Trivial (docs) | Re-processing on next poll |
| **Low** | #5 Octokit mock error shape | Small | False test confidence |
| **Low** | #7 `cli.ts` parseArgs untested | Small | Silent regressions on CLI changes |
| **Info** | #3 process.exit in cli.ts | N/A | Acceptable for CLI entry points |
| **Info** | #8 CHANGELOG duplicate cleaned | N/A | Already fixed |

---

### Overall assessment

**What the team did well:**
- The `core.ts` extraction is textbook separation of concerns. Every function in `core.ts` is independently testable. The Extract-Wrap pattern is explained clearly in Entry 15.
- The test suite is genuinely useful. The `getMaxIssues` tests (8 edge cases) and idempotency tests (skip + proceed + error paths) catch real bugs. The `process.exit` interception pattern is clever and well-documented.
- Backwards compatibility is preserved. `pnpm start` still works. No existing workflow is broken.
- The CLI is pragmatic -- no unnecessary framework dependencies. Manual parsing for 4 commands and 3 flags is the right call.
- The mock Octokit factory (`createMockOctokit`) is reusable and clean, leveraging the dependency injection pattern from Phase 0.
- Entry 16's comparison of three mock strategies (factory, vi.mock, vi.spyOn) is excellent teaching material.
- The CHANGELOG duplicate v0.1.1 entry was cleaned up.
- Entry 14 Finding #7 (`maxIssuesPerRun` validation) was addressed in `getMaxIssues()`.

**What needs attention:**
- The `--dry-run` naming is the biggest issue. Users will misunderstand what it does. Either rename it or add prominent warnings.
- The `bin` field pointing to `.ts` means `npx deepagents` does not work as documented.
- `list_repo_files` (the most complex tool) is the only tool without tests.

**The learning takeaway:** Phase 3 demonstrates that **testability is an architectural property, not a testing property.** The reason the test suite works well is not because of clever test techniques -- it is because Phase 0's shared Octokit client (dependency injection) and Phase 3's `core.ts` extraction (separation of concerns) made the code *testable by design*. The mock Octokit factory is trivial because the tools accept their dependencies as parameters. The pure function tests are trivial because `buildUserMessage()` takes arguments and returns a string, with no side effects. Writing tests is easy when the code is designed for it.

### Connection to next work

The remaining Phase 2 issues (#6 circuit breaker, #7 dry run, #11 action tracking) should be implemented with tests from the start, following the patterns established here. In particular:
- Issue #7 (real dry run) will address Finding #2 by wrapping tools to skip write operations
- Tests for #7 can use the existing mock Octokit factory to verify that mocked tools return skip results
- Issue #6 (circuit breaker) is testable as a pure function that counts tool calls

---

## Entry 18: Cron Lock File + maxIssuesPerRun Enforcement (Quick Fixes)

**Date:** 2026-02-08
**Author:** Builder Agent
**Implements:** Remaining safety items from Critic/Architect review
**Files changed:** `poll.sh`, `src/github-tools.ts`, `src/agent.ts`, `src/core.ts`, `tests/github-tools.test.ts`
**Version:** 0.2.7

### What we did

Two small but important safety improvements that came from prior reviews.

### Fix 1: Cron lock file (poll.sh)

**Problem:** If `poll.sh` takes longer than the cron interval (e.g., 15 minutes), cron starts a second instance. Two agents running simultaneously against the same repo means duplicate comments, duplicate branches, and race conditions.

**Solution:** Use `mkdir` as an atomic lock. `mkdir` fails atomically if the directory already exists (even on NFS), which makes it safer than file-based locks that require read-then-write.

```bash
LOCK_DIR="./poll.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "=== Poll SKIPPED ... ===" >> "$LOG_FILE"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT
```

**Why `mkdir` instead of a PID file?** PID files have a race condition: process A reads the file, process B reads the file, both see it's stale, both write their PID. `mkdir` is atomic at the filesystem level -- only one process can create a directory. The `trap ... EXIT` ensures cleanup even if the script crashes.

**Teaching note:** `trap 'command' EXIT` runs when the shell exits for *any* reason (normal exit, error with `set -e`, signals). This is the shell equivalent of `try/finally`.

### Fix 2: maxIssuesPerRun in the tool (code enforcement)

**Problem:** The `maxIssuesPerRun` config only appeared in the agent's text prompt. The LLM could ignore it and pass `limit: 100` to `fetch_github_issues`, fetching far more issues than intended.

**Solution:** Pass `maxIssues` into the tool constructor and clamp `limit` with `Math.min(limit, maxIssues)`.

```typescript
// Before: agent could request any limit
per_page: limit

// After: clamped to config maximum
const effectiveLimit = maxIssues ? Math.min(limit, maxIssues) : limit;
per_page: effectiveLimit
```

**The threading path:** `config.maxIssuesPerRun` -> `core.ts` resolves it -> passes to `createDeepAgentWithGitHub(config, { maxIssues })` -> passes to `createGitHubIssuesTool(owner, repo, octokit, maxIssues)`.

**Teaching note:** This is a defense-in-depth pattern. The prompt says "limit: 5" and the code enforces it. Even if the LLM hallucinates a larger number, the tool silently clamps it. The prompt-level instruction is still useful because it saves API calls (the LLM won't even try to ask for 100), but the code-level cap is the real safety net.

### Connection to next work

These fixes close out quick safety items. The remaining Phase 2 work is the three feature issues: #7 (true dry run), #6 (circuit breaker), and #11 (action tracking).

---

## Entry 19: True Dry-Run Mode -- Swapping Tools at Construction Time (Issue #7)

**Date:** 2026-02-08
**Author:** Builder Agent
**Implements:** Issue #7 (true dry run that skips GitHub writes)
**Files changed:** `src/github-tools.ts`, `src/agent.ts`, `src/core.ts`, `src/cli.ts`, `tests/github-tools.test.ts`
**Version:** 0.2.8

### The problem

The existing `--no-save` flag prevented poll state from being written, but it still executed all GitHub API calls (comments, branches, PRs). Users needed a way to test the full pipeline without touching their repository at all.

### The design decision: tool swapping vs. runtime check

There are two common approaches to dry-run in tool-based agents:

**Option A: Runtime flag inside each tool**
```typescript
// Every tool checks a flag
if (dryRun) { log("would do X"); return fake; }
// then does the real thing
```

**Option B: Swap the entire tool at construction time**
```typescript
// Agent factory picks different tool implementations
const commentTool = dryRun ? createDryRunCommentTool() : createCommentOnIssueTool(owner, repo, octokit);
```

We chose **Option B** because:
1. **No `if` pollution** in the real tools. The production code paths stay clean and unchanged.
2. **The LLM sees the same tool names.** The dry-run wrappers have the same `name` and `schema` as the real tools, so the agent's behavior is identical.
3. **Testable in isolation.** Each dry-run wrapper can be tested without mocking Octokit.
4. **Defense in depth.** The dry-run tool literally has no reference to the Octokit client. It *cannot* make API calls even if something goes wrong.

### How the two flags work together

```
--dry-run   → skip GitHub writes + skip poll state save
--no-save   → keep GitHub writes + skip poll state save
(neither)   → everything runs normally
```

The `dryRun` flag implies `noSave` (implemented as `skipSave = options.noSave || options.dryRun`). This prevents a confusing state where a dry run creates no real artifacts but the poll state records those (phantom) issues as processed.

### What the dry-run tool returns

Each wrapper returns a JSON object with `dry_run: true` plus the same shape as the real tool's success response (with placeholder values). This is important because the agent's next steps may depend on the tool's return value -- for example, the PR creation step reads the branch name from the branch tool's response.

```typescript
// Real tool returns:  { branch: "issue-5-fix", sha: "abc123", url: "https://..." }
// Dry-run returns:    { dry_run: true, branch: "issue-5-fix", sha: "000...0", url: "(dry-run) ..." }
```

### Teaching note: why tool names must match

LangChain tools are registered by name. The agent's system prompt says "use `comment_on_issue`", and when the LLM emits a tool call, it uses that exact name. If the dry-run tool had a different name (like `dry_run_comment_on_issue`), the system prompt would need to change and the agent's behavior would diverge in dry-run mode -- defeating the purpose of a faithful dry run.

### Connection to next work

Circuit breaker (#6) is the next safety feature. It constrains the *quantity* of tool calls (not which tools run), so it operates at a different layer -- it counts calls across all tools rather than swapping implementations.

---

## Entry 20: Circuit Breaker -- Capping Tool Calls to Prevent Runaway Agents (Issue #6)

**Date:** 2026-02-08
**Author:** Builder Agent
**Implements:** Issue #6 (circuit breaker / max tool calls per run)
**Files changed:** `src/github-tools.ts`, `src/agent.ts`, `src/core.ts`, `src/cli.ts`, `tests/github-tools.test.ts`, `tests/core.test.ts`, `config.json.example`
**Version:** 0.2.9

### The problem

LLM agents can enter loops. The ReAct pattern (think-act-observe) works well when the agent makes progress on each iteration, but sometimes the agent gets stuck retrying a failed tool call, or oscillates between two states. Without a hard limit, a looping agent burns unlimited API credits and makes unlimited GitHub API calls.

### Design choices

**Shared counter vs. per-tool counters:** We use a single `ToolCallCounter` instance shared across all tools. This counts *total* tool calls, not per-tool counts. The rationale: the danger is total cost and API abuse, not any single tool being called too often. A normal 5-issue run uses roughly 5 x (1 fetch + 2 reads + 1 comment + 1 branch + 1 PR) = 30 tool calls, so the default limit of 30 is tight but realistic.

**Wrapper pattern vs. callback handler:** LangChain supports callback handlers that can intercept tool calls, but our tools are created by the `langchain` `tool()` function and passed to `deepagents`' `createDeepAgent()`. We don't control the agent loop's callback wiring. Instead, we wrap each tool's `invoke` method with a counter check -- simple, explicit, and testable.

```typescript
export function wrapWithCircuitBreaker<T>(wrappedTool: T, counter: ToolCallCounter): T {
  const originalInvoke = wrappedTool.invoke.bind(wrappedTool);
  wrappedTool.invoke = async (input, options) => {
    counter.increment(wrappedTool.name);  // throws if over limit
    return originalInvoke(input, options);
  };
  return wrappedTool;
}
```

**Error handling strategy:** When `CircuitBreakerError` is thrown, `runPollCycle` catches it, saves poll state (so partially-processed issues are preserved), logs what happened, and exits with code 2. Exit code 2 distinguishes circuit breaker stops from normal errors (code 1) and success (code 0), which is useful for cron monitoring scripts.

### The class design

`ToolCallCounter` is a simple class with a `limit` and a `count`. It throws `CircuitBreakerError` (a custom Error subclass) when `count > limit`. The custom error class carries `callCount` and `callLimit` properties so the catch handler can report specifics.

### Teaching note: why throw instead of return an error string?

The existing tools use the "error string" pattern -- they catch errors and return an error message as a string. This works for recoverable tool failures (API errors, validation errors) because the LLM can read the error and decide what to do next.

But the circuit breaker is fundamentally different: it *must* stop the agent. If we returned an error string, the LLM would just read "circuit breaker tripped" and try to continue. Throwing an exception breaks out of the agent's ReAct loop entirely, which is the correct behavior for a safety limit.

### Connection to next work

Action tracking (#11) is the last Phase 2 feature. It changes the poll state format to track which actions have been completed per issue, enabling the agent to resume partially-completed work.

---

## Entry 21: Per-Issue Action Tracking -- Resumable Workflows (Issue #11)

**Date:** 2026-02-08
**Author:** Builder Agent
**Implements:** Issue #11 (action tracking per issue in poll state)
**Files changed:** `src/core.ts`, `tests/core.test.ts`
**Version:** 0.2.10

### The problem

The old poll state tracked only *which issue numbers* were processed, not *what was done for each one*. If the agent crashed (or hit the circuit breaker) mid-run, it had processed issue #5's comment and branch but not the PR. On the next run, the agent would see "#5 already processed" and skip it entirely -- leaving the PR forever uncreated.

### The new state format

```json
{
  "lastPollTimestamp": "2026-02-08T12:00:00Z",
  "lastPollIssueNumbers": [1, 5],
  "issues": {
    "1": { "commented": true, "branch": "issue-1-fix-login", "pr": 7 },
    "5": { "commented": true, "branch": "issue-5-add-tests", "pr": null }
  }
}
```

The `issues` field maps issue numbers (as strings, because JSON keys are always strings) to an `IssueActions` object tracking three workflow steps: comment, branch, and PR.

### Backwards compatibility

The `issues` field is optional. Old poll state files (no `issues` key) are detected by `migratePollState()` which creates stub entries:

```typescript
// Old format: { lastPollTimestamp, lastPollIssueNumbers: [1, 2] }
// Migrated:   { ..., issues: { "1": { commented: true, branch: null, pr: null }, ... } }
```

We mark migrated issues as `commented: true` because the old code only recorded an issue as processed after commenting. The branch and PR status are unknown, so they're marked `null`.

### How the agent uses action context

`buildUserMessage()` now accepts an optional `issueActions` parameter. When partially-processed issues exist, it adds context to the agent prompt:

```
Partially-processed issues from previous runs (resume these first):
  Issue #5: done=[commented, branch: issue-5-add-tests] remaining=[open PR]
```

This tells the agent to skip the comment and branch steps (they're idempotent anyway, but this saves API calls) and go straight to opening the PR.

### Extracting actions from messages

`extractIssueActions()` scans the agent's tool calls to build action records. It uses naming conventions to link actions to issues:

- `comment_on_issue({ issue_number: 5 })` -> issue #5, commented
- `create_branch({ branch_name: 'issue-5-fix' })` -> issue #5, branch (extracted from branch name pattern)
- `create_pull_request({ head: 'issue-5-fix' })` -> issue #5, PR attempted

The PR number itself comes from parsing the tool's JSON response (if available), since the `create_pull_request` call arguments don't include the PR number -- it's only known after creation.

### Teaching note: why string keys?

JSON object keys are always strings. Even though issue numbers are integers in our TypeScript code, they become `"5"` in the JSON file. We use `String(num)` when indexing into the `issues` map and accept this minor type mismatch because it's the natural representation in persisted JSON. The alternative (using a Map or an array of tuples) would complicate serialization.

### Connection to next work

This completes Phase 2 (Safety & Idempotency). All six Phase 2 issues are now implemented:
- #5 maxIssuesPerRun (v0.2.1)
- #8 idempotent comments (v0.2.2)
- #9 idempotent branches (v0.2.3)
- #10 idempotent PRs (v0.2.4)
- #6 circuit breaker (v0.2.9)
- #7 true dry run (v0.2.8)
- #11 action tracking (v0.2.10)

Plus the quick fixes: cron lock file and code-enforced maxIssuesPerRun (v0.2.7).

Phase 3 (CLI & Testing) was completed earlier. The next milestone is Phase 4 (Intelligence).

---

## Entry 22: Critic Review -- Phase 2 Remainder + v0.3.0 Milestone Decision

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviewed:** Tasks #16-#19 (v0.2.7 through v0.2.10)
**Scope:** Cron lock file, maxIssuesPerRun enforcement, true dry-run, circuit breaker, per-issue action tracking

This review covers the final four Phase 2 implementations. With these, all 7 Phase 2 issues (#5, #6, #7, #8, #9, #10, #11) and both Phase 3 issues (#23, #24) are complete. The central question is: should we bump to v0.3.0?

### Overall Assessment

The implementations are solid. Each addresses a real safety concern with a clean, testable design. The code is well-structured and the teaching notes are accurate and valuable. I have 9 findings -- mostly low severity, with one medium design concern. No HIGH-severity issues.

### Findings

**Finding #1: Lock file cleanup on kill -9 (poll.sh) -- Low**

The `mkdir`/`trap ... EXIT` lock pattern is correct and handles normal exits, `set -e` failures, and most signals. However, `kill -9` (SIGKILL) bypasses all traps. If the agent process is force-killed, `poll.lock/` will persist and all future cron runs will be skipped forever.

This is a known limitation of all lock file schemes. Mitigation options:
- Document that `rmdir poll.lock` is the manual recovery step
- Add a staleness check based on lock directory age (e.g., skip if lock is older than 1 hour)

For a learning project, the current approach is fine. The teaching note correctly explains why `mkdir` beats PID files. But for production use, a staleness check would be important.

**Teaching moment:** Every lock scheme has a failure mode. PID files have race conditions. `mkdir` has the SIGKILL problem. `flock(2)` is automatically released on process death but is not portable to all NFS mounts. There is no perfect lock -- only trade-offs.

**Finding #2: Circuit breaker default of 30 may be too tight -- Medium**

The default `maxToolCallsPerRun` is 30. Entry 20 estimates a normal 5-issue run uses ~30 tool calls: `5 x (1 fetch + 2 reads + 1 comment + 1 branch + 1 PR) = 30`.

But this estimate undercuts the actual workflow. The agent also calls `write_todos` (1 call) and `write_file` for each issue (5 calls), plus `list_repo_files` (at least 1 per issue, possibly more). A realistic 5-issue run is closer to:
- 1 `fetch_github_issues` + 1 `write_todos` = 2
- Per issue: 1 `list_repo_files` + 2 `read_repo_file` + 1 `write_file` + 1 `comment` + 1 `branch` + 1 `PR` = 7
- Total: 2 + (5 x 7) = 37

With the default of 30, a legitimate 5-issue run will trip the circuit breaker around issue #4 or #5. This means the circuit breaker fires during *normal* operation, not just runaway loops.

**Recommendation:** Raise the default to 50 or make it `maxIssuesPerRun * 10`. The current default will cause confusion for learners who think the agent is broken.

**Finding #3: `wrapWithCircuitBreaker` mutates the original tool object -- Low**

```typescript
export function wrapWithCircuitBreaker<T>(wrappedTool: T, counter: ToolCallCounter): T {
  const originalInvoke = wrappedTool.invoke.bind(wrappedTool);
  wrappedTool.invoke = async (input, options) => { ... };
  return wrappedTool;  // returns the same object, now mutated
}
```

This mutates the `invoke` method of the original tool. The function signature suggests it returns a wrapped copy (it accepts and returns `T`), but it modifies in place. If someone called `wrapWithCircuitBreaker` twice on the same tool, the counter would be checked twice per call.

In the current code this is safe because `agent.ts` only wraps once. But it violates the principle of least surprise. A cleaner approach would be to create a new tool object with the wrapped invoke.

**Teaching moment:** Functions named `wrapX` conventionally return a new wrapper, leaving the original untouched. When you mutate the original instead, document it clearly -- or better, create a new object.

**Finding #4: Dry-run wrappers duplicate Zod schemas -- Low**

Each dry-run wrapper (`createDryRunCommentTool`, etc.) defines its own Zod schema that duplicates the real tool's schema. If the real tool's schema changes (e.g., adding a `labels` parameter to `comment_on_issue`), the dry-run wrapper must be updated separately.

This is acceptable at the current scale (3 write tools). But if the tool count grows, consider extracting the schemas to shared constants so both real and dry-run tools reference the same definition.

**Finding #5: `extractIssueActions` uses fragile branch name parsing -- Low**

The function extracts issue numbers from branch names using `String(args.branch_name).match(/^issue-(\d+)/)`. This works for branches following the `issue-N-description` convention but silently ignores branches with other naming patterns.

Similarly, it parses PR response JSON looking for `parsed.title.match(/Fix #(\d+)/)`. These heuristics are reasonable but brittle -- if the agent ever changes its naming convention, action tracking breaks silently.

For a learning project this is fine. The teaching note in Entry 21 correctly identifies the convention dependency. For production, the agent should pass structured metadata (issue number) alongside each tool call.

**Finding #6: Circuit breaker wraps only custom GitHub tools, not built-in deepagents tools -- Low**

In `agent.ts`, the circuit breaker wraps all 6 GitHub tools. But the agent also has access to `write_todos`, `read_file`, and `write_file` from the `deepagents` package. These are not wrapped because they are added by `createDeepAgent()` internally, not passed in the `tools` array.

This means a looping agent that only calls `write_todos` or `write_file` repeatedly would not trip the circuit breaker. In practice this is unlikely (the agent loop usually involves GitHub API calls), but it is an incomplete safety boundary.

**Teaching moment:** When adding cross-cutting concerns (circuit breaker, rate limiter, logging), the boundary must cover *all* tools, not just the ones you control. This is a challenge when using frameworks that add tools internally.

**Finding #7: `runAnalyzeSingle` has no circuit breaker -- Low**

`runPollCycle` creates the agent with `{ maxIssues, dryRun, maxToolCalls }`, but `runAnalyzeSingle` creates the agent with no options: `createDeepAgentWithGitHub(config)`. This means `analyze --issue 42` runs without a circuit breaker or dry-run capability.

The `analyze` command is for single-issue use, so runaway loops are less likely. But for consistency, it should pass through the same safety options.

**Finding #8: `migratePollState` assumes `commented: true` for old issues -- Info**

When migrating old poll state (no `issues` field), the function marks all issues as `commented: true, branch: null, pr: null`. The assumption that the comment was posted is reasonable (the old code only recorded issues after commenting), but the branch and PR could also have been created.

Entry 21 documents this assumption clearly. The consequence is that on the first run after migration, the agent may skip comments (good) but will retry branches and PRs (which are idempotent, so harmless). Correct behavior.

**Finding #9: CHANGELOG v0.2.5 still references old `--dry-run` behavior -- Info**

The v0.2.5 CHANGELOG entry says:
- `--dry-run flag for poll command (no poll state written)`
- `dry-run shorthand command (equivalent to poll --dry-run)`

This is now outdated. The `--dry-run` flag was renamed to `--no-save` in the Architect's rename (not versioned), then `--dry-run` was reintroduced in v0.2.8 with different (stronger) semantics. A reader going through the CHANGELOG chronologically will be confused.

**Recommendation:** Update the v0.2.5 entry to reference `--no-save` (its current name) or add a note that this was superseded by v0.2.8.

### Teaching Notes Accuracy

All four entries (18-21) are well-written and technically accurate.

- Entry 18: `mkdir` atomicity explanation is correct. `trap EXIT` coverage is accurate.
- Entry 19: Tool swapping vs. runtime flag comparison is a genuinely useful architectural lesson. The four reasons for choosing Option B are sound.
- Entry 20: The throw-vs-return distinction for circuit breakers is an important insight. Exit code 2 for monitoring is a good practice.
- Entry 21: The JSON string-keys teaching note is a small but valuable gotcha for TypeScript developers.

One minor note: Entry 21 lists "six Phase 2 issues" but then enumerates seven (#5, #6, #7, #8, #9, #10, #11). The count should say seven, not six.

### Test Coverage Assessment

Tests were added for all new functionality:

| Feature | Tests | Quality |
|---------|-------|---------|
| `maxIssuesPerRun` clamping | 3 tests (clamp, no-clamp, no-limit) | Good -- covers all three code paths |
| Dry-run wrappers | 6 tests (2 per tool: result shape + name match) | Good -- verifies tool name identity |
| `ToolCallCounter` | 4 tests (increment, at-limit, over-limit, error shape) | Good -- boundary conditions covered |
| `wrapWithCircuitBreaker` | 3 tests (counting, throw, cross-tool sharing) | Good -- the cross-tool test is especially valuable |
| `getMaxToolCalls` | 5 tests (valid, missing, zero, negative, string) | Good -- mirrors getMaxIssues pattern |
| `migratePollState` | 3 tests (new format, old format, empty) | Good |
| `extractIssueActions` | 6 tests (empty, comment, branch, PR, merge, no-match) | Good -- covers the happy path and edge cases |
| `buildUserMessage` with actions | 3 tests (partial, complete, no-actions) | Good |

Total new tests: ~33 across the four tasks. Combined with the existing ~34 tests from Phase 3, the test suite is now at approximately 67 tests. This is strong coverage for a learning project.

**Still missing:** `createListRepoFilesTool` tests (flagged in Entry 17, Finding #6). This remains the only untested tool.

### Version Recommendation: Bump to v0.3.0

**Yes, this is the right time for v0.3.0.**

Rationale:
1. **Phase 2 is complete.** All 7 issues (#5, #6, #7, #8, #9, #10, #11) are implemented and tested.
2. **Phase 3 is complete.** Both issues (#23, #24) are implemented and tested.
3. **The versioning plan maps v0.3.0 to Phase 2.** Since Phase 3 was completed out of order (before Phase 2 finished), consolidating both into v0.3.0 tells a cleaner story than bumping Phase 3 separately.
4. **All previously-flagged HIGH issues are resolved.** The `--dry-run` semantics (Entry 17 Finding #2) is fixed. The cron lock file (flagged in Entries 7, 11, and 14) is implemented. The maxIssuesPerRun code enforcement (Entry 14 Finding #7) is done.

The v0.3.0 CHANGELOG entry should note: "Phase 2 (Safety & Idempotency) + Phase 3 (CLI & Testing) complete."

### Open Items Carried Forward

| # | Finding | Severity | First flagged |
|---|---------|----------|---------------|
| 1 | `config.ts` uses `process.exit` instead of throwing | Low | Entry 7 |
| 2 | Config type is `any` from `JSON.parse` | Low | Entry 7 |
| 3 | `bin` field points to `.ts` file (npx fails) | Medium | Entry 17 |
| 4 | No tests for `createListRepoFilesTool` | Medium | Entry 17 |
| 5 | Circuit breaker default may be too tight (30) | Medium | This entry |
| 6 | `runAnalyzeSingle` has no circuit breaker | Low | This entry |

---

## Entry 23: Closing the Loop -- Committing Code and Self-Review (Issues #25, #27)

**Date:** 2026-02-08
**Author:** Architect Agent

### The gap: empty PRs

After Phase 1-3, the agent could analyze issues, comment, create branches, and open PRs — but the PRs were always empty. The agent had no tool to commit files to a branch. It could *read* the codebase but not *write back* to it.

### The fix: `create_or_update_file` tool (Issue #25)

Added a new tool using `octokit.rest.repos.createOrUpdateFileContents()`. This GitHub API endpoint creates or updates a single file in a single commit. Key design choices:

1. **Full file content, not diffs.** The agent writes the complete file content, not a patch. This is simpler for the LLM (no diff format to get wrong) and matches the GitHub API's model.
2. **Auto-detects create vs update.** The tool checks if the file exists on the branch. If it does, it includes the existing SHA (required by GitHub for updates). If not, it creates the file.
3. **One commit per call.** Each tool invocation creates one commit. Multi-file changes require multiple calls. This is simple but verbose in git history — acceptable for a learning project.

The tool follows all existing patterns: circuit breaker wrapping, dry-run stub, Zod schema validation.

### The self-review step (Issue #27)

With the agent now able to commit code, a new risk appeared: hallucinated code. The agent might invent imports, functions, or APIs that don't exist in the codebase.

**First attempt:** Hard constraints — "NEVER add new dependencies", "ONLY use existing patterns." This was too restrictive. Adding dependencies is a legitimate part of coding. Some issues require new libraries.

**Corrected approach:** Soft self-review. After committing, the agent reads back its changes and sanity-checks them:
- Do imports resolve to real modules?
- Do function calls match actual signatures?
- Are new dependencies justified?

If something is clearly wrong, the agent fixes it. Otherwise, it notes what it checked in the PR body.

### Why soft, not hard?

The project architecture already has the answer: the **PR reviewer bot** (Phase 8) is the real gate. The self-review is a lightweight first pass that catches obvious mistakes. Hard constraints in the analyzer bot would block legitimate fixes. The design philosophy is:
- **Issue handler** (this project) = proposes freely
- **PR reviewer** (Phase 8) = catches problems
- **Human** = makes the final merge decision

This is a three-layer defense: self-review → reviewer bot → human. Each layer catches what the previous one missed.

### The 7-step workflow

The agent's workflow is now:
1. **Analyze** — read issue + relevant source files
2. **Comment** — post summary on the issue
3. **Document** — write detailed analysis to `./issues/`
4. **Branch** — create feature branch
5. **Commit** — push proposed changes to the branch
6. **Self-review** — read back, sanity-check, fix if needed
7. **PR** — open draft PR with analysis + self-review notes

### Teaching moment: prompt constraints vs code constraints vs architecture constraints

This session surfaced three layers of enforcement:

| Layer | Example | Strength | When to use |
|-------|---------|----------|-------------|
| **Prompt** | "Prefer existing patterns" | Weak — LLM can ignore | Style guidance, soft preferences |
| **Code** | `maxIssuesPerRun` clamped in tool constructor | Strong — cannot be bypassed | Correctness-critical limits |
| **Architecture** | Reviewer bot as separate gate | Strongest — separate system | Safety-critical validation |

The mistake is using prompts for things that need code enforcement, or code for things that need architectural separation. The self-review is correctly a prompt-level concern (it's advisory). The circuit breaker is correctly code-level (it's a hard limit). The reviewer bot is correctly architectural (it's a separate trust boundary).

---

## Entry 24: Phase 4 Architecture -- Two-Phase Agent Pipeline (Triage + Analysis)

**Date:** 2026-02-08
**Author:** Architect Agent
**Builds on:** Entries 1, 8, 23

### Why Phase 4 exists

After Phases 1-3, the agent is code-aware, safe, testable, and can commit real changes. But it has one fundamental inefficiency: **every issue gets the same treatment**. A typo in a README and a complex race condition in the core loop both trigger the full 7-step workflow -- read the entire codebase, post a detailed comment, write an analysis file, create a branch, commit a fix, self-review, and open a PR.

This is expensive. Each full run can burn dozens of tool calls and thousands of LLM tokens. Phase 4 introduces **two-phase processing** to fix this: a cheap, fast **triage agent** scopes each issue first, then an expensive, thorough **analysis agent** does the deep work -- but only when the triage agent says it is worth it.

### The conceptual shift: ReAct loop to StateGraph

Through Phases 1-3, the project used a single ReAct loop. Here is what that looks like:

```
User message
    |
    v
[Single Agent: ReAct Loop]
    |-- call tool --> get result --> think --> call tool --> ...
    |
    v
Final response
```

The ReAct pattern (Reason + Act) is a loop: the LLM thinks, picks a tool, sees the result, thinks again, picks another tool, and so on until it decides it is done. This is powerful but monolithic -- one model, one system prompt, one continuous chain of thought.

**LangGraph's StateGraph** breaks this into a directed graph of discrete steps:

```
[Fetch Issues]
      |
      v
[Triage Agent] ──── should_analyze? ────┐
      |                                  |
      | (yes)                      (no)  |
      v                                  v
[Analysis Agent]                   [Log & Skip]
      |
      v
[Post Results]
```

Each box is a **node** (a function or agent). Each arrow is an **edge** (a transition). Conditional edges let us route based on the triage output. The graph carries a **state** object that flows between nodes, accumulating context.

### Why this matters for learning

If you are studying agentic systems, this is the biggest conceptual jump in the project:

| Concept | ReAct (Phases 1-3) | StateGraph (Phase 4) |
|---------|-------------------|---------------------|
| **Structure** | One agent, one loop | Multiple agents, explicit graph |
| **Decisions** | Implicit (LLM decides when to stop) | Explicit (conditional edges) |
| **Model selection** | One model for everything | Different model per node |
| **Debugging** | Read the full conversation trace | Inspect state at each node |
| **Cost control** | Circuit breaker (hard stop) | Route cheap issues to cheap processing |

The StateGraph does not replace ReAct -- each node *inside* the graph can still use a ReAct loop internally. The graph adds structure *around* the loops.

### LangGraph StateGraph: how it works

LangGraph (the `@langchain/langgraph` package, used by `deepagents`) provides the `StateGraph` class. Here is the mental model:

**1. Define the state schema.** This is a TypeScript type (or Zod schema) that describes what data flows between nodes. Every node reads from and writes to this shared state.

```typescript
// Conceptual state for the two-phase pipeline
interface PipelineState {
  issue: {                // The GitHub issue being processed
    number: number;
    title: string;
    body: string;
    labels: string[];
  };
  triage: {               // Output from the triage agent
    issueType: 'bug' | 'feature' | 'docs' | 'question' | 'unknown';
    complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
    relevantFiles: string[];
    shouldAnalyze: boolean;
    skipReason?: string;
    summary: string;
  } | null;
  analysis: {             // Output from the analysis agent
    comment: string;
    documentPath: string;
    branch: string;
    prNumber: number;
  } | null;
}
```

**2. Define the nodes.** Each node is a function that takes the current state and returns a partial state update. The graph merges the updates into the running state.

```typescript
// Triage node: lightweight, fast
async function triageNode(state: PipelineState): Promise<Partial<PipelineState>> {
  // Call the triage agent (cheap model, limited tools)
  const triageResult = await triageAgent.invoke({ issue: state.issue });
  return { triage: triageResult };
}

// Analysis node: thorough, expensive
async function analysisNode(state: PipelineState): Promise<Partial<PipelineState>> {
  // Call the analysis agent (expensive model, full tool suite)
  // Uses state.triage to know what files to focus on
  const analysisResult = await analysisAgent.invoke({
    issue: state.issue,
    triage: state.triage,
  });
  return { analysis: analysisResult };
}
```

**3. Define the edges.** Edges connect nodes. Conditional edges inspect the state to decide where to go next.

```typescript
// Conditional edge: should we analyze or skip?
function shouldAnalyze(state: PipelineState): 'analyze' | 'skip' {
  if (state.triage?.shouldAnalyze) return 'analyze';
  return 'skip';
}
```

**4. Wire the graph.**

```typescript
const graph = new StateGraph({ schema: PipelineStateSchema })
  .addNode('triage', triageNode)
  .addNode('analyze', analysisNode)
  .addNode('skip', skipNode)
  .addEdge('__start__', 'triage')
  .addConditionalEdges('triage', shouldAnalyze, {
    analyze: 'analyze',
    skip: 'skip',
  })
  .addEdge('analyze', '__end__')
  .addEdge('skip', '__end__');

const pipeline = graph.compile();
```

When you call `pipeline.invoke({ issue })`, LangGraph executes the graph step by step: start -> triage -> (condition) -> analyze or skip -> end. The state accumulates through each step.

### How the `deepagents` package supports this

The `deepagents` package (v1.7.2) already provides the building blocks:

1. **`createDeepAgent()`** creates a ReAct agent with built-in middleware (todo list, filesystem tools, summarization). It returns a `DeepAgent` which is a `ReactAgent` wrapped with type information.

2. **Subagents.** `createDeepAgent` accepts a `subagents` parameter -- an array of `SubAgent` specs. Each subagent has its own `name`, `description`, `systemPrompt`, `tools`, and optionally a different `model`. The main agent can delegate work to subagents via the built-in `task` tool.

3. **LangGraph's `StateGraph`** (from `@langchain/langgraph`) is available as a direct dependency. We can use it to build the two-phase pipeline without the `task` tool -- instead of one agent delegating to another dynamically, we wire the agents into a fixed graph with explicit transitions.

**Which approach for Phase 4?** Two options:

| Approach | How it works | Pros | Cons |
|----------|-------------|------|------|
| **Subagent delegation** | Main agent uses `task` tool to call triage/analysis subagents | Simple setup, leverages existing `createDeepAgent` | Routing decision is made by the LLM (prompt-based), not code-enforced |
| **StateGraph pipeline** | Explicit graph with triage and analysis as nodes | Routing is deterministic (code-enforced), each node gets exactly the right tools | More code to write, new pattern to learn |

**Decision: StateGraph pipeline.** The whole point of Phase 4 is learning the StateGraph pattern (Entry 8 calls it out explicitly). And the routing decision -- "should this issue get deep analysis?" -- is exactly the kind of thing that should be code-enforced, not left to prompt-based suggestions (a recurring theme from Entries 14, 20, 23).

### What changes in the codebase

Here is the current flow and the target flow:

**Current (single agent):**

```
src/index.ts
  → loadConfig()
  → src/core.ts: runPollCycle()
      → src/agent.ts: createDeepAgentWithGitHub()
          → creates ONE agent with ALL tools and ONE system prompt
      → agent.invoke({ messages: [userMessage] })
      → extract poll state from conversation
      → save state
```

**Target (two-phase pipeline):**

```
src/index.ts
  → loadConfig()
  → src/core.ts: runPollCycle()
      → src/pipeline.ts: createPipeline()       <-- NEW FILE
          → creates triage agent (cheap model, read-only tools)
          → creates analysis agent (expensive model, full tools)
          → wires them into a StateGraph
      → pipeline.invoke({ issues })
      → extract poll state from graph state
      → save state
```

**New files:**

| File | Purpose |
|------|---------|
| `src/pipeline.ts` | StateGraph definition: nodes, edges, state schema |
| `src/triage-agent.ts` | Triage agent factory: cheap model, limited tools, scoping prompt |
| `src/analysis-agent.ts` | Analysis agent factory: expensive model, full tools, deep analysis prompt |

**Changed files:**

| File | What changes |
|------|-------------|
| `src/core.ts` | `runPollCycle()` calls `createPipeline()` instead of `createDeepAgentWithGitHub()` |
| `src/agent.ts` | Kept for backwards compatibility, but the pipeline becomes the primary entry point |
| `src/config.ts` | May need a `triageModel` field alongside the existing `llm` config |
| `src/index.ts` | No change -- it still calls `runPollCycle()` |

### The triage agent: what it does and what it does NOT do

The triage agent is the first phase. Its job is to **scope** the issue quickly and cheaply:

**What it does:**
- Reads the issue title, body, and labels
- Calls `list_repo_files` to see the repo structure
- Optionally calls `read_repo_file` on 1-2 files to confirm relevance
- Classifies the issue type (bug, feature, docs, question)
- Estimates complexity (trivial, simple, moderate, complex)
- Identifies which files are most relevant
- Decides: should this issue proceed to full analysis?

**What it does NOT do:**
- Post comments on the issue
- Write analysis files
- Create branches
- Open PRs
- Read more than a few files

The triage agent has access to **read-only tools only**: `fetch_github_issues`, `list_repo_files`, `read_repo_file`. No write tools. This is a deliberate constraint -- the triage phase should be cheap, fast, and side-effect-free.

**Model choice:** The triage agent can use a smaller, cheaper model (e.g., Claude Haiku, GPT-4o-mini). Its task is classification and scoping, not deep reasoning. This is the **model routing** pattern: use the right model for the right job.

### The analysis agent: picking up where triage left off

The analysis agent is the second phase. It receives the triage output as context and performs the full 7-step workflow from Entry 23:

1. **Analyze** -- but now it already knows the issue type, complexity, and relevant files (from triage). It can skip the exploratory phase and go straight to the relevant code.
2. **Comment** -- post findings on the issue.
3. **Document** -- write `./issues/issue_<number>.md`.
4. **Branch** -- create the feature branch.
5. **Commit** -- push proposed changes.
6. **Self-review** -- read back and sanity-check.
7. **PR** -- open the draft PR.

The analysis agent has access to **all tools**: both read-only and write tools. It uses the full (expensive) model because its task requires deep reasoning about code.

**Key advantage:** The analysis agent receives `triage.relevantFiles` in its state. Instead of calling `list_repo_files` and scanning the entire repo (like the current single agent does), it can jump directly to the files that matter. This saves tool calls, reduces token usage, and focuses the analysis.

### The state contract: how triage feeds analysis

The triage agent's output is the analysis agent's input. This is the **interface** between the two phases. Getting this interface right is critical -- it determines what information flows downstream.

```typescript
interface TriageOutput {
  issueType: 'bug' | 'feature' | 'docs' | 'question' | 'unknown';
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
  relevantFiles: string[];      // file paths the analysis agent should focus on
  shouldAnalyze: boolean;       // false = skip this issue
  skipReason?: string;          // why we're skipping (logged for debugging)
  summary: string;              // one-paragraph scope statement
}
```

This is why **Issue #3 (triage) must be built before Issue #4 (analysis)**. The triage agent *defines* this interface. The analysis agent *consumes* it. If you built the analysis agent first, you would have to guess what the triage output looks like -- and you would guess wrong, because the shape of the triage output only becomes clear when you actually build the triage agent and see what information it naturally produces.

This is a general principle in multi-agent systems: **build the upstream agent first**. The upstream agent defines the contract; the downstream agent implements against it.

### Dependency map for Phase 4

```
Phase 1-3 (complete)
    |
    | Provides: tools (list_repo_files, read_repo_file, comment_on_issue, etc.)
    | Provides: test infrastructure (vitest, mocks)
    | Provides: CLI (deepagents poll, deepagents analyze)
    | Provides: safety (circuit breaker, idempotency, dry-run)
    |
    v
Issue #3: Triage Agent
    |
    | Defines: TriageOutput interface (the state contract)
    | Defines: triage system prompt
    | Produces: src/triage-agent.ts
    | Tests: unit tests with mocked LLM
    |
    v
Issue #4: Analysis Agent
    |
    | Consumes: TriageOutput interface
    | Defines: analysis system prompt (enhanced with triage context)
    | Produces: src/analysis-agent.ts, src/pipeline.ts
    | Changes: src/core.ts (switch from single agent to pipeline)
    | Tests: unit tests with mocked LLM, integration test for full pipeline
    |
    v
Phase 4 Complete (v0.5.0 milestone -- per Entry 8 versioning plan)
```

**What Phase 4 depends on from earlier phases:**

| Dependency | From | Why |
|-----------|------|-----|
| `list_repo_files`, `read_repo_file` | Phase 1 | Triage agent needs to see the codebase |
| Circuit breaker, idempotency | Phase 2 | Both agents need bounded, safe tool usage |
| Dry-run mode | Phase 2 | Testing the pipeline without side effects |
| Test infrastructure | Phase 3 | Unit testing each agent independently |
| `create_or_update_file`, self-review | Phase 3 | Analysis agent commits code and reviews it |

### The skip path: when triage says "no"

Not every issue needs full analysis. The triage agent might decide to skip an issue because:

- It is a **question**, not a bug or feature (better handled by a human)
- It is a **duplicate** of an already-processed issue
- It is **too vague** to act on (needs more information from the reporter)
- It is **out of scope** (targets a different repo or external dependency)

When `shouldAnalyze: false`, the graph follows the skip edge. The skip node logs the reason and moves on. No tools are called, no comments posted, no branches created. The issue can be re-triaged on the next poll if it gets updated.

This is where the cost savings come from. If 3 out of 5 issues in a poll run are skippable, the pipeline runs the expensive analysis agent only twice instead of five times.

### Model routing: the right model for the right job

Phase 4 introduces a second model configuration. The current `config.json` has one `llm` block:

```json
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "...",
    "model": "claude-sonnet-4-5-20250929"
  }
}
```

For Phase 4, we need to support a triage model separately:

```json
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "...",
    "model": "claude-sonnet-4-5-20250929"
  },
  "triageLlm": {
    "provider": "anthropic",
    "apiKey": "...",
    "model": "claude-haiku-4-5-20251001"
  }
}
```

If `triageLlm` is not specified, both agents use the same model. This keeps the config backwards-compatible -- existing users do not need to change anything.

**Why different models?** Cost and latency. A triage classification can be done by a small model in milliseconds. Deep code analysis needs a large model that reasons carefully. Using the same large model for both is wasteful. The model routing pattern is one of the most practical cost-optimization techniques in production agentic systems.

### What this teaches about agent architecture

Phase 4 teaches three patterns that come up repeatedly in production agentic systems:

**1. Pipeline decomposition.** Breaking a monolithic agent into stages with defined interfaces. Each stage has a clear responsibility, its own prompt, and its own tool set. This is the agent equivalent of Unix pipes: each program does one thing well, and the output of one feeds the input of the next.

**2. Conditional routing.** Not every input takes the same path through the pipeline. The StateGraph's conditional edges make this explicit and deterministic. Compare this to the alternative: putting "skip low-priority issues" in the system prompt and hoping the LLM follows it. The StateGraph approach is code-enforced routing (Entry 23's "code constraint" layer).

**3. Model routing.** Different stages can use different models, optimized for their specific task. This is the beginning of a cost model for agentic systems: total cost = (triage cost per issue x all issues) + (analysis cost per issue x analyzed issues). If triage is 10x cheaper than analysis and filters out 60% of issues, the pipeline is roughly 5x cheaper than running full analysis on everything.

### Connection to future entries

The Builder agent will implement Phase 4 in two entries:
- Entry 25: Implementing the triage agent (Issue #3) -- the triage system prompt, read-only tool set, and TriageOutput interface
- Entry 26: Implementing the analysis agent and pipeline (Issue #4) -- the StateGraph wiring, enhanced analysis prompt, and pipeline integration into `runPollCycle()`

After both are complete, we will write a Phase 4 retrospective entry.

---

## Entry 25: Implementing the Triage Agent (Issue #3)

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entry 24

### What just happened

Entry 24 designed the two-phase pipeline architecture. This entry implements the first phase: the triage agent. The triage agent is a standalone component that classifies GitHub issues quickly and cheaply, deciding which ones deserve expensive full analysis.

### The pattern: structured JSON output from an LLM

The triage agent needs to return a structured `TriageOutput` object, but it is an LLM -- it returns text, not typed data. The simplest approach that works reliably: instruct the agent via system prompt to output raw JSON, then parse and validate the response.

```typescript
// The system prompt says: "Your FINAL message must be the JSON object and nothing else."
// The parser extracts JSON, validates fields, and falls back to safe defaults.
export function parseTriageOutput(text: string): TriageOutput {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ...FALLBACK_TRIAGE };
  // ... parse, validate, normalize
}
```

**Why not structured output (tool_use/function_call)?** Structured output schemas vary by provider. The JSON-in-text approach works with any LLM -- Anthropic, OpenAI, Ollama, local models. Since this is a learning project that supports multiple providers, portability wins over elegance.

**Why a conservative fallback?** If parsing fails, we default to `shouldAnalyze: true`. It is better to over-analyze (wasting some tokens) than to skip a real issue. The fallback is the triage agent's error budget.

### The pattern: read-only tool isolation

The triage agent has access to exactly three tools: `fetch_github_issues`, `list_repo_files`, `read_repo_file`. All are read-only. It cannot post comments, create branches, or open PRs.

This is **tool isolation** -- giving each agent exactly the capabilities it needs and no more. The constraint is enforced at the code level (the agent is constructed with only read-only tools), not at the prompt level. This is a recurring theme from Entries 14, 20, and 24: code-enforced constraints are more reliable than prompt-based ones.

The triage agent also has its own tight circuit breaker (8 tool calls max). A triage that needs more than 8 tool calls is doing too much work -- it should be fast.

### The pattern: model routing via config fallback

```typescript
const modelConfig = config.triageLlm
  ? { ...config, llm: config.triageLlm }
  : config;
const model = createModel(modelConfig);
```

If `triageLlm` is configured, the triage agent uses a different (typically cheaper) model. If not, it falls back to the main `llm` config. This is backwards-compatible -- existing configs work without changes.

### How triage integrates into the poll cycle

The poll cycle now has two phases:

1. **Fetch + Triage:** Fetch new issues from GitHub (via direct Octokit call, not through the agent). For each new issue, run the triage agent. Issues where `shouldAnalyze: false` are logged and skipped.

2. **Analysis:** The existing full agent runs on the remaining issues (the ones triage approved).

This means the poll cycle now makes its own decision about which issues to analyze, rather than delegating everything to a single monolithic agent. The triage decision is code-enforced via the `shouldAnalyze` boolean.

### Aha moment: the triage agent is the interface definition

Building the triage agent forced us to define `TriageOutput` concretely. Before implementation, the interface was conceptual (Entry 24's design). After implementation, it is battle-tested -- we know exactly what fields the LLM actually produces, what edge cases arise (missing fields, invalid enum values), and how to handle parsing failures.

This validates Entry 24's principle: **build the upstream agent first**. The downstream analysis agent (Issue #4) will consume `TriageOutput`. Now that interface is real, tested with 19 unit tests, and has clear fallback semantics.

### Files changed

| File | What changed |
|------|-------------|
| `src/triage-agent.ts` | **NEW** -- triage agent factory, TriageOutput interface, parser, message builder |
| `src/config.ts` | Added `triageLlm` validation (optional, falls back to main llm) |
| `src/core.ts` | Added `fetchSingleIssue()`, `runTriageSingle()`, triage pre-filter in `runPollCycle()` |
| `src/cli.ts` | Added `triage` subcommand: `deepagents triage --issue N` |
| `config.json.example` | Added `triageLlm` field placeholder |
| `tests/triage-agent.test.ts` | **NEW** -- 19 tests for parseTriageOutput and buildTriageMessage |
| `tests/config.test.ts` | 5 new tests for triageLlm config validation |

---

## Entry 26: Critic's Phase 4 Review -- Triage Agent

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviewed:** Entry 25 implementation (Issue #3, PR #34, branch `issue-3-triage-agent`)
**Scope:** Triage agent factory, TriageOutput parsing, config extension, CLI subcommand, poll cycle integration, Ollama model fix
**Files reviewed:** `src/triage-agent.ts`, `src/core.ts`, `src/config.ts`, `src/cli.ts`, `src/model.ts`, `tests/triage-agent.test.ts`, `tests/config.test.ts`, `tests/model.test.ts`, `CHANGELOG.md`, `config.json.example`

### Overall Assessment

This is a well-structured implementation of the first phase of the two-phase pipeline. The triage agent follows the project's established patterns: read-only tool isolation, conservative fallbacks, circuit breaker wrapping, and backwards-compatible config. The code is clean and the test suite is thorough for the parsing layer.

I have 10 findings: one **HIGH** (triage results not passed to the analysis agent), two **MEDIUM** (analysis agent still re-fetches everything; triage-skipped issues mark as "processed" permanently), and the rest LOW/INFO. The HIGH finding is a functional gap that should be addressed before or alongside Issue #4.

### Findings

**Finding #1: Triage results are not passed to the analysis agent -- HIGH**

The triage phase runs, classifies issues, and filters them. But then the analysis phase starts from scratch:

```typescript
// core.ts ~line 407-420 (after triage block)
// ── Analysis phase ──────────────────────────────────────────────────────

// Create agent
const agent = createDeepAgentWithGitHub(config, { maxIssues, dryRun: options.dryRun, maxToolCalls });

// Build user message (include action context for partially-processed issues)
const userMessage = buildUserMessage(
  maxIssues,
  sinceDate,
  previousIssueNumbers,
  pollState?.issues,
);
```

The `toAnalyze` array (containing triage results with `issueType`, `complexity`, `relevantFiles`, and `summary`) is computed but never used. The analysis agent receives the same `buildUserMessage()` it always did -- it fetches issues from GitHub again via its own tool call, completely ignoring the triage output.

This means:
- The analysis agent re-fetches the same issues triage already fetched (double API calls)
- The analysis agent does not receive `relevantFiles` (loses the triage's file scoping)
- The analysis agent does not know which issues were filtered out by triage -- it might re-discover and analyze them anyway
- The cost savings from triage filtering are partially negated because the analysis agent might process the skipped issues too

**Teaching moment:** This is the classic "pipeline with a gap" problem. The triage phase produces valuable context (`TriageOutput`), but the handoff to the analysis phase drops that context on the floor. In a StateGraph pipeline (as designed in Entry 24), this handoff is explicit -- the state flows between nodes. In the current imperative integration, the handoff must be done manually, and it was missed.

Entry 24 specifically designed the `TriageOutput` interface as "the contract between triage and analysis phases." The contract exists in code (the interface), but the actual data flow is not connected yet.

**Recommendation:** This is expected to be resolved by Issue #4 (analysis agent), which will consume `TriageOutput`. But the current code is misleading -- it runs triage, computes `toAnalyze`, and then ignores it. At minimum, add a comment: `// TODO(Issue #4): Pass toAnalyze to the analysis agent instead of re-fetching`. Or better, filter the `buildUserMessage()` to only include the approved issue numbers.

**Finding #2: Triage-skipped issues are permanently marked as "processed" -- MEDIUM**

When triage skips an issue, the issue number is added to `lastPollIssueNumbers`:

```typescript
// core.ts ~line 393
const allProcessed = [...previousIssueNumbers, ...triageResults.map((r) => r.issue.number)];
```

This means skipped issues will never be re-triaged, even if:
- The issue is updated with more information (was "too vague", now has a detailed description)
- The reporter adds clarifying comments
- Labels change (a "question" is re-labeled as "bug")

The `since` parameter in `fetchIssuesForPoll` uses `updated_at`, so updated issues would re-appear in the API response. But the `newIssues` filter removes them:

```typescript
const newIssues = issues.filter((i) => !previousIssueNumbers.includes(i.number));
```

**Teaching moment:** This reveals a semantic mismatch. `lastPollIssueNumbers` means "issues we have fully processed" in the original design, but here it is overloaded to also mean "issues triage decided to skip." These are different things -- a processed issue should not be re-analyzed, but a skipped issue might deserve re-triage if it changes.

**Possible fix:** Track triage-skipped issues separately from fully-analyzed issues. For example:
```typescript
// In poll state:
{
  lastPollIssueNumbers: [1, 2, 3],  // fully analyzed
  triageSkipped: [4, 5],             // skipped by triage, re-triage if updated
}
```

Then the filter would only exclude fully-analyzed issues, and skipped issues would be re-triaged if their `updated_at` is newer than the last poll.

**Impact:** Medium -- silently drops issues that might become actionable. For a learning project this is acceptable as a known limitation, but it should be documented.

**Finding #3: Analysis agent still fetches and processes ALL issues despite triage filtering -- MEDIUM**

Related to Finding #1, but a distinct problem. Even when triage runs, the analysis phase calls `buildUserMessage(maxIssues, sinceDate, previousIssueNumbers, ...)` which tells the analysis agent to "fetch open issues" via its own tool call. The analysis agent has no knowledge that triage already filtered the list.

In the worst case, triage says "skip issue #5" but the analysis agent fetches all issues including #5 and analyzes it anyway. The triage filtering is effectively advisory, not enforced.

**Teaching moment:** This is another instance of the "prompt-based constraint" vs "code-enforced constraint" pattern (Entry 14 Finding #1, Entry 23). The triage decision is code-enforced at the triage level, but the downstream analysis agent can still undo it because it has direct access to `fetch_github_issues`.

**Finding #4: `parseTriageOutput` regex is greedy across multiple JSON objects -- LOW**

```typescript
const jsonMatch = text.match(/\{[\s\S]*\}/);
```

The `[\s\S]*` is greedy. If the LLM response contains two JSON objects (e.g., the agent calls a tool that returns JSON, and then outputs its own JSON), the regex matches from the first `{` to the last `}`, spanning both objects. The resulting string is likely malformed JSON.

Example: `Tool returned: {"files": ["a.ts"]} Here is my assessment: {"issueType": "bug", ...}` would match `{"files": ["a.ts"]} Here is my assessment: {"issueType": "bug", ...}`, which is not valid JSON. `JSON.parse` would fail and the fallback would activate.

The fallback is safe (defaults to `shouldAnalyze: true`), so this is not dangerous. But it means legitimate triage output could be silently discarded if the LLM includes tool results in its final message.

**Fix:** Use a non-greedy match or extract the last JSON object: `text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)` and take the last match. Or simply search from the end of the string.

**Impact:** Low -- the fallback handles it safely, and well-prompted LLMs typically output clean JSON as their final message.

**Finding #5: Triage creates a new agent (and Octokit client) per issue -- LOW**

```typescript
// triage-agent.ts:214
export async function runTriage(config, issue): Promise<TriageOutput> {
  const agent = createTriageAgent(config);  // creates new agent, new Octokit, new tools
  // ...
}
```

In the poll cycle, `runTriage` is called in a loop for each issue. Each call creates a new agent, new Octokit client, new tool instances, and new circuit breaker counter. For 5 issues, that is 5 agents and 5 Octokit clients.

This is wasteful but not harmful. The circuit breaker counter resets per agent, which means each triage run gets its own budget of 8 tool calls -- this is actually correct behavior (each issue should get its own budget).

However, the Octokit client creation is unnecessary overhead. The agent could be created once and reused across issues.

**Teaching moment:** Agent-per-invocation vs agent-per-session is a design choice. Agent-per-invocation (current) is simpler and avoids conversation state leaking between issues. Agent-per-session would be more efficient but requires resetting the conversation between calls. For a learning project, simplicity wins.

**Finding #6: `skipTriage` flag disconnects the triage and analysis phases -- LOW**

When `options.skipTriage` is true, the entire triage block is skipped and the analysis phase runs as before. But the `previousIssueNumbers` variable is still set from poll state, so the analysis phase correctly handles previously-processed issues.

The issue is that `skipTriage` is accepted as an option but never exposed via CLI. It is an internal escape hatch with no documentation and no tests.

**Recommendation:** Either expose it as `--skip-triage` in the CLI (consistent with `--no-save` and `--dry-run`), or remove it until needed. Dead options accumulate confusion.

**Finding #7: The Ollama model change is unrelated to triage -- INFO**

The diff includes switching `ollama` from `ChatOpenAI` with compatibility wrapper to native `ChatOllama` from `@langchain/ollama`. This is a good improvement (native client is more reliable than the OpenAI compatibility layer), but it is unrelated to the triage agent feature.

The change also adds `@langchain/ollama` as a dependency (visible in `pnpm-lock.yaml`). The tests are updated to mock `ChatOllama` and verify the `baseUrl` `/v1` stripping logic.

**Teaching moment:** Bundling unrelated changes in a feature branch is common but makes code review harder. A reviewer looking at "triage agent" does not expect to also review model client changes. Ideally this would be a separate commit or PR. For a learning project this is fine, but in production it is a common source of review fatigue.

**Finding #8: Config validation uses falsy check, not type check -- LOW**

```typescript
// config.ts:32
if (!config.triageLlm.provider) {
```

The `!` operator catches empty string, `null`, `undefined`, and `0`. This means `{ triageLlm: { provider: 0 } }` would fail validation (correct), but `{ triageLlm: { provider: "  " } }` would pass (a whitespace-only string is truthy). This is the same pattern as the existing `config.llm.provider` check, so it is consistent even if imperfect.

The root cause is still the `Config` type being `any` from `JSON.parse` (Entry 7 Finding #2). Zod validation would catch all these cases.

**Finding #9: `fetchIssuesForPoll` duplicates the existing `fetch_github_issues` tool logic -- LOW**

The triage integration adds a new `fetchIssuesForPoll()` function in `core.ts` that calls `octokit.rest.issues.listForRepo()` directly. The existing `fetch_github_issues` tool in `github-tools.ts` does the same thing.

```typescript
// core.ts (new)
async function fetchIssuesForPoll(config, maxIssues, sinceDate) {
  const { owner, repo, token } = config.github;
  const octokit = createGitHubClient(token);
  const { data: issues } = await octokit.rest.issues.listForRepo(params);
  // ...
}
```

This duplication means a change to the issue fetching logic (e.g., filtering out pull requests, which GitHub's API includes in the issues endpoint) would need to be applied in two places.

**Teaching moment:** This is a tension between "tools are for the LLM" and "the orchestrator also needs the same data." The cleanest solution is to extract the shared logic into a function that both the tool and the orchestrator call. But for now, the duplication is small and the risk of divergence is low.

**Finding #10: CHANGELOG accurately documents the changes -- INFO**

The v0.3.2 CHANGELOG entry is well-structured, lists all additions and changes, and correctly notes the total test count (113). The format matches previous entries.

### Test Coverage Assessment

| Feature | Tests | Quality |
|---------|-------|---------|
| `parseTriageOutput` -- valid JSON | 1 | Good -- happy path |
| `parseTriageOutput` -- markdown fences | 1 | Good -- common LLM behavior |
| `parseTriageOutput` -- surrounding text | 1 | Good -- realistic edge case |
| `parseTriageOutput` -- no JSON | 1 | Good -- fallback path |
| `parseTriageOutput` -- malformed JSON | 1 | Good -- fallback path |
| `parseTriageOutput` -- invalid enum values | 2 | Good -- normalization |
| `parseTriageOutput` -- non-string array entries | 1 | Good -- type filtering |
| `parseTriageOutput` -- non-boolean shouldAnalyze | 1 | Good -- defaults to true |
| `parseTriageOutput` -- missing fields | 1 | Good -- all defaults exercised |
| `parseTriageOutput` -- non-array relevantFiles | 1 | Good -- type guard |
| `parseTriageOutput` -- skipReason preservation | 1 | Good |
| `parseTriageOutput` -- all valid issueType values | 1 | Good -- exhaustive enum check |
| `parseTriageOutput` -- all valid complexity values | 1 | Good -- exhaustive enum check |
| `buildTriageMessage` -- content inclusion | 5 | Good -- covers number, title, body, labels, JSON instruction |
| Config -- triageLlm present | 1 | Good |
| Config -- triageLlm absent | 1 | Good |
| Config -- triageLlm missing provider | 1 | Good |
| Config -- triageLlm missing API key | 1 | Good |
| Config -- triageLlm ollama no key | 1 | Good |
| Ollama model creation | 2 | Good -- default and custom baseUrl |

Total: 24 new tests. The `parseTriageOutput` coverage is excellent -- it tests every field, every fallback, and every normalization path. This is one of the most thoroughly-tested parsers in the project.

**What is NOT tested:**
- `runTriage()` (requires mocking the agent invocation -- reasonable to defer)
- `runTriageSingle()` (integration-level, requires config + GitHub API)
- `fetchIssuesForPoll()` and `fetchSingleIssue()` (require Octokit mocks)
- Triage integration in `runPollCycle()` (integration test, reasonable to defer)
- The `skipTriage` option path
- The greedy regex edge case (Finding #4)

The missing tests are all at the integration level, which is harder to mock. The unit-level coverage is strong.

### "Humans Decide" Principle

**Pass.** The triage agent has read-only tools only -- it cannot post comments, create branches, or open PRs. Its only output is a classification. The skip path is visible via console logging. The triage result does not prevent human access to the issue on GitHub.

One nuance: triage-skipped issues are marked as "processed" in poll state (Finding #2), which means the agent will not re-visit them. This is not destructive (the issue is still visible on GitHub), but it is silent. A human monitoring the agent's output would see the skip log line, but there is no persistent record of why an issue was skipped (it is only in console output, not in poll state or a file).

**Recommendation:** Consider writing skip decisions to poll state:
```json
{
  "issues": {
    "5": { "triageSkipped": true, "skipReason": "Question, not a bug", "triageDate": "2026-02-08T..." }
  }
}
```

This would make the skip path auditable without requiring log parsing.

### Idempotency

**Pass with caveat.** Running triage twice on the same issue produces the same classification (the LLM is deterministic enough for classification tasks with low temperature). No side effects are created.

However, the poll state interaction has the issue described in Finding #2 -- once skipped, an issue is permanently marked as processed. Running the poll cycle again will not re-triage updated issues.

### Unattended Safety

**The fallback is correctly conservative.** If the LLM hallucinates, `parseTriageOutput` normalizes invalid values and defaults `shouldAnalyze` to `true`. If triage fails entirely (exception), the catch block also defaults to `shouldAnalyze: true`. An always-false triage (skips everything) is the concerning case -- but the fallback defaults protect against parsing failures, not against a deliberately pessimistic LLM.

If the triage LLM consistently returns `shouldAnalyze: false` for everything, all issues would be skipped. The console output would show this, but there is no automated alert. For a cron-triggered system, this means the agent silently stops doing work.

**Mitigation idea (not required):** Log a warning if all issues in a batch are skipped: "All N issues skipped by triage -- verify triage model is working correctly."

### Docker / SIGTERM Implications

Triage creates no persistent state during execution -- it only writes to poll state at the end of the poll cycle. If SIGTERM arrives during triage:
- No partial state is saved (the `savePollState` call happens after triage)
- The next run will re-triage the same issues (idempotent, no side effects)
- No GitHub API writes occurred (read-only tools)

This is safe. Container restart re-runs triage cleanly.

### Version Bump Assessment

**Agree with v0.3.2.** The triage agent is a new feature on top of the v0.3.1 baseline. It follows the project's patch-bump-per-feature convention (v0.2.1-v0.2.10 through Phase 2). A minor bump would be premature -- Phase 4 is not complete until Issue #4 (analysis agent + StateGraph pipeline) is done. v0.4.0 should be reserved for the full two-phase pipeline.

### Open Items Carried Forward

| # | Finding | Severity | First flagged |
|---|---------|----------|---------------|
| 1 | `config.ts` uses `process.exit` instead of throwing | Low | Entry 7 |
| 2 | Config type is `any` from `JSON.parse` | Low | Entry 7 |
| 3 | `bin` field points to `.ts` file (npx fails) | Medium | Entry 17 |
| 4 | No tests for `createListRepoFilesTool` | Medium | Entry 17 |
| 5 | Circuit breaker default may be too tight (30) | Medium | Entry 22 |
| 6 | `runAnalyzeSingle` has no circuit breaker | Low | Entry 22 |
| 7 | **Triage results not passed to analysis agent** | **HIGH** | **This entry** |
| 8 | Triage-skipped issues permanently marked as processed | Medium | This entry |
| 9 | Analysis agent ignores triage filtering | Medium | This entry |
| 10 | `skipTriage` option not exposed in CLI | Low | This entry |

### HIGH Severity Summary

**One HIGH finding: Finding #1 -- Triage results not passed to analysis agent.**

The triage phase computes `toAnalyze` (filtered issues with classification data) but the analysis phase ignores it and re-fetches everything from scratch. This means:
1. Triage filtering can be bypassed by the analysis agent
2. The `relevantFiles` context from triage is lost
3. Double API calls to fetch the same issues

This does not block the merge because the triage agent itself works correctly in isolation. The gap is in the handoff, which is the responsibility of Issue #4 (analysis agent + pipeline). However, the current code is misleading -- it looks like triage feeds analysis, but it does not.

**Recommendation to team lead:** Merge is safe -- the triage agent is a standalone component that works correctly. The handoff gap should be tracked as a known limitation and addressed in Issue #4. A `// TODO(Issue #4)` comment in `core.ts` at the analysis phase boundary would make this explicit.

---

## Entry 29: Composable Middleware -- Structured Logging via Tool Wrapping (Issue #33)

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entry 20 (Circuit Breaker), Entry 24 (Two-Phase Pipeline)

### What just happened?

We added structured logging for every tool call. Each invocation now logs:
- Timestamp (HH:MM:SS)
- Running tool count and circuit breaker headroom (e.g., `#7/30`)
- Tool name
- Arguments (compact JSON)
- Duration in milliseconds

Errors are logged to `console.error` with the same format plus the error message, then re-thrown so the circuit breaker and agent framework can handle them normally.

### Why this design: Composable middleware via `wrapWithLogging()`

The key pattern here is **composable tool wrappers** -- small functions that each add one behavior by wrapping `tool.invoke()`. The tool wrapping stack is now:

```
LLM calls tool.invoke(input)
  -> wrapWithLogging    (outermost: logs args, timing, errors)
    -> wrapWithCircuitBreaker  (increments counter, may throw)
      -> original tool.invoke  (actual API call)
```

This is the middleware/decorator pattern applied to LangChain tools. Each wrapper:
1. Takes a tool and returns the same tool with a modified `.invoke()`
2. Does not know about the other wrappers
3. Can be applied in any order (though order matters for semantics)

**Why logging is the outermost layer:** If logging wrapped inside the circuit breaker, a breaker trip would prevent the log from being written. By placing logging outside, we see the attempted call and the error in the log even when the breaker trips.

**Why a separate `src/logger.ts` file:** The circuit breaker lives in `github-tools.ts` because it was the first wrapper and was tightly coupled to tool creation. But as more wrappers accumulate (logging, retry, rate limiting), keeping them in the tools file creates coupling between unrelated concerns. A separate file per wrapper keeps each composable unit independent. The retry wrapper (Issue #17) should follow the same pattern.

### The `ToolCallCounter` as a read-only dependency

The logging wrapper accepts an optional `ToolCallCounter` to display headroom (`#7/30`). It reads the counter but never increments it -- incrementing is the circuit breaker's job. This avoids double-counting and keeps responsibilities clear: the counter has one writer (circuit breaker) and one reader (logger).

### What NOT to log

The issue explicitly calls out that tool **responses** should not be logged. For tools like `read_repo_file`, the response is an entire file's contents -- logging it would flood the terminal and duplicate data that is already visible in the LLM's context. Arguments are small (a file path, a branch name), so they provide useful debugging context without volume.

---

## Entry 30: Retry with Exponential Backoff -- Making API Calls Resilient (Issue #17)

**Date:** 2026-02-08
**Author:** Builder Agent
**Scope:** New `src/utils.ts` module, `withRetry()` wrapper applied to all GitHub API calls in `github-tools.ts`

### Why This Design

GitHub API calls fail transiently for many reasons: rate limits (429), server errors (5xx), and network hiccups (ECONNRESET, ETIMEDOUT). Without retry logic, a single transient failure kills the entire poll cycle. For a cron-triggered system that runs unattended, silent failures are worse than slow retries.

### Key Design Decisions

**1. Retry classification -- what to retry and what not to:**
- Retry: HTTP 5xx (server errors), 429 (rate limit), network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE)
- Do NOT retry: 4xx client errors (except 429) -- these are permanent failures (bad auth, not found, validation errors)
- The classifier (`isRetryableError`) checks both `error.status` (Octokit HTTP responses) and `error.code` (Node.js network errors)

**2. Exponential backoff with Retry-After:**
- Default: 3 retries with backoff multiplier of 2 (delays: 1s, 2s, 4s = 7s total worst case)
- On 429 responses, the `Retry-After` header (seconds) overrides the computed backoff -- this respects GitHub's rate limit reset timing
- `getRetryAfterMs()` extracts and converts the header value, returning `null` if absent or invalid

**3. Architectural placement -- innermost wrapper:**
The retry wrapper sits closest to the Octokit call, inside the LangChain tool function. The layer ordering (inside out) is:
1. `withRetry()` -- retries transient Octokit failures
2. Idempotency check -- skips duplicate operations (comment/branch/PR)
3. Circuit breaker -- caps total tool calls per agent run
4. Dry-run wrapper -- swaps write tools with logging stubs

This ordering matters: retries are invisible to the circuit breaker (a call that succeeds after 2 retries counts as 1 tool call, not 3). If retry were outside the circuit breaker, retries would eat into the tool call budget.

**4. Transparent wrapping -- no changes to tool interfaces:**
Every `await octokit.rest.*()` call becomes `await withRetry(() => octokit.rest.*())`. The tool's input/output schema is unchanged. The retry logic is invisible to the LLM agent -- it just sees success or failure.

### Test Strategy

18 unit tests in `tests/utils.test.ts`:
- `isRetryableError`: 10 tests covering 5xx, 429, 4xx rejection, network error codes, null/undefined/non-objects
- `withRetry`: 8 tests covering success on first try, success after retries, max retries exhausted, non-retryable immediate throw, Retry-After header respect, default options, custom options

Fake timers (`vi.useFakeTimers()`) control the backoff delays. The `.catch(e => e)` pattern avoids unhandled promise rejections when testing failure paths with fake timers.

One existing test in `github-tools.test.ts` was updated: the "re-throws non-404 errors from existence check" test changed from status 500 to 403 because 500 is now retryable (would cause timeout as `withRetry` retries with real delays).

### What This Does NOT Cover

- Per-endpoint retry budgets (all endpoints share the same default)
- Jitter (randomized backoff to avoid thundering herd)
- Retry logging to structured output (currently uses `console.log`)
- Integration with the circuit breaker counter (retries are invisible to it -- by design)

These are reasonable future enhancements but not needed for the current learning project scope.

---

## Entry 31: Webhook Listener -- From Polling to Push (Issue #12)

**Date:** 2026-02-08
**Author:** Builder Agent
**Builds on:** Entry 1 (Polling Architecture), Entry 15 (CLI Wrapper)

### What just happened?

We added an HTTP webhook listener as an alternative trigger mechanism to cron-based polling. The listener receives GitHub webhook deliveries at `POST /webhook`, verifies the HMAC-SHA256 signature, parses event metadata from headers, and logs the event. Actual event routing to agent workflows is deferred to Issues #13/#14.

### Why webhooks vs polling?

Cron polling has two limitations:

1. **Latency** -- a 15-minute cron interval means up to 15 minutes of delay between an issue being opened and the agent responding. Webhooks deliver events in near-real-time (seconds).
2. **Wasted runs** -- cron fires even when nothing changed, burning API calls and compute. Webhooks only fire when an event actually occurs.

Both modes coexist: `deepagents webhook` starts the listener (long-running), while `deepagents poll` via `poll.sh` remains for environments where webhooks are impractical (no public IP, firewall restrictions, etc.). The same agent code runs underneath either trigger -- the listener just replaces the cron schedule with HTTP push.

### HMAC-SHA256 verification: why it matters

GitHub signs every webhook delivery with an HMAC using a shared secret. The signature arrives in the `X-Hub-Signature-256` header as `sha256=<hex>`. The listener must:

1. Compute HMAC-SHA256 over the raw request body using the configured secret
2. Compare the computed digest to the provided digest
3. Use timing-safe comparison to prevent timing attacks

**Why timing-safe comparison?** A naive string comparison (`===`) short-circuits on the first differing character. An attacker could measure response times to progressively guess the correct signature one character at a time. `crypto.timingSafeEqual` takes constant time regardless of where the strings differ.

**Why compare as UTF-8 strings, not decoded hex?** `Buffer.from(hexString, 'hex')` silently skips invalid hex characters, producing a shorter buffer than expected. This causes `timingSafeEqual` to throw a `RangeError` on length mismatch. By comparing the hex strings as UTF-8 buffers (which always produce predictable lengths), we avoid this edge case entirely.

### Express raw body middleware

The webhook endpoint uses `express.raw({ type: 'application/json' })` instead of `express.json()`. This is intentional: HMAC verification must run over the exact bytes GitHub sent. If Express parsed the JSON first and we re-serialized it, whitespace differences could change the digest.

### Architecture: why `createWebhookApp` returns the app, not the server

The `createWebhookApp()` factory returns the configured Express app without calling `.listen()`. The separate `startWebhookServer()` function calls `.listen()` and returns the HTTP server. This separation lets tests inject requests into the app without binding a port, avoiding port conflicts in parallel test runs.

### Coexistence design

The listener is a standalone long-running process, not integrated into the poll cycle. This is deliberate:

- Polling is one-shot (run, process, exit) -- clean for cron
- Webhook listening is persistent (start, wait, handle events in a loop)
- Mixing them would create awkward lifecycle management

Future work (#13/#14) will wire webhook events to the same `runAnalyzeSingle()` and triage functions, creating a shared code path between both triggers.

---

## Entry 32: Graceful Shutdown -- Signal Handling in Node.js and Docker (Issue #22)

**Date:** 2026-02-08
**Author:** Builder Agent

### Why this matters

When Docker sends `docker stop`, it sends SIGTERM to the container's PID 1. If the process uses `process.exit()` in error handlers or ignores SIGTERM entirely, the running work is killed mid-flight. For this bot, that means `last_poll.json` might not get saved, causing duplicate processing on the next run.

### The pattern: cooperative cancellation

Instead of killing the process immediately, we set a boolean flag (`shuttingDown`) and check it at natural "seam points" in the poll cycle:

1. **Between triage iterations** -- before picking up the next issue to triage
2. **After triage, before analysis** -- the most expensive phase hasn't started yet
3. **Before agent invocation** -- if triage was skipped via `--skip-triage`

At each checkpoint, if the flag is set, we save poll state with whatever progress we've made and return cleanly. The process then exits naturally as the event loop drains.

### Why `process.exitCode` instead of `process.exit()`

`process.exit(N)` terminates the process immediately, which can:
- Interrupt pending file writes (like saving `last_poll.json`)
- Skip `finally` blocks and cleanup handlers
- Lose buffered stdout/stderr output

`process.exitCode = N` sets the exit code but lets the process finish naturally. The event loop drains, all pending I/O completes, and *then* the process exits with the specified code. This is the Node.js-recommended approach for non-emergency exits.

### Why we don't forcefully kill during `agent.invoke()`

Once the LLM agent is running (`agent.invoke()`), we can't easily interrupt it mid-call -- LangChain's invoke is a single async operation. The shutdown flag is checked *before* starting the agent, not during. If a signal arrives during agent execution, the agent finishes its current run, then the normal post-agent code saves poll state and the process exits. This is acceptable because:
- Agent runs are bounded by the circuit breaker (max tool calls)
- A single analysis pass is minutes, not hours
- Docker's default SIGTERM timeout is 10 seconds before SIGKILL, but `docker stop -t 120` can extend this

### Teaching note: signal safety in Node.js

Signal handlers in Node.js run in the main thread's event loop, so they're safe to use with `console.log()` and simple variable assignment. Unlike C where signal handlers have severe restrictions (only async-signal-safe functions), Node.js handlers are regular JavaScript callbacks scheduled by libuv. The key constraint is: don't do heavy async work in the handler itself -- just set a flag and let the main code path check it.

---

## Entry 33: Enriching Action Tracking -- State Schema Evolution (Issue #31)

**Date:** 2026-02-08
**Author:** Builder Agent
**Scope:** `IssueActions` interface in `src/core.ts`, `extractIssueActions()`, `migratePollState()`, `buildUserMessage()`, `showStatus()`

### Why This Design

The original `IssueActions` tracked simple booleans (`commented: true`) and primitive values (`branch: string`, `pr: number`). This was enough to know *whether* an action happened but not enough to *retract* it. If the agent posts a bad comment, you need the comment ID to delete it. If it pushes a broken file, you need the file SHA to revert it.

Enriched metadata solves this: each action now stores the full API response identifiers (IDs, SHAs, URLs) needed for future retraction workflows.

### Key Design Decisions

**1. Schema shape -- objects instead of scalars:**
- `comment: { id: number; html_url: string } | null` (was `commented: boolean`)
- `branch: { name: string; sha: string } | null` (was `branch: string | null`)
- `commits: Array<{ path, sha, commit_sha }>` (new -- tracks every file committed)
- `pr: { number: number; html_url: string } | null` (was `pr: number | null`)

Null means "not done yet". An object means "done, here's the metadata".

**2. Tool call / response correlation via pending state:**
The agent's message history alternates: tool_call message, then tool_response message. `extractIssueActions` uses pending-state variables (`pendingCommentIssue`, `pendingBranchIssue`, etc.) to remember which tool call is awaiting a response. When the next message contains parseable JSON matching the expected response shape, the metadata is captured.

**3. Three-generation migration:**
`migratePollState()` handles:
- Case 1: pre-v0.2.10 -- no `issues` field at all (creates stub enriched entries)
- Case 2: v0.2.10 -- boolean format `{ commented, branch, pr }` (converts via `migrateActionEntry()`)
- Case 3: v0.3.7+ -- enriched format (pass through)

Detection uses `isOldActionFormat()` which checks `typeof entry.commented === 'boolean'`.

**4. Backwards-compatible serialization:**
The enriched format is a superset. Old consumers that don't understand the new fields will fail gracefully because the field names changed (`commented` -> `comment`). The migration path is one-way: old -> enriched.

### What This Enables (Future)

- **Retraction:** Delete comments by ID, revert files by SHA, close PRs by number
- **Audit trail:** Full provenance of every action the agent took
- **Resumption with context:** The agent knows exactly what was committed, not just that "a branch exists"

---

## Entry 34: Critic's Batch 1 Post-Implementation Review -- 5 Parallel PRs

**Date:** 2026-02-08
**Author:** Critic Agent
**Builds on:** Entry 27 (Cross-Phase Parallelism), Entry 28 (Pre-Implementation Constraint Review)

### What was reviewed

Five parallel PRs from Batch 1: #35 (logging), #36 (webhook), #37 (shutdown), #38 (retry), #39 (metadata). Each PR was reviewed for: issue requirement compliance, parallel constraint adherence, merge conflict risk, test quality, and cross-PR interactions.

### Constraint compliance: all pass

The two hard constraints from the pre-implementation review were honored:
1. **#33 (logging) must use tool-layer wrapping only** -- PASS. `wrapWithLogging()` in `src/logger.ts`, applied in `agent.ts`. Zero modifications to `create*Tool()` function bodies.
2. **#22 (shutdown) must not touch listener.ts** -- PASS. Changes scoped to `core.ts`, `index.ts`, `cli.ts` only.

### Cross-PR merge issues discovered

**LEARNING_LOG entry number collisions.** All 5 PRs append entries after Entry 26 (the last on main), but use overlapping numbers. Entry 27 was claimed by #38 (retry) but already existed on main. Entry 29 was claimed by both #35 (logging) and #37 (shutdown) with DIFFERENT content.

**Resolution applied by team lead:** Entries renumbered at merge time: 29 (logging), 30 (retry), 31 (webhook), 32 (shutdown), 33 (metadata).

### Implementation quality highlights

- **Best:** #38 (retry) -- clean utility module, correct error classification, 18 thorough tests with fake timers
- **Best design:** #35 (logging) -- composable middleware pattern, read-only counter sharing, separation of concerns
- **Most complex:** #39 (metadata) -- pending-state correlation, three-generation migration, 12 metadata tests
- **Most isolated:** #36 (webhook) -- entirely new subsystem, HMAC verification, factory pattern for testability
- **Simplest:** #37 (shutdown) -- flag + checkpoints, `process.exitCode` over `process.exit()`

### What this teaches about parallel development

**Entry number collisions are the append-only file problem.** When N builders independently append to the same file, they all claim the "next" entry number. This is structurally identical to a last-write-wins race condition. Mitigation: assign entry numbers before builders start, or use a merge coordinator who renumbers at integration time.

**Cross-branch contamination spreads silently.** Two builders (#36, #37) started from branches that included other builders' work, creating duplicate content. Mitigation: all parallel builders should branch from the same base commit (main), not from each other.

**The compositional architecture paid off.** The wrapping stack (retry inside, circuit breaker middle, logging outside) allowed three separate builders to work on overlapping concerns without code conflicts. The Decorator pattern established in Phase 2 made Phase 5 parallelism possible. Good architecture is not just about the current feature -- it is about what it enables next.

---

## Entry 35: Architect's Full Roadmap Completion Plan -- 10 Issues Across 5 Phases

**Date:** 2026-02-08
**Author:** Architect Agent
**Builds on:** Entry 8 (Dependency Map), Entry 24 (Phase 4 Architecture), Entry 27 (Cross-Phase Parallelism), Entry 34 (Batch 1 Critic Review)

### Context

We are at v0.3.7 with 177 tests across 8 test files. Phases 1-3 are complete. Phase 4 is half done (triage agent shipped, analysis agent remains). Phase 5 is mostly done (retry, shutdown, metadata, logging shipped; retract command remains). Phase 6 is started (webhook listener shipped; event handlers and job queue remain). Phases 7 and 8 are untouched.

Ten open issues remain: #4, #32, #13, #14, #18, #21, #20, #19, #15, #16.

This entry defines the full batch plan, dependency graph, pre-assigned entry numbers, and version targets for completing the project.

---

### 1. Dependency graph

Each arrow means "must be done before." File-level and API-level dependencies are called out.

```
#4  Analysis Agent (StateGraph pipeline, triage-to-analysis handoff)
    └── depends on: #3 (triage, DONE) -- TriageOutput interface in triage-agent.ts
    └── touches: src/core.ts (runPollCycle analysis phase), src/agent.ts (agent factory)
    └── new file: src/analysis-graph.ts (StateGraph wiring)

#32 Retract Command
    └── depends on: #31 (enriched metadata, DONE) -- IssueActions with comment.id, branch.name, pr.number
    └── touches: src/cli.ts (new subcommand), src/core.ts (new retract function)
    └── uses: Octokit delete/close APIs

#13 Handle issues.opened
    └── depends on: #12 (webhook listener, DONE) -- createWebhookApp() in listener.ts
    └── depends on: #4 (analysis agent) -- needs the analysis pipeline to dispatch to
    └── touches: src/listener.ts (event handler), src/core.ts (runAnalyzeSingle or new entry point)

#14 Handle pull_request.opened
    └── depends on: #12 (webhook listener, DONE)
    └── no dependency on #4 or #13 (different event type, can be independent handler)
    └── touches: src/listener.ts (event handler)
    └── may need new tool: fetch PR details / diff

#18 Persistent Job Queue (PostgreSQL)
    └── depends on: #13, #14 (need event handlers to know what to enqueue)
    └── new file: src/queue.ts (pg-based queue)
    └── new dependency: pg or postgres.js in package.json
    └── touches: src/listener.ts (enqueue instead of direct dispatch), src/core.ts (dequeue + process)

#20 Health Check Endpoint
    └── depends on: #12 (webhook listener, DONE) -- GET /health already exists
    └── see audit below (Section 6)

#21 Docker + Caddy Deployment
    └── depends on: #18 (job queue) -- Dockerfile needs PostgreSQL setup
    └── depends on: #20 (health check) -- Caddy health probe
    └── new files: Dockerfile, docker-compose.yml, Caddyfile

#19 GitHub App Migration
    └── depends on: #21 (deployment) -- App registration needs a public webhook URL
    └── touches: src/config.ts (new auth mode), src/github-tools.ts (App auth via Octokit)
    └── new dependency: @octokit/auth-app

#15 PR Review Agent
    └── depends on: #16 (submit_pr_review tool) -- the agent needs the tool to post reviews
    └── depends on: #4 (analysis agent pattern) -- establishes the StateGraph pattern
    └── touches: new file src/review-agent.ts

#16 submit_pr_review Tool
    └── no code dependencies on other open issues
    └── touches: src/github-tools.ts (new tool factory)
    └── uses: Octokit pulls.createReview API
```

**Simplified DAG:**
```
          #4 ──────────┐
          │            │
          ▼            │
  #13 ──► #18 ──► #21 ──► #19
  #14 ──┘         ▲
                  │
          #20 ───┘

  #32 (independent -- no downstream dependents)

  #16 ──► #15 (Phase 8 pair, mostly independent of main chain)
```

---

### 2. Batch plan

Lessons applied from Batch 1:
- All builders branch from the SAME main commit
- Entry numbers pre-assigned to prevent collisions
- File conflict zones identified per batch

#### Batch 2: Phase 4 Completion + Phase 5 Completion (2 parallel issues)

| Issue | Builder | Entry # | Version bump |
|-------|---------|---------|-------------|
| #4 Analysis Agent | Builder A | 36, 37 (impl + learning) | v0.4.0 |
| #32 Retract Command | Builder B | 38, 39 (impl + learning) | v0.5.0 |

**Why parallel:** #4 and #32 have zero file overlap.
- #4 touches: `src/core.ts` (analysis phase only), `src/agent.ts`, new `src/analysis-graph.ts`
- #32 touches: `src/cli.ts` (new subcommand), `src/core.ts` (new retract function), `src/github-tools.ts` (new delete tools)

**File conflict risk:** Both touch `src/core.ts`, but in different sections. #4 modifies the analysis phase (lines 538-628). #32 adds a new exported function at the bottom. Low conflict risk -- append vs. modify different sections.

**Version bumps:** #4 completes Phase 4 -> v0.4.0. #32 completes Phase 5 -> v0.5.0. Merge #4 first, bump to v0.4.0, then merge #32, bump to v0.5.0. The version bumps are sequential even though development is parallel.

**Both touch CHANGELOG.md and LEARNING_LOG.md.** These get renumbered at merge time (same pattern as Batch 1).

#### Batch 3: Phase 6 Event Handlers (2 parallel issues)

| Issue | Builder | Entry # | Version bump |
|-------|---------|---------|-------------|
| #13 issues.opened handler | Builder A | 40 | patch |
| #14 pull_request.opened handler | Builder B | 41 | patch |

**Prerequisite:** Batch 2 must be merged first. #13 needs #4's analysis pipeline to dispatch to.

**Why parallel:** #13 and #14 both touch `src/listener.ts` but add independent event handlers. The handlers are additive (new `if` branches in the webhook POST handler), so merge conflicts will be trivial.

**File conflict risk:** Medium on `src/listener.ts`. Both add handler logic to the webhook route. Mitigation: extract a `handleEvent(event: WebhookEvent)` dispatcher function that both can independently add cases to (switch/case on event type). If builders coordinate this pattern, conflicts become trivial.

#### Batch 4: Job Queue (1 issue, sequential)

| Issue | Builder | Entry # | Version bump |
|-------|---------|---------|-------------|
| #18 PostgreSQL job queue | Builder A | 42 | v0.6.0 |

**Why sequential:** #18 is the most architecturally complex remaining issue. It:
- Adds a new runtime dependency (PostgreSQL client library)
- Creates a new module (`src/queue.ts`)
- Modifies `src/listener.ts` to enqueue instead of directly dispatching
- Modifies `src/core.ts` or creates `src/worker.ts` for dequeue + process
- Needs new config fields (database connection string)
- Needs migration SQL for the job table

This issue should NOT be parallelized. It cross-cuts too many files and introduces a new infrastructure dependency. The builder needs full attention without merge conflicts.

**Version bump:** Completes Phase 6 -> v0.6.0.

#### Batch 5: Deployment (2 parallel issues, with #20 audit caveat)

| Issue | Builder | Entry # | Version bump |
|-------|---------|---------|-------------|
| #21 Docker + Caddy | Builder A | 43 | patch |
| #19 GitHub App migration | Builder B | 44 | patch -> v0.7.0 |

**Prerequisite:** Batch 4 must be merged. Docker setup needs PostgreSQL in docker-compose.yml.

**Why parallel:** #21 creates new files (Dockerfile, docker-compose.yml, Caddyfile) that #19 does not touch. #19 modifies `src/config.ts` and `src/github-tools.ts` which #21 does not touch. Zero file overlap.

**#20 Health Check:** See Section 6 below. If the audit confirms GET /health is sufficient, close #20 with no code changes and no batch slot needed.

**Version bump:** After both merge, bump to v0.7.0 (Phase 7 complete).

#### Batch 6: Phase 8 -- Reviewer Bot (2 parallel issues, or deferred)

| Issue | Builder | Entry # | Version bump |
|-------|---------|---------|-------------|
| #16 submit_pr_review tool | Builder A | 45 | patch |
| #15 PR review agent | Builder B | 46 | v1.0.0 |

**Prerequisite:** #16 must merge before #15 starts (the agent needs the tool). So these are sequential within the batch, not truly parallel. Builder B waits for Builder A.

**See Section 7 for the "same repo vs. new repo" recommendation.**

---

### 3. Pre-assigned LEARNING_LOG entry numbers

This table eliminates the collision problem from Batch 1. Each builder writes ONLY their assigned entry numbers. The merge coordinator does NOT renumber.

| Entry | Issue | Author | Title |
|-------|-------|--------|-------|
| 35 | -- | Architect | This entry (Full Roadmap Completion Plan) |
| 36 | #4 | Builder | Analysis Agent Implementation |
| 37 | #4 | Builder | StateGraph Pipeline -- Why This Design |
| 38 | #32 | Builder | Retract Command Implementation |
| 39 | #32 | Builder | Undo Architecture -- Design Decisions |
| 40 | #13 | Builder | issues.opened Webhook Handler |
| 41 | #14 | Builder | pull_request.opened Webhook Handler |
| 42 | #18 | Builder | PostgreSQL Job Queue -- From Memory to Persistence |
| 43 | #21 | Builder | Docker + Caddy Deployment |
| 44 | #19 | Builder | GitHub App Migration -- From PAT to App Identity |
| 45 | #16 | Builder | submit_pr_review Tool Implementation |
| 46 | #15 | Builder | PR Review Agent -- The Second Bot |
| 47 | -- | Critic | Batch 2 Review |
| 48 | -- | Critic | Batch 3 Review |
| 49 | -- | Critic | Batch 4 Review |
| 50 | -- | Critic | Batch 5 Review |
| 51 | -- | Critic | Batch 6 Review (or Separate Project Post-Mortem) |

**Rule:** Builders MUST use their assigned entry numbers. No "next available" guessing. Critic entries are written AFTER each batch merges.

---

### 4. Version plan

| Batch | Issues | Phase | Version after merge |
|-------|--------|-------|-------------------|
| 2 | #4, #32 | Phase 4 + Phase 5 | v0.4.0, then v0.5.0 |
| 3 | #13, #14 | Phase 6 (partial) | v0.5.x patches |
| 4 | #18 | Phase 6 (complete) | v0.6.0 |
| 5 | #21, #19 (+#20 close) | Phase 7 | v0.7.0 |
| 6 | #16, #15 | Phase 8 | v1.0.0 |

**Merge order within Batch 2:** #4 first (v0.4.0), then #32 (v0.5.0). This preserves the phase ordering in the changelog. Even though both were developed in parallel, the version history reads Phase 4 -> Phase 5.

---

### 5. CLI drift check

Every feature must have a corresponding CLI subcommand (Guiding Principle #4).

| Feature | CLI subcommand | Status |
|---------|---------------|--------|
| Poll cycle | `deepagents poll` | Exists |
| Single issue analysis | `deepagents analyze --issue N` | Exists |
| Triage | `deepagents triage --issue N` | Exists |
| Webhook listener | `deepagents webhook` | Exists |
| Status | `deepagents status` | Exists |
| **Retract** (#32) | `deepagents retract --issue N` | **NEEDS CLI** |
| **Job queue worker** (#18) | `deepagents worker` | **NEEDS CLI** |
| Docker/deploy (#21) | N/A (infrastructure, not a runtime command) | N/A |
| GitHub App (#19) | N/A (config change, not a new command) | N/A |
| PR review (#15) | `deepagents review --pr N` (or similar) | **NEEDS CLI** |

**Gaps flagged:**
1. **#32 retract** -- Builder must add `deepagents retract --issue N` subcommand to `src/cli.ts`.
2. **#18 worker** -- If the job queue uses a separate worker process, it needs `deepagents worker` to start the dequeue loop. If the worker is embedded in the webhook server process, no new subcommand needed (but document the choice).
3. **#15 review** -- If the reviewer bot lives in this repo, it needs a CLI entry point. If it is a separate project, it gets its own CLI.

---

### 6. #20 Health Check Audit

**File reviewed:** `src/listener.ts:75-77`

```typescript
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
```

**What Issue #20 asks for:** "Health check endpoint" (per ROADMAP: "Health checks for monitoring").

**What already exists:** `GET /health` returns `{ status: "ok", timestamp: "..." }` with a 200 status code. This was implemented as part of #12 (webhook listener, v0.3.5).

**Does this satisfy #20?** Almost. The current endpoint is minimal but functional for:
- Docker HEALTHCHECK directives (`curl -f http://localhost:3000/health`)
- Caddy health_check upstream probes
- Simple uptime monitoring

**What might be missing for a production health check:**
- Database connectivity check (relevant after #18 adds PostgreSQL)
- Memory/uptime stats
- Version string in the response

**Recommendation:** Close #20 with a note that the basic health check was shipped in #12. If richer health data is needed after #18 (database liveness), open a new issue. The current `/health` endpoint is sufficient for Phase 7's Docker HEALTHCHECK and Caddy probe. No code changes needed now.

---

### 7. Phase 8 scoping: same repo or separate project?

The ROADMAP says: "Phase 8 -- Reviewer Bot (Separate Project). Lives in its own repo."

**Analysis of the two options:**

**Option A: Build #15/#16 in THIS repo first, extract later.**
- Pros: Shares all existing infrastructure (Octokit client, tool wrappers, logging, retry, config). The `submit_pr_review` tool (#16) follows the exact same pattern as `createCommentOnIssueTool`. Copy-paste-modify.
- Pros: The reviewer agent (#15) can reuse the `createDeepAgent` factory and model configuration.
- Pros: Testing infrastructure already exists (vitest, mock patterns for Octokit).
- Cons: Coupling. The reviewer bot's lifecycle (when to run, what triggers it) is different from the analyzer bot. Mixing them in one process creates operational complexity.
- Cons: The ROADMAP envisions them as independently deployable services.

**Option B: Start fresh in a new repo.**
- Pros: Clean separation. Independent deployment, testing, and versioning.
- Cons: Duplicates a lot of infrastructure: config loading, Octokit setup, model creation, tool wrapping, logging, retry.
- Cons: Slower to get started -- builder must recreate the foundation.

**Recommendation: Option A (build in this repo), with a clean extraction path.**

Build #16 (tool) and #15 (agent) in this repo. The tool goes in `src/github-tools.ts` following existing patterns. The agent goes in `src/review-agent.ts` following the triage-agent.ts pattern. The CLI gets `deepagents review --pr N`.

This keeps v1.0.0 as a milestone for THIS project. Extraction to a separate repo can happen later if operational needs demand it, but for a learning project, the pedagogical value is in seeing the full pipeline (triage -> analysis -> review) in one codebase.

Mark Phase 8 in the ROADMAP as: "Built in this repo. Can be extracted to a separate deployment if needed."

---

### 8. Summary: execution order

```
NOW  ──► Batch 2 (#4 + #32 parallel)     ──► v0.4.0, v0.5.0
         Close #20 (health check audit)
     ──► Batch 3 (#13 + #14 parallel)     ──► v0.5.x patches
     ──► Batch 4 (#18 sequential)          ──► v0.6.0
     ──► Batch 5 (#21 + #19 parallel)      ──► v0.7.0
     ──► Batch 6 (#16 then #15 sequential) ──► v1.0.0
```

Total: 5 batches, 10 issues, 6 version bumps, ending at v1.0.0.

### What the Critic should check

1. Is the #4 + #32 parallelism safe given both touch `src/core.ts`? Verify the sections don't overlap.
2. Is the #13 dependency on #4 real? Could #13 dispatch to `runAnalyzeSingle` without the StateGraph? If yes, #13 could move to Batch 2.
3. Is PostgreSQL (#18) the right choice for the job queue? Alternatives: SQLite (simpler), Redis (faster), or even a JSON file queue (simplest for a learning project).
4. Are the Critic entry numbers (47-51) realistic? If batches produce fewer surprises, some Critic entries may be unnecessary.

---

## Entry 36: Critic's Pre-Implementation Review -- Full Roadmap Completion Plan

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviews:** Entry 35 (Architect's Full Roadmap Completion Plan)

---

### A. Dependency Analysis Accuracy

**File-level conflicts: correctly identified.** The Architect's DAG is accurate. I verified every "touches" annotation against the actual source files.

**One hidden dependency the Architect missed:**

- **#32 (retract) touches `src/github-tools.ts`** to add delete/close API tools (e.g., `deleteComment`, `deleteBranch`, `closePR`). The Architect notes this in the dependency graph but does NOT flag it as a conflict zone with #4 in Batch 2. This is fine -- #4 does not touch `github-tools.ts` (it touches `agent.ts` and `core.ts`). So no actual conflict, but the Architect's Batch 2 conflict analysis only mentions `core.ts` and omits `github-tools.ts` as a #32 touchpoint. Minor documentation gap, not a blocker.

**Critical path is correct:** #4 -> #13 -> #18 -> #21 -> #19 is the longest chain. #32, #14, #16, #15, and #20 are off the critical path.

**VERDICT: Dependency analysis is ACCURATE. No blocking issues found.**

---

### B. Batch Plan Feasibility

#### B1. Can #4 + #32 really run in parallel?

**YES, with a minor caveat.** I verified the sections of `src/core.ts` each touches:

- **#4 (analysis agent)** modifies the analysis phase: lines 538-628. Specifically, it would replace the current `createDeepAgentWithGitHub` call at line 556 and the `agent.invoke` block (lines 575-588) with a StateGraph pipeline. It may also restructure `runPollCycle` to pass triage results into the analysis phase (the HIGH finding from the Critic noted in MEMORY.md -- triage results are currently discarded before analysis).

- **#32 (retract command)** adds a NEW exported function (e.g., `retractIssue(config, issueNumber)`) at the bottom of `core.ts`, after line 752. It reads `pollState.issues[N]` to get the metadata, then calls Octokit delete APIs. It also adds a new `case 'retract':` block to `src/cli.ts`.

These touch different sections of `core.ts`. The Architect's assessment of "append vs. modify different sections" is correct. **Low conflict risk.** The only merge friction will be `CHANGELOG.md` and `LEARNING_LOG.md`, which are handled by the renumbering protocol.

**One concern:** #4 may need to change the `IssueActions` interface or `PollState` shape (lines 37-53) to store triage results alongside action tracking. If #32 also reads `IssueActions` (to know what to retract), both builders need to agree on the interface shape. **Mitigation:** Freeze the `IssueActions` interface for Batch 2. #4 should add triage data in a SEPARATE field on `PollState`, not modify `IssueActions`. This keeps #32's read path stable.

#### B2. Could #13 move earlier (Batch 2)?

**YES, technically.** The `runAnalyzeSingle` function (line 633) already exists and works independently of the StateGraph. Issue #13 could wire `issues.opened` events to call `runAnalyzeSingle(config, issueNumber)` directly.

**However, I do NOT recommend moving it.** Reasons:
1. If #13 ships before #4, it would dispatch to the old analysis path. Then when #4 ships, #13's handler would need updating to use the new StateGraph pipeline. This creates rework.
2. Batch 2 already has 2 parallel issues. Adding a third that touches `listener.ts` (which neither #4 nor #32 touch) is technically safe but increases merge coordination load for limited benefit.
3. The Architect's sequencing (Batch 3 after #4 merges) means #13 can wire directly into the new pipeline from the start. Cleaner.

**VERDICT: Keep #13 in Batch 3.** The Architect's sequencing is correct.

#### B3. Is PostgreSQL appropriate for a learning project?

**NO. Use SQLite instead.**

The ROADMAP vision says "Docker stack (Caddy + Node + PostgreSQL)" and the Phase 7 architecture diagram shows PostgreSQL. But for a learning project:

- PostgreSQL requires a running server, connection management, and migrations. This is a significant operational burden.
- SQLite is zero-config, file-based, and sufficient for a single-process job queue.
- The learning value of "persistent job queue" comes from the queue semantics (enqueue, dequeue, retry, dead-letter), not from the database engine.
- If the project later needs PostgreSQL (multi-instance deployment), the migration from SQLite is straightforward -- swap the storage layer.
- `better-sqlite3` is a well-maintained, synchronous driver that avoids async pool complexity.

**Recommendation:** Change #18 from "PostgreSQL job queue" to "SQLite job queue." Update the ROADMAP accordingly. If the Architect insists on PostgreSQL for pedagogical reasons (learning Docker Compose multi-container setups), then keep it but acknowledge it adds complexity to every subsequent batch (local dev needs `docker-compose up db` or a local PostgreSQL install).

**This is a CONDITIONAL finding, not a blocker.** The batch plan works with either database. The Architect should make the call.

#### B4. Is the batch count (5 batches) realistic?

**Yes, but Batches 5 and 6 could be consolidated.**

Batch 5 (#21 Docker + #19 GitHub App) and Batch 6 (#16 tool + #15 agent) have no dependency between them. The only dependency is that #21 needs #18 (Batch 4), and #15 needs #16. If builders are available, Batch 5 and 6 could run simultaneously (4 builders in parallel). This would reduce total batches from 5 to 4.

**However**, the Architect's conservative approach of 5 sequential batches is defensible. Each batch is a clean checkpoint. Consolidating adds coordination load. For a learning project, clarity over speed.

**VERDICT: 5 batches is fine. Consolidation is optional optimization.**

---

### C. #20 Health Check Audit

**Verified.** I read `src/listener.ts:75-77`. The GET `/health` endpoint exists exactly as the Architect described:

```typescript
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
```

This returns `{ status: "ok", timestamp: "..." }` with a 200 status code. It was shipped in v0.3.5 as part of #12.

**Is it sufficient to close #20?** Yes, for now. The current endpoint satisfies:
- Docker HEALTHCHECK directives
- Caddy upstream health probes
- Simple uptime monitoring

The Architect correctly notes that richer health data (database liveness after #18, memory/uptime stats, version string) can be a follow-up issue if needed. No code changes required.

**VERDICT: APPROVE closing #20 with no code changes.**

---

### D. Phase 8 Scoping

**I AGREE with building #15/#16 in this repo.** The Architect's reasoning is sound:

1. Shared infrastructure (Octokit client, tool wrappers, logging, retry, config) avoids duplication.
2. The `submit_pr_review` tool follows the exact pattern of `createCommentOnIssueTool` (I verified the tool factory pattern in `github-tools.ts`).
3. The reviewer agent follows the pattern of `triage-agent.ts` (separate file, own system prompt, reuses `createDeepAgent`).
4. For a learning project, seeing the full pipeline in one codebase is pedagogically superior.

**Risks:**
1. **Process coupling.** If the webhook listener dispatches to both analysis and review in the same process, a crash in one affects the other. Mitigation: the job queue (#18) provides isolation -- each job type runs independently.
2. **Scope creep.** The reviewer bot could grow into a second full project within this one. Mitigation: keep the scope tight -- #16 is one tool, #15 is one agent file with one system prompt. No new infrastructure.
3. **ROADMAP says "Separate Project."** The Architect proposes changing this. This should be documented explicitly in the ROADMAP with the rationale, not just in the LEARNING_LOG. Update Phase 8's description.

**VERDICT: APPROVE building in this repo. Update ROADMAP Phase 8 description.**

---

### E. Version Plan

**Alignment with ROADMAP verified:**

| Phase | ROADMAP target | Entry 35 plan | Match? |
|-------|---------------|---------------|--------|
| Phase 4 | v0.4.0 | #4 -> v0.4.0 | YES |
| Phase 5 | (no explicit target) | #32 -> v0.5.0 | REASONABLE |
| Phase 6 | (no explicit target) | #13/#14 patches, #18 -> v0.6.0 | YES |
| Phase 7 | (no explicit target) | #21/#19 -> v0.7.0 | YES |
| Phase 8 | (no explicit target) | #16 patch, #15 -> v1.0.0 | YES |

**One issue:** Batch 3 version plan says "#13/#14 -> v0.5.x patches." But v0.5.0 is the Phase 5 completion version (from #32 in Batch 2). So Batch 3 patches would be v0.5.1 and v0.5.2. This is correct but slightly confusing -- Phase 6 issues get Phase 5 patch numbers. This is because the minor version tracks completion order, not phase number. Acceptable but worth noting in the CHANGELOG.

**VERDICT: Version plan is CORRECT.**

---

### F. CLI Drift

**Verified the 3 gaps the Architect flagged.** All are real:

1. **#32 retract** -- `src/cli.ts` has no `retract` case. The builder MUST add `case 'retract':` with `--issue N` parsing, similar to `analyze` and `triage`. Confirmed by reading `cli.ts:103-193`.

2. **#18 worker** -- No `worker` subcommand exists. The Architect correctly notes this depends on the architectural choice (embedded vs. separate process). The builder should document the choice.

3. **#15 review** -- No `review` subcommand exists. Builder must add `case 'review':` with `--pr N` parsing.

**Additional gap found:**

4. **`--skip-triage` flag** -- The `runPollCycle` function (core.ts:403) accepts `skipTriage` in options, but `cli.ts` does NOT expose a `--skip-triage` flag in the `poll` command. This is a pre-existing drift, not caused by the batch plan, but worth noting. A user cannot skip triage from the CLI even though the code supports it.

**VERDICT: 3 flagged gaps are real. 1 additional pre-existing gap found.**

---

### G. Pre-assigned Entry Numbers

**Count check:**
- Builder entries: 36-46 = 11 entries for 10 issues (issue #4 gets 2 entries: impl + learning). Correct.
- Critic entries: 47-51 = 5 entries for 5 batches. Correct.
- Total: 16 entries (36-51).

**But wait -- Entry 36 is THIS entry (the Critic's pre-implementation review).** The Architect assigned Entry 36 to "#4 Builder: Analysis Agent Implementation." There is a collision: Entry 36 is claimed by both this Critic review AND the #4 builder.

**Resolution:** This Critic review IS Entry 36 (it is being written now). The #4 builder entries should shift to 37, 38. The #32 builder entries shift to 39, 40. All subsequent entries shift by +1. The Architect should update the table. Alternatively, the Architect intended Entries 36-51 to start AFTER this Critic entry, but the table explicitly labels Entry 36 as "#4 Builder."

**Updated table (proposed):**

| Entry | Issue | Author | Title |
|-------|-------|--------|-------|
| 36 | -- | Critic | This entry (Pre-Implementation Review) |
| 37 | #4 | Builder | Analysis Agent Implementation |
| 38 | #4 | Builder | StateGraph Pipeline -- Why This Design |
| 39 | #32 | Builder | Retract Command Implementation |
| 40 | #32 | Builder | Undo Architecture -- Design Decisions |
| 41 | #13 | Builder | issues.opened Webhook Handler |
| 42 | #14 | Builder | pull_request.opened Webhook Handler |
| 43 | #18 | Builder | SQLite/PostgreSQL Job Queue |
| 44 | #21 | Builder | Docker + Caddy Deployment |
| 45 | #19 | Builder | GitHub App Migration |
| 46 | #16 | Builder | submit_pr_review Tool Implementation |
| 47 | #15 | Builder | PR Review Agent |
| 48 | -- | Critic | Batch 2 Review |
| 49 | -- | Critic | Batch 3 Review |
| 50 | -- | Critic | Batch 4 Review |
| 51 | -- | Critic | Batch 5 Review |
| 52 | -- | Critic | Batch 6 Review (or Post-Mortem) |

This shifts everything by +1 and adds Entry 52. **The Architect must update the table before Batch 2 starts.**

**Are 36-52 enough?** Yes. 12 builder entries + 6 critic entries = 18 entries. Overhead entries (unexpected findings, design pivots) could use 53+. No collision risk if builders stick to assigned numbers.

**VERDICT: Entry number collision found. Requires table update before Batch 2 starts.**

---

### H. Per-Batch Verdicts

| Batch | Verdict | Conditions |
|-------|---------|------------|
| Batch 2 (#4 + #32) | **APPROVE** | 1. Freeze `IssueActions` interface -- #4 adds triage data in a separate PollState field. 2. Architect updates entry number table (shift +1). |
| Batch 3 (#13 + #14) | **APPROVE** | Extract `handleEvent()` dispatcher in listener.ts to reduce merge conflict risk (as Architect suggested). |
| Batch 4 (#18) | **APPROVE** | Architect decides SQLite vs. PostgreSQL before builder starts. Document rationale. |
| Batch 5 (#21 + #19 + close #20) | **APPROVE** | Update ROADMAP Phase 8 description to reflect "built in this repo." |
| Batch 6 (#16 then #15) | **APPROVE** | Keep scope tight: one tool, one agent file, one CLI subcommand. No new infrastructure. |

**Overall: ALL BATCHES APPROVED with conditions noted above.**

---

### I. Summary of Findings That Would Change the Plan

1. **Entry number collision** (Section G) -- Must fix before Batch 2. The Architect's table assigns Entry 36 to the #4 builder, but this Critic review already occupies Entry 36.
2. **SQLite vs. PostgreSQL** (Section B3) -- Recommend SQLite. Architect should decide before Batch 4.
3. **IssueActions interface freeze** (Section B1) -- Critical for Batch 2 parallelism. #4 must not modify the shape that #32 reads.
4. **Pre-existing CLI gap** (Section F) -- `--skip-triage` is supported in code but not exposed in CLI. Not blocking, but should be a follow-up.
5. **ROADMAP Phase 8 update** (Section D) -- Change "Separate Project" to "Built in this repo."

None of these are plan-blockers. All are addressable with minor adjustments before the relevant batch starts.

---

## Entry 37: Triage-to-Analysis Handoff -- Wiring the Two-Phase Pipeline (Issue #4)

**Date:** 2026-02-08
**Author:** Builder Agent
**Issue:** #4

### The problem

The triage agent (#3, Entry 25) pre-filters issues and produces structured output: issue type, complexity, relevant files, and a summary. But this output was discarded before the analysis agent started. The analysis agent received a generic user message with no triage context, forcing it to redo work the triage agent already did (listing files, classifying the issue).

This was flagged as a HIGH severity gap by the Critic (see MEMORY.md: "Triage results not passed to analysis agent").

### What was built

1. **`buildUserMessage()` now accepts a 5th parameter: `triageResults`** -- a `Record<string, TriageOutput>` keyed by issue number. When present, the user message includes a "Triage context" section with issue type, complexity, relevant files, and summary for each issue.

2. **`runPollCycle()` wiring** -- triage results collected during the triage phase are now hoisted into a `collectedTriageResults` variable that survives the triage block's scope. After filtering, the results for issues that will be analyzed are collected and passed to `buildUserMessage()`.

3. **`PollState.triageResults`** -- a new optional field that persists triage results across runs. This allows the analysis agent to have triage context even if a previous run triaged issues but didn't complete analysis (e.g., circuit breaker or shutdown).

4. **System prompt update** -- the analysis agent's system prompt now instructs it to use triage context when available: skip `list_repo_files` if triage already identified relevant files, use the triage summary for initial scoping.

### Why this design

**Passing triage via the user message (not a separate state graph channel):**

The current architecture uses a single `agent.invoke()` call with a user message. Adding triage context as part of the user message is the minimal change that closes the gap without requiring a StateGraph refactor. The triage output is small (a few fields per issue), so including it in the prompt is cheap. A StateGraph pipeline (mentioned in the issue title) is a larger architectural change that can be built on top of this wiring later.

**Separate `triageResults` field instead of embedding in `IssueActions`:**

The Critic and Architect both noted that `IssueActions` must not be modified (it's #32's territory for retraction). `triageResults` is a separate field on `PollState`, keyed by issue number, with `TriageOutput` values. This keeps the two concerns cleanly separated.

**Conservative system prompt guidance:**

The prompt says "if triage context is provided" rather than assuming it always exists. This handles: (a) first run with no triage, (b) `--skip-triage` mode, (c) backward compatibility with older poll state files.

---

## Entry 38: Retract Command Implementation

**Date:** 2026-02-08
**Author:** Builder Agent
**Issue:** #32

### What was built

The `deepagents retract --issue N` CLI command undoes all actions the agent previously took on a GitHub issue. It uses the enriched metadata from v0.3.7 (#31) to find the exact PR number, branch name, and comment ID, then calls GitHub's API to close/delete each one.

### Design decisions

**1. Ordering: PR first, then branch, then comment.**

The PR references the branch. If we delete the branch first, GitHub may behave unexpectedly when we try to close the PR (the branch it points to is gone). Closing the PR first is cleanest -- GitHub marks it as closed, then we can safely delete the branch. The comment is independent and goes last.

**2. Partial retraction over all-or-nothing.**

If closing the PR fails (e.g., it was already closed manually), we still try to delete the branch and comment. The `RetractResult` reports what succeeded and what failed, along with error messages. This is more useful than aborting on the first failure -- the operator can see exactly what state was left behind.

**3. No new GitHub tools in github-tools.ts.**

The retract function uses Octokit directly (via `createGitHubClient`) rather than creating new LangChain tools. Why? The retract operation is a CLI-driven, human-invoked command -- the LLM agent never calls it. LangChain tool wrappers (with Zod schemas and descriptions) exist so the agent can discover and call them. Retract has no agent-facing surface, so wrapping it as a tool would be unnecessary ceremony.

**4. Skipping zero/empty IDs.**

Old poll state (migrated from pre-v0.3.7 format) has placeholder values: `comment.id = 0`, `pr.number = 0`. These mean "we know a comment/PR existed but we don't have the real ID." Trying to delete comment ID 0 or close PR #0 would hit GitHub's API with invalid requests. The retract function checks for these sentinel values and skips them.

**5. Clearing poll state after retraction.**

After retraction, the issue is removed from both `pollState.issues` (action tracking) and `pollState.lastPollIssueNumbers` (processed list). This means the next poll run will pick up the issue again if it's still open -- which is exactly the right behavior for "undo and redo."

### Testing approach

Seven tests cover the key scenarios: full retraction (all 3 actions), no poll state, missing issue in state, partial retraction (PR only, comment only), error recovery (PR close fails but branch and comment still succeed), and migrated-format safety (zero IDs are skipped). The mock pattern uses `vi.mock` to intercept `createGitHubClient` from `github-tools.ts`, which is a new pattern in this codebase -- previous tests mocked Octokit directly because tools accepted it as a parameter.

### What the Critic should check

1. Should retraction also delete the local `./issues/issue_N.md` file? Currently it only retracts GitHub-side artifacts. The local file is left behind.
2. The `withRetry()` wrapper retries on 5xx/429 errors. For delete operations, is retrying safe? (Yes -- deletes are idempotent, and GitHub returns 404 for already-deleted resources, which `withRetry` does not retry on.)
3. Should there be a `--dry-run` flag for retract? Currently there is no dry-run mode for retraction.

---

## Entry 39: Critic's Batch 2 Review -- PR #41 (Issue #4) and PR #40 (Issue #32)

**Date:** 2026-02-08
**Author:** Critic Agent
**Reviews:** PR #41 (issue-4-analysis-agent), PR #40 (issue-32-retract-command)

---

### Cross-PR Contamination: CONFIRMED in PR #40

**This is the most significant finding.** PR #40 (issue #32, retract command) contains the ENTIRE diff from PR #41 (issue #4, triage-to-analysis handoff). The contamination is visible in every shared file:

| File | PR #41 additions | PR #40 additions | PR #40 unique to #32 |
|------|-----------------|-----------------|---------------------|
| `src/core.ts` | 28 lines | 130 lines | ~102 lines (retract) |
| `src/agent.ts` | identical diff | identical diff | 0 lines |
| `tests/core.test.ts` | 13 tests (triage) | 13 tests (triage) + 7 tests (retract) | 7 tests |
| `CHANGELOG.md` | v0.3.8 entry | v0.3.8 + v0.3.9 entries | v0.3.9 entry |
| `LEARNING_LOG.md` | Entry 37 | Entry 37 + Entry 38 | Entry 38 |

**Root cause:** Builder-32 branched from a working tree that already had builder-4's uncommitted changes, or builder-32 started after builder-4's commit was on the branch. The builder-32 warning about "picked up uncommitted changes from builder-4" confirms this.

**Impact on merge:** If we merge PR #41 first (as planned), then PR #40 will have merge conflicts in every shared file because the same lines appear in both diffs. The merge coordinator must:
1. Merge PR #41 into main first (clean merge)
2. Rebase PR #40 onto the updated main
3. Resolve conflicts by keeping only the #32-specific additions (retract function, retract CLI, retract tests, Entry 38, v0.3.9 changelog)

This is the exact same pattern as Batch 1's CHANGELOG/LEARNING_LOG conflicts, but worse because it extends into source code (`core.ts`, `agent.ts`) and tests (`core.test.ts`).

**Recommendation:** The merge coordinator should handle this carefully. The conflicts are resolvable but require manual attention in 5+ files.

---

### PR #41 (Issue #4 -- Analysis Agent): APPROVE

**Implementation correctness: GOOD**

1. **Triage-to-analysis handoff is correctly wired.** `runPollCycle()` collects triage results during the triage phase (line 517-519 in the diff), stores them in `collectedTriageResults`, and passes them to `buildUserMessage()` as the 5th argument. This closes the HIGH-severity gap flagged in MEMORY.md.

2. **`IssueActions` interface NOT modified.** Verified: the interface at lines 37-42 is byte-identical to main. Triage data is stored in a new `PollState.triageResults` field (line 52-53 in the diff). This respects the constraint from Entry 36.

3. **System prompt update is conservative.** The prompt says "If TRIAGE CONTEXT is provided" with a conditional, handling the case where triage context is absent. The agent is instructed to skip `list_repo_files` when triage already identified relevant files, but "may still call it if needed." Good balance.

4. **Poll state persistence includes triage results.** New triage results are merged with existing ones from previous polls (`{ ...pollState?.triageResults, ...collectedTriageResults }`). Empty results produce `undefined` (not `{}`), keeping the JSON clean.

**Test quality: GOOD**

- 13 new tests covering: triage context in user message (header, issue number, type, complexity, files, summary), empty/missing triage, no-files case, multiple issues, combined action+triage context, workflow instructions still present.
- The `savePollState` and `migratePollState` tests verify the new `triageResults` field round-trips through JSON serialization.
- All 191 tests pass (8 test files).

**Minor observations (not blocking):**
- The triage context format uses `type=bug, complexity=moderate` which is readable but not machine-parseable. For a learning project this is fine.
- Entry 37 uses the title "Triage-to-Analysis Handoff" rather than "Analysis Agent Implementation" (the pre-assigned title from the corrected Entry 36 table). The content is more accurate than the pre-assigned title, so this is fine.

**Version: v0.3.8.** This is a patch bump, not v0.4.0 (which Entry 35 planned for Phase 4 completion). The Architect's plan called for v0.4.0 when #4 merges, but the builder chose a patch bump. This is a deviation. The merge coordinator should decide: does #4 complete Phase 4 (warranting v0.4.0), or is #4 just a step toward it? Looking at the ROADMAP, Phase 4 has only two issues (#3 triage, #4 analysis), and #3 is already done. So #4 DOES complete Phase 4 and should be v0.4.0. **The merge coordinator should bump to v0.4.0 at merge time.**

**VERDICT: APPROVE. Bump version to v0.4.0 at merge.**

---

### PR #40 (Issue #32 -- Retract Command): APPROVE WITH CONDITIONS

**Implementation correctness: GOOD**

1. **`retractIssue()` function is well-structured.** Order of operations is correct: close PR first (preserves branch reference), then delete branch, then delete comment. Each step is wrapped in try/catch for partial retraction. Uses `withRetry()` for transient failures.

2. **Sentinel value handling is correct.** PR number 0 and comment ID 0 are skipped (these come from migrated old-format state where we know an action happened but don't have the real ID). Branch deletion still proceeds even with empty SHA, because the branch name is the meaningful identifier.

3. **Poll state cleanup is correct.** After retraction, the issue is removed from both `pollState.issues` (action map) and `pollState.lastPollIssueNumbers` (processed list). This means the next poll run will re-discover the issue -- correct "undo and redo" behavior.

4. **CLI subcommand is properly implemented.** `case 'retract':` follows the same pattern as `analyze` and `triage`: validates `--issue N`, calls `retractIssue()`, prints a summary. Usage text, help text, and examples are all updated.

5. **No new tools in `github-tools.ts`.** The builder made a conscious decision (documented in Entry 38) to use Octokit directly rather than creating LangChain tools. This is correct -- retract is a human-invoked CLI command, not an agent-facing tool. This matches my Entry 36 note that #32 would touch `github-tools.ts`, but the builder found a simpler approach.

**Test quality: GOOD**

- 7 new tests covering: full retraction, no poll state, missing issue, partial (PR-only, comment-only), error recovery (PR fails but branch+comment succeed), migrated-format safety (zero IDs skipped).
- Mock pattern uses `vi.mock('../src/github-tools.js')` at module level to intercept `createGitHubClient`. This is a new pattern in the codebase (previous tests mocked Octokit at the function parameter level). Works but has a side effect: the mock is module-scoped, meaning ALL tests in `core.test.ts` now run with the mocked `createGitHubClient`. The existing tests don't call `createGitHubClient` directly so this is harmless, but it's a latent risk for future tests.

**Cross-contamination (see above):** PR #40 contains all of PR #41's changes. This is NOT a code quality issue in the retract implementation itself -- the retract code is clean and correct. It's a branching/isolation issue that the merge coordinator must handle.

**Version discrepancy:** CHANGELOG says v0.3.9 but `package.json` says v0.3.8 (same as PR #41). This is because the contamination means PR #40 has PR #41's package.json bump to v0.3.8. The merge coordinator must bump `package.json` to the correct version at merge time. Per the Architect's plan, #32 completes Phase 5 and should be v0.5.0. **The merge coordinator should bump to v0.5.0 at merge.**

**Questions raised by the builder (Entry 38) -- my answers:**

1. **Should retraction also delete `./issues/issue_N.md`?** No, not by default. The local file is a useful historical record even after retraction. If needed, add `--delete-local` flag later.

2. **Is retrying deletes safe?** Yes. Deletes are idempotent -- GitHub returns 404 for already-deleted resources, and `withRetry` only retries on 5xx/429. A 404 on delete would surface as an error in `RetractResult.errors`, which is the correct behavior.

3. **Should there be a `--dry-run` flag for retract?** Worth adding later as a separate enhancement. Not blocking for this PR.

**VERDICT: APPROVE WITH CONDITIONS:**
1. Merge coordinator must resolve cross-contamination conflicts (merge #41 first, rebase #40, strip duplicate changes)
2. Bump `package.json` version to v0.5.0 at merge
3. The module-level `vi.mock` for `createGitHubClient` should be watched in future test additions

---

### Summary

| PR | Issue | Verdict | Key conditions |
|----|-------|---------|----------------|
| #41 | #4 (analysis agent) | **APPROVE** | Bump to v0.4.0 at merge (completes Phase 4) |
| #40 | #32 (retract command) | **APPROVE WITH CONDITIONS** | 1. Resolve cross-contamination at merge. 2. Bump to v0.5.0 (completes Phase 5). 3. Watch module-level mock. |

**Merge order: PR #41 first, then rebase and merge PR #40.**

**Test counts after both merge:** 198 total (191 from PR #41 + 7 new retract tests from PR #40). Both branches pass all tests independently.

---

## Entry 40: Webhook issues.opened Handler -- From Polling to Push (Issue #13)

**Date:** 2026-02-09
**Author:** Builder Agent (consolidated by merge coordinator)
**Issue:** #13 — Handle `issues.opened` webhook event

### What changed

Added `handleIssuesEvent()` to `src/listener.ts` that dispatches `issues.opened` webhook events to the existing `runAnalyzeSingle()` pipeline. This is the first real event handler wired into the webhook listener (previously it only logged events).

### Design decisions

1. **Fire-and-forget pattern.** The webhook POST handler responds with `200 OK` immediately, then dispatches to `handleIssuesEvent` asynchronously. GitHub retries on timeout (10 seconds), so we must respond fast. The actual analysis (which can take minutes) runs in the background. Errors are caught and logged -- they never bubble up to crash the server.

2. **Config threading.** `createWebhookApp` and `startWebhookServer` now accept an optional `Config` parameter. Without it, events are logged but not processed (backwards-compatible with existing tests). When provided, `handleWebhookEvent` routes events to the appropriate handler.

3. **Only `opened` action triggers analysis.** The `issues` event fires for many actions (edited, closed, labeled, etc.). We only care about `opened` -- new issues that need triage. All other actions are logged and ignored.

---

## Entry 41: PR.opened Webhook Handler -- Loop Prevention and Stub Design (Issue #14)

**Date:** 2026-02-08
**Author:** Builder Agent
**Issue:** #14 — Handle `pull_request.opened` webhook event

### What we built

A handler for `pull_request.opened` events in the webhook listener. When GitHub sends a PR event, the handler decides whether it was created by our bot and logs it for future review.

### Key design decision: Loop prevention

The bot creates PRs as part of its workflow (via `create_pull_request` tool). If the webhook listener naively processed every PR event, it could trigger an infinite loop: bot creates PR -> webhook fires -> bot processes PR -> bot creates another PR -> ...

We prevent this with a **dual-signal check** in `isBotPr()`:

1. **HTML marker** (`<!-- deep-agent-pr -->`) — the `create_pull_request` tool already embeds this in PR bodies. This is the primary signal.
2. **Branch naming convention** (`issue-N-*` regex) — a fallback signal if the marker is missing or the PR body was edited.

If *either* signal matches, we treat it as a bot-created PR. This is deliberately permissive — false positives (treating a human PR as bot-created) are harmless (we just log it), while false negatives (treating a bot PR as human) could cause loops.

### Why a stub, not the full reviewer

Issue #15 will implement the actual PR review agent. This handler is a hook point: it extracts metadata, checks for bot origin, and returns a `PrHandlerResult` with `reviewQueued: true`. The `PrReviewStub` interface is exported so #15 can wire in without modifying the handler's dispatch logic.

### Fire-and-forget pattern

The webhook endpoint responds 200 immediately, then dispatches to handlers. This follows GitHub's guidance: webhook deliveries time out after 10 seconds, so long-running work should be deferred. The handler is synchronous today (just logging), but the pattern is ready for async work in #15.

### The dispatcher

`handleWebhookEvent()` is a simple router that checks `event.event` and delegates. It returns `null` for unhandled events, making it easy for #13 (issues.opened) to add its case. Both #13 and #14 can merge independently — the dispatcher handles the union.

### Test coverage

17 new tests covering: `isBotPr` helper (5), `handlePullRequestEvent` (9 cases including bot/non-bot/missing-data/wrong-action), `handleWebhookEvent` dispatcher (3). Total: 215 tests across 8 files.

---

## Entry 42: Docker + Caddy Deployment -- From Local Script to Containerized Service (Issue #21)

**Date:** 2026-02-09
**Author:** Builder Agent
**Issue:** #21 — Docker + Caddy deployment

### Why containerize?

The project started as a cron-triggered script (`poll.sh`), but with the webhook listener (Issue #12), it became a long-running service. Long-running services need:

1. **Process supervision** -- restart on crash (Docker's `restart: unless-stopped`)
2. **TLS termination** -- GitHub webhook payloads should be delivered over HTTPS
3. **Reproducible environment** -- Node 24+ requirement is enforced by the base image, not by documentation

Docker Compose ties these together: the bot container runs the webhook listener, and Caddy handles TLS + reverse proxying.

### Why Caddy over Nginx?

Caddy provides **automatic HTTPS** out of the box. With Nginx, you need to set up certbot, configure cron for certificate renewal, write the TLS configuration manually, and handle the ACME challenge. Caddy does all of this with zero configuration beyond the domain name. For a learning project, this eliminates an entire category of ops complexity.

### Design decisions

**Single-stage Dockerfile.** A multi-stage build (build stage + runtime stage) is common for TypeScript projects that compile to JavaScript. We skip this because `tsx` runs TypeScript directly -- there is no build step. The image installs all dependencies (including devDependencies like `tsx` and `vitest`) because `tsx` is needed at runtime to execute TypeScript. This keeps the Dockerfile simple at the cost of a slightly larger image. A future optimization could move `tsx` to production dependencies and use `--prod`.

**Corepack for pnpm.** Node 24 ships with corepack, which can install pnpm without a separate `npm install -g pnpm` step. This is cleaner than adding a global npm install and avoids version drift.

**Health-gated startup.** The `docker-compose.yml` uses `depends_on: { bot: { condition: service_healthy } }` so Caddy only starts accepting traffic after the bot's `/health` endpoint responds. This prevents Caddy from proxying to a container that is not ready yet.

**Volume mounts, not COPY.** `config.json` is mounted read-only at runtime, not copied into the image. This keeps credentials out of the Docker image layer history. `last_poll.json` and `issues/` are mounted read-write so state persists across container restarts.

**.dockerignore.** Excludes `node_modules/` (rebuilt inside the container), `.git/` (large, not needed at runtime), `config.json` and `last_poll.json` (secrets and state), and test files (not needed in production). This keeps the build context small and avoids accidentally baking credentials into the image.

### What this does NOT do

- No CI/CD pipeline -- this is a deployment recipe, not an automated release system
- No Docker registry push -- images are built locally on the server
- No secrets management beyond file mounts -- a production system would use Docker secrets or a vault
- No horizontal scaling -- single instance is sufficient for a learning project

---

## Entry 43: PAT vs GitHub App Authentication -- Migration Strategy (Issue #19)

**Date:** 2026-02-09
**Author:** Builder Agent
**Issue:** #19 -- Migrate from PAT to GitHub App authentication

### Why GitHub Apps over PATs

Personal Access Tokens (PATs) are the simplest way to authenticate with GitHub's API -- one token, one line of config. But they have significant drawbacks for bot-like applications:

1. **Tied to a user account.** If the user leaves the org or revokes the token, the bot breaks.
2. **Broad permissions.** Fine-grained PATs help, but classic PATs grant access to all repos the user can see.
3. **No installation context.** GitHub Apps get per-installation tokens scoped to specific repos, which is the Right Way for an app that operates on a single repo.
4. **Rate limits.** GitHub Apps get higher rate limits (5,000 requests/hour per installation vs 5,000 per user for PATs).

### Design decisions

**Backwards-compatible migration.** PAT remains the default. Existing users don't need to change anything. GitHub App auth is opt-in: provide `appId`, `privateKeyPath`, and `installationId` in the config, and omit `token`.

**Config validation is strict for partial App config.** If you provide `appId` but not `installationId`, that's a config error -- not a silent fallback to PAT. This prevents confusing "why isn't App auth working?" debugging sessions.

**Private key file path, not inline PEM.** The config takes a file path to the `.pem` file rather than the key content inline. This avoids JSON escaping issues with multi-line PEM content and keeps the key in a separate file that's easy to secure (file permissions, `.gitignore`).

**`getAuthFromConfig()` helper.** Rather than making every caller understand both auth modes, this function takes the github config section and returns either a PAT string or `GitHubAppAuth` object. The `createGitHubClient()` function handles both.

**`@octokit/auth-app` does the heavy lifting.** This official Octokit package handles JWT signing, installation token generation, and token refresh. We pass `authStrategy: createAppAuth` to Octokit's constructor and it handles the rest transparently.

### What changed in the codebase

- `config.ts`: Validation now accepts either `token` OR all three app fields. Private key file existence is checked at load time.
- `github-tools.ts`: `createGitHubClient()` accepts `string | GitHubAppAuth`. New `getAuthFromConfig()` helper.
- `agent.ts`, `triage-agent.ts`, `core.ts`: All updated to use `getAuthFromConfig()` instead of raw `token`.
- 8 new tests covering all validation paths and both auth modes.

## Entry 44: PR Reviewer Bot -- Closing the Feedback Loop (Issues #15, #16)

**Date:** 2026-02-09
**Author:** Builder Agent
**Issues:** #15 -- PR review agent, #16 -- submit_pr_review tool

### Why a reviewer bot?

The deepagents pipeline creates draft PRs for every issue it analyzes. But who reviews those PRs? Without automated review, a human must manually check every bot-generated PR -- defeating the purpose of automation.

The reviewer bot closes the feedback loop: the analysis agent creates a PR, and the reviewer agent immediately reviews it. This gives humans a second opinion before they look at the PR, catching obvious issues early.

### Key design decisions

**COMMENT-only reviews.** The `submit_pr_review` tool hardcodes `event: 'COMMENT'` regardless of what the LLM tries to send. This is a code-enforced constraint, not a prompt-based one. The tool literally ignores any event the LLM might try to set. Why? An autonomous bot should never approve its own work or block merging -- those are human decisions.

**Idempotency via HTML marker.** Same pattern as `comment_on_issue` (Entry 8). The `<!-- deep-agent-review -->` marker in the review body prevents duplicate reviews if the webhook fires twice or the CLI is run manually after a webhook-triggered review.

**Automated footer.** Every review ends with "This is an automated review by deep-agents. A human should verify before merging." This is hardcoded in the tool, not in the prompt. Prompt-based constraints can be ignored; code-enforced constraints cannot.

**Separate agent, not an extra step.** The reviewer runs as its own agent (`createReviewerAgent`) rather than being bolted onto the analysis agent's workflow. This keeps concerns separate: the analysis agent focuses on understanding issues and proposing fixes, while the reviewer focuses on evaluating code changes. Each has its own system prompt, tool set, and circuit breaker.

**Optional model override.** Like `triageLlm`, the reviewer supports `reviewerLlm` in config. This lets operators use a cheaper model for reviewing (most reviews are simpler than full analysis) or a different model to get diverse perspectives.

### Two trigger paths

1. **Webhook (automatic):** `handlePullRequestEvent()` detects bot-created PRs (via HTML marker or branch pattern) and calls `runReviewSingle()`. The review happens within seconds of PR creation.
2. **CLI (manual):** `deepagents review --pr N` lets humans trigger a review on any PR. Useful for re-reviewing after force-pushes or testing the reviewer in isolation.

### What the reviewer sees

The reviewer agent has three tools:
- `get_pr_diff` -- fetches the unified diff (truncated at 50k chars for LLM context budget)
- `read_repo_file` -- reads source files for context (reuses the existing tool)
- `submit_pr_review` -- posts the review with optional inline comments

The system prompt asks it to: read the diff, read relevant files, evaluate the approach, and post a review with specific inline comments where relevant. It's instructed to be constructive and not nitpick style.

### What changed

- `github-tools.ts`: Two new tool factories (`createGetPrDiffTool`, `createSubmitPrReviewTool`)
- `reviewer-agent.ts`: New file with agent factory and `runReviewSingle()` entry point
- `listener.ts`: `handlePullRequestEvent()` now async, calls reviewer instead of logging stub
- `cli.ts`: New `review --pr N` subcommand
- 12 new tests for the tools, 2 updated listener tests for reviewer integration

## Entry 47: SSE Streaming -- Making the Agent's Thinking Visible (Issue #51)

**Date:** 2026-02-10
**Author:** Builder Agent
**Issue:** #51 (SSE streaming with thinking and token usage)
**Builds on:** Entry 46 (Agent-Human Interactive Dialog)

### The problem

The v1.2.0 dialog sent a single JSON response after the agent finished. For simple questions this was fine, but when the agent called multiple tools (fetching issues, reading files), the UI showed "Thinking..." for 10+ seconds with no feedback. Worse, if the LLM call failed silently, the user saw nothing — just an eternal spinner.

### The fix: Server-Sent Events

LangGraph's compiled graph exposes `.streamEvents()` which emits fine-grained events as the agent runs. We pipe these through SSE:

1. `chatStream()` async generator yields typed events (`tool_start`, `tool_end`, `response`, `usage`, `error`)
2. The `/chat` endpoint writes each event as `data: {...}\n\n`
3. The frontend reads the stream via `fetch()` + `ReadableStream` and renders each event as it arrives

Token usage is extracted from `on_chat_model_end` events where `usage_metadata` contains input/output counts. These accumulate across multiple LLM calls (tool-calling loop) and are yielded as a final `usage` event.

### UI changes

The dialog now has a collapsible "Thinking" block that shows each tool call with its arguments and result. It auto-collapses after the response arrives, keeping the chat clean. A pulsing status line shows what the agent is currently doing ("Calling list_repo_files...").

### Connections to previous entries

- **Entry 46** (Interactive Dialog): This directly improves the chat experience built there.
- **Entry 33** (Structured Logging): The server-side logging still works alongside SSE — tool calls are logged to stdout and streamed to the client simultaneously.

---

## Entry 46: Agent-Human Interactive Dialog -- From Autonomous to Conversational (Issues #48, #49)

**Date:** 2026-02-10
**Author:** Builder Agent
**Issues:** #48 (chat endpoint), #49 (dialog.html)
**Builds on:** Entry 44 (Reviewer Bot), Entry 31 (Webhook Listener)

### Why this design

Until now, the agent was purely autonomous: it received GitHub events and acted on them without human interaction. But LangChain and the DeepAgents framework already have human-in-the-loop patterns built in — `createDeepAgent` accepts a `checkpointer` parameter for conversation state, and the agent's `invoke()` method supports `thread_id` for session isolation. We're not building something new; we're wiring up what's already there.

### The pattern: LangGraph checkpointer for multi-turn chat

The key insight is that LangGraph's `MemorySaver` gives us conversation state for free. Each session gets a `thread_id`, and the checkpointer automatically accumulates messages across invocations:

```typescript
const agent = createDeepAgent({ model, tools, systemPrompt, checkpointer });

// Each call with the same thread_id continues the conversation
await agent.invoke(
  { messages: [{ role: 'user', content: 'What does this project do?' }] },
  { configurable: { thread_id: sessionId } },
);
```

No custom message history management, no database — the framework handles it.

### What could go wrong

- **Memory grows unbounded** — `MemorySaver` is in-memory, so long sessions or many concurrent sessions will consume memory. For a learning project this is fine; production would need a persistent checkpointer (SQLite, PostgreSQL).
- **Agent creates new tools per request** — `createChatAgent()` is called per chat message, which creates fresh Octokit clients and tool instances. This is intentional for simplicity and matches the existing pattern (analysis agent is also created per invocation). If latency becomes an issue, agent instances could be cached per session.
- **Circuit breaker is per-invocation** — each chat turn gets a fresh 15-call budget. A user can't exhaust the circuit breaker across turns, which is the right behavior for interactive use.

### Connections to previous entries

- **Entry 31** (Webhook Listener): The dialog server reuses the same Express pattern — `createDialogApp()` mirrors `createWebhookApp()`. Both are testable factories that return an Express app.
- **Entry 44** (Reviewer Bot): The chat agent uses the same `createModel()` and read-only tool factories, following the established pattern of agent-specific tool subsets.
- **Entry 16** (Test Infrastructure): The dialog tests reuse the same `inject()` HTTP helper pattern from webhook tests — no supertest dependency.

---

## Entry 45: Consolidating Config into .env -- Single Source of Truth (Issue #47)

**Date:** 2026-02-09
**Author:** Architect Agent
**Issue:** #47 -- Consolidate config into `.env`

### The problem: three files, three places for secrets

After v1.0.0, a real setup session exposed several pain points:

1. **Secrets scattered everywhere.** GitHub token in `config.json`, Cloudflare token in `.env`, domain name in a user-created `Caddyfile`. Three files, three places to make mistakes.
2. **`triageLlm`/`reviewerLlm` shape unclear.** Users had to study `config.json.example` to understand these are the same shape as `llm`. The nesting felt arbitrary.
3. **`privateKeyPath` confusion.** The path in `config.json` refers to the host filesystem, but inside Docker the PEM is mounted at `/app/app.pem`. Users kept putting the container path in config.
4. **Ollama `https` vs `http` gotcha.** Local models run on `http://localhost`, but users reflexively type `https://`. The error that results is opaque (TLS handshake failure, not a clear message).

### The solution: env vars as primary, config.json as fallback

The new `loadConfig()` works in three steps:
1. Read `config.json` if present (info log if absent — no longer fatal)
2. Overlay env vars using nullish coalescing (`??`) — env vars win when set
3. Run all existing validation (unchanged logic)

This means:
- **Docker users** only need `.env` — no `config.json` mount
- **Local users** can use either `.env` or `config.json` (or both)
- **Existing setups** keep working unchanged

### Key design decisions

**All-or-nothing for optional LLM sections.** `TRIAGE_LLM_*` and `REVIEWER_LLM_*` env vars only create their config section if `_PROVIDER` is set. This prevents half-configured sections where only the API key is set but no provider.

**`parseIntEnv()` for numeric fields.** `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `WEBHOOK_PORT`, `MAX_ISSUES_PER_RUN`, and `MAX_TOOL_CALLS_PER_RUN` must be numbers. The helper parses env var strings to integers, returning `undefined` for invalid values (which then falls through to the config.json value or to the validation error).

**Localhost-HTTPS warning.** A new `warnLocalhostHttps()` helper checks all three LLM baseUrls. If you point `https://localhost:11434/v1` at Ollama, you get a clear warning instead of a cryptic TLS error. This is a `console.warn`, not an error — it doesn't block startup in case someone legitimately runs HTTPS locally.

**Caddyfile is now committable.** By using `{$DOMAIN}` (a Caddy env var placeholder), the Caddyfile template contains no secrets or user-specific values. Docker Compose passes the `DOMAIN` env var from `.env` to Caddy via `env_file`. No more user-created `Caddyfile` that's git-ignored.

### What changed

- `config.ts`: Three new helpers + rewritten `loadConfig()` with env var merge
- `tests/config.test.ts`: Env var cleanup in `beforeEach`, 12 new tests (269 total)
- `.env.example`: Comprehensive template covering all sections
- `Caddyfile.example`: Uses `{$DOMAIN}` env var, no more hardcoded domain
- `docker-compose.yml`: `env_file: .env`, Caddyfile.example mounted directly
- `.gitignore`: Removed `Caddyfile` (now committable)

### Connections to previous entries

- **Entry 1** (Project Overview): config.ts was the simplest file — "read and validate config.json." Now it's the merge layer between two config sources.
- **Entry 43** (GitHub App Auth): The `privateKeyPath` confusion was a direct consequence of adding App auth. Env vars make the Docker mount path clearer.
- **Entry 30** (Webhook Listener): Webhook secret was already in `config.json`. Now `WEBHOOK_SECRET` env var is a more natural fit for Docker deployments.
