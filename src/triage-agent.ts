import { createDeepAgent } from 'deepagents';
import type { Config } from './config.js';
import { createModel } from './model.js';
import {
  createGitHubClient,
  createGitHubIssuesTool,
  createListRepoFilesTool,
  createReadRepoFileTool,
  ToolCallCounter,
  wrapWithCircuitBreaker,
} from './github-tools.js';
import { wrapWithLogging } from './logger.js';

// ── Triage output interface ─────────────────────────────────────────────────

/**
 * Structured output from the triage agent.
 * This is the contract between triage and analysis phases.
 */
export interface TriageOutput {
  issueType: 'bug' | 'feature' | 'docs' | 'question' | 'unknown';
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
  relevantFiles: string[];
  shouldAnalyze: boolean;
  skipReason?: string;
  summary: string;
}

/**
 * Default triage output when parsing fails.
 * Conservative: assumes the issue should be analyzed.
 */
const FALLBACK_TRIAGE: TriageOutput = {
  issueType: 'unknown',
  complexity: 'moderate',
  relevantFiles: [],
  shouldAnalyze: true,
  summary: 'Triage output could not be parsed. Defaulting to full analysis.',
};

// ── Triage system prompt ────────────────────────────────────────────────────

function buildTriageSystemPrompt(owner: string, repo: string): string {
  return `You are a triage agent for the GitHub repository ${owner}/${repo}.

Your job is to quickly scope and classify a GitHub issue. You are the FIRST phase of a two-phase pipeline. Your output will determine whether the issue proceeds to expensive, full analysis or is skipped.

WORKFLOW:
1. Read the issue title, body, and labels
2. Call list_repo_files to see the repository structure
3. Optionally call read_repo_file on 1-2 files to confirm relevance (no more than 2 files)
4. Classify the issue and output your structured assessment

YOU MUST respond with a JSON object (and ONLY a JSON object, no markdown fences, no extra text) matching this exact schema:

{
  "issueType": "bug" | "feature" | "docs" | "question" | "unknown",
  "complexity": "trivial" | "simple" | "moderate" | "complex",
  "relevantFiles": ["path/to/file1.ts", "path/to/file2.ts"],
  "shouldAnalyze": true | false,
  "skipReason": "only if shouldAnalyze is false -- explain why",
  "summary": "One paragraph describing what this issue is about and what the fix would involve"
}

CLASSIFICATION GUIDE:

Issue types:
- "bug": Something is broken or behaving incorrectly
- "feature": A new capability or enhancement
- "docs": Documentation improvement (README, comments, etc.)
- "question": The reporter is asking a question, not reporting a problem
- "unknown": Cannot determine from the description

Complexity:
- "trivial": Typo fix, config change, one-line change
- "simple": Clear fix in 1-2 files, well-understood scope
- "moderate": Touches multiple files, requires understanding existing patterns
- "complex": Architectural change, cross-cutting concerns, unclear scope

When to skip (shouldAnalyze: false):
- Questions that need human answers, not code changes
- Issues too vague to act on (need more info from reporter)
- Duplicates of already-processed issues
- Issues targeting external dependencies or different repos

When in doubt, set shouldAnalyze to true. It is better to over-analyze than to miss a real issue.

CONSTRAINTS:
- You have READ-ONLY access. You CANNOT post comments, create branches, or open PRs.
- Keep it fast: at most 1 call to list_repo_files and 2 calls to read_repo_file.
- Your FINAL message must be the JSON object and nothing else.`;
}

// ── Triage agent factory ────────────────────────────────────────────────────

/**
 * Maximum tool calls for the triage agent.
 * Triage is meant to be fast: 1 list + 2 reads + 1 fetch = 4 max.
 * We allow a few extra for flexibility.
 */
const TRIAGE_MAX_TOOL_CALLS = 8;

/**
 * Create a triage agent with read-only tools.
 *
 * The triage agent uses a potentially cheaper model (config.triageLlm)
 * and has access only to read-only GitHub tools. It cannot cause side effects.
 */
export function createTriageAgent(config: Config, options: { maxToolCalls?: number } = {}) {
  // Use triageLlm if configured, otherwise fall back to main llm
  const modelConfig = config.triageLlm
    ? { ...config, llm: config.triageLlm }
    : config;
  const model = createModel(modelConfig);

  const { owner, repo, token } = config.github;
  const octokit = createGitHubClient(token);

  // Read-only tools only -- no side effects
  let githubIssuesTool = createGitHubIssuesTool(owner, repo, octokit);
  let listFilesTool = createListRepoFilesTool(owner, repo, octokit);
  let readFileTool = createReadRepoFileTool(owner, repo, octokit);

  // Circuit breaker for triage (tight limit)
  const maxToolCalls = options.maxToolCalls ?? TRIAGE_MAX_TOOL_CALLS;
  const counter = new ToolCallCounter(maxToolCalls);
  githubIssuesTool = wrapWithCircuitBreaker(githubIssuesTool, counter);
  listFilesTool = wrapWithCircuitBreaker(listFilesTool, counter);
  readFileTool = wrapWithCircuitBreaker(readFileTool, counter);

  // Structured logging (outermost layer)
  githubIssuesTool = wrapWithLogging(githubIssuesTool, counter);
  listFilesTool = wrapWithLogging(listFilesTool, counter);
  readFileTool = wrapWithLogging(readFileTool, counter);

  const systemPrompt = buildTriageSystemPrompt(owner, repo);

  const agent = createDeepAgent({
    model,
    tools: [githubIssuesTool, listFilesTool, readFileTool],
    systemPrompt,
  });

  return agent;
}

// ── Triage output parsing ───────────────────────────────────────────────────

const VALID_ISSUE_TYPES = new Set(['bug', 'feature', 'docs', 'question', 'unknown']);
const VALID_COMPLEXITIES = new Set(['trivial', 'simple', 'moderate', 'complex']);

/**
 * Parse the triage agent's final message into a structured TriageOutput.
 *
 * The agent is instructed to output raw JSON. We extract JSON from the
 * last message, parse it, and validate the fields. Falls back to
 * FALLBACK_TRIAGE if parsing fails.
 */
export function parseTriageOutput(text: string): TriageOutput {
  // Try to extract JSON from the text (handles markdown fences, extra whitespace)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('Triage: no JSON object found in agent response. Using fallback.');
    return { ...FALLBACK_TRIAGE };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn('Triage: failed to parse JSON from agent response. Using fallback.');
    return { ...FALLBACK_TRIAGE };
  }

  // Validate and normalize fields
  const issueType = VALID_ISSUE_TYPES.has(parsed.issueType) ? parsed.issueType : 'unknown';
  const complexity = VALID_COMPLEXITIES.has(parsed.complexity) ? parsed.complexity : 'moderate';
  const relevantFiles = Array.isArray(parsed.relevantFiles)
    ? parsed.relevantFiles.filter((f: unknown) => typeof f === 'string')
    : [];
  const shouldAnalyze = typeof parsed.shouldAnalyze === 'boolean' ? parsed.shouldAnalyze : true;
  const skipReason = typeof parsed.skipReason === 'string' ? parsed.skipReason : undefined;
  const summary = typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.';

  return { issueType, complexity, relevantFiles, shouldAnalyze, skipReason, summary };
}

// ── Triage user message builder ─────────────────────────────────────────────

/**
 * Build the user message for triaging a single issue.
 */
export function buildTriageMessage(issue: {
  number: number;
  title: string;
  body: string;
  labels: string[];
}): string {
  const labelsStr = issue.labels.length > 0 ? issue.labels.join(', ') : 'none';
  return `Triage this GitHub issue:

Issue #${issue.number}: ${issue.title}
Labels: ${labelsStr}

Description:
${issue.body}

Examine the repository structure and classify this issue. Output your assessment as a JSON object.`;
}

// ── Run triage on a single issue ────────────────────────────────────────────

/**
 * Run the triage agent on a single issue and return structured output.
 */
export async function runTriage(
  config: Config,
  issue: { number: number; title: string; body: string; labels: string[] },
): Promise<TriageOutput> {
  const agent = createTriageAgent(config);
  const userMessage = buildTriageMessage(issue);

  const result = await agent.invoke({
    messages: [{ role: 'user', content: userMessage }],
  });

  // Extract the last message content
  const lastMessage = result.messages[result.messages.length - 1];
  const content = typeof lastMessage.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);

  return parseTriageOutput(content);
}
