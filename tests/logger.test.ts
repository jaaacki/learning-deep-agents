import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wrapWithLogging } from '../src/logger.js';
import {
  createDryRunBranchTool,
  createDryRunCommentTool,
  ToolCallCounter,
} from '../src/github-tools.js';

// ── wrapWithLogging ──────────────────────────────────────────────────────────

describe('wrapWithLogging', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('logs tool name, arguments, and duration on success', async () => {
    const tool = wrapWithLogging(createDryRunBranchTool());

    await tool.invoke({ branch_name: 'issue-1-fix' });

    expect(consoleSpy).toHaveBeenCalledTimes(2); // dry-run tool logs + our log
    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    expect(ourLog).toBeDefined();
    expect(ourLog).toContain('create_branch');
    expect(ourLog).toContain('issue-1-fix');
    expect(ourLog).toMatch(/\d+ms/);
  });

  it('includes count label when ToolCallCounter is provided', async () => {
    const counter = new ToolCallCounter(10);
    const tool = wrapWithLogging(createDryRunBranchTool(), counter);

    await tool.invoke({ branch_name: 'test-branch' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    expect(ourLog).toContain('#1/10');
  });

  it('omits count label when no counter is provided', async () => {
    const tool = wrapWithLogging(createDryRunBranchTool());

    await tool.invoke({ branch_name: 'test-branch' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    // Should have "TOOL |" without a count
    expect(ourLog).toMatch(/TOOL \|/);
    expect(ourLog).not.toMatch(/#\d+\/\d+/);
  });

  it('increments count label on successive calls', async () => {
    const counter = new ToolCallCounter(10);
    const tool = wrapWithLogging(createDryRunBranchTool(), counter);

    // Note: counter is not wrapped with circuit breaker, so it won't increment on its own.
    // wrapWithLogging reads the counter but does NOT increment it.
    // In production, the circuit breaker wrapper increments the counter.
    // For this test, we manually increment to simulate.
    counter.increment('create_branch');
    await tool.invoke({ branch_name: 'first' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    // After 1 manual increment, getCount() = 1, so next label = #2/10
    expect(ourLog).toContain('#2/10');
  });

  it('logs errors to console.error and re-throws', async () => {
    const tool = createDryRunBranchTool();
    const originalInvoke = tool.invoke.bind(tool);

    // Make the tool throw
    tool.invoke = async () => {
      throw new Error('API exploded');
    };

    const logged = wrapWithLogging(tool);

    await expect(logged.invoke({ branch_name: 'err' })).rejects.toThrow('API exploded');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const errLog = consoleErrorSpy.mock.calls[0][0];
    expect(errLog).toContain('ERROR');
    expect(errLog).toContain('API exploded');
    expect(errLog).toContain('create_branch');

    // Restore for other tests
    tool.invoke = originalInvoke;
  });

  it('includes timestamp in HH:MM:SS format', async () => {
    const tool = wrapWithLogging(createDryRunCommentTool());

    await tool.invoke({ issue_number: 5, body: 'test' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    // Match [HH:MM:SS] pattern
    expect(ourLog).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it('preserves the tool name after wrapping', () => {
    const tool = wrapWithLogging(createDryRunBranchTool());
    expect(tool.name).toBe('create_branch');
  });

  it('returns the original tool result', async () => {
    const tool = wrapWithLogging(createDryRunBranchTool());
    const result = JSON.parse(await tool.invoke({ branch_name: 'test' }));

    expect(result.dry_run).toBe(true);
    expect(result.branch).toBe('test');
  });

  it('works with multiple tools sharing a counter', async () => {
    const counter = new ToolCallCounter(20);
    const branchTool = wrapWithLogging(createDryRunBranchTool(), counter);
    const commentTool = wrapWithLogging(createDryRunCommentTool(), counter);

    await branchTool.invoke({ branch_name: 'b1' });
    await commentTool.invoke({ issue_number: 1, body: 'hi' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const toolLogs = logCalls.filter((msg: string) => msg.includes('TOOL'));
    // Both should show count out of 20
    expect(toolLogs[0]).toContain('/20');
    expect(toolLogs[1]).toContain('/20');
  });
});
