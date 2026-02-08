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
/**
 * Hidden HTML marker embedded in bot comments for idempotency detection.
 * GitHub renders HTML comments invisibly, so users never see this.
 */
const BOT_COMMENT_MARKER = '<!-- deep-agent-analysis -->';

export function createCommentOnIssueTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ issue_number, body }: { issue_number: number; body: string }) => {
      try {
        console.log(`\u{1F4AC} Commenting on issue #${issue_number} in ${owner}/${repo}...`);

        // Idempotency check: see if we already posted an analysis comment
        const { data: existingComments } = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number,
          per_page: 100,
        });
        const alreadyCommented = existingComments.some(
          (c) => c.body?.includes(BOT_COMMENT_MARKER)
        );

        if (alreadyCommented) {
          console.log(`\u{26A0}\uFE0F  Skipping comment on issue #${issue_number} -- analysis comment already exists.`);
          return JSON.stringify({
            skipped: true,
            reason: 'Analysis comment already exists on this issue.',
            issue_number,
          });
        }

        // Include the marker in the comment body (invisible in rendered Markdown)
        const markedBody = `${BOT_COMMENT_MARKER}\n${body}`;

        const { data: comment } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number,
          body: markedBody,
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
      description: 'Post a comment on a GitHub issue. Use this to share analysis findings directly on the issue. Automatically skips if an analysis comment already exists (idempotent).',
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

        // Idempotency check: see if the branch already exists
        try {
          await octokit.rest.git.getRef({
            owner,
            repo,
            ref: `heads/${branch_name}`,
          });
          // If we get here, the branch exists
          console.log(`\u{26A0}\uFE0F  Skipping branch creation -- '${branch_name}' already exists.`);
          return JSON.stringify({
            skipped: true,
            reason: `Branch '${branch_name}' already exists.`,
            branch: branch_name,
            url: `https://github.com/${owner}/${repo}/tree/${branch_name}`,
          });
        } catch (e: unknown) {
          // 404 means the branch does not exist -- this is the expected path
          const status = (e as { status?: number }).status;
          if (status !== 404) throw e;
        }

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
      description: 'Create a new Git branch in the repository. Used to prepare a feature branch before opening a pull request. Automatically skips if the branch already exists (idempotent).',
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

        // Idempotency check: see if an open PR already exists for this head branch
        const { data: existingPRs } = await octokit.rest.pulls.list({
          owner,
          repo,
          head: `${owner}:${head}`,
          base,
          state: 'open',
        });

        if (existingPRs.length > 0) {
          const existing = existingPRs[0];
          console.log(`\u{26A0}\uFE0F  Skipping PR creation -- open PR #${existing.number} already exists for branch '${head}'.`);
          return JSON.stringify({
            skipped: true,
            reason: `Open PR #${existing.number} already exists for branch '${head}'.`,
            number: existing.number,
            html_url: existing.html_url,
          });
        }

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
      description: 'Open a draft pull request. The PR should reference the issue number in the title and body. Always creates a draft PR -- never auto-merges. Automatically skips if an open PR already exists for the same branch (idempotent).',
      schema: z.object({
        title: z.string().describe('PR title (e.g., "Fix #42: Resolve login timeout")'),
        body: z.string().describe('PR description with analysis and approach. Include "Closes #N" to link the issue.'),
        head: z.string().describe('The branch containing changes (e.g., "issue-42-fix-login")'),
        base: z.string().optional().default('main').describe('The branch to merge into (default: main)'),
      }),
    }
  );
}

/**
 * Tool: List files in the repository
 * Uses three GitHub API calls:
 *   1. octokit.rest.git.getRef() -- get the commit SHA of the branch
 *   2. octokit.rest.git.getCommit() -- get the tree SHA from the commit
 *   3. octokit.rest.git.getTree() -- get the full file tree recursively
 *
 * Returns file paths and sizes. Supports optional path prefix filtering.
 */
export function createListRepoFilesTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ path = '', branch = 'main' }: { path?: string; branch?: string }) => {
      try {
        console.log(`\u{1F4C2} Listing files in ${owner}/${repo}${path ? ` under ${path}` : ''}...`);

        // Step 1: Get the commit SHA of the branch
        const { data: ref } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branch}`,
        });
        const commitSha = ref.object.sha;

        // Step 2: Get the tree SHA from the commit
        const { data: commit } = await octokit.rest.git.getCommit({
          owner,
          repo,
          commit_sha: commitSha,
        });
        const treeSha = commit.tree.sha;

        // Step 3: Get the full tree recursively
        const { data: tree } = await octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: treeSha,
          recursive: 'true',
        });

        // Filter to blobs (files only, not sub-trees) and apply path prefix
        const prefix = path ? (path.endsWith('/') ? path : path + '/') : '';
        const files = tree.tree
          .filter((item) => item.type === 'blob')
          .filter((item) => !prefix || item.path?.startsWith(prefix))
          .map((item) => ({
            path: item.path,
            size: item.size,
          }));

        if (tree.truncated) {
          return JSON.stringify({
            files,
            warning: 'Tree was truncated by GitHub API (repo has too many files). Results may be incomplete.',
            total: files.length,
          }, null, 2);
        }

        return JSON.stringify({ files, total: files.length }, null, 2);
      } catch (error) {
        return `Error listing files: ${error}`;
      }
    },
    {
      name: 'list_repo_files',
      description: 'List all files in the repository. Returns file paths and sizes. Use this to understand the repo structure before reading specific files. Supports optional path prefix filtering (e.g., "src/" to list only source files).',
      schema: z.object({
        path: z.string().optional().default('').describe('Filter files by path prefix (e.g., "src/", "test/"). Empty string returns all files.'),
        branch: z.string().optional().default('main').describe('Branch to list files from (default: main)'),
      }),
    }
  );
}

/**
 * Tool: Read a single file from the repository
 * Uses octokit.rest.repos.getContent() to fetch file content.
 * GitHub returns base64-encoded content which we decode to UTF-8 text.
 *
 * Note: GitHub's Content API has a 1MB file size limit. For larger files,
 * the API returns a git_url that can be used with the Blobs API instead.
 */
export function createReadRepoFileTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ path, branch = 'main' }: { path: string; branch?: string }) => {
      try {
        console.log(`\u{1F4D6} Reading ${path} from ${owner}/${repo} (${branch})...`);

        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref: branch,
        });

        // getContent can return a file, directory, symlink, or submodule.
        // We only handle files (type === 'file' with content + encoding).
        if (Array.isArray(data)) {
          return `Error: '${path}' is a directory, not a file. Use list_repo_files to browse directories.`;
        }

        if (data.type !== 'file') {
          return `Error: '${path}' is a ${data.type}, not a file.`;
        }

        if (!data.content) {
          return `Error: '${path}' has no content (file may be too large for the Content API -- GitHub limit is 1MB).`;
        }

        // Decode base64 content to UTF-8 string
        const fullContent = Buffer.from(data.content, 'base64').toString('utf-8');

        // Truncate files over 500 lines to avoid flooding the LLM context
        const MAX_LINES = 500;
        const lines = fullContent.split('\n');
        const truncated = lines.length > MAX_LINES;
        const content = truncated
          ? lines.slice(0, MAX_LINES).join('\n')
          : fullContent;

        const result: Record<string, unknown> = {
          path: data.path,
          size: data.size,
          sha: data.sha,
          content,
        };

        if (truncated) {
          result.truncated = true;
          result.total_lines = lines.length;
          result.shown_lines = MAX_LINES;
          result.note = `File has ${lines.length} lines. Only the first ${MAX_LINES} are shown. Use list_repo_files to find smaller, more targeted files.`;
        }

        return JSON.stringify(result, null, 2);
      } catch (error) {
        return `Error reading file '${path}': ${error}`;
      }
    },
    {
      name: 'read_repo_file',
      description: 'Read the contents of a single file from the repository. Returns the file content as text. Files over 500 lines are truncated. Use list_repo_files first to find the correct file path. Limited to files under 1MB.',
      schema: z.object({
        path: z.string().describe('Full path to the file in the repo (e.g., "src/index.ts", "README.md")'),
        branch: z.string().optional().default('main').describe('Branch to read from (default: main)'),
      }),
    }
  );
}
