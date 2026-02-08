import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCommentOnIssueTool,
  createBranchTool,
  createPullRequestTool,
  createGitHubIssuesTool,
  createListRepoFilesTool,
  createReadRepoFileTool,
} from '../src/github-tools.js';

/**
 * Mock Octokit factory.
 * Returns an object matching the shape used by the tool functions.
 */
function createMockOctokit(overrides: Record<string, any> = {}) {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn(),
        listComments: vi.fn(),
        createComment: vi.fn(),
      },
      git: {
        getRef: vi.fn(),
        getCommit: vi.fn(),
        getTree: vi.fn(),
        createRef: vi.fn(),
      },
      pulls: {
        list: vi.fn(),
        create: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
      },
      ...overrides,
    },
  } as any;
}

// ── Comment idempotency ───────────────────────────────────────────────────────

describe('createCommentOnIssueTool (idempotency)', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('skips when marker comment already exists', async () => {
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { body: '<!-- deep-agent-analysis -->\nSome analysis here' },
      ],
    });

    const toolFn = createCommentOnIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ issue_number: 1, body: 'New analysis' }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already exists');
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('posts comment when no marker found', async () => {
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ body: 'Regular comment without marker' }],
    });
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { id: 123, html_url: 'https://github.com/owner/repo/issues/1#issuecomment-123', created_at: '2026-02-08' },
    });

    const toolFn = createCommentOnIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ issue_number: 1, body: 'Analysis' }));

    expect(result.skipped).toBeUndefined();
    expect(result.id).toBe(123);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    // Verify the marker is prepended to the body
    const callArgs = octokit.rest.issues.createComment.mock.calls[0][0];
    expect(callArgs.body).toContain('<!-- deep-agent-analysis -->');
  });

  it('posts comment when comments list is empty', async () => {
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { id: 456, html_url: 'https://github.com/owner/repo/issues/2#issuecomment-456', created_at: '2026-02-08' },
    });

    const toolFn = createCommentOnIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ issue_number: 2, body: 'Analysis' }));

    expect(result.id).toBe(456);
  });
});

// ── Branch idempotency ────────────────────────────────────────────────────────

describe('createBranchTool (idempotency)', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('skips when branch already exists', async () => {
    // First getRef call (existence check) succeeds -- branch exists
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'abc123' } },
    });

    const toolFn = createBranchTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ branch_name: 'issue-1-fix' }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already exists');
    expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
  });

  it('creates branch when it does not exist (404)', async () => {
    // First getRef call (existence check) throws 404
    octokit.rest.git.getRef.mockRejectedValueOnce({ status: 404 });
    // Second getRef call (get source branch SHA) succeeds
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'main-sha-123' } },
    });
    octokit.rest.git.createRef.mockResolvedValue({});

    const toolFn = createBranchTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ branch_name: 'issue-2-new', from_branch: 'main' }));

    expect(result.skipped).toBeUndefined();
    expect(result.branch).toBe('issue-2-new');
    expect(result.sha).toBe('main-sha-123');
    expect(octokit.rest.git.createRef).toHaveBeenCalledTimes(1);
  });

  it('re-throws non-404 errors from existence check', async () => {
    octokit.rest.git.getRef.mockRejectedValueOnce({ status: 500 });

    const toolFn = createBranchTool('owner', 'repo', octokit);
    const result = await toolFn.invoke({ branch_name: 'issue-3-err' });

    // Should return an error string (tool catch block)
    expect(result).toContain('Error creating branch');
  });
});

// ── PR idempotency ────────────────────────────────────────────────────────────

describe('createPullRequestTool (idempotency)', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('skips when open PR exists for the same head branch', async () => {
    octokit.rest.pulls.list.mockResolvedValue({
      data: [{ number: 10, html_url: 'https://github.com/owner/repo/pull/10' }],
    });

    const toolFn = createPullRequestTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({
      title: 'Fix #1',
      body: 'Closes #1',
      head: 'issue-1-fix',
    }));

    expect(result.skipped).toBe(true);
    expect(result.number).toBe(10);
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
  });

  it('creates PR when no existing open PR found', async () => {
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 11, html_url: 'https://github.com/owner/repo/pull/11', state: 'open', draft: true },
    });

    const toolFn = createPullRequestTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({
      title: 'Fix #2',
      body: 'Closes #2',
      head: 'issue-2-fix',
    }));

    expect(result.number).toBe(11);
    expect(result.draft).toBe(true);
    expect(octokit.rest.pulls.create).toHaveBeenCalledTimes(1);
    // Verify draft: true is passed
    const callArgs = octokit.rest.pulls.create.mock.calls[0][0];
    expect(callArgs.draft).toBe(true);
  });

  it('uses owner:head format for the head parameter in list', async () => {
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 12, html_url: 'url', state: 'open', draft: true },
    });

    const toolFn = createPullRequestTool('myorg', 'repo', octokit);
    await toolFn.invoke({ title: 'T', body: 'B', head: 'my-branch' });

    const listArgs = octokit.rest.pulls.list.mock.calls[0][0];
    expect(listArgs.head).toBe('myorg:my-branch');
  });
});

// ── Fetch issues ──────────────────────────────────────────────────────────────

describe('createGitHubIssuesTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns formatted issues', async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 1,
          title: 'Bug report',
          body: 'Something is broken',
          state: 'open',
          created_at: '2026-01-01',
          updated_at: '2026-02-01',
          html_url: 'https://github.com/owner/repo/issues/1',
          labels: [{ name: 'bug' }],
        },
      ],
    });

    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ state: 'open', limit: 5 }));

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].title).toBe('Bug report');
    expect(result[0].labels).toEqual(['bug']);
  });

  it('passes since parameter when provided', async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit);
    await toolFn.invoke({ since: '2026-01-01T00:00:00Z' });

    const callArgs = octokit.rest.issues.listForRepo.mock.calls[0][0];
    expect(callArgs.since).toBe('2026-01-01T00:00:00Z');
  });

  it('returns error string on API failure', async () => {
    octokit.rest.issues.listForRepo.mockRejectedValue(new Error('API rate limited'));

    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit);
    const result = await toolFn.invoke({ state: 'open' });

    expect(result).toContain('Error fetching issues');
    expect(result).toContain('API rate limited');
  });
});

// ── Read repo file (truncation) ───────────────────────────────────────────────

describe('createReadRepoFileTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns file content decoded from base64', async () => {
    const content = 'Hello, world!';
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'README.md',
        size: content.length,
        sha: 'abc',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'README.md' }));

    expect(result.content).toBe('Hello, world!');
    expect(result.path).toBe('README.md');
  });

  it('truncates files over 500 lines', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'big.ts',
        size: content.length,
        sha: 'def',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'big.ts' }));

    expect(result.truncated).toBe(true);
    expect(result.total_lines).toBe(600);
    expect(result.shown_lines).toBe(500);
    expect(result.content.split('\n')).toHaveLength(500);
  });

  it('returns error for directories', async () => {
    octokit.rest.repos.getContent.mockResolvedValue({
      data: [{ name: 'file1.ts' }, { name: 'file2.ts' }],
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = await toolFn.invoke({ path: 'src' });

    expect(result).toContain('directory');
  });
});
