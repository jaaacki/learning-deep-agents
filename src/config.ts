import fs from 'fs';

/**
 * Read an LLM config section from env vars with a given prefix.
 * Returns undefined if {PREFIX}_PROVIDER is not set (all-or-nothing).
 */
function readLlmFromEnv(prefix: string) {
  const provider = process.env[`${prefix}_PROVIDER`];
  if (!provider) return undefined;
  return {
    provider,
    apiKey: process.env[`${prefix}_API_KEY`] || null,
    model: process.env[`${prefix}_MODEL`] || null,
    baseUrl: process.env[`${prefix}_BASE_URL`] || null,
  };
}

/**
 * Parse an env var as an integer. Returns undefined if not set or not a valid integer.
 */
function parseIntEnv(name: string): number | undefined {
  const val = process.env[name];
  if (val === undefined || val === '') return undefined;
  const num = parseInt(val, 10);
  if (isNaN(num)) return undefined;
  return num;
}

/**
 * Warn if a baseUrl points to localhost/127.0.0.1 over HTTPS (common Ollama gotcha).
 */
function warnLocalhostHttps(label: string, baseUrl: string | null | undefined) {
  if (!baseUrl) return;
  try {
    const url = new URL(baseUrl);
    if (url.protocol === 'https:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
      console.warn(`⚠️  ${label} baseUrl uses HTTPS for localhost — did you mean http://?`);
    }
  } catch {
    // Invalid URL — validation will catch it elsewhere
  }
}

/**
 * Load config entirely from environment variables.
 * Copy .env.example to .env and fill in your credentials.
 */
export function loadConfig() {
  const config: any = {
    github: {
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      token: process.env.GITHUB_TOKEN,
      appId: parseIntEnv('GITHUB_APP_ID'),
      privateKeyPath: process.env.GITHUB_APP_PEM_PATH,
      installationId: parseIntEnv('GITHUB_APP_INSTALLATION_ID'),
    },
    llm: {
      provider: process.env.LLM_PROVIDER,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
      baseUrl: process.env.LLM_BASE_URL || null,
    },
    maxIssuesPerRun: parseIntEnv('MAX_ISSUES_PER_RUN'),
    maxToolCallsPerRun: parseIntEnv('MAX_TOOL_CALLS_PER_RUN'),
  };

  // triageLlm (all-or-nothing: only if PROVIDER is set)
  config.triageLlm = readLlmFromEnv('TRIAGE_LLM');

  // reviewerLlm (all-or-nothing: only if PROVIDER is set)
  config.reviewerLlm = readLlmFromEnv('REVIEWER_LLM');

  // webhook
  const webhookPort = parseIntEnv('WEBHOOK_PORT');
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookPort !== undefined || webhookSecret) {
    config.webhook = {
      port: webhookPort,
      secret: webhookSecret,
    };
  }

  // Validate required fields
  if (!config.github.owner || !config.github.repo) {
    console.error('❌ Missing required config: GITHUB_OWNER and GITHUB_REPO. Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  // Auth: either PAT (token) or GitHub App (appId + privateKeyPath + installationId)
  const hasToken = !!config.github.token;
  const hasAppId = typeof config.github.appId === 'number';
  const hasPrivateKeyPath = !!config.github.privateKeyPath;
  const hasInstallationId = typeof config.github.installationId === 'number';
  const appFieldCount = [hasAppId, hasPrivateKeyPath, hasInstallationId].filter(Boolean).length;

  if (!hasToken && appFieldCount === 0) {
    console.error('❌ Missing GitHub auth: set GITHUB_TOKEN or GITHUB_APP_ID + GITHUB_APP_PEM_PATH + GITHUB_APP_INSTALLATION_ID');
    process.exit(1);
  }

  if (!hasToken && appFieldCount > 0 && appFieldCount < 3) {
    console.error('❌ Incomplete GitHub App config: all three required (GITHUB_APP_ID, GITHUB_APP_PEM_PATH, GITHUB_APP_INSTALLATION_ID)');
    process.exit(1);
  }

  if (!hasToken && appFieldCount === 3) {
    if (!fs.existsSync(config.github.privateKeyPath)) {
      console.error(`❌ GitHub App private key file not found: ${config.github.privateKeyPath}`);
      process.exit(1);
    }
  }

  // LLM validation
  const localProviders = ['ollama', 'openai-compatible'];
  if (!config.llm.apiKey && !localProviders.includes(config.llm.provider)) {
    console.error('❌ Missing LLM_API_KEY (required for cloud providers)');
    process.exit(1);
  }

  // triageLlm validation
  if (config.triageLlm) {
    if (!config.triageLlm.provider) {
      console.error('❌ TRIAGE_LLM_PROVIDER is required when any TRIAGE_LLM_* vars are set');
      process.exit(1);
    }
    if (!config.triageLlm.apiKey && !localProviders.includes(config.triageLlm.provider)) {
      console.error('❌ Missing TRIAGE_LLM_API_KEY (required for cloud providers)');
      process.exit(1);
    }
  }

  // reviewerLlm validation
  if (config.reviewerLlm) {
    if (!config.reviewerLlm.provider) {
      console.error('❌ REVIEWER_LLM_PROVIDER is required when any REVIEWER_LLM_* vars are set');
      process.exit(1);
    }
    if (!config.reviewerLlm.apiKey && !localProviders.includes(config.reviewerLlm.provider)) {
      console.error('❌ Missing REVIEWER_LLM_API_KEY (required for cloud providers)');
      process.exit(1);
    }
  }

  // webhook validation
  if (config.webhook) {
    if (typeof config.webhook.port !== 'number' || config.webhook.port < 1 || config.webhook.port > 65535) {
      console.error('❌ WEBHOOK_PORT must be a number between 1 and 65535');
      process.exit(1);
    }
    if (!config.webhook.secret || typeof config.webhook.secret !== 'string') {
      console.error('❌ WEBHOOK_SECRET is required when WEBHOOK_PORT is set');
      process.exit(1);
    }
  }

  // localhost-https warnings
  warnLocalhostHttps('LLM_BASE_URL', config.llm.baseUrl);
  if (config.triageLlm) warnLocalhostHttps('TRIAGE_LLM_BASE_URL', config.triageLlm.baseUrl);
  if (config.reviewerLlm) warnLocalhostHttps('REVIEWER_LLM_BASE_URL', config.reviewerLlm.baseUrl);

  return config;
}

export type Config = ReturnType<typeof loadConfig>;
