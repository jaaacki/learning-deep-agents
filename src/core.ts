import fs from 'fs';
import path from 'path';
import type { Config } from './config.js';
import { createDeepAgentWithGitHub } from './agent.js';
import { CircuitBreakerError, createGitHubClient } from './github-tools.js';
import { withRetry } from './utils.js';
import { runTriage } from './triage-agent.js';
import type { TriageOutput } from './triage-agent.js';

// ── Graceful shutdown ────────────────────────────────────────────────────────

/**
 * When true, the poll cycle will finish its current issue and exit cleanly
 * instead of picking up the next issue. Set by SIGTERM/SIGINT handlers.
 */
let shuttingDown = false;

export function requestShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Reset shutdown flag. Used in tests to restore clean state.
 */
export function resetShutdown(): void {
  shuttingDown = false;
}

/**
 * Per-issue action tracking. Records which workflow steps have been
 * completed so the agent can resume partially-processed issues.
 * v0.3.4: enriched with full response metadata for retraction capability.
 */
export interface IssueActions {
  comment: { id: number; html_url: string } | null;
  branch: { name: string; sha: string } | null;
  commits: Array<{ path: string; sha: string; commit_sha: string }>;
  pr: { number: number; html_url: string } | null;
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
  /** Per-issue triage results (added in v0.3.8). Passed to the analysis agent as context. */
  triageResults?: Record<string, TriageOutput>;
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
 * Check if an issue actions entry uses the old v0.2.10 boolean format.
 */
function isOldActionFormat(entry: any): boolean {
  return typeof entry.commented === 'boolean';
}

/**
 * Migrate a single v0.2.10 boolean action entry to the enriched format.
 */
function migrateActionEntry(old: any): IssueActions {
  return {
    comment: old.commented ? { id: 0, html_url: '' } : null,
    branch: old.branch ? { name: old.branch, sha: '' } : null,
    commits: [],
    pr: (old.pr !== null && old.pr > 0) ? { number: old.pr, html_url: '' } : null,
  };
}

/**
 * Migrate poll state across 3 format generations:
 *   Case 1: pre-v0.2.10 — no `issues` field at all
 *   Case 2: v0.2.10 — `issues` with boolean format { commented, branch, pr }
 *   Case 3: v0.3.4+ — enriched format { comment, branch, commits, pr }
 */
export function migratePollState(raw: any): PollState {
  // Case 1: pre-v0.2.10 — no issues field
  if (!raw.issues) {
    const issues: Record<string, IssueActions> = {};
    for (const num of raw.lastPollIssueNumbers ?? []) {
      issues[String(num)] = { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null };
    }
    return {
      lastPollTimestamp: raw.lastPollTimestamp,
      lastPollIssueNumbers: raw.lastPollIssueNumbers ?? [],
      issues,
    };
  }

  // Case 2: v0.2.10 boolean format
  const entries = Object.values(raw.issues);
  if (entries.length > 0 && isOldActionFormat(entries[0])) {
    const migrated: Record<string, IssueActions> = {};
    for (const [num, entry] of Object.entries(raw.issues)) {
      migrated[num] = migrateActionEntry(entry);
    }
    return {
      lastPollTimestamp: raw.lastPollTimestamp,
      lastPollIssueNumbers: raw.lastPollIssueNumbers ?? [],
      issues: migrated,
    };
  }

  // Case 3: already enriched format
  return raw as PollState;
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
 * Correlates tool calls with their responses to capture full metadata
 * (comment IDs, branch SHAs, file SHAs, PR numbers/URLs).
 */
export function extractIssueActions(
  messages: Array<{ tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>; content?: unknown }>,
  existing: Record<string, IssueActions> = {},
): Record<string, IssueActions> {
  const actions: Record<string, IssueActions> = { ...existing };

  function ensureEntry(issueNum: string): IssueActions {
    if (!actions[issueNum]) {
      actions[issueNum] = { comment: null, branch: null, commits: [], pr: null };
    }
    return actions[issueNum];
  }

  let pendingCommentIssue: string | null = null;
  let pendingBranchIssue: string | null = null;
  let pendingBranchName: string | null = null;
  let pendingCommitIssue: string | null = null;
  let pendingPrIssue: string | null = null;

  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        const args = call.args ?? {};

        if (call.name === 'comment_on_issue' && args.issue_number) {
          pendingCommentIssue = String(args.issue_number);
          ensureEntry(pendingCommentIssue);
        }

        if (call.name === 'create_branch' && args.branch_name) {
          const branchMatch = String(args.branch_name).match(/^issue-(\d+)/);
          if (branchMatch) {
            pendingBranchIssue = branchMatch[1];
            pendingBranchName = String(args.branch_name);
            ensureEntry(pendingBranchIssue);
          }
        }

        if (call.name === 'create_or_update_file' && args.branch) {
          const branchMatch = String(args.branch).match(/^issue-(\d+)/);
          if (branchMatch) {
            pendingCommitIssue = branchMatch[1];
            ensureEntry(pendingCommitIssue);
          }
        }

        if (call.name === 'create_pull_request' && args.head) {
          const headMatch = String(args.head).match(/^issue-(\d+)/);
          if (headMatch) {
            pendingPrIssue = headMatch[1];
            ensureEntry(pendingPrIssue);
          }
        }
      }
    }

    if (typeof msg.content === 'string') {
      try {
        const parsed = JSON.parse(msg.content);

        if (pendingCommentIssue && parsed.id && parsed.html_url && typeof parsed.body === 'string') {
          ensureEntry(pendingCommentIssue).comment = { id: parsed.id, html_url: parsed.html_url };
          pendingCommentIssue = null;
        }

        if (pendingBranchIssue && pendingBranchName && parsed.ref && parsed.object?.sha) {
          ensureEntry(pendingBranchIssue).branch = { name: pendingBranchName, sha: parsed.object.sha };
          pendingBranchIssue = null;
          pendingBranchName = null;
        }

        if (pendingCommitIssue && parsed.content?.sha && parsed.commit?.sha) {
          ensureEntry(pendingCommitIssue).commits.push({
            path: parsed.content.path ?? '',
            sha: parsed.content.sha,
            commit_sha: parsed.commit.sha,
          });
          pendingCommitIssue = null;
        }

        if (parsed.number && parsed.html_url && parsed.draft !== undefined) {
          const titleMatch = String(parsed.title ?? '').match(/Fix #(\d+)/);
          if (titleMatch) {
            ensureEntry(titleMatch[1]).pr = { number: parsed.number, html_url: parsed.html_url };
            pendingPrIssue = null;
          } else if (pendingPrIssue) {
            ensureEntry(pendingPrIssue).pr = { number: parsed.number, html_url: parsed.html_url };
            pendingPrIssue = null;
          }
        }

        if (parsed.skipped) {
          if (pendingCommentIssue && parsed.existing_comment_url) {
            ensureEntry(pendingCommentIssue).comment = { id: parsed.comment_id ?? 0, html_url: parsed.existing_comment_url };
            pendingCommentIssue = null;
          }
          if (pendingBranchIssue && pendingBranchName && parsed.branch_url) {
            ensureEntry(pendingBranchIssue).branch = { name: pendingBranchName, sha: '' };
            pendingBranchIssue = null;
            pendingBranchName = null;
          }
          if (pendingPrIssue && parsed.existing_pr_url) {
            ensureEntry(pendingPrIssue).pr = { number: parsed.pr_number ?? 0, html_url: parsed.existing_pr_url };
            pendingPrIssue = null;
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
  triageResults?: Record<string, TriageOutput>,
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
      .filter(([, a]) => !a.comment || !a.branch || a.pr === null)
      .map(([num, a]) => {
        const done: string[] = [];
        const todo: string[] = [];
        if (a.comment) done.push('commented'); else todo.push('comment');
        if (a.branch) done.push(`branch: ${a.branch.name}`); else todo.push('create branch');
        if (a.pr) done.push(`PR #${a.pr.number}`); else todo.push('open PR');
        return `  Issue #${num}: done=[${done.join(', ')}] remaining=[${todo.join(', ')}]`;
      });

    if (incomplete.length > 0) {
      actionContext = `\n\nPartially-processed issues from previous runs (resume these first):\n${incomplete.join('\n')}`;
    }
  }

  // Build triage context so the analysis agent knows what triage already found
  let triageContext = '';
  if (triageResults && Object.keys(triageResults).length > 0) {
    const entries = Object.entries(triageResults).map(([num, t]) => {
      const files = t.relevantFiles.length > 0 ? t.relevantFiles.join(', ') : 'none identified';
      return `  Issue #${num}: type=${t.issueType}, complexity=${t.complexity}, relevant_files=[${files}]\n    Summary: ${t.summary}`;
    });
    triageContext = `\n\nTriage context (from the triage agent -- use this to guide your analysis):\n${entries.join('\n')}`;
  }

  return pollingContext + actionContext + triageContext + `

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
 * Fetch issues from GitHub that are new/updated since the last poll.
 * Returns formatted issue objects for triage.
 */
async function fetchIssuesForPoll(
  config: Config,
  maxIssues: number,
  sinceDate: string | null,
): Promise<Array<{ number: number; title: string; body: string; labels: string[] }>> {
  const { owner, repo, token } = config.github;
  const octokit = createGitHubClient(token);

  const params: Record<string, any> = {
    owner,
    repo,
    state: 'open',
    per_page: maxIssues,
    sort: 'updated',
    direction: 'desc',
  };
  if (sinceDate) params.since = sinceDate;

  const { data: issues } = await octokit.rest.issues.listForRepo(params);

  return issues.map((issue: any) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body || '(no description)',
    labels: issue.labels.map((l: any) => typeof l === 'string' ? l : l.name ?? ''),
  }));
}

/**
 * Run a full poll cycle: fetch new issues, triage, analyze, comment, branch, PR.
 *
 * The triage agent pre-filters issues: only issues where shouldAnalyze=true
 * get passed to the full analysis agent. This saves cost on issues that
 * don't need deep analysis (questions, duplicates, too vague, etc.).
 */
export async function runPollCycle(config: Config, options: { noSave?: boolean; dryRun?: boolean; maxIssues?: number; maxToolCalls?: number; skipTriage?: boolean } = {}): Promise<void> {
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

  // ── Triage phase ────────────────────────────────────────────────────────
  // Fetch issues and run triage on each to determine which need full analysis.
  // Issues where shouldAnalyze=false are skipped (logged but not analyzed).

  const previousIssueNumbers = pollState?.lastPollIssueNumbers ?? [];

  // Triage results collected during triage phase, keyed by issue number.
  // Passed to the analysis agent so it has context about what triage found.
  let collectedTriageResults: Record<string, TriageOutput> = {};

  if (!options.skipTriage) {
    console.log('\u{1F50E} Fetching issues for triage...');
    const issues = await fetchIssuesForPoll(config, maxIssues, sinceDate);

    // Filter out previously processed issues
    const newIssues = issues.filter((i) => !previousIssueNumbers.includes(i.number));

    if (newIssues.length === 0) {
      console.log('\u{2705} No new issues to process.\n');

      if (!skipSave) {
        savePollState({
          lastPollTimestamp: new Date().toISOString(),
          lastPollIssueNumbers: previousIssueNumbers,
          issues: pollState?.issues ?? {},
        });
        console.log(`\u{1F4BE} Poll state saved to ${POLL_STATE_FILE}`);
      }
      return;
    }

    console.log(`\u{1F4CB} Found ${newIssues.length} new issue(s) to triage.\n`);

    // Run triage on each new issue (check shutdown flag between issues)
    const triageResults: Array<{ issue: typeof newIssues[0]; triage: TriageOutput }> = [];
    for (const issue of newIssues) {
      if (isShuttingDown()) {
        console.log('\n\u{1F6D1} Shutdown requested -- stopping triage early, saving state...');
        break;
      }

      console.log(`\u{1F50E} Triaging issue #${issue.number}: ${issue.title}`);
      try {
        const triageResult = await runTriage(config, issue);
        triageResults.push({ issue, triage: triageResult });
        console.log(`   -> ${triageResult.issueType} | ${triageResult.complexity} | analyze: ${triageResult.shouldAnalyze}`);
        if (!triageResult.shouldAnalyze) {
          console.log(`   -> Skipping: ${triageResult.skipReason || 'no reason given'}`);
        }
      } catch (error) {
        console.log(`   -> Triage failed for #${issue.number}, defaulting to full analysis: ${error}`);
        triageResults.push({
          issue,
          triage: {
            issueType: 'unknown',
            complexity: 'moderate',
            relevantFiles: [],
            shouldAnalyze: true,
            summary: 'Triage failed. Defaulting to full analysis.',
          },
        });
      }
    }

    // Filter to issues that need analysis
    const toAnalyze = triageResults.filter((r) => r.triage.shouldAnalyze);
    const skipped = triageResults.filter((r) => !r.triage.shouldAnalyze);

    console.log(`\n\u{1F4CA} Triage summary: ${toAnalyze.length} to analyze, ${skipped.length} skipped\n`);

    // Collect triage results for issues that will be analyzed (keyed by issue number)
    for (const r of toAnalyze) {
      collectedTriageResults[String(r.issue.number)] = r.triage;
    }

    if (toAnalyze.length === 0) {
      console.log('\u{2705} All issues were skipped by triage. Nothing to analyze.\n');

      // Still record the skipped issues as "processed" so we don't re-triage them
      const allProcessed = [...previousIssueNumbers, ...triageResults.map((r) => r.issue.number)];

      if (!skipSave) {
        savePollState({
          lastPollTimestamp: new Date().toISOString(),
          lastPollIssueNumbers: allProcessed,
          issues: pollState?.issues ?? {},
        });
        console.log(`\u{1F4BE} Poll state saved to ${POLL_STATE_FILE}`);
      }
      return;
    }

    // If shutdown was requested during triage, save progress and exit
    if (isShuttingDown()) {
      const triaged = triageResults.map((r) => r.issue.number);
      const allProcessed = [...previousIssueNumbers, ...triaged];

      if (!skipSave) {
        savePollState({
          lastPollTimestamp: new Date().toISOString(),
          lastPollIssueNumbers: allProcessed,
          issues: pollState?.issues ?? {},
        });
        console.log(`\u{1F4BE} Poll state saved before shutdown to ${POLL_STATE_FILE}`);
      }
      console.log('\u{1F6D1} Graceful shutdown complete (after triage phase).');
      return;
    }
  }

  // ── Analysis phase ──────────────────────────────────────────────────────

  // Check shutdown before starting the expensive analysis phase
  if (isShuttingDown()) {
    if (!skipSave) {
      savePollState({
        lastPollTimestamp: new Date().toISOString(),
        lastPollIssueNumbers: previousIssueNumbers,
        issues: pollState?.issues ?? {},
      });
      console.log(`\u{1F4BE} Poll state saved before shutdown to ${POLL_STATE_FILE}`);
    }
    console.log('\u{1F6D1} Graceful shutdown complete (before analysis phase).');
    return;
  }

  // Create agent
  console.log('\u{2699}\uFE0F  Creating Deep Agent...');
  const agent = createDeepAgentWithGitHub(config, { maxIssues, dryRun: options.dryRun, maxToolCalls });
  console.log('\u{2705} Agent ready!\n');

  // Build user message (include action + triage context for the analysis agent)
  const userMessage = buildUserMessage(
    maxIssues,
    sinceDate,
    previousIssueNumbers,
    pollState?.issues,
    collectedTriageResults,
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
    previousIssueNumbers,
  );
  const issueActions = extractIssueActions(
    result?.messages ?? [],
    pollState?.issues ?? {},
  );

  if (!skipSave) {
    // Merge new triage results with any existing ones from previous polls
    const mergedTriageResults = { ...pollState?.triageResults, ...collectedTriageResults };
    savePollState({
      lastPollTimestamp: new Date().toISOString(),
      lastPollIssueNumbers: processedNumbers,
      issues: issueActions,
      triageResults: Object.keys(mergedTriageResults).length > 0 ? mergedTriageResults : undefined,
    });
    console.log(`\n\u{1F4BE} Poll state saved to ${POLL_STATE_FILE}`);
  } else {
    console.log(`\n\u{1F9EA} ${options.dryRun ? 'Dry run' : 'No-save'} mode -- poll state NOT saved`);
  }
  console.log(`   Processed issues: ${processedNumbers.join(', ')}`);

  // Set exit code if circuit breaker tripped (useful for cron monitoring).
  // Use process.exitCode instead of process.exit() so pending I/O (like
  // poll state writes) can flush before the process terminates.
  if (circuitBroken) {
    process.exitCode = 2;
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
 * Fetch a single issue from GitHub by number.
 * Returns the issue in the format expected by the triage agent.
 */
export async function fetchSingleIssue(
  config: Config,
  issueNumber: number,
): Promise<{ number: number; title: string; body: string; labels: string[] }> {
  const { owner, repo, token } = config.github;
  const octokit = createGitHubClient(token);

  const { data: issue } = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || '(no description)',
    labels: issue.labels.map((l) => typeof l === 'string' ? l : l.name ?? ''),
  };
}

/**
 * Run triage on a single issue and print the structured result.
 */
export async function runTriageSingle(config: Config, issueNumber: number): Promise<TriageOutput> {
  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  console.log(`\u{1F50E} Triaging issue #${issueNumber}\n`);

  // Fetch the issue from GitHub
  const issue = await fetchSingleIssue(config, issueNumber);
  console.log(`\u{1F4CB} Issue: ${issue.title}`);
  console.log(`   Labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : 'none'}\n`);

  console.log('='.repeat(60));

  // Run triage
  const triageResult = await runTriage(config, issue);

  console.log('='.repeat(60));
  console.log('\n\u{2705} Triage completed!\n');

  // Print structured output
  console.log('\u{1F4CB} Triage Result:');
  console.log(`   Issue Type:     ${triageResult.issueType}`);
  console.log(`   Complexity:     ${triageResult.complexity}`);
  console.log(`   Should Analyze: ${triageResult.shouldAnalyze}`);
  if (triageResult.skipReason) {
    console.log(`   Skip Reason:    ${triageResult.skipReason}`);
  }
  console.log(`   Relevant Files: ${triageResult.relevantFiles.length > 0 ? triageResult.relevantFiles.join(', ') : 'none'}`);
  console.log(`   Summary:        ${triageResult.summary}`);

  return triageResult;
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
    for (const [num, a] of Object.entries(pollState.issues)) {
      const status: string[] = [];
      status.push(a.comment ? 'commented' : 'no comment');
      status.push(a.branch ? `branch: ${a.branch.name}` : 'no branch');
      if (a.commits.length > 0) status.push(`${a.commits.length} commit(s)`);
      status.push(a.pr ? `PR #${a.pr.number}` : 'no PR');
      console.log(`  #${num}: ${status.join(', ')}`);
    }
  }

  const maxIssues = getMaxIssues(config);
  const maxToolCalls = getMaxToolCalls(config);
  console.log(`\nMax issues per run: ${maxIssues}`);
  console.log(`Max tool calls per run: ${maxToolCalls}`);
}

/**
 * Result of a retraction operation. Reports what was retracted and what failed.
 */
export interface RetractResult {
  issueNumber: number;
  prClosed: boolean;
  branchDeleted: boolean;
  commentDeleted: boolean;
  errors: string[];
}

/**
 * Retract all actions taken on a specific issue: close PR, delete branch, delete comment.
 * Order matters: close PR first (it references the branch), then delete branch, then delete comment.
 * Partial retraction is supported -- if one step fails, the others still attempt.
 */
export async function retractIssue(config: Config, issueNumber: number): Promise<RetractResult> {
  const { owner, repo, token } = config.github;
  const octokit = createGitHubClient(token);

  const pollState = loadPollState();
  if (!pollState) {
    throw new Error('No poll state found. Nothing to retract.');
  }

  const actions = pollState.issues?.[String(issueNumber)];
  if (!actions) {
    throw new Error(`No actions recorded for issue #${issueNumber}. Nothing to retract.`);
  }

  const result: RetractResult = {
    issueNumber,
    prClosed: false,
    branchDeleted: false,
    commentDeleted: false,
    errors: [],
  };

  // Step 1: Close PR (must happen before branch deletion)
  if (actions.pr && actions.pr.number > 0) {
    try {
      await withRetry(() => octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: actions.pr!.number,
        state: 'closed',
      }));
      result.prClosed = true;
      console.log(`  Closed PR #${actions.pr.number}`);
    } catch (error) {
      const msg = `Failed to close PR #${actions.pr.number}: ${error}`;
      result.errors.push(msg);
      console.error(`  ${msg}`);
    }
  }

  // Step 2: Delete branch
  if (actions.branch && actions.branch.name) {
    try {
      await withRetry(() => octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${actions.branch!.name}`,
      }));
      result.branchDeleted = true;
      console.log(`  Deleted branch ${actions.branch.name}`);
    } catch (error) {
      const msg = `Failed to delete branch ${actions.branch.name}: ${error}`;
      result.errors.push(msg);
      console.error(`  ${msg}`);
    }
  }

  // Step 3: Delete comment
  if (actions.comment && actions.comment.id > 0) {
    try {
      await withRetry(() => octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: actions.comment!.id,
      }));
      result.commentDeleted = true;
      console.log(`  Deleted comment ${actions.comment.id}`);
    } catch (error) {
      const msg = `Failed to delete comment ${actions.comment.id}: ${error}`;
      result.errors.push(msg);
      console.error(`  ${msg}`);
    }
  }

  // Update poll state: remove the issue's actions and issue number
  delete pollState.issues![String(issueNumber)];
  pollState.lastPollIssueNumbers = pollState.lastPollIssueNumbers.filter(
    (n) => n !== issueNumber,
  );
  savePollState(pollState);
  console.log(`  Poll state updated (issue #${issueNumber} cleared)`);

  return result;
}
