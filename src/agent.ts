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
  if (options.maxToolCalls) {
    const counter = new ToolCallCounter(options.maxToolCalls);
    githubIssuesTool = wrapWithCircuitBreaker(githubIssuesTool, counter);
    listFilesTool = wrapWithCircuitBreaker(listFilesTool, counter);
    readFileTool = wrapWithCircuitBreaker(readFileTool, counter);
    commentTool = wrapWithCircuitBreaker(commentTool, counter);
    branchTool = wrapWithCircuitBreaker(branchTool, counter);
    prTool = wrapWithCircuitBreaker(prTool, counter);
    commitFileTool = wrapWithCircuitBreaker(commitFileTool, counter);
  }

  // System prompt - full workflow instructions
  const systemPrompt = `You are a GitHub issue analysis agent for the repository ${owner}/${repo}.

When given issues to analyze, follow this workflow for EACH issue:

1. ANALYZE the issue:
   - Read the title, body, and labels carefully
   - Identify the type of problem (bug, feature, docs, etc.)
   - Use list_repo_files to see the repo structure and identify relevant files
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

6. OPEN a draft PR:
   - Use create_pull_request with:
     - title: "Fix #<number>: <short description>"
     - body: Include "Closes #<number>" on its own line, plus your analysis summary
     - head: the branch you just created
   - This links the PR to the issue automatically

IMPORTANT:
- Always create the branch BEFORE committing files, and commit files BEFORE the PR
- Use write_todos at the start to plan your approach for all issues
- Process issues one at a time, completing all 6 steps before moving to the next
- Never merge PRs -- always open them as drafts
- Write tools (comment, branch, PR, create_or_update_file) are idempotent. If they return { skipped: true }, the work was already done -- move to the next step without retrying

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
