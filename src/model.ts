import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatOllama } from '@langchain/ollama';
import type { Config } from './config.js';

/**
 * Create an LLM instance based on the provider in config.
 *
 * Supported providers:
 *   - "anthropic"          → ChatAnthropic (Claude)
 *   - "openai"             → ChatOpenAI (GPT-4, etc.)
 *   - "openai-compatible"  → ChatOpenAI with custom baseUrl (Ollama, LM Studio, Together, Groq, etc.)
 *   - "ollama"             → Shorthand for openai-compatible with Ollama's default baseUrl
 */
export function createModel(config: Config) {
  const { provider, apiKey, model, baseUrl } = config.llm;

  switch (provider) {
    case 'anthropic':
      return new ChatAnthropic({
        apiKey,
        model: model || 'claude-sonnet-4-20250514',
      });

    case 'openai':
      return new ChatOpenAI({
        apiKey,
        model: model || 'gpt-4',
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
      });

    case 'openai-compatible':
      if (!baseUrl) {
        throw new Error('openai-compatible provider requires a baseUrl in config (e.g., "http://localhost:1234/v1")');
      }
      return new ChatOpenAI({
        apiKey: apiKey || 'not-needed',
        model: model || 'default',
        configuration: { baseURL: baseUrl },
      });

    case 'ollama':
      return new ChatOllama({
        model: model || 'llama3',
        baseUrl: baseUrl?.replace(/\/v1\/?$/, '') || 'http://localhost:11434',
      });

    default:
      throw new Error(
        `Unsupported provider: "${provider}". Use: anthropic, openai, openai-compatible, or ollama`
      );
  }
}
