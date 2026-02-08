import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createGetPrDiffTool,
  createSubmitPrReviewTool,
  BOT_REVIEW_MARKER,
} from '../src/github-tools.js';

/**
 * Mock Octokit factory for reviewer tools.
 */
function createMockOctokit(overrides: Record<string, any> = {}) {
  return {
    rest: {
      pulls: {
        get: vi.fn(),
        listReviews: vi.fn(),
        createReview: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
      },
      ...overrides,
    },
  } as any;
}

// ── get_pr_diff ──────────────────────────────────────────────────────────────

describe('createGetPrDiffTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns the diff string for a PR', async () => {
    const diffText = 'diff --git a/src/index.ts b/src/index.ts\n+console.log("hello");\n';
    octokit.rest.pulls.get.mockResolvedValue({ data: diffText });

    const toolFn = createGetPrDiffTool(octokit, 'owner', 'repo');
    const result = await toolFn.invoke({ pull_number: 42 });

    expect(result).toBe(diffText);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 42,
      mediaType: { format: 'diff' },
    });
  });

  it('truncates very large diffs', async () => {
    const largeDiff = 'x'.repeat(60000);
    octokit.rest.pulls.get.mockResolvedValue({ data: largeDiff });

    const toolFn = createGetPrDiffTool(octokit, 'owner', 'repo');
    const result = await toolFn.invoke({ pull_number: 1 });

    expect(result.length).toBeLessThan(largeDiff.length);
    expect(result).toContain('truncated');
    expect(result).toContain('50000');
  });

  it('returns error string on API failure', async () => {
    octokit.rest.pulls.get.mockRejectedValue(new Error('Not found'));

    const toolFn = createGetPrDiffTool(octokit, 'owner', 'repo');
    const result = await toolFn.invoke({ pull_number: 999 });

    expect(result).toContain('Error fetching diff');
    expect(result).toContain('999');
  });

  it('returns the full diff when under the limit', async () => {
    const smallDiff = 'diff --git a/file.ts b/file.ts\n- old\n+ new\n';
    octokit.rest.pulls.get.mockResolvedValue({ data: smallDiff });

    const toolFn = createGetPrDiffTool(octokit, 'owner', 'repo');
    const result = await toolFn.invoke({ pull_number: 5 });

    expect(result).toBe(smallDiff);
    expect(result).not.toContain('truncated');
  });
});

// ── submit_pr_review ─────────────────────────────────────────────────────────

describe('createSubmitPrReviewTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('submits a review with COMMENT event', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 100, html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-100', state: 'COMMENTED' },
    });

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = JSON.parse(await toolFn.invoke({ pull_number: 1, body: 'Looks good!' }));

    expect(result.id).toBe(100);
    expect(result.state).toBe('COMMENTED');
    expect(result.pull_number).toBe(1);

    // Verify the call uses COMMENT event
    const callArgs = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(callArgs.event).toBe('COMMENT');
  });

  it('always forces event to COMMENT regardless of input', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 101, html_url: 'url', state: 'COMMENTED' },
    });

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    await toolFn.invoke({ pull_number: 1, body: 'LGTM' });

    // Even though we only pass body (no event field in schema), verify COMMENT is set
    const callArgs = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(callArgs.event).toBe('COMMENT');
    // Verify it's not APPROVE or REQUEST_CHANGES
    expect(callArgs.event).not.toBe('APPROVE');
    expect(callArgs.event).not.toBe('REQUEST_CHANGES');
  });

  it('appends the bot marker and footer to the body', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 102, html_url: 'url', state: 'COMMENTED' },
    });

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    await toolFn.invoke({ pull_number: 1, body: 'Review text' });

    const callArgs = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(callArgs.body).toContain(BOT_REVIEW_MARKER);
    expect(callArgs.body).toContain('automated review');
    expect(callArgs.body).toContain('human should verify');
  });

  it('skips when a bot review already exists (idempotency)', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        { body: `${BOT_REVIEW_MARKER}\nPrevious review`, state: 'COMMENTED' },
      ],
    });

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = JSON.parse(await toolFn.invoke({ pull_number: 1, body: 'New review' }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already exists');
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('posts review when no previous bot review exists', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        { body: 'Human review here', state: 'APPROVED' },
      ],
    });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 103, html_url: 'url', state: 'COMMENTED' },
    });

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = JSON.parse(await toolFn.invoke({ pull_number: 1, body: 'Bot review' }));

    expect(result.skipped).toBeUndefined();
    expect(result.id).toBe(103);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it('includes inline comments when provided', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 104, html_url: 'url', state: 'COMMENTED' },
    });

    const comments = [
      { path: 'src/index.ts', line: 10, body: 'Consider error handling here' },
      { path: 'src/utils.ts', line: 25, body: 'This could be simplified' },
    ];

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    await toolFn.invoke({ pull_number: 1, body: 'Review with comments', comments });

    const callArgs = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(callArgs.comments).toHaveLength(2);
    expect(callArgs.comments[0].path).toBe('src/index.ts');
    expect(callArgs.comments[0].line).toBe(10);
    expect(callArgs.comments[1].path).toBe('src/utils.ts');
  });

  it('submits review without inline comments when not provided', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 105, html_url: 'url', state: 'COMMENTED' },
    });

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    await toolFn.invoke({ pull_number: 1, body: 'Just a summary' });

    const callArgs = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(callArgs.comments).toBeUndefined();
  });

  it('returns error string on API failure', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockRejectedValue(new Error('Validation failed'));

    const toolFn = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = await toolFn.invoke({ pull_number: 1, body: 'Review' });

    expect(result).toContain('Error submitting review');
    expect(result).toContain('Validation failed');
  });
});

// Note: Integration tests for handlePullRequestEvent with the reviewer agent
// are in tests/listener.test.ts. The unit tests above cover the tools independently.
