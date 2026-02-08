import { Octokit } from 'octokit';
import { tool } from 'langchain';
import { z } from 'zod';
import { withRetry } from './utils.js';

// ── Circuit breaker ─────────────────────────────────────────────────────────

/**
 * Shared counter for circuit breaker. Tracks total tool calls across all tools
 * in a single agent run and throws when the limit is exceeded.
 */
export class ToolCallCounter {
  private count = 0;
  constructor(readonly limit: number) {}

  increment(toolName: string): void {
    this.count++;
    if (this.count > this.limit) {
      throw new CircuitBreakerError(
        `Circuit breaker tripped: ${this.count} tool calls exceeded limit of ${this.limit}. ` +
        `Last tool: ${toolName}. Stopping agent to prevent runaway execution.`,
        this.count,
        this.limit,
      );
    }
  }

  getCount(): number {
    return this.count;
  }
}

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly callCount: number,
    public readonly callLimit: number,
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Wrap a LangChain tool with circuit breaker counting.
 * Returns a new tool with the same name/schema that increments the shared counter before each call.
 */
export function wrapWithCircuitBreaker<T extends ReturnType<typeof tool>>(
  wrappedTool: T,
  counter: ToolCallCounter,
): T {
  const originalInvoke = wrappedTool.invoke.bind(wrappedTool);
  wrappedTool.invoke = async (input: any, options?: any) => {
    counter.increment(wrappedTool.name);
    return originalInvoke(input, options);
  };
  return wrappedTool;
}

/**
 * Create GitHub API client
 */
export function createGitHubClient(token: string) {
  return new Octokit({ auth: token });
}

/**
 * Tool: Fetch open issues from GitHub repository
 */
export function createGitHubIssuesTool(owner: string, repo: string, octokit: Octokit, maxIssues?: number) {
  return tool(
    async ({ state = 'open', limit = 5, since }: { state?: 'open' | 'closed' | 'all'; limit?: number; since?: string }) => {
      try {
        const effectiveLimit = maxIssues ? Math.min(limit, maxIssues) : limit;
        const sinceLabel = since ? ` updated since ${since}` : '';
        console.log(`\u{1F4E5} Fetching ${state} issues from ${owner}/${repo}${sinceLabel}...`);
        const params: Parameters<typeof octokit.rest.issues.listForRepo>[0] = {
          owner, repo, state, per_page: effectiveLimit, sort: 'updated', direction: 'desc',
        };
        if (since) { params.since = since; }
        const { data: issues } = await withRetry(() => octokit.rest.issues.listForRepo(params));
        const formattedIssues = issues.map((issue) => ({
          number: issue.number, title: issue.title, body: issue.body || '(no description)',
          state: issue.state, created_at: issue.created_at, updated_at: issue.updated_at,
          url: issue.html_url, labels: issue.labels.map((l) => l.name),
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

const BOT_COMMENT_MARKER = '<!-- deep-agent-analysis -->';

export function createCommentOnIssueTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ issue_number, body }: { issue_number: number; body: string }) => {
      try {
        console.log(`\u{1F4AC} Commenting on issue #${issue_number} in ${owner}/${repo}...`);
        const { data: existingComments } = await withRetry(() => octokit.rest.issues.listComments({
          owner, repo, issue_number, per_page: 100,
        }));
        const alreadyCommented = existingComments.some((c) => c.body?.includes(BOT_COMMENT_MARKER));
        if (alreadyCommented) {
          console.log(`\u{26A0}\uFE0F  Skipping comment on issue #${issue_number} -- analysis comment already exists.`);
          return JSON.stringify({ skipped: true, reason: 'Analysis comment already exists on this issue.', issue_number });
        }
        const markedBody = `${BOT_COMMENT_MARKER}\n${body}`;
        const { data: comment } = await withRetry(() => octokit.rest.issues.createComment({
          owner, repo, issue_number, body: markedBody,
        }));
        return JSON.stringify({ id: comment.id, html_url: comment.html_url, created_at: comment.created_at });
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

export function createBranchTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ branch_name, from_branch = 'main' }: { branch_name: string; from_branch?: string }) => {
      try {
        console.log(`\u{1F33F} Creating branch '${branch_name}' from '${from_branch}' in ${owner}/${repo}...`);
        try {
          await withRetry(() => octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch_name}` }));
          console.log(`\u{26A0}\uFE0F  Skipping branch creation -- '${branch_name}' already exists.`);
          return JSON.stringify({ skipped: true, reason: `Branch '${branch_name}' already exists.`, branch: branch_name, url: `https://github.com/${owner}/${repo}/tree/${branch_name}` });
        } catch (e: unknown) {
          const status = (e as { status?: number }).status;
          if (status !== 404) throw e;
        }
        const { data: ref } = await withRetry(() => octokit.rest.git.getRef({ owner, repo, ref: `heads/${from_branch}` }));
        const sha = ref.object.sha;
        await withRetry(() => octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch_name}`, sha }));
        return JSON.stringify({ branch: branch_name, sha, url: `https://github.com/${owner}/${repo}/tree/${branch_name}` });
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

export function createPullRequestTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ title, body, head, base = 'main' }: { title: string; body: string; head: string; base?: string }) => {
      try {
        console.log(`\u{1F4DD} Creating draft PR '${title}' in ${owner}/${repo}...`);
        const { data: existingPRs } = await withRetry(() => octokit.rest.pulls.list({
          owner, repo, head: `${owner}:${head}`, base, state: 'open',
        }));
        if (existingPRs.length > 0) {
          const existing = existingPRs[0];
          console.log(`\u{26A0}\uFE0F  Skipping PR creation -- open PR #${existing.number} already exists for branch '${head}'.`);
          return JSON.stringify({ skipped: true, reason: `Open PR #${existing.number} already exists for branch '${head}'.`, number: existing.number, html_url: existing.html_url });
        }
        const { data: pr } = await withRetry(() => octokit.rest.pulls.create({
          owner, repo, title, body, head, base, draft: true,
        }));
        return JSON.stringify({ number: pr.number, html_url: pr.html_url, state: pr.state, draft: pr.draft });
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

export function createListRepoFilesTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ path = '', branch = 'main' }: { path?: string; branch?: string }) => {
      try {
        console.log(`\u{1F4C2} Listing files in ${owner}/${repo}${path ? ` under ${path}` : ''}...`);
        const { data: ref } = await withRetry(() => octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }));
        const commitSha = ref.object.sha;
        const { data: commit } = await withRetry(() => octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha }));
        const treeSha = commit.tree.sha;
        const { data: tree } = await withRetry(() => octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: 'true' }));
        const prefix = path ? (path.endsWith('/') ? path : path + '/') : '';
        const files = tree.tree
          .filter((item) => item.type === 'blob')
          .filter((item) => !prefix || item.path?.startsWith(prefix))
          .map((item) => ({ path: item.path, size: item.size }));
        if (tree.truncated) {
          return JSON.stringify({ files, warning: 'Tree was truncated by GitHub API (repo has too many files). Results may be incomplete.', total: files.length }, null, 2);
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

export function createReadRepoFileTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ path, branch = 'main' }: { path: string; branch?: string }) => {
      try {
        console.log(`\u{1F4D6} Reading ${path} from ${owner}/${repo} (${branch})...`);
        const { data } = await withRetry(() => octokit.rest.repos.getContent({ owner, repo, path, ref: branch }));
        if (Array.isArray(data)) {
          return `Error: '${path}' is a directory, not a file. Use list_repo_files to browse directories.`;
        }
        if (data.type !== 'file') {
          return `Error: '${path}' is a ${data.type}, not a file.`;
        }
        if (!data.content) {
          return `Error: '${path}' has no content (file may be too large for the Content API -- GitHub limit is 1MB).`;
        }
        const fullContent = Buffer.from(data.content, 'base64').toString('utf-8');
        const MAX_LINES = 500;
        const lines = fullContent.split('\n');
        const truncated = lines.length > MAX_LINES;
        const content = truncated ? lines.slice(0, MAX_LINES).join('\n') : fullContent;
        const result: Record<string, unknown> = { path: data.path, size: data.size, sha: data.sha, content };
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

export function createOrUpdateFileTool(owner: string, repo: string, octokit: Octokit) {
  return tool(
    async ({ path, content, message, branch }: { path: string; content: string; message: string; branch: string }) => {
      try {
        console.log(`\u{1F4DD} Committing ${path} to ${branch} in ${owner}/${repo}...`);
        let existingSha: string | undefined;
        try {
          const { data } = await withRetry(() => octokit.rest.repos.getContent({ owner, repo, path, ref: branch }));
          if (!Array.isArray(data) && data.type === 'file') { existingSha = data.sha; }
        } catch (e: unknown) {
          const status = (e as { status?: number }).status;
          if (status !== 404) throw e;
        }
        const { data: result } = await withRetry(() => octokit.rest.repos.createOrUpdateFileContents({
          owner, repo, path, message, content: Buffer.from(content).toString('base64'), branch,
          ...(existingSha ? { sha: existingSha } : {}),
        }));
        return JSON.stringify({ path, sha: result.content?.sha, commit_sha: result.commit.sha, html_url: result.content?.html_url });
      } catch (error) {
        return `Error committing file '${path}': ${error}`;
      }
    },
    {
      name: 'create_or_update_file',
      description: 'Create or update a file on a branch via the GitHub API. Each call creates one commit. Use this to push proposed code changes to a feature branch before opening a PR.',
      schema: z.object({
        path: z.string().describe('File path in the repo (e.g., "README.md", "src/utils.ts")'),
        content: z.string().describe('The full file content to write'),
        message: z.string().describe('Git commit message for this change'),
        branch: z.string().describe('The branch to commit to (e.g., "issue-1-improve-readme")'),
      }),
    }
  );
}

// ── Dry-run wrappers ────────────────────────────────────────────────────────

export function createDryRunCommentTool() {
  return tool(
    async ({ issue_number, body }: { issue_number: number; body: string }) => {
      const preview = body.length > 80 ? body.slice(0, 80) + '...' : body;
      console.log(`DRY RUN -- would comment on issue #${issue_number}: ${preview}`);
      return JSON.stringify({ dry_run: true, id: 0, html_url: `(dry-run) issue #${issue_number} comment`, created_at: new Date().toISOString() });
    },
    { name: 'comment_on_issue', description: 'Post a comment on a GitHub issue. (DRY RUN MODE: will log but not execute)', schema: z.object({ issue_number: z.number().describe('The issue number to comment on'), body: z.string().describe('The comment body (Markdown supported)') }) }
  );
}

export function createDryRunBranchTool() {
  return tool(
    async ({ branch_name, from_branch = 'main' }: { branch_name: string; from_branch?: string }) => {
      console.log(`DRY RUN -- would create branch '${branch_name}' from '${from_branch}'`);
      return JSON.stringify({ dry_run: true, branch: branch_name, sha: '0000000000000000000000000000000000000000', url: `(dry-run) branch ${branch_name}` });
    },
    { name: 'create_branch', description: 'Create a new Git branch in the repository. (DRY RUN MODE: will log but not execute)', schema: z.object({ branch_name: z.string().describe('Name for the new branch'), from_branch: z.string().optional().default('main').describe('Branch to create from (default: main)') }) }
  );
}

export function createDryRunPullRequestTool() {
  return tool(
    async ({ title, body, head, base = 'main' }: { title: string; body: string; head: string; base?: string }) => {
      console.log(`DRY RUN -- would create draft PR '${title}' (${head} -> ${base})`);
      return JSON.stringify({ dry_run: true, number: 0, html_url: `(dry-run) PR: ${title}`, state: 'open', draft: true });
    },
    { name: 'create_pull_request', description: 'Open a draft pull request. (DRY RUN MODE: will log but not execute)', schema: z.object({ title: z.string().describe('PR title'), body: z.string().describe('PR description'), head: z.string().describe('The branch containing changes'), base: z.string().optional().default('main').describe('The branch to merge into (default: main)') }) }
  );
}

export function createDryRunCreateOrUpdateFileTool() {
  return tool(
    async ({ path, content, message, branch }: { path: string; content: string; message: string; branch: string }) => {
      const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
      console.log(`DRY RUN -- would commit ${path} to ${branch}: ${preview}`);
      return JSON.stringify({ dry_run: true, path, sha: '0000000000000000000000000000000000000000', commit_sha: '0000000000000000000000000000000000000000', html_url: `(dry-run) ${path} on ${branch}` });
    },
    { name: 'create_or_update_file', description: 'Create or update a file on a branch. (DRY RUN MODE: will log but not execute)', schema: z.object({ path: z.string().describe('File path in the repo'), content: z.string().describe('The full file content to write'), message: z.string().describe('Git commit message'), branch: z.string().describe('The branch to commit to') }) }
  );
}
