import { createDeepAgent } from 'deepagents';
import type { Config } from './config.js';
import { createModel } from './model.js';
import {
  createGitHubClient,
  getAuthFromConfig,
  createGetPrDiffTool,
  createReadRepoFileTool,
  createSubmitPrReviewTool,
  ToolCallCounter,
  wrapWithCircuitBreaker,
} from './github-tools.js';
import { wrapWithLogging } from './logger.js';

// ── Reviewer system prompt ───────────────────────────────────────────────────

function buildReviewerSystemPrompt(owner: string, repo: string): string {
  return `You are a code review agent for the GitHub repository ${owner}/${repo}.

Your job is to review a pull request and provide constructive feedback. You are an automated reviewer -- your review helps human maintainers decide whether to merge.

WORKFLOW:
1. Fetch the PR diff using get_pr_diff
2. Read relevant source files for context using read_repo_file (the files touched in the diff, plus related files)
3. Evaluate the changes:
   - Does the approach make sense for the problem it's solving?
   - Are there any bugs, logic errors, or edge cases missed?
   - Is the code readable and maintainable?
   - Are there any security concerns (injection, XSS, etc.)?
   - Does the change follow existing patterns in the codebase?
4. Submit your review using submit_pr_review with:
   - A summary of your assessment in the body
   - Inline comments on specific lines where you have feedback
   - Be constructive -- suggest improvements, don't just criticize

CONSTRAINTS:
- You can ONLY post a COMMENT review. You CANNOT approve or request changes.
- You are NOT a human. Always be transparent that this is an automated review.
- Keep reviews focused and actionable. Don't nitpick style if the code works.
- If the PR looks good, say so! Not every review needs to find problems.
- Read at most 5 source files for context (don't over-explore).

Your FINAL message should confirm the review was submitted (or skipped if already reviewed).`;
}

// ── Reviewer agent factory ───────────────────────────────────────────────────

/** Maximum tool calls for the reviewer agent. */
const REVIEWER_MAX_TOOL_CALLS = 15;

/**
 * Create a PR reviewer agent.
 *
 * Uses a potentially different model (config.reviewerLlm) and has access to:
 * - get_pr_diff: fetch the PR diff
 * - read_repo_file: read source files for context
 * - submit_pr_review: post a review (always COMMENT)
 */
export function createReviewerAgent(config: Config, options: { maxToolCalls?: number } = {}) {
  // Use reviewerLlm if configured, otherwise fall back to main llm
  const modelConfig = config.reviewerLlm
    ? { ...config, llm: config.reviewerLlm }
    : config;
  const model = createModel(modelConfig);

  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  // Tools: diff reader, source reader, review submitter
  let diffTool = createGetPrDiffTool(octokit, owner, repo);
  let readFileTool = createReadRepoFileTool(owner, repo, octokit);
  let reviewTool = createSubmitPrReviewTool(octokit, owner, repo);

  // Circuit breaker
  const maxToolCalls = options.maxToolCalls ?? REVIEWER_MAX_TOOL_CALLS;
  const counter = new ToolCallCounter(maxToolCalls);
  diffTool = wrapWithCircuitBreaker(diffTool, counter);
  readFileTool = wrapWithCircuitBreaker(readFileTool, counter);
  reviewTool = wrapWithCircuitBreaker(reviewTool, counter);

  // Structured logging (outermost layer)
  diffTool = wrapWithLogging(diffTool, counter);
  readFileTool = wrapWithLogging(readFileTool, counter);
  reviewTool = wrapWithLogging(reviewTool, counter);

  const systemPrompt = buildReviewerSystemPrompt(owner, repo);

  const agent = createDeepAgent({
    model,
    tools: [diffTool, readFileTool, reviewTool],
    systemPrompt,
  });

  return agent;
}

// ── Run review on a single PR ────────────────────────────────────────────────

/**
 * Run the reviewer agent on a single PR.
 */
export async function runReviewSingle(config: Config, prNumber: number): Promise<void> {
  console.log(`\u{1F50D} Reviewing PR #${prNumber}\n`);

  const agent = createReviewerAgent(config);
  const userMessage = `Review pull request #${prNumber}. Fetch the diff, read relevant source files, and submit your review.`;

  console.log('='.repeat(60));

  const result = await agent.invoke({
    messages: [{ role: 'user', content: userMessage }],
  });

  console.log('='.repeat(60));
  console.log('\n\u{2705} Review completed!\n');

  const lastMessage = result.messages[result.messages.length - 1];
  console.log('\u{1F4DD} Agent Response:');
  console.log(typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content));
}
