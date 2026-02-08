import { createDeepAgent } from 'deepagents';
import type { Config } from './config.js';
import { createModel } from './model.js';
import {
  createGitHubClient,
  createGitHubIssuesTool,
  createCommentOnIssueTool,
  createBranchTool,
  createPullRequestTool,
  createListRepoFilesTool,
  createReadRepoFileTool,
  createDryRunCommentTool,
  createDryRunBranchTool,
  createDryRunPullRequestTool,
  createOrUpdateFileTool,
  createDryRunCreateOrUpdateFileTool,
  ToolCallCounter,
  wrapWithCircuitBreaker,
} from './github-tools.js';
import { wrapWithLogging } from './logger.js';

/**
 * Create the Deep Agent with GitHub integration
 */
export function createDeepAgentWithGitHub(config: Config, options: { maxIssues?: number; dryRun?: boolean; maxToolCalls?: number } = {}) {
  const model = createModel(config);

  const { owner, repo, token } = config.github;

  // Create one shared Octokit client for all tools
  const octokit = createGitHubClient(token);

  // Read-only tools always use real implementations
  let githubIssuesTool = createGitHubIssuesTool(owner, repo, octokit, options.maxIssues);
  let listFilesTool = createListRepoFilesTool(owner, repo, octokit);
  let readFileTool = createReadRepoFileTool(owner, repo, octokit);

  // Write tools: swap to dry-run stubs when --dry-run is active
  let commentTool = options.dryRun ? createDryRunCommentTool() : createCommentOnIssueTool(owner, repo, octokit);
  let branchTool = options.dryRun ? createDryRunBranchTool() : createBranchTool(owner, repo, octokit);
  let prTool = options.dryRun ? createDryRunPullRequestTool() : createPullRequestTool(owner, repo, octokit);
  let commitFileTool = options.dryRun ? createDryRunCreateOrUpdateFileTool() : createOrUpdateFileTool(owner, repo, octokit);

  // Circuit breaker: wrap all tools with a shared call counter
  const counter = options.maxToolCalls ? new ToolCallCounter(options.maxToolCalls) : undefined;
  if (counter) {
    githubIssuesTool = wrapWithCircuitBreaker(githubIssuesTool, counter);
    listFilesTool = wrapWithCircuitBreaker(listFilesTool, counter);
    readFileTool = wrapWithCircuitBreaker(readFileTool, counter);
    commentTool = wrapWithCircuitBreaker(commentTool, counter);
    branchTool = wrapWithCircuitBreaker(branchTool, counter);
    prTool = wrapWithCircuitBreaker(prTool, counter);
    commitFileTool = wrapWithCircuitBreaker(commitFileTool, counter);
  }

  // Structured logging: wrap all tools (outermost layer, logs even on breaker trip)
  githubIssuesTool = wrapWithLogging(githubIssuesTool, counter);
  listFilesTool = wrapWithLogging(listFilesTool, counter);
  readFileTool = wrapWithLogging(readFileTool, counter);
  commentTool = wrapWithLogging(commentTool, counter);
  branchTool = wrapWithLogging(branchTool, counter);
  prTool = wrapWithLogging(prTool, counter);
  commitFileTool = wrapWithLogging(commitFileTool, counter);

  // System prompt - full workflow instructions
  const systemPrompt = `You are a GitHub issue analysis agent for the repository ${owner}/${repo}.

When given issues to analyze, follow this workflow for EACH issue:

1. ANALYZE the issue:
   - Read the title, body, and labels carefully
   - Identify the type of problem (bug, feature, docs, etc.)
   - If TRIAGE CONTEXT is provided in the user message, use it to jumpstart your analysis:
     * The triage agent has already classified the issue type and complexity
     * Start by reading the relevant files it identified (skip list_repo_files if triage already found them)
     * Use the triage summary to understand the issue scope before diving into code
     * You may still call list_repo_files if you need to explore beyond what triage found
   - Otherwise, use list_repo_files to see the repo structure and identify relevant files
   - Use read_repo_file to read the source code of files related to the issue
   - Determine severity and complexity
   - Think about what a fix would involve based on actual code

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

5. COMMIT proposed changes to the branch:
   - Use create_or_update_file to write your proposed fix to the feature branch
   - Each call commits one file. Make multiple calls for multi-file changes.
   - Write the FULL file content (not a diff) — the tool replaces the entire file
   - Use clear commit messages like "Fix #<number>: improve README structure"
   - You MUST commit at least one file so the PR has a real diff

6. SELF-REVIEW your committed changes:
   - Use read_repo_file to read back each file you committed (from the feature branch)
   - Compare against the original file from main that you read in step 1
   - Sanity-check your changes:
     a. Do the imports resolve to real modules (in the codebase or a well-known package)?
     b. Do function calls match actual signatures you saw in the code?
     c. Are new dependencies justified by the fix? If so, note them in the PR body.
   - If you spot something clearly wrong, commit a corrected version
   - Add a brief "## Self-Review" section to your PR body noting what you checked

7. OPEN a draft PR:
   - Use create_pull_request with:
     - title: "Fix #<number>: <short description>"
     - body: Include "Closes #<number>" on its own line, plus your analysis summary and self-review notes
     - head: the branch you just created
   - This links the PR to the issue automatically

IMPORTANT:
- Always create the branch BEFORE committing files, and commit files BEFORE the PR
- Use write_todos at the start to plan your approach for all issues
- Process issues one at a time, completing all 7 steps before moving to the next
- Never merge PRs -- always open them as drafts
- Write tools (comment, branch, PR, create_or_update_file) are idempotent. If they return { skipped: true }, the work was already done -- move to the next step without retrying

CODE QUALITY GUIDELINES:
- Prefer existing patterns and dependencies, but propose new ones when the fix genuinely requires them
- Base your changes on the actual content from read_repo_file, not assumptions
- If adding new dependencies, explain why in the PR body
- If unsure about something, note it in the PR body for human review

Available tools:
- fetch_github_issues: Fetch issues from the repo (supports 'since' for polling)
- list_repo_files: List all files in the repo (supports path prefix filtering)
- read_repo_file: Read a single file's contents from the repo
- comment_on_issue: Post a comment on a GitHub issue
- create_branch: Create a new branch in the repo
- create_or_update_file: Commit a file to a branch (creates one commit per call)
- create_pull_request: Open a draft PR
- write_file: Write analysis files to ./issues/
- read_file: Read local files
- write_todos: Plan your approach
`;

  // Create the agent
  const agent = createDeepAgent({
    model,
    tools: [githubIssuesTool, listFilesTool, readFileTool, commentTool, branchTool, commitFileTool, prTool],
    systemPrompt,
  });

  return agent;
}
