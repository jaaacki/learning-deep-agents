import fs from 'fs';
import path from 'path';
import type { Config } from './config.js';
import { createDeepAgentWithGitHub } from './agent.js';
import { CircuitBreakerError } from './github-tools.js';

/**
 * Per-issue action tracking. Records which workflow steps have been
 * completed so the agent can resume partially-processed issues.
 */
export interface IssueActions {
  commented: boolean;
  branch: string | null;
  pr: number | null;
}

/**
 * Polling state -- tracks which issues we have already processed
 * and what actions were taken for each one.
 */
export interface PollState {
  lastPollTimestamp: string;
  lastPollIssueNumbers: number[];
  /** Per-issue action tracking (added in v0.2.10). */
  issues?: Record<string, IssueActions>;
}

const POLL_STATE_FILE = path.resolve('./last_poll.json');

/**
 * Maximum number of issues to process per run (default).
 * Can be overridden via config.json or --max-issues CLI flag.
 */
const DEFAULT_MAX_ISSUES_PER_RUN = 5;

/**
 * Maximum number of tool calls per run (default).
 * Prevents runaway agent loops from burning API credits.
 * Can be overridden via config.json or --max-tool-calls CLI flag.
 */
const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 30;

export function loadPollState(): PollState | null {
  if (!fs.existsSync(POLL_STATE_FILE)) return null;
  const raw = JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf-8'));
  return migratePollState(raw);
}

/**
 * Migrate old poll state format (no `issues` field) to new format.
 * Old format: { lastPollTimestamp, lastPollIssueNumbers }
 * New format: adds `issues` record with empty actions for each known issue.
 */
export function migratePollState(raw: any): PollState {
  if (raw.issues) return raw as PollState;

  // Old format: create stub action records for known issue numbers
  const issues: Record<string, IssueActions> = {};
  for (const num of raw.lastPollIssueNumbers ?? []) {
    issues[String(num)] = { commented: true, branch: null, pr: null };
  }

  return {
    lastPollTimestamp: raw.lastPollTimestamp,
    lastPollIssueNumbers: raw.lastPollIssueNumbers ?? [],
    issues,
  };
}

export function savePollState(state: PollState): void {
  fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Extract issue numbers from the agent's conversation messages.
 * Uses two heuristics: tool call arguments and JSON content parsing.
 */
export function extractProcessedIssues(
  messages: Array<{ tool_calls?: Array<{ args?: Record<string, unknown> }>; content?: unknown }>,
  existing: number[] = [],
): number[] {
  const processedNumbers = new Set<number>(existing);

  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (call.args?.issue_number) {
          processedNumbers.add(call.args.issue_number as number);
        }
      }
    }
    if (typeof msg.content === 'string') {
      const issueMatches = msg.content.matchAll(/"number":\s*(\d+)/g);
      for (const match of issueMatches) {
        processedNumbers.add(parseInt(match[1], 10));
      }
    }
  }

  return [...processedNumbers];
}

/**
 * Extract per-issue action tracking from the agent's conversation messages.
 * Scans tool calls for comment, branch, and PR operations and records
 * which issues they targeted.
 */
export function extractIssueActions(
  messages: Array<{ tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>; content?: unknown }>,
  existing: Record<string, IssueActions> = {},
): Record<string, IssueActions> {
  const actions: Record<string, IssueActions> = { ...existing };

  // Helper to ensure an entry exists for an issue
  function ensureEntry(issueNum: string): IssueActions {
    if (!actions[issueNum]) {
      actions[issueNum] = { commented: false, branch: null, pr: null };
    }
    return actions[issueNum];
  }

  for (const msg of messages) {
    if (!msg.tool_calls) continue;
    for (const call of msg.tool_calls) {
      const args = call.args ?? {};

      if (call.name === 'comment_on_issue' && args.issue_number) {
        const entry = ensureEntry(String(args.issue_number));
        entry.commented = true;
      }

      if (call.name === 'create_branch' && args.branch_name) {
        // Try to extract issue number from branch name pattern: issue-<N>-...
        const branchMatch = String(args.branch_name).match(/^issue-(\d+)/);
        if (branchMatch) {
          const entry = ensureEntry(branchMatch[1]);
          entry.branch = String(args.branch_name);
        }
      }

      if (call.name === 'create_pull_request' && args.head) {
        // Try to extract issue number from head branch pattern
        const headMatch = String(args.head).match(/^issue-(\d+)/);
        if (headMatch) {
          const entry = ensureEntry(headMatch[1]);
          // We don't know the PR number from the tool call args alone,
          // but we know a PR was attempted. Mark with -1 as "attempted".
          if (entry.pr === null) entry.pr = -1;
        }
      }
    }

    // Check tool responses for PR numbers
    if (typeof msg.content === 'string') {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.number && parsed.html_url && parsed.draft !== undefined) {
          // This looks like a PR response. Try to find the issue from the title.
          const titleMatch = String(parsed.title ?? '').match(/Fix #(\d+)/);
          const urlMatch = String(parsed.html_url ?? '').match(/\/pull\/(\d+)/);
          if (titleMatch && urlMatch) {
            const entry = ensureEntry(titleMatch[1]);
            entry.pr = parsed.number;
          }
        }
      } catch {
        // Not JSON, skip
      }
    }
  }

  return actions;
}

/**
 * Build the user message for the agent with polling context.
 */
export function buildUserMessage(
  maxIssues: number,
  sinceDate: string | null,
  previousIssues: number[],
  issueActions?: Record<string, IssueActions>,
): string {
  const pollingContext = sinceDate
    ? `Fetch open issues updated since ${sinceDate} (limit: ${maxIssues}) and analyze any new ones. ` +
      `Previously processed issues: ${previousIssues.join(', ')}. ` +
      `Skip those unless they have been updated.`
    : `Fetch open issues (limit: ${maxIssues}) and analyze them. This is the first poll run.`;

  // Build action status context for partially-processed issues
  let actionContext = '';
  if (issueActions && Object.keys(issueActions).length > 0) {
    const incomplete = Object.entries(issueActions)
      .filter(([, actions]) => !actions.commented || !actions.branch || actions.pr === null)
      .map(([num, actions]) => {
        const done: string[] = [];
        const todo: string[] = [];
        if (actions.commented) done.push('commented'); else todo.push('comment');
        if (actions.branch) done.push(`branch: ${actions.branch}`); else todo.push('create branch');
        if (actions.pr !== null && actions.pr > 0) done.push(`PR #${actions.pr}`); else todo.push('open PR');
        return `  Issue #${num}: done=[${done.join(', ')}] remaining=[${todo.join(', ')}]`;
      });

    if (incomplete.length > 0) {
      actionContext = `\n\nPartially-processed issues from previous runs (resume these first):\n${incomplete.join('\n')}`;
    }
  }

  return pollingContext + actionContext + `

For each new/updated issue:
1. Analyze the issue
2. Post a summary comment on the issue using comment_on_issue
3. Write detailed analysis to ./issues/issue_<number>.md using write_file
4. Create a branch named issue-<number>-<short-description> using create_branch
5. Open a draft PR with title "Fix #<number>: <description>" and body containing "Closes #<number>" using create_pull_request

Use write_todos at the start to plan your approach.`;
}

/**
 * Build a user message for analyzing a single specific issue.
 */
export function buildAnalyzeMessage(issueNumber: number): string {
  return `Fetch issue #${issueNumber} and analyze it thoroughly.

For this issue:
1. Analyze the issue
2. Post a summary comment on the issue using comment_on_issue
3. Write detailed analysis to ./issues/issue_${issueNumber}.md using write_file
4. Create a branch named issue-${issueNumber}-<short-description> using create_branch
5. Open a draft PR with title "Fix #${issueNumber}: <description>" and body containing "Closes #${issueNumber}" using create_pull_request

Use write_todos at the start to plan your approach.`;
}

/**
 * Resolve the effective max issues value from config.
 */
export function getMaxIssues(config: Config): number {
  const raw = config.maxIssuesPerRun;
  return (typeof raw === 'number' && raw > 0) ? raw : DEFAULT_MAX_ISSUES_PER_RUN;
}

/**
 * Resolve the effective max tool calls value from config.
 */
export function getMaxToolCalls(config: Config): number {
  const raw = config.maxToolCallsPerRun;
  return (typeof raw === 'number' && raw > 0) ? raw : DEFAULT_MAX_TOOL_CALLS_PER_RUN;
}

/**
 * Run a full poll cycle: fetch new issues, analyze, comment, branch, PR.
 */
export async function runPollCycle(config: Config, options: { noSave?: boolean; dryRun?: boolean; maxIssues?: number; maxToolCalls?: number } = {}): Promise<void> {
  const maxIssues = options.maxIssues ?? getMaxIssues(config);
  const maxToolCalls = options.maxToolCalls ?? getMaxToolCalls(config);
  // Dry run implies no-save (never persist state when skipping writes)
  const skipSave = options.noSave || options.dryRun;

  // Ensure the issues/ directory exists for write_file calls
  fs.mkdirSync('./issues', { recursive: true });

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  console.log(`\u{1F6E1}\uFE0F  Max issues per run: ${maxIssues}`);
  console.log(`\u{1F6E1}\uFE0F  Max tool calls per run: ${maxToolCalls}`);
  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- GitHub writes (comments, branches, PRs) will be SKIPPED');
    console.log('   Read operations (fetch issues, list files, read files) still execute.');
    console.log('   Local file writes (./issues/) still execute.');
    console.log('   Poll state will NOT be saved.');
  } else if (options.noSave) {
    console.log('\u{1F9EA} NO-SAVE MODE -- poll state will NOT be saved after this run');
    console.log('   NOTE: GitHub operations (comments, branches, PRs) WILL still execute.');
  }
  console.log('');

  // Load polling state
  const pollState = loadPollState();
  const sinceDate = pollState?.lastPollTimestamp ?? null;

  if (sinceDate) {
    console.log(`\u{1F4C5} Last poll: ${sinceDate}`);
    console.log(`\u{1F4CB} Previously processed issues: ${pollState!.lastPollIssueNumbers.join(', ')}\n`);
  } else {
    console.log('\u{1F195} First poll run -- no previous state found.\n');
  }

  // Create agent
  console.log('\u{2699}\uFE0F  Creating Deep Agent...');
  const agent = createDeepAgentWithGitHub(config, { maxIssues, dryRun: options.dryRun, maxToolCalls });
  console.log('\u{2705} Agent ready!\n');

  // Build user message (include action context for partially-processed issues)
  const userMessage = buildUserMessage(
    maxIssues,
    sinceDate,
    pollState?.lastPollIssueNumbers ?? [],
    pollState?.issues,
  );

  // Run the agent
  console.log('\u{1F680} Running agent to analyze GitHub issues...\n');
  console.log('='.repeat(60));

  let result: any;
  let circuitBroken = false;

  try {
    result = await agent.invoke({
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      circuitBroken = true;
      console.log('\n' + '!'.repeat(60));
      console.log(`\u{1F6A8} CIRCUIT BREAKER: ${error.message}`);
      console.log('!'.repeat(60));
      // result stays undefined -- we'll save poll state with what we have
    } else {
      throw error;
    }
  }

  console.log('='.repeat(60));
  console.log(circuitBroken ? '\n\u{26A0}\uFE0F  Agent stopped (circuit breaker).\n' : '\n\u{2705} Agent completed!\n');

  // Print the final response (if we got one)
  if (result) {
    const lastMessage = result.messages[result.messages.length - 1];
    console.log('\u{1F4DD} Agent Response:');
    console.log(lastMessage.content);
  }

  // Extract and save poll state (including per-issue action tracking)
  const processedNumbers = extractProcessedIssues(
    result?.messages ?? [],
    pollState?.lastPollIssueNumbers ?? [],
  );
  const issueActions = extractIssueActions(
    result?.messages ?? [],
    pollState?.issues ?? {},
  );

  if (!skipSave) {
    savePollState({
      lastPollTimestamp: new Date().toISOString(),
      lastPollIssueNumbers: processedNumbers,
      issues: issueActions,
    });
    console.log(`\n\u{1F4BE} Poll state saved to ${POLL_STATE_FILE}`);
  } else {
    console.log(`\n\u{1F9EA} ${options.dryRun ? 'Dry run' : 'No-save'} mode -- poll state NOT saved`);
  }
  console.log(`   Processed issues: ${processedNumbers.join(', ')}`);

  // Exit with error code if circuit breaker tripped (useful for cron monitoring)
  if (circuitBroken) {
    process.exit(2);
  }
}

/**
 * Analyze a single specific issue by number.
 */
export async function runAnalyzeSingle(config: Config, issueNumber: number): Promise<void> {
  fs.mkdirSync('./issues', { recursive: true });

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  console.log(`\u{1F50D} Analyzing issue #${issueNumber}\n`);

  const agent = createDeepAgentWithGitHub(config);
  const userMessage = buildAnalyzeMessage(issueNumber);

  console.log('='.repeat(60));

  const result = await agent.invoke({
    messages: [{ role: 'user', content: userMessage }],
  });

  console.log('='.repeat(60));
  console.log('\n\u{2705} Analysis completed!\n');

  const lastMessage = result.messages[result.messages.length - 1];
  console.log('\u{1F4DD} Agent Response:');
  console.log(lastMessage.content);
}

/**
 * Show current polling status (last run time, processed issues).
 */
export function showStatus(config: Config): void {
  console.log(`\u{1F4CA} Status for ${config.github.owner}/${config.github.repo}\n`);

  const pollState = loadPollState();

  if (!pollState) {
    console.log('No poll state found. Run `deepagents poll` to start.');
    return;
  }

  console.log(`Last poll: ${pollState.lastPollTimestamp}`);
  console.log(`Processed issues: ${pollState.lastPollIssueNumbers.length}`);

  if (pollState.lastPollIssueNumbers.length > 0) {
    console.log(`Issue numbers: ${pollState.lastPollIssueNumbers.join(', ')}`);
  }

  // Show per-issue action tracking
  if (pollState.issues && Object.keys(pollState.issues).length > 0) {
    console.log('\nPer-issue actions:');
    for (const [num, actions] of Object.entries(pollState.issues)) {
      const status: string[] = [];
      status.push(actions.commented ? 'commented' : 'no comment');
      status.push(actions.branch ? `branch: ${actions.branch}` : 'no branch');
      status.push(actions.pr !== null ? `PR #${actions.pr}` : 'no PR');
      console.log(`  #${num}: ${status.join(', ')}`);
    }
  }

  const maxIssues = getMaxIssues(config);
  const maxToolCalls = getMaxToolCalls(config);
  console.log(`\nMax issues per run: ${maxIssues}`);
  console.log(`Max tool calls per run: ${maxToolCalls}`);
}
