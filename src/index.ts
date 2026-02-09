import 'dotenv/config';
import { loadConfig } from './config.js';
import { runPollCycle, requestShutdown } from './core.js';

// ── Signal handlers for graceful shutdown ────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, finishing current work...');
  requestShutdown();
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, finishing current work...');
  requestShutdown();
});

/**
 * Original entry point -- preserved for backwards compatibility.
 *
 * Runs a single poll cycle (equivalent to `deepagents poll`).
 * New users should prefer the CLI: `npx deepagents poll`
 */
async function main() {
  const config = loadConfig();
  console.log('\u{1F916} Deep Agents GitHub Issue Poller\n');
  await runPollCycle(config);
}

main().catch((error) => {
  console.error('\u{274C} Error:', error);
  process.exitCode = 1;
});
