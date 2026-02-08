import fs from 'fs';
import path from 'path';
import type { Config } from './config.js';
import { createDeepAgentWithGitHub } from './agent.js';

/**
 * Polling state -- tracks which issues we have already processed
 * so we do not re-analyze them on subsequent runs.
 */
export interface PollState {
  lastPollTimestamp: string;
  lastPollIssueNumbers: number[];
}

const POLL_STATE_FILE = path.resolve('./last_poll.json');

/**
 * Maximum number of issues to process per run (default).
 * Can be overridden via config.json or --max-issues CLI flag.
 */
const DEFAULT_MAX_ISSUES_PER_RUN = 5;

export function loadPollState(): PollState | null {
  if (!fs.existsSync(POLL_STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf-8'));
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
 * Build the user message for the agent with polling context.
 */
export function buildUserMessage(maxIssues: number, sinceDate: string | null, previousIssues: number[]): string {
  const pollingContext = sinceDate
    ? `Fetch open issues updated since ${sinceDate} (limit: ${maxIssues}) and analyze any new ones. ` +
      `Previously processed issues: ${previousIssues.join(', ')}. ` +
      `Skip those unless they have been updated.`
    : `Fetch open issues (limit: ${maxIssues}) and analyze them. This is the first poll run.`;

  return pollingContext + `

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
 * Run a full poll cycle: fetch new issues, analyze, comment, branch, PR.
 */
export async function runPollCycle(config: Config, options: { dryRun?: boolean; maxIssues?: number } = {}): Promise<void> {
  const maxIssues = options.maxIssues ?? getMaxIssues(config);

  // Ensure the issues/ directory exists for write_file calls
  fs.mkdirSync('./issues', { recursive: true });

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  console.log(`\u{1F6E1}\uFE0F  Max issues per run: ${maxIssues}`);
  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- no write operations will be executed');
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
  const agent = createDeepAgentWithGitHub(config);
  console.log('\u{2705} Agent ready!\n');

  // Build user message
  const userMessage = buildUserMessage(maxIssues, sinceDate, pollState?.lastPollIssueNumbers ?? []);

  // Run the agent
  console.log('\u{1F680} Running agent to analyze GitHub issues...\n');
  console.log('='.repeat(60));

  const result = await agent.invoke({
    messages: [{ role: 'user', content: userMessage }],
  });

  console.log('='.repeat(60));
  console.log('\n\u{2705} Agent completed!\n');

  // Print the final response
  const lastMessage = result.messages[result.messages.length - 1];
  console.log('\u{1F4DD} Agent Response:');
  console.log(lastMessage.content);

  // Extract and save poll state
  const processedNumbers = extractProcessedIssues(
    result.messages,
    pollState?.lastPollIssueNumbers ?? [],
  );

  if (!options.dryRun) {
    savePollState({
      lastPollTimestamp: new Date().toISOString(),
      lastPollIssueNumbers: processedNumbers,
    });
    console.log(`\n\u{1F4BE} Poll state saved to ${POLL_STATE_FILE}`);
  } else {
    console.log(`\n\u{1F9EA} Dry run -- poll state NOT saved`);
  }
  console.log(`   Processed issues: ${processedNumbers.join(', ')}`);
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

  const maxIssues = getMaxIssues(config);
  console.log(`\nMax issues per run: ${maxIssues}`);
}
