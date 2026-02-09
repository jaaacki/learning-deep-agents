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
 * Load config from env vars and/or config.json file.
 * Env vars override config.json values (nullish coalescing).
 */
export function loadConfig() {
  const configPath = './config.json';

  // 1. Read config.json if present (no longer fatal if missing)
  let fileConfig: any = {};
  if (fs.existsSync(configPath)) {
    const configFile = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(configFile);
  } else {
    console.info('ℹ️  config.json not found — loading configuration from environment variables.');
  }

  // 2. Build merged config: env vars override file values
  const fileGithub = fileConfig.github || {};
  const fileLlm = fileConfig.llm || {};

  const config: any = {
    github: {
      owner: process.env.GITHUB_OWNER ?? fileGithub.owner,
      repo: process.env.GITHUB_REPO ?? fileGithub.repo,
      token: process.env.GITHUB_TOKEN ?? fileGithub.token,
      appId: parseIntEnv('GITHUB_APP_ID') ?? fileGithub.appId,
      privateKeyPath: process.env.GITHUB_APP_PEM_PATH ?? fileGithub.privateKeyPath,
      installationId: parseIntEnv('GITHUB_APP_INSTALLATION_ID') ?? fileGithub.installationId,
    },
    llm: {
      provider: process.env.LLM_PROVIDER ?? fileLlm.provider,
      apiKey: process.env.LLM_API_KEY ?? fileLlm.apiKey,
      model: process.env.LLM_MODEL ?? fileLlm.model,
      baseUrl: process.env.LLM_BASE_URL ?? fileLlm.baseUrl,
    },
    maxIssuesPerRun: parseIntEnv('MAX_ISSUES_PER_RUN') ?? fileConfig.maxIssuesPerRun,
    maxToolCallsPerRun: parseIntEnv('MAX_TOOL_CALLS_PER_RUN') ?? fileConfig.maxToolCallsPerRun,
  };

  // triageLlm: env vars (all-or-nothing) ?? config.json
  const triageFromEnv = readLlmFromEnv('TRIAGE_LLM');
  config.triageLlm = triageFromEnv ?? fileConfig.triageLlm;

  // reviewerLlm: env vars (all-or-nothing) ?? config.json
  const reviewerFromEnv = readLlmFromEnv('REVIEWER_LLM');
  config.reviewerLlm = reviewerFromEnv ?? fileConfig.reviewerLlm;

  // webhook: env vars ?? config.json
  const webhookPort = parseIntEnv('WEBHOOK_PORT');
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookPort !== undefined || webhookSecret) {
    config.webhook = {
      port: webhookPort ?? fileConfig.webhook?.port,
      secret: webhookSecret ?? fileConfig.webhook?.secret,
    };
  } else {
    config.webhook = fileConfig.webhook;
  }

  // 3. Validate required fields
  if (!config.github.owner || !config.github.repo) {
    console.error('❌ Missing required GitHub config: owner, repo. Set GITHUB_OWNER/GITHUB_REPO env vars or provide config.json.');
    process.exit(1);
  }

  // Auth: either PAT (token) or GitHub App (appId + privateKeyPath + installationId)
  const hasToken = !!config.github.token;
  const hasAppId = typeof config.github.appId === 'number';
  const hasPrivateKeyPath = !!config.github.privateKeyPath;
  const hasInstallationId = typeof config.github.installationId === 'number';
  const appFieldCount = [hasAppId, hasPrivateKeyPath, hasInstallationId].filter(Boolean).length;

  if (!hasToken && appFieldCount === 0) {
    console.error('❌ Missing GitHub auth: provide either token (PAT) or appId + privateKeyPath + installationId (GitHub App)');
    process.exit(1);
  }

  if (!hasToken && appFieldCount > 0 && appFieldCount < 3) {
    console.error('❌ Incomplete GitHub App config: all three fields required (appId, privateKeyPath, installationId)');
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
    console.error('❌ Missing LLM API key');
    process.exit(1);
  }

  // triageLlm validation
  if (config.triageLlm) {
    if (!config.triageLlm.provider) {
      console.error('❌ triageLlm.provider is required when triageLlm is specified');
      process.exit(1);
    }
    if (!config.triageLlm.apiKey && !localProviders.includes(config.triageLlm.provider)) {
      console.error('❌ Missing triageLlm API key');
      process.exit(1);
    }
  }

  // reviewerLlm validation
  if (config.reviewerLlm) {
    if (!config.reviewerLlm.provider) {
      console.error('❌ reviewerLlm.provider is required when reviewerLlm is specified');
      process.exit(1);
    }
    if (!config.reviewerLlm.apiKey && !localProviders.includes(config.reviewerLlm.provider)) {
      console.error('❌ Missing reviewerLlm API key');
      process.exit(1);
    }
  }

  // webhook validation
  if (config.webhook) {
    if (typeof config.webhook.port !== 'number' || config.webhook.port < 1 || config.webhook.port > 65535) {
      console.error('❌ webhook.port must be a number between 1 and 65535');
      process.exit(1);
    }
    if (!config.webhook.secret || typeof config.webhook.secret !== 'string') {
      console.error('❌ webhook.secret is required when webhook is configured');
      process.exit(1);
    }
  }

  // localhost-https warnings
  warnLocalhostHttps('llm', config.llm.baseUrl);
  if (config.triageLlm) warnLocalhostHttps('triageLlm', config.triageLlm.baseUrl);
  if (config.reviewerLlm) warnLocalhostHttps('reviewerLlm', config.reviewerLlm.baseUrl);

  return config;
}

export type Config = ReturnType<typeof loadConfig>;
