import fs from 'fs';

/**
 * Load config from config.json file in project root
 */
export function loadConfig() {
  const configPath = './config.json';

  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found. Copy config.json.example to config.json and fill in your credentials.');
    process.exit(1);
  }

  const configFile = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(configFile);

  // Validate required fields: owner and repo are always required
  if (!config.github.owner || !config.github.repo) {
    console.error('❌ Missing required GitHub config: owner, repo');
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
    // Validate that the private key file exists
    if (!fs.existsSync(config.github.privateKeyPath)) {
      console.error(`❌ GitHub App private key file not found: ${config.github.privateKeyPath}`);
      process.exit(1);
    }
  }

  // API key is required for cloud providers, optional for local (ollama, openai-compatible)
  const localProviders = ['ollama', 'openai-compatible'];
  if (!config.llm.apiKey && !localProviders.includes(config.llm.provider)) {
    console.error('❌ Missing LLM API key');
    process.exit(1);
  }

  // Validate triageLlm if present (optional -- falls back to main llm)
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

  // Validate webhook config if present (optional -- only needed for `deepagents webhook`)
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

  return config;
}

export type Config = ReturnType<typeof loadConfig>;
