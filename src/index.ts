import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { createDeepAgentWithGitHub } from './agent.js';

/**
 * Polling state -- tracks which issues we have already processed
 * so we do not re-analyze them on subsequent runs.
 */
interface PollState {
  lastPollTimestamp: string;
  lastPollIssueNumbers: number[];
}

const POLL_STATE_FILE = path.resolve('./last_poll.json');

function loadPollState(): PollState | null {
  if (!fs.existsSync(POLL_STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf-8'));
}

function savePollState(state: PollState): void {
  fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Maximum number of issues to process per run.
 * Prevents runaway API usage and LLM token costs.
 * Can be overridden via config.json: { "maxIssuesPerRun": 10 }
 */
const DEFAULT_MAX_ISSUES_PER_RUN = 5;

/**
 * Main entry point - Poll GitHub issues and analyze them
 */
async function main() {
  console.log('\u{1F916} Deep Agents GitHub Issue Poller\n');

  // Ensure the issues/ directory exists for write_file calls
  fs.mkdirSync('./issues', { recursive: true });

  // Load config
  const config = loadConfig();
  const maxIssues: number = config.maxIssuesPerRun ?? DEFAULT_MAX_ISSUES_PER_RUN;
  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  console.log(`\u{1F6E1}\uFE0F  Max issues per run: ${maxIssues}\n`);

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

  // Build user message with polling context
  const pollingContext = sinceDate
    ? `Fetch open issues updated since ${sinceDate} (limit: ${maxIssues}) and analyze any new ones. ` +
      `Previously processed issues: ${pollState!.lastPollIssueNumbers.join(', ')}. ` +
      `Skip those unless they have been updated.`
    : `Fetch open issues (limit: ${maxIssues}) and analyze them. This is the first poll run.`;

  const userMessage = pollingContext + `

For each new/updated issue:
1. Analyze the issue
2. Post a summary comment on the issue using comment_on_issue
3. Write detailed analysis to ./issues/issue_<number>.md using write_file
4. Create a branch named issue-<number>-<short-description> using create_branch
5. Open a draft PR with title "Fix #<number>: <description>" and body containing "Closes #<number>" using create_pull_request

Use write_todos at the start to plan your approach.`;

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

  // Extract issue numbers from the agent's response
  // Look for issue numbers mentioned in tool calls throughout the conversation
  const processedNumbers = new Set<number>(pollState?.lastPollIssueNumbers ?? []);

  for (const msg of result.messages) {
    // Check tool calls for issue_number arguments and fetch results
    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (call.args?.issue_number) {
          processedNumbers.add(call.args.issue_number);
        }
      }
    }
    // Also check tool results that contain issue data
    if (typeof msg.content === 'string') {
      const issueMatches = msg.content.matchAll(/"number":\s*(\d+)/g);
      for (const match of issueMatches) {
        processedNumbers.add(parseInt(match[1], 10));
      }
    }
  }

  // Save updated poll state
  savePollState({
    lastPollTimestamp: new Date().toISOString(),
    lastPollIssueNumbers: [...processedNumbers],
  });

  console.log(`\n\u{1F4BE} Poll state saved to ${POLL_STATE_FILE}`);
  console.log(`   Processed issues: ${[...processedNumbers].join(', ')}`);
}

main().catch((error) => {
  console.error('\u{274C} Error:', error);
  process.exit(1);
});
