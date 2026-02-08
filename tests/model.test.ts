import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM constructors before importing the module under test
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation((opts: any) => ({
    _type: 'anthropic',
    ...opts,
  })),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation((opts: any) => ({
    _type: 'openai',
    ...opts,
  })),
}));

import { createModel } from '../src/model.js';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Provider routing ──────────────────────────────────────────────────────────

describe('createModel', () => {
  it('creates ChatAnthropic for "anthropic" provider', () => {
    createModel({
      llm: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-20250514' },
    } as any);

    expect(ChatAnthropic).toHaveBeenCalledTimes(1);
    expect(ChatAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-20250514',
      })
    );
  });

  it('uses default model for anthropic when model is empty', () => {
    createModel({
      llm: { provider: 'anthropic', apiKey: 'sk-test', model: '' },
    } as any);

    expect(ChatAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
      })
    );
  });

  it('creates ChatOpenAI for "openai" provider', () => {
    createModel({
      llm: { provider: 'openai', apiKey: 'sk-openai', model: 'gpt-4' },
    } as any);

    expect(ChatOpenAI).toHaveBeenCalledTimes(1);
    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-openai',
        model: 'gpt-4',
      })
    );
  });

  it('creates ChatOpenAI with custom baseUrl for "openai-compatible"', () => {
    createModel({
      llm: { provider: 'openai-compatible', apiKey: 'key', model: 'my-model', baseUrl: 'http://localhost:1234/v1' },
    } as any);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: { baseURL: 'http://localhost:1234/v1' },
      })
    );
  });

  it('throws when openai-compatible has no baseUrl', () => {
    expect(() =>
      createModel({
        llm: { provider: 'openai-compatible', apiKey: 'key', model: 'model' },
      } as any)
    ).toThrow('requires a baseUrl');
  });

  it('creates ChatOpenAI with Ollama defaults for "ollama" provider', () => {
    createModel({
      llm: { provider: 'ollama', model: 'llama3' },
    } as any);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'ollama',
        model: 'llama3',
        configuration: { baseURL: 'http://localhost:11434/v1' },
      })
    );
  });

  it('uses custom baseUrl for ollama when provided', () => {
    createModel({
      llm: { provider: 'ollama', model: 'llama3', baseUrl: 'http://remote:11434/v1' },
    } as any);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: { baseURL: 'http://remote:11434/v1' },
      })
    );
  });

  it('throws for unknown provider', () => {
    expect(() =>
      createModel({
        llm: { provider: 'unknown-provider', apiKey: 'key', model: 'model' },
      } as any)
    ).toThrow('Unsupported provider');
  });
});
