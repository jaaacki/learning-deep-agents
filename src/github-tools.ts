import { Octokit } from 'octokit';
import { tool } from 'langchain';
import { z } from 'zod';

/**
 * Create GitHub API client
 */
export function createGitHubClient(token: string) {
  return new Octokit({ auth: token });
}

/**
 * Tool: Fetch open issues from GitHub repository
 * Accepts a shared Octokit client instead of creating its own.
 * Supports a 'since' parameter for polling (only return issues updated after a given date).
 */
export function createGitHubIssuesTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ state = 'open', limit = 5, since }: { state?: 'open' | 'closed' | 'all'; limit?: number; since?: string }) => {
      try {
        const sinceLabel = since ? ` updated since ${since}` : '';
        console.log(`\u{1F4E5} Fetching ${state} issues from ${owner}/${repo}${sinceLabel}...`);

        const params: Parameters<typeof octokit.rest.issues.listForRepo>[0] = {
          owner,
          repo,
          state,
          per_page: limit,
          sort: 'updated',
          direction: 'desc',
        };

        if (since) {
          params.since = since;
        }

        const { data: issues } = await octokit.rest.issues.listForRepo(params);

        // Format issues for the agent
        const formattedIssues = issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body || '(no description)',
          state: issue.state,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          url: issue.html_url,
          labels: issue.labels.map((l) => l.name),
        }));

        return JSON.stringify(formattedIssues, null, 2);
      } catch (error) {
        return `Error fetching issues: ${error}`;
      }
    },
    {
      name: 'fetch_github_issues',
      description: 'Fetch issues from a GitHub repository. Supports a "since" parameter for polling -- only returns issues updated after the given ISO 8601 timestamp.',
      schema: z.object({
        state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state: open, closed, or all'),
        limit: z.number().optional().default(5).describe('Maximum number of issues to return'),
        since: z.string().optional().describe('ISO 8601 timestamp. Only issues updated after this date are returned.'),
      }),
    }
  );
}

/**
 * Tool: Post a comment on a GitHub issue
 * Uses octokit.rest.issues.createComment() -- works for both issues and PRs.
 */
export function createCommentOnIssueTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ issue_number, body }: { issue_number: number; body: string }) => {
      try {
        console.log(`\u{1F4AC} Commenting on issue #${issue_number} in ${owner}/${repo}...`);

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

/**
 * Tool: Create a new Git branch in the repository
 * Uses two GitHub API calls:
 *   1. octokit.rest.git.getRef() -- get the SHA of the source branch
 *   2. octokit.rest.git.createRef() -- create a new branch pointing to that SHA
 */
export function createBranchTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ branch_name, from_branch = 'main' }: { branch_name: string; from_branch?: string }) => {
      try {
        console.log(`\u{1F33F} Creating branch '${branch_name}' from '${from_branch}' in ${owner}/${repo}...`);

        // Step 1: Get the SHA of the source branch
        const { data: ref } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${from_branch}`,
        });
        const sha = ref.object.sha;

        // Step 2: Create the new branch pointing to that SHA
        await octokit.rest.git.createRef({
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

/**
 * Tool: Open a draft pull request
 * Uses octokit.rest.pulls.create() with draft: true.
 * Always creates a draft -- the agent should never auto-merge.
 */
export function createPullRequestTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ title, body, head, base = 'main' }: { title: string; body: string; head: string; base?: string }) => {
      try {
        console.log(`\u{1F4DD} Creating draft PR '${title}' in ${owner}/${repo}...`);

        const { data: pr } = await octokit.rest.pulls.create({
          owner,
          repo,
          title,
          body,
          head,
          base,
          draft: true,
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
