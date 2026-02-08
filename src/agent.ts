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
} from './github-tools.js';

/**
 * Create the Deep Agent with GitHub integration
 */
export function createDeepAgentWithGitHub(config: Config) {
  const model = createModel(config);

  const { owner, repo, token } = config.github;

  // Create one shared Octokit client for all tools
  const octokit = createGitHubClient(token);

  // Create all GitHub tools with the shared client
  const githubIssuesTool = createGitHubIssuesTool(owner, repo, octokit);
  const commentTool = createCommentOnIssueTool(owner, repo, octokit);
  const branchTool = createBranchTool(owner, repo, octokit);
  const prTool = createPullRequestTool(owner, repo, octokit);
  const listFilesTool = createListRepoFilesTool(owner, repo, octokit);
  const readFileTool = createReadRepoFileTool(owner, repo, octokit);

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
- Write tools (comment, branch, PR) are idempotent. If they return { skipped: true }, the work was already done -- move to the next step without retrying

Available tools:
- fetch_github_issues: Fetch issues from the repo (supports 'since' for polling)
- list_repo_files: List all files in the repo (supports path prefix filtering)
- read_repo_file: Read a single file's contents from the repo
- comment_on_issue: Post a comment on a GitHub issue
- create_branch: Create a new branch in the repo
- create_pull_request: Open a draft PR
- write_file: Write analysis files to ./issues/
- read_file: Read local files
- write_todos: Plan your approach
`;

  // Create the agent
  const agent = createDeepAgent({
    model,
    tools: [githubIssuesTool, listFilesTool, readFileTool, commentTool, branchTool, prTool],
    systemPrompt,
  });

  return agent;
}
