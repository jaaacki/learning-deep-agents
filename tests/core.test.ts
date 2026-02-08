import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  loadPollState,
  savePollState,
  extractProcessedIssues,
  extractIssueActions,
  buildUserMessage,
  buildAnalyzeMessage,
  getMaxIssues,
  getMaxToolCalls,
  migratePollState,
} from '../src/core.js';
import type { IssueActions } from '../src/core.js';

// ── getMaxIssues ──────────────────────────────────────────────────────────────

describe('getMaxIssues', () => {
  it('returns config value when it is a valid positive number', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 10 } as any)).toBe(10);
  });

  it('returns config value of 1 (minimum valid)', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 1 } as any)).toBe(1);
  });

  it('returns default (5) when config value is missing', () => {
    expect(getMaxIssues({} as any)).toBe(5);
  });

  it('returns default when config value is zero', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 0 } as any)).toBe(5);
  });

  it('returns default when config value is negative', () => {
    expect(getMaxIssues({ maxIssuesPerRun: -1 } as any)).toBe(5);
  });

  it('returns default when config value is a string', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 'banana' } as any)).toBe(5);
  });

  it('returns default when config value is null', () => {
    expect(getMaxIssues({ maxIssuesPerRun: null } as any)).toBe(5);
  });

  it('returns default when config value is undefined', () => {
    expect(getMaxIssues({ maxIssuesPerRun: undefined } as any)).toBe(5);
  });
});

// ── getMaxToolCalls ──────────────────────────────────────────────────────────

describe('getMaxToolCalls', () => {
  it('returns config value when it is a valid positive number', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: 50 } as any)).toBe(50);
  });

  it('returns default (30) when config value is missing', () => {
    expect(getMaxToolCalls({} as any)).toBe(30);
  });

  it('returns default when config value is zero', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: 0 } as any)).toBe(30);
  });

  it('returns default when config value is negative', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: -5 } as any)).toBe(30);
  });

  it('returns default when config value is a string', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: 'lots' } as any)).toBe(30);
  });
});

// ── buildUserMessage ──────────────────────────────────────────────────────────

describe('buildUserMessage', () => {
  it('includes the limit in the message', () => {
    const msg = buildUserMessage(3, null, []);
    expect(msg).toContain('limit: 3');
  });

  it('indicates first poll run when sinceDate is null', () => {
    const msg = buildUserMessage(5, null, []);
    expect(msg).toContain('first poll run');
  });

  it('includes sinceDate when provided', () => {
    const msg = buildUserMessage(5, '2026-01-01T00:00:00Z', []);
    expect(msg).toContain('2026-01-01T00:00:00Z');
  });

  it('includes previously processed issue numbers', () => {
    const msg = buildUserMessage(5, '2026-01-01T00:00:00Z', [1, 2, 3]);
    expect(msg).toContain('1, 2, 3');
  });

  it('includes workflow instructions', () => {
    const msg = buildUserMessage(5, null, []);
    expect(msg).toContain('comment_on_issue');
    expect(msg).toContain('create_branch');
    expect(msg).toContain('create_pull_request');
    expect(msg).toContain('write_file');
    expect(msg).toContain('write_todos');
  });
});

// ── buildAnalyzeMessage ───────────────────────────────────────────────────────

describe('buildAnalyzeMessage', () => {
  it('includes the issue number', () => {
    const msg = buildAnalyzeMessage(42);
    expect(msg).toContain('#42');
  });

  it('includes file path with issue number', () => {
    const msg = buildAnalyzeMessage(42);
    expect(msg).toContain('issue_42.md');
  });

  it('includes workflow instructions', () => {
    const msg = buildAnalyzeMessage(1);
    expect(msg).toContain('comment_on_issue');
    expect(msg).toContain('create_branch');
    expect(msg).toContain('create_pull_request');
  });
});

// ── extractProcessedIssues ────────────────────────────────────────────────────

describe('extractProcessedIssues', () => {
  it('returns existing issues when messages are empty', () => {
    const result = extractProcessedIssues([], [1, 2]);
    expect(result).toEqual(expect.arrayContaining([1, 2]));
    expect(result).toHaveLength(2);
  });

  it('extracts issue numbers from tool call arguments', () => {
    const messages = [
      { tool_calls: [{ args: { issue_number: 42 } }] },
    ];
    const result = extractProcessedIssues(messages);
    expect(result).toContain(42);
  });

  it('extracts issue numbers from JSON content', () => {
    const messages = [
      { content: '{"number": 7, "title": "Fix bug"}' },
    ];
    const result = extractProcessedIssues(messages);
    expect(result).toContain(7);
  });

  it('merges tool call and content numbers', () => {
    const messages = [
      { tool_calls: [{ args: { issue_number: 1 } }] },
      { content: '{"number": 2}' },
    ];
    const result = extractProcessedIssues(messages);
    expect(result).toContain(1);
    expect(result).toContain(2);
  });

  it('deduplicates issue numbers', () => {
    const messages = [
      { tool_calls: [{ args: { issue_number: 5 } }] },
      { content: '{"number": 5}' },
    ];
    const result = extractProcessedIssues(messages, [5]);
    expect(result.filter((n) => n === 5)).toHaveLength(1);
  });

  it('handles messages with no tool_calls or content', () => {
    const messages = [{ role: 'assistant' } as any];
    const result = extractProcessedIssues(messages);
    expect(result).toEqual([]);
  });

  it('handles tool_calls without issue_number', () => {
    const messages = [
      { tool_calls: [{ args: { body: 'hello' } }] },
    ];
    const result = extractProcessedIssues(messages);
    expect(result).toEqual([]);
  });
});

// ── loadPollState / savePollState ─────────────────────────────────────────────

describe('loadPollState', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync');
    vi.spyOn(fs, 'readFileSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadPollState()).toBeNull();
  });

  it('returns parsed state when file exists', () => {
    const state = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1, 2, 3],
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
    // migratePollState adds issues field to old-format state (enriched format)
    expect(loadPollState()).toEqual({
      ...state,
      issues: {
        '1': { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null },
        '2': { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null },
        '3': { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null },
      },
    });
  });
});

describe('savePollState', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes JSON state to file', () => {
    const state = {
      lastPollTimestamp: '2026-02-08T12:00:00Z',
      lastPollIssueNumbers: [10, 20],
    };
    savePollState(state);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(JSON.parse(content as string)).toEqual(state);
  });
});

// ── migratePollState ────────────────────────────────────────────────────────

describe('migratePollState', () => {
  it('passes through enriched-format state unchanged', () => {
    const state = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1, 2],
      issues: {
        '1': { comment: { id: 100, html_url: 'https://x' }, branch: { name: 'issue-1-fix', sha: 'abc' }, commits: [], pr: { number: 5, html_url: 'https://y' } },
        '2': { comment: null, branch: null, commits: [], pr: null },
      },
    };
    expect(migratePollState(state)).toEqual(state);
  });

  it('migrates pre-v0.2.10 state (no issues field) to enriched format', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [3, 7],
    };
    const result = migratePollState(old);
    expect(result.issues).toBeDefined();
    expect(result.issues!['3']).toEqual({ comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null });
    expect(result.issues!['7']).toEqual({ comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null });
    expect(result.lastPollIssueNumbers).toEqual([3, 7]);
  });

  it('migrates v0.2.10 boolean format to enriched format', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1, 2],
      issues: {
        '1': { commented: true, branch: 'issue-1-fix', pr: 5 },
        '2': { commented: false, branch: null, pr: null },
      },
    };
    const result = migratePollState(old);
    expect(result.issues!['1']).toEqual({
      comment: { id: 0, html_url: '' },
      branch: { name: 'issue-1-fix', sha: '' },
      commits: [],
      pr: { number: 5, html_url: '' },
    });
    expect(result.issues!['2']).toEqual({
      comment: null, branch: null, commits: [], pr: null,
    });
  });

  it('handles pre-v0.2.10 state with empty issue list', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [],
    };
    const result = migratePollState(old);
    expect(result.issues).toEqual({});
  });

  it('migrates v0.2.10 pr=-1 (attempted) as null in enriched format', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [4],
      issues: {
        '4': { commented: true, branch: null, pr: -1 },
      },
    };
    const result = migratePollState(old);
    expect(result.issues!['4'].pr).toBeNull();
  });
});

// ── extractIssueActions ─────────────────────────────────────────────────────

describe('extractIssueActions', () => {
  it('returns existing actions when messages are empty', () => {
    const existing = { '1': { comment: { id: 10, html_url: 'u' }, branch: null, commits: [], pr: null } };
    const result = extractIssueActions([], existing);
    expect(result).toEqual(existing);
  });

  it('creates empty entry for comment_on_issue call', () => {
    const messages = [
      { tool_calls: [{ name: 'comment_on_issue', args: { issue_number: 3, body: 'analysis' } }] },
    ];
    const result = extractIssueActions(messages);
    // Entry created but no response yet, so comment is still null
    expect(result['3']).toBeDefined();
    expect(result['3'].comment).toBeNull();
  });

  it('creates empty entry for create_branch call', () => {
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'issue-5-fix-login' } }] },
    ];
    const result = extractIssueActions(messages);
    expect(result['5']).toBeDefined();
    expect(result['5'].branch).toBeNull();
  });

  it('creates empty entry for create_pull_request call', () => {
    const messages = [
      { tool_calls: [{ name: 'create_pull_request', args: { title: 'Fix #8', head: 'issue-8-fix', body: 'Closes #8' } }] },
    ];
    const result = extractIssueActions(messages);
    expect(result['8']).toBeDefined();
    expect(result['8'].pr).toBeNull();
  });

  it('preserves existing when merging new tool call entries', () => {
    const existing: Record<string, IssueActions> = {
      '1': { comment: { id: 10, html_url: 'u' }, branch: null, commits: [], pr: null },
    };
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'issue-1-fix' } }] },
    ];
    const result = extractIssueActions(messages, existing);
    expect(result['1'].comment).toEqual({ id: 10, html_url: 'u' }); // preserved
    expect(result['1'].branch).toBeNull(); // pending, no response yet
  });

  it('ignores branch names that do not match issue-N pattern', () => {
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'feature-add-tests' } }] },
    ];
    const result = extractIssueActions(messages);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ── enriched metadata capture ────────────────────────────────────────────────

describe('enriched metadata', () => {
  it('captures comment metadata from response', () => {
    const messages = [
      { tool_calls: [{ name: 'comment_on_issue', args: { issue_number: 3, body: 'hi' } }] },
      { content: JSON.stringify({ id: 100, html_url: 'https://github.com/x/y/issues/3#issuecomment-100', body: 'hi' }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['3'].comment).toEqual({ id: 100, html_url: 'https://github.com/x/y/issues/3#issuecomment-100' });
  });

  it('captures branch metadata from response', () => {
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'issue-5-fix' } }] },
      { content: JSON.stringify({ ref: 'refs/heads/issue-5-fix', object: { sha: 'abc123' } }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['5'].branch).toEqual({ name: 'issue-5-fix', sha: 'abc123' });
  });

  it('captures commit metadata from response', () => {
    const messages = [
      { tool_calls: [{ name: 'create_or_update_file', args: { branch: 'issue-7-fix', path: 'src/foo.ts', content: 'x' } }] },
      { content: JSON.stringify({ content: { path: 'src/foo.ts', sha: 'file-sha' }, commit: { sha: 'commit-sha' } }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['7'].commits).toEqual([{ path: 'src/foo.ts', sha: 'file-sha', commit_sha: 'commit-sha' }]);
  });

  it('captures PR metadata via title match', () => {
    const messages = [
      { tool_calls: [{ name: 'create_pull_request', args: { title: 'Fix #8: bug', head: 'issue-8-fix' } }] },
      { content: JSON.stringify({ number: 42, html_url: 'https://github.com/x/y/pull/42', title: 'Fix #8: bug', draft: true }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['8'].pr).toEqual({ number: 42, html_url: 'https://github.com/x/y/pull/42' });
  });

  it('captures PR metadata via pending state when title does not match', () => {
    const messages = [
      { tool_calls: [{ name: 'create_pull_request', args: { title: 'Some PR', head: 'issue-9-fix' } }] },
      { content: JSON.stringify({ number: 55, html_url: 'https://github.com/x/y/pull/55', title: 'Some PR', draft: true }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['9'].pr).toEqual({ number: 55, html_url: 'https://github.com/x/y/pull/55' });
  });

  it('captures full workflow: comment + branch + commit + PR', () => {
    const messages = [
      { tool_calls: [{ name: 'comment_on_issue', args: { issue_number: 10, body: 'analysis' } }] },
      { content: JSON.stringify({ id: 200, html_url: 'https://c', body: 'analysis' }) },
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'issue-10-fix' } }] },
      { content: JSON.stringify({ ref: 'refs/heads/issue-10-fix', object: { sha: 'bbb' } }) },
      { tool_calls: [{ name: 'create_or_update_file', args: { branch: 'issue-10-fix', path: 'f.ts', content: 'x' } }] },
      { content: JSON.stringify({ content: { path: 'f.ts', sha: 'fs' }, commit: { sha: 'cs' } }) },
      { tool_calls: [{ name: 'create_pull_request', args: { title: 'Fix #10: x', head: 'issue-10-fix' } }] },
      { content: JSON.stringify({ number: 77, html_url: 'https://pr', title: 'Fix #10: x', draft: true }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['10'].comment).toEqual({ id: 200, html_url: 'https://c' });
    expect(result['10'].branch).toEqual({ name: 'issue-10-fix', sha: 'bbb' });
    expect(result['10'].commits).toEqual([{ path: 'f.ts', sha: 'fs', commit_sha: 'cs' }]);
    expect(result['10'].pr).toEqual({ number: 77, html_url: 'https://pr' });
  });

  it('handles skipped comment response', () => {
    const messages = [
      { tool_calls: [{ name: 'comment_on_issue', args: { issue_number: 1 } }] },
      { content: JSON.stringify({ skipped: true, comment_id: 50, existing_comment_url: 'https://skip-c' }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['1'].comment).toEqual({ id: 50, html_url: 'https://skip-c' });
  });

  it('handles skipped branch response', () => {
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'issue-2-fix' } }] },
      { content: JSON.stringify({ skipped: true, branch_url: 'https://skip-b' }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['2'].branch).toEqual({ name: 'issue-2-fix', sha: '' });
  });

  it('handles skipped PR response', () => {
    const messages = [
      { tool_calls: [{ name: 'create_pull_request', args: { head: 'issue-4-fix' } }] },
      { content: JSON.stringify({ skipped: true, pr_number: 99, existing_pr_url: 'https://skip-pr' }) },
    ];
    const result = extractIssueActions(messages);
    expect(result['4'].pr).toEqual({ number: 99, html_url: 'https://skip-pr' });
  });

  it('handles non-JSON content gracefully', () => {
    const messages = [
      { tool_calls: [{ name: 'comment_on_issue', args: { issue_number: 6 } }] },
      { content: 'This is not JSON' },
    ];
    const result = extractIssueActions(messages);
    expect(result['6']).toBeDefined();
    expect(result['6'].comment).toBeNull();
  });

  it('creates empty entry with correct shape', () => {
    const messages = [
      { tool_calls: [{ name: 'comment_on_issue', args: { issue_number: 99 } }] },
    ];
    const result = extractIssueActions(messages);
    expect(result['99']).toEqual({ comment: null, branch: null, commits: [], pr: null });
  });
});

// ── buildUserMessage with action context ────────────────────────────────────

describe('buildUserMessage with issueActions', () => {
  it('includes partial action status in the message', () => {
    const actions: Record<string, IssueActions> = {
      '5': { comment: { id: 1, html_url: 'u' }, branch: null, commits: [], pr: null },
    };
    const msg = buildUserMessage(5, '2026-01-01T00:00:00Z', [5], actions);
    expect(msg).toContain('Issue #5');
    expect(msg).toContain('commented');
    expect(msg).toContain('create branch');
    expect(msg).toContain('open PR');
  });

  it('does not include fully-processed issues in partial list', () => {
    const actions: Record<string, IssueActions> = {
      '3': { comment: { id: 1, html_url: 'u' }, branch: { name: 'issue-3-fix', sha: 's' }, commits: [], pr: { number: 10, html_url: 'p' } },
    };
    const msg = buildUserMessage(5, '2026-01-01T00:00:00Z', [3], actions);
    expect(msg).not.toContain('Partially-processed');
  });

  it('works without issueActions parameter', () => {
    const msg = buildUserMessage(5, null, []);
    expect(msg).toContain('first poll run');
    expect(msg).not.toContain('Partially-processed');
  });
});
