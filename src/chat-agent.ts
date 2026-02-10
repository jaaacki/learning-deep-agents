import { createDeepAgent } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import type { Config } from './config.js';
import { createModel } from './model.js';
import {
  createGitHubClient,
  getAuthFromConfig,
  createGitHubIssuesTool,
  createListRepoFilesTool,
  createReadRepoFileTool,
  wrapWithCircuitBreaker,
  ToolCallCounter,
} from './github-tools.js';
import { wrapWithLogging } from './logger.js';

/**
 * Maximum tool calls per chat turn to prevent runaway loops.
 */
const CHAT_MAX_TOOL_CALLS = 15;

/**
 * In-memory checkpointer for multi-turn conversation state.
 * Shared across all sessions within a single process.
 */
const checkpointer = new MemorySaver();

/**
 * Create a chat agent that humans can interact with directly.
 *
 * Uses the same LLM and read-only GitHub tools as the analysis agent,
 * but with a conversational system prompt and LangGraph checkpointer
 * for multi-turn conversation state.
 */
export function createChatAgent(config: Config) {
  const model = createModel(config);
  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  // Read-only tools — the chat agent can browse but not write
  let issuesTool = createGitHubIssuesTool(owner, repo, octokit);
  let listFilesTool = createListRepoFilesTool(owner, repo, octokit);
  let readFileTool = createReadRepoFileTool(owner, repo, octokit);

  // Circuit breaker per turn
  const counter = new ToolCallCounter(CHAT_MAX_TOOL_CALLS);
  issuesTool = wrapWithCircuitBreaker(issuesTool, counter);
  listFilesTool = wrapWithCircuitBreaker(listFilesTool, counter);
  readFileTool = wrapWithCircuitBreaker(readFileTool, counter);

  // Logging
  issuesTool = wrapWithLogging(issuesTool, counter);
  listFilesTool = wrapWithLogging(listFilesTool, counter);
  readFileTool = wrapWithLogging(readFileTool, counter);

  const systemPrompt = `You are a helpful assistant for the GitHub repository ${owner}/${repo}.

You can browse the repository to answer questions about the codebase, issues, and project structure.
You have read-only access — you cannot modify code, create branches, or post comments.

Available tools:
- fetch_github_issues: Fetch open issues from the repo
- list_repo_files: List files in the repo (supports path prefix filtering)
- read_repo_file: Read a file's contents from the repo

When answering questions:
- Use the tools to look up actual code and issues rather than guessing
- Be concise and direct
- Reference specific files and line numbers when discussing code
`;

  const agent = createDeepAgent({
    model,
    tools: [issuesTool, listFilesTool, readFileTool],
    systemPrompt,
    checkpointer,
  });

  return agent;
}

/**
 * Result of a single chat turn.
 */
export interface ChatResult {
  response: string;
  sessionId: string;
}

/**
 * Send a message to the chat agent and get a response.
 * Conversation state is maintained per sessionId via the checkpointer.
 */
export async function chat(
  config: Config,
  message: string,
  sessionId: string,
): Promise<ChatResult> {
  const agent = createChatAgent(config);

  const result = await agent.invoke(
    { messages: [{ role: 'user', content: message }] },
    { configurable: { thread_id: sessionId } },
  );

  // Extract the last AI message
  const messages = result.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  const response = typeof lastMessage?.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage?.content ?? '');

  return { response, sessionId };
}
