import { loadConfig } from './config.js';
import { runPollCycle } from './core.js';

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
  process.exit(1);
});
