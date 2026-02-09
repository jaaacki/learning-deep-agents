import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// We need to mock process.exit to prevent it from killing the test runner.
// config.ts calls process.exit(1) on validation failures.
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as any);

import { loadConfig } from '../src/config.js';

// All config-related env vars that must be cleaned between tests
const CONFIG_ENV_VARS = [
  'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN',
  'GITHUB_APP_ID', 'GITHUB_APP_PEM_PATH', 'GITHUB_APP_INSTALLATION_ID',
  'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL',
  'TRIAGE_LLM_PROVIDER', 'TRIAGE_LLM_API_KEY', 'TRIAGE_LLM_MODEL', 'TRIAGE_LLM_BASE_URL',
  'REVIEWER_LLM_PROVIDER', 'REVIEWER_LLM_API_KEY', 'REVIEWER_LLM_MODEL', 'REVIEWER_LLM_BASE_URL',
  'WEBHOOK_PORT', 'WEBHOOK_SECRET',
  'MAX_ISSUES_PER_RUN', 'MAX_TOOL_CALLS_PER_RUN',
];

/** Set the minimum required env vars for a valid config */
function setValidEnv() {
  process.env.GITHUB_OWNER = 'test-owner';
  process.env.GITHUB_REPO = 'test-repo';
  process.env.GITHUB_TOKEN = 'ghp_test123';
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.LLM_API_KEY = 'sk-ant-test';
  process.env.LLM_MODEL = 'claude-sonnet-4-20250514';
}

beforeEach(() => {
  vi.spyOn(fs, 'existsSync');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockExit.mockClear();
  // Clean all config env vars to prevent cross-test bleed
  for (const key of CONFIG_ENV_VARS) {
    delete process.env[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of CONFIG_ENV_VARS) {
    delete process.env[key];
  }
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns config when all required env vars are set', () => {
    setValidEnv();

    const config = loadConfig();

    expect(config.github.owner).toBe('test-owner');
    expect(config.github.repo).toBe('test-repo');
    expect(config.github.token).toBe('ghp_test123');
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.apiKey).toBe('sk-ant-test');
  });

  it('exits when GITHUB_OWNER is missing', () => {
    setValidEnv();
    delete process.env.GITHUB_OWNER;

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_OWNER')
    );
  });

  it('exits when GITHUB_REPO is missing', () => {
    setValidEnv();
    delete process.env.GITHUB_REPO;

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_OWNER')
    );
  });

  it('exits when no auth env vars are set', () => {
    setValidEnv();
    delete process.env.GITHUB_TOKEN;

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing GitHub auth')
    );
  });

  it('exits when LLM_API_KEY is missing for cloud providers', () => {
    setValidEnv();
    delete process.env.LLM_API_KEY;

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('LLM_API_KEY')
    );
  });

  it('does NOT exit when LLM_API_KEY is missing for ollama', () => {
    setValidEnv();
    process.env.LLM_PROVIDER = 'ollama';
    delete process.env.LLM_API_KEY;

    const config = loadConfig();
    expect(config.llm.provider).toBe('ollama');
  });

  it('does NOT exit when LLM_API_KEY is missing for openai-compatible', () => {
    setValidEnv();
    process.env.LLM_PROVIDER = 'openai-compatible';
    delete process.env.LLM_API_KEY;
    process.env.LLM_BASE_URL = 'http://localhost:1234/v1';

    const config = loadConfig();
    expect(config.llm.provider).toBe('openai-compatible');
  });

  // ── triageLlm ───────────────────────────────────────────────────────────────

  it('creates triageLlm when TRIAGE_LLM_PROVIDER is set', () => {
    setValidEnv();
    process.env.TRIAGE_LLM_PROVIDER = 'anthropic';
    process.env.TRIAGE_LLM_API_KEY = 'sk-ant-triage';
    process.env.TRIAGE_LLM_MODEL = 'claude-haiku-4-5-20251001';

    const config = loadConfig();
    expect(config.triageLlm).toBeDefined();
    expect(config.triageLlm.provider).toBe('anthropic');
    expect(config.triageLlm.apiKey).toBe('sk-ant-triage');
    expect(config.triageLlm.model).toBe('claude-haiku-4-5-20251001');
  });

  it('triageLlm is undefined when TRIAGE_LLM_PROVIDER is not set', () => {
    setValidEnv();

    const config = loadConfig();
    expect(config.triageLlm).toBeUndefined();
  });

  it('exits when TRIAGE_LLM_API_KEY is missing for cloud providers', () => {
    setValidEnv();
    process.env.TRIAGE_LLM_PROVIDER = 'anthropic';

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('TRIAGE_LLM_API_KEY')
    );
  });

  it('does NOT exit when TRIAGE_LLM_API_KEY is missing for ollama', () => {
    setValidEnv();
    process.env.TRIAGE_LLM_PROVIDER = 'ollama';
    process.env.TRIAGE_LLM_MODEL = 'llama3';

    const config = loadConfig();
    expect(config.triageLlm.provider).toBe('ollama');
  });

  // ── reviewerLlm ─────────────────────────────────────────────────────────────

  it('creates reviewerLlm when REVIEWER_LLM_PROVIDER is set', () => {
    setValidEnv();
    process.env.REVIEWER_LLM_PROVIDER = 'openai';
    process.env.REVIEWER_LLM_API_KEY = 'sk-openai-rev';
    process.env.REVIEWER_LLM_MODEL = 'gpt-4';

    const config = loadConfig();
    expect(config.reviewerLlm).toBeDefined();
    expect(config.reviewerLlm.provider).toBe('openai');
    expect(config.reviewerLlm.apiKey).toBe('sk-openai-rev');
    expect(config.reviewerLlm.model).toBe('gpt-4');
  });

  it('exits when REVIEWER_LLM_API_KEY is missing for cloud providers', () => {
    setValidEnv();
    process.env.REVIEWER_LLM_PROVIDER = 'anthropic';

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('REVIEWER_LLM_API_KEY')
    );
  });

  // ── webhook ─────────────────────────────────────────────────────────────────

  it('creates webhook config from WEBHOOK_PORT and WEBHOOK_SECRET', () => {
    setValidEnv();
    process.env.WEBHOOK_PORT = '3000';
    process.env.WEBHOOK_SECRET = 'my-secret';

    const config = loadConfig();
    expect(config.webhook.port).toBe(3000);
    expect(config.webhook.secret).toBe('my-secret');
  });

  it('webhook is undefined when neither WEBHOOK_PORT nor WEBHOOK_SECRET is set', () => {
    setValidEnv();

    const config = loadConfig();
    expect(config.webhook).toBeUndefined();
  });

  it('exits when WEBHOOK_PORT is out of range', () => {
    setValidEnv();
    process.env.WEBHOOK_PORT = '99999';
    process.env.WEBHOOK_SECRET = 'secret';

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('WEBHOOK_PORT must be a number')
    );
  });

  it('exits when WEBHOOK_PORT is not a number', () => {
    setValidEnv();
    process.env.WEBHOOK_PORT = 'abc';
    process.env.WEBHOOK_SECRET = 'secret';

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('WEBHOOK_PORT must be a number')
    );
  });

  it('exits when WEBHOOK_SECRET is missing but WEBHOOK_PORT is set', () => {
    setValidEnv();
    process.env.WEBHOOK_PORT = '3000';

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('WEBHOOK_SECRET is required')
    );
  });

  // ── GitHub App auth ─────────────────────────────────────────────────────────

  it('accepts GitHub App auth env vars (no PAT)', () => {
    setValidEnv();
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PEM_PATH = '/tmp/test-key.pem';
    process.env.GITHUB_APP_INSTALLATION_ID = '67890';

    vi.mocked(fs.existsSync).mockReturnValue(true);

    const config = loadConfig();
    expect(config.github.appId).toBe(12345);
    expect(typeof config.github.appId).toBe('number');
    expect(config.github.installationId).toBe(67890);
    expect(typeof config.github.installationId).toBe('number');
  });

  it('exits when partial App env vars provided (appId but no privateKeyPath)', () => {
    setValidEnv();
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_APP_ID = '12345';

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete GitHub App config')
    );
  });

  it('exits when partial App env vars provided (appId + privateKeyPath but no installationId)', () => {
    setValidEnv();
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PEM_PATH = '/tmp/key.pem';

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete GitHub App config')
    );
  });

  it('exits when App private key file does not exist', () => {
    setValidEnv();
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PEM_PATH = '/nonexistent/key.pem';
    process.env.GITHUB_APP_INSTALLATION_ID = '67890';

    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('private key file not found')
    );
  });

  it('accepts both PAT and App env vars (PAT takes precedence)', () => {
    setValidEnv();
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PEM_PATH = '/tmp/key.pem';
    process.env.GITHUB_APP_INSTALLATION_ID = '67890';

    const config = loadConfig();
    expect(config.github.token).toBe('ghp_test123');
  });

  // ── limits ──────────────────────────────────────────────────────────────────

  it('reads MAX_ISSUES_PER_RUN and MAX_TOOL_CALLS_PER_RUN as numbers', () => {
    setValidEnv();
    process.env.MAX_ISSUES_PER_RUN = '10';
    process.env.MAX_TOOL_CALLS_PER_RUN = '50';

    const config = loadConfig();
    expect(config.maxIssuesPerRun).toBe(10);
    expect(config.maxToolCallsPerRun).toBe(50);
  });

  it('limits are undefined when env vars are not set', () => {
    setValidEnv();

    const config = loadConfig();
    expect(config.maxIssuesPerRun).toBeUndefined();
    expect(config.maxToolCallsPerRun).toBeUndefined();
  });

  // ── localhost-https warnings ────────────────────────────────────────────────

  it('warns on https://localhost baseUrl', () => {
    setValidEnv();
    process.env.LLM_PROVIDER = 'openai-compatible';
    delete process.env.LLM_API_KEY;
    process.env.LLM_BASE_URL = 'https://localhost:11434/v1';

    loadConfig();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTPS for localhost')
    );
  });

  it('warns on https://127.0.0.1 baseUrl', () => {
    setValidEnv();
    process.env.LLM_PROVIDER = 'openai-compatible';
    delete process.env.LLM_API_KEY;
    process.env.LLM_BASE_URL = 'https://127.0.0.1:11434/v1';

    loadConfig();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTPS for localhost')
    );
  });

  it('does NOT warn on http://localhost baseUrl', () => {
    setValidEnv();
    process.env.LLM_PROVIDER = 'openai-compatible';
    delete process.env.LLM_API_KEY;
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    loadConfig();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does NOT warn on https://api.openai.com baseUrl', () => {
    setValidEnv();
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_API_KEY = 'sk-test';
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1';

    loadConfig();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
