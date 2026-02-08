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

  // Validate required fields
  if (!config.github.owner || !config.github.repo || !config.github.token) {
    console.error('❌ Missing required GitHub config: owner, repo, token');
    process.exit(1);
  }

  if (!config.llm.apiKey) {
    console.error('❌ Missing LLM API key');
    process.exit(1);
  }

  return config;
}

export type Config = ReturnType<typeof loadConfig>;