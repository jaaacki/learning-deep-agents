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
  requestShutdown,
  isShuttingDown,
  resetShutdown,
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
    // migratePollState adds issues field to old-format state
    expect(loadPollState()).toEqual({
      ...state,
      issues: {
        '1': { commented: true, branch: null, pr: null },
        '2': { commented: true, branch: null, pr: null },
        '3': { commented: true, branch: null, pr: null },
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
  it('passes through new-format state unchanged', () => {
    const state = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1, 2],
      issues: {
        '1': { commented: true, branch: 'issue-1-fix', pr: 5 },
        '2': { commented: true, branch: null, pr: null },
      },
    };
    expect(migratePollState(state)).toEqual(state);
  });

  it('migrates old-format state to new format with stub actions', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [3, 7],
    };
    const result = migratePollState(old);
    expect(result.issues).toBeDefined();
    expect(result.issues!['3']).toEqual({ commented: true, branch: null, pr: null });
    expect(result.issues!['7']).toEqual({ commented: true, branch: null, pr: null });
    expect(result.lastPollIssueNumbers).toEqual([3, 7]);
  });

  it('handles old state with empty issue list', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [],
    };
    const result = migratePollState(old);
    expect(result.issues).toEqual({});
  });
});

// ── extractIssueActions ─────────────────────────────────────────────────────

describe('extractIssueActions', () => {
  it('returns existing actions when messages are empty', () => {
    const existing = { '1': { commented: true, branch: 'b', pr: 5 } };
    const result = extractIssueActions([], existing);
    expect(result).toEqual(existing);
  });

  it('tracks comment_on_issue calls', () => {
    const messages = [
      { tool_calls: [{ name: 'comment_on_issue', args: { issue_number: 3, body: 'analysis' } }] },
    ];
    const result = extractIssueActions(messages);
    expect(result['3'].commented).toBe(true);
  });

  it('tracks create_branch calls and extracts issue number from branch name', () => {
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'issue-5-fix-login' } }] },
    ];
    const result = extractIssueActions(messages);
    expect(result['5'].branch).toBe('issue-5-fix-login');
  });

  it('tracks create_pull_request calls', () => {
    const messages = [
      { tool_calls: [{ name: 'create_pull_request', args: { title: 'Fix #8', head: 'issue-8-fix', body: 'Closes #8' } }] },
    ];
    const result = extractIssueActions(messages);
    expect(result['8'].pr).toBe(-1); // -1 = attempted (PR number not known from call args)
  });

  it('merges new actions with existing actions', () => {
    const existing: Record<string, IssueActions> = {
      '1': { commented: true, branch: null, pr: null },
    };
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'issue-1-fix' } }] },
    ];
    const result = extractIssueActions(messages, existing);
    expect(result['1'].commented).toBe(true); // preserved from existing
    expect(result['1'].branch).toBe('issue-1-fix'); // added from new message
  });

  it('ignores branch names that do not match issue-N pattern', () => {
    const messages = [
      { tool_calls: [{ name: 'create_branch', args: { branch_name: 'feature-add-tests' } }] },
    ];
    const result = extractIssueActions(messages);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ── buildUserMessage with action context ────────────────────────────────────

describe('buildUserMessage with issueActions', () => {
  it('includes partial action status in the message', () => {
    const actions: Record<string, IssueActions> = {
      '5': { commented: true, branch: null, pr: null },
    };
    const msg = buildUserMessage(5, '2026-01-01T00:00:00Z', [5], actions);
    expect(msg).toContain('Issue #5');
    expect(msg).toContain('commented');
    expect(msg).toContain('create branch');
    expect(msg).toContain('open PR');
  });

  it('does not include fully-processed issues in partial list', () => {
    const actions: Record<string, IssueActions> = {
      '3': { commented: true, branch: 'issue-3-fix', pr: 10 },
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

// ── Graceful shutdown ─────────────────────────────────────────────────────────

describe('graceful shutdown', () => {
  afterEach(() => {
    resetShutdown();
  });

  it('isShuttingDown returns false by default', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('requestShutdown sets the flag to true', () => {
    requestShutdown();
    expect(isShuttingDown()).toBe(true);
  });

  it('resetShutdown clears the flag', () => {
    requestShutdown();
    expect(isShuttingDown()).toBe(true);
    resetShutdown();
    expect(isShuttingDown()).toBe(false);
  });

  it('multiple requestShutdown calls are idempotent', () => {
    requestShutdown();
    requestShutdown();
    requestShutdown();
    expect(isShuttingDown()).toBe(true);
    resetShutdown();
    expect(isShuttingDown()).toBe(false);
  });
});
