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

    expect(() => loadConfig()).toThrow('process.exit called');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('config.json not found')
    );
  });

  it('exits when github.owner is missing', () => {
    const bad = { ...validConfig, github: { ...validConfig.github, owner: '' } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit called');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing required GitHub config')
    );
  });

  it('exits when github.token is missing', () => {
    const bad = { ...validConfig, github: { ...validConfig.github, token: '' } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit called');
  });

  it('exits when LLM API key is missing for cloud providers', () => {
    const bad = { ...validConfig, llm: { ...validConfig.llm, apiKey: '' } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit called');
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
});
