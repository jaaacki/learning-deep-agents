import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// We need to mock process.exit to prevent it from killing the test runner.
// config.ts calls process.exit(1) on validation failures.
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as any);

import { loadConfig } from '../src/config.js';

beforeEach(() => {
  vi.spyOn(fs, 'existsSync');
  vi.spyOn(fs, 'readFileSync');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockExit.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  const validConfig = {
    github: { owner: 'test-owner', repo: 'test-repo', token: 'ghp_test123' },
    llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
  };

  it('returns config when all required fields are present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    const config = loadConfig();

    expect(config.github.owner).toBe('test-owner');
    expect(config.github.repo).toBe('test-repo');
    expect(config.llm.provider).toBe('anthropic');
  });

  it('exits when config.json does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('config.json not found')
    );
  });

  it('exits when github.owner is missing', () => {
    const bad = { ...validConfig, github: { ...validConfig.github, owner: '' } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing required GitHub config')
    );
  });

  it('exits when github.token is missing', () => {
    const bad = { ...validConfig, github: { ...validConfig.github, token: '' } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
  });

  it('exits when LLM API key is missing for cloud providers', () => {
    const bad = { ...validConfig, llm: { ...validConfig.llm, apiKey: '' } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing LLM API key')
    );
  });

  it('does NOT exit when API key is missing for ollama', () => {
    const ollamaConfig = {
      ...validConfig,
      llm: { provider: 'ollama', apiKey: '', model: 'llama3' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(ollamaConfig));

    const config = loadConfig();
    expect(config.llm.provider).toBe('ollama');
  });

  it('does NOT exit when API key is missing for openai-compatible', () => {
    const compatConfig = {
      ...validConfig,
      llm: { provider: 'openai-compatible', apiKey: '', model: 'model', baseUrl: 'http://localhost:1234/v1' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(compatConfig));

    const config = loadConfig();
    expect(config.llm.provider).toBe('openai-compatible');
  });

  it('accepts config with triageLlm specified', () => {
    const triageConfig = {
      ...validConfig,
      triageLlm: { provider: 'anthropic', apiKey: 'sk-ant-triage', model: 'claude-haiku-4-5-20251001' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(triageConfig));

    const config = loadConfig();
    expect(config.triageLlm.provider).toBe('anthropic');
    expect(config.triageLlm.model).toBe('claude-haiku-4-5-20251001');
  });

  it('accepts config without triageLlm (falls back to main llm)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    const config = loadConfig();
    expect(config.triageLlm).toBeUndefined();
  });

  it('exits when triageLlm.provider is missing', () => {
    const bad = {
      ...validConfig,
      triageLlm: { provider: '', apiKey: 'sk-ant-triage', model: 'claude-haiku' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('triageLlm.provider is required')
    );
  });

  it('exits when triageLlm API key is missing for cloud providers', () => {
    const bad = {
      ...validConfig,
      triageLlm: { provider: 'anthropic', apiKey: '', model: 'claude-haiku' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing triageLlm API key')
    );
  });

  it('does NOT exit when triageLlm API key is missing for ollama', () => {
    const triageOllama = {
      ...validConfig,
      triageLlm: { provider: 'ollama', apiKey: '', model: 'llama3' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(triageOllama));

    const config = loadConfig();
    expect(config.triageLlm.provider).toBe('ollama');
  });

  // ── webhook config validation ──────────────────────────────────────────────

  it('accepts config with valid webhook section', () => {
    const webhookConfig = {
      ...validConfig,
      webhook: { port: 3000, secret: 'my-webhook-secret' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(webhookConfig));

    const config = loadConfig();
    expect(config.webhook.port).toBe(3000);
    expect(config.webhook.secret).toBe('my-webhook-secret');
  });

  it('accepts config without webhook section', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    const config = loadConfig();
    expect(config.webhook).toBeUndefined();
  });

  it('exits when webhook.port is out of range', () => {
    const bad = {
      ...validConfig,
      webhook: { port: 99999, secret: 'secret' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('webhook.port must be a number between 1 and 65535')
    );
  });

  it('exits when webhook.port is not a number', () => {
    const bad = {
      ...validConfig,
      webhook: { port: 'abc', secret: 'secret' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('webhook.port must be a number between 1 and 65535')
    );
  });

  it('exits when webhook.secret is missing', () => {
    const bad = {
      ...validConfig,
      webhook: { port: 3000, secret: '' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('webhook.secret is required')
    );
  });
});
