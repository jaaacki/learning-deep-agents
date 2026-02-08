import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  loadPollState,
  savePollState,
  extractProcessedIssues,
  buildUserMessage,
  buildAnalyzeMessage,
  getMaxIssues,
} from '../src/core.js';

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
    expect(loadPollState()).toEqual(state);
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
