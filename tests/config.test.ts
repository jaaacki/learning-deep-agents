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

beforeEach(() => {
  vi.spyOn(fs, 'existsSync');
  vi.spyOn(fs, 'readFileSync');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
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

  it('exits when neither config.json nor env vars provide required fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing required GitHub config')
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

  it('exits when github.token is missing and no app fields', () => {
    const bad = { ...validConfig, github: { ...validConfig.github, token: '' } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing GitHub auth')
    );
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

  // ── reviewerLlm config validation ────────────────────────────────────────

  it('accepts config with reviewerLlm specified', () => {
    const reviewerConfig = {
      ...validConfig,
      reviewerLlm: { provider: 'openai', apiKey: 'sk-openai-test', model: 'gpt-4' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(reviewerConfig));

    const config = loadConfig();
    expect(config.reviewerLlm.provider).toBe('openai');
    expect(config.reviewerLlm.model).toBe('gpt-4');
  });

  it('exits when reviewerLlm.provider is missing', () => {
    const bad = {
      ...validConfig,
      reviewerLlm: { provider: '', apiKey: 'sk-test', model: 'gpt-4' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('reviewerLlm.provider is required')
    );
  });

  it('exits when reviewerLlm API key is missing for cloud providers', () => {
    const bad = {
      ...validConfig,
      reviewerLlm: { provider: 'anthropic', apiKey: '', model: 'claude-sonnet' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing reviewerLlm API key')
    );
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

  // ── GitHub App auth validation ──────────────────────────────────────────────

  it('accepts config with only GitHub App fields (no PAT)', () => {
    const appConfig = {
      github: {
        owner: 'test-owner',
        repo: 'test-repo',
        appId: 12345,
        privateKeyPath: '/tmp/test-key.pem',
        installationId: 67890,
      },
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(appConfig));

    const config = loadConfig();
    expect(config.github.appId).toBe(12345);
    expect(config.github.installationId).toBe(67890);
  });

  it('accepts config with PAT (backwards-compatible, no app fields)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    const config = loadConfig();
    expect(config.github.token).toBe('ghp_test123');
  });

  it('exits when neither PAT nor App fields are provided', () => {
    const bad = {
      github: { owner: 'test-owner', repo: 'test-repo' },
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing GitHub auth')
    );
  });

  it('exits when partial App fields provided (appId but no privateKeyPath)', () => {
    const bad = {
      github: { owner: 'test-owner', repo: 'test-repo', appId: 12345 },
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete GitHub App config')
    );
  });

  it('exits when partial App fields provided (appId + privateKeyPath but no installationId)', () => {
    const bad = {
      github: { owner: 'test-owner', repo: 'test-repo', appId: 12345, privateKeyPath: '/tmp/key.pem' },
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete GitHub App config')
    );
  });

  it('exits when App private key file does not exist', () => {
    const bad = {
      github: {
        owner: 'test-owner',
        repo: 'test-repo',
        appId: 12345,
        privateKeyPath: '/nonexistent/key.pem',
        installationId: 67890,
      },
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
    };
    // First call: config.json exists, second call: private key does not
    vi.mocked(fs.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bad));

    expect(() => loadConfig()).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('private key file not found')
    );
  });

  it('accepts config with both PAT and App fields (PAT takes precedence via hasToken)', () => {
    const bothConfig = {
      github: {
        owner: 'test-owner',
        repo: 'test-repo',
        token: 'ghp_test123',
        appId: 12345,
        privateKeyPath: '/tmp/key.pem',
        installationId: 67890,
      },
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(bothConfig));

    // Should not throw -- both are valid, PAT is present so no validation of app fields needed
    const config = loadConfig();
    expect(config.github.token).toBe('ghp_test123');
  });

  // ── env var loading ─────────────────────────────────────────────────────────

  it('loads entirely from env vars when config.json is absent', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    process.env.GITHUB_OWNER = 'env-owner';
    process.env.GITHUB_REPO = 'env-repo';
    process.env.GITHUB_TOKEN = 'ghp_env_token';
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_API_KEY = 'sk-ant-env';
    process.env.LLM_MODEL = 'claude-sonnet-4-20250514';

    const config = loadConfig();
    expect(config.github.owner).toBe('env-owner');
    expect(config.github.repo).toBe('env-repo');
    expect(config.github.token).toBe('ghp_env_token');
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.apiKey).toBe('sk-ant-env');
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('config.json not found'));
  });

  it('env vars override config.json values', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    process.env.GITHUB_OWNER = 'override-owner';
    process.env.LLM_MODEL = 'claude-opus-4-20250514';

    const config = loadConfig();
    expect(config.github.owner).toBe('override-owner');
    expect(config.github.repo).toBe('test-repo'); // not overridden
    expect(config.llm.model).toBe('claude-opus-4-20250514');
  });

  it('GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are parsed as numbers', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    process.env.GITHUB_OWNER = 'env-owner';
    process.env.GITHUB_REPO = 'env-repo';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PEM_PATH = '/tmp/test.pem';
    process.env.GITHUB_APP_INSTALLATION_ID = '67890';
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_API_KEY = 'sk-ant-env';

    // PEM file must exist for validation
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (p === './config.json') return false;
      if (p === '/tmp/test.pem') return true;
      return false;
    });

    const config = loadConfig();
    expect(config.github.appId).toBe(12345);
    expect(typeof config.github.appId).toBe('number');
    expect(config.github.installationId).toBe(67890);
    expect(typeof config.github.installationId).toBe('number');
  });

  it('TRIAGE_LLM_* env vars create triageLlm section', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    process.env.TRIAGE_LLM_PROVIDER = 'anthropic';
    process.env.TRIAGE_LLM_API_KEY = 'sk-ant-triage';
    process.env.TRIAGE_LLM_MODEL = 'claude-haiku-4-5-20251001';

    const config = loadConfig();
    expect(config.triageLlm).toBeDefined();
    expect(config.triageLlm.provider).toBe('anthropic');
    expect(config.triageLlm.apiKey).toBe('sk-ant-triage');
    expect(config.triageLlm.model).toBe('claude-haiku-4-5-20251001');
  });

  it('REVIEWER_LLM_* env vars create reviewerLlm section', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    process.env.REVIEWER_LLM_PROVIDER = 'openai';
    process.env.REVIEWER_LLM_API_KEY = 'sk-openai-rev';
    process.env.REVIEWER_LLM_MODEL = 'gpt-4';

    const config = loadConfig();
    expect(config.reviewerLlm).toBeDefined();
    expect(config.reviewerLlm.provider).toBe('openai');
    expect(config.reviewerLlm.apiKey).toBe('sk-openai-rev');
    expect(config.reviewerLlm.model).toBe('gpt-4');
  });

  it('WEBHOOK_PORT and WEBHOOK_SECRET from env vars', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    process.env.WEBHOOK_PORT = '4000';
    process.env.WEBHOOK_SECRET = 'env-secret-123';

    const config = loadConfig();
    expect(config.webhook.port).toBe(4000);
    expect(config.webhook.secret).toBe('env-secret-123');
  });

  it('MAX_ISSUES_PER_RUN and MAX_TOOL_CALLS_PER_RUN from env vars', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

    process.env.MAX_ISSUES_PER_RUN = '10';
    process.env.MAX_TOOL_CALLS_PER_RUN = '50';

    const config = loadConfig();
    expect(config.maxIssuesPerRun).toBe(10);
    expect(config.maxToolCallsPerRun).toBe(50);
  });

  // ── localhost-https warnings ─────────────────────────────────────────────────

  it('warns on https://localhost baseUrl', () => {
    const httpsLocalConfig = {
      ...validConfig,
      llm: { provider: 'openai-compatible', apiKey: '', model: 'model', baseUrl: 'https://localhost:11434/v1' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(httpsLocalConfig));

    loadConfig();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTPS for localhost')
    );
  });

  it('warns on https://127.0.0.1 baseUrl', () => {
    const httpsLoopbackConfig = {
      ...validConfig,
      llm: { provider: 'openai-compatible', apiKey: '', model: 'model', baseUrl: 'https://127.0.0.1:11434/v1' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(httpsLoopbackConfig));

    loadConfig();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTPS for localhost')
    );
  });

  it('does NOT warn on http://localhost baseUrl', () => {
    const httpLocalConfig = {
      ...validConfig,
      llm: { provider: 'openai-compatible', apiKey: '', model: 'model', baseUrl: 'http://localhost:11434/v1' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(httpLocalConfig));

    loadConfig();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does NOT warn on https://api.openai.com baseUrl', () => {
    const cloudConfig = {
      ...validConfig,
      llm: { provider: 'openai-compatible', apiKey: 'sk-test', model: 'model', baseUrl: 'https://api.openai.com/v1' },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cloudConfig));

    loadConfig();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('logs info when config.json is absent but env vars are sufficient', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    process.env.GITHUB_OWNER = 'env-owner';
    process.env.GITHUB_REPO = 'env-repo';
    process.env.GITHUB_TOKEN = 'ghp_env_token';
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_API_KEY = 'sk-ant-env';

    loadConfig();
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('config.json not found')
    );
  });
});
