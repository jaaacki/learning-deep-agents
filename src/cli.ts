#!/usr/bin/env node

import { loadConfig } from './config.js';
import { runPollCycle, runAnalyzeSingle, showStatus } from './core.js';

/**
 * CLI entry point for the Deep Agents GitHub Issue Poller.
 *
 * Usage:
 *   deepagents poll [--dry-run] [--max-issues N]
 *   deepagents analyze --issue N
 *   deepagents status
 *
 * No external CLI framework -- uses manual process.argv parsing.
 */

const USAGE = `
Usage: deepagents <command> [options]

Commands:
  poll              Run a poll cycle: fetch, analyze, comment, branch, PR
  analyze           Analyze a single issue by number
  status            Show current polling state
  help              Show this help message

Options for 'poll':
  --dry-run         Run without saving poll state (no write operations skipped)
  --max-issues N    Override maxIssuesPerRun from config

Options for 'analyze':
  --issue N         Issue number to analyze (required)

Examples:
  deepagents poll
  deepagents poll --dry-run
  deepagents poll --max-issues 3
  deepagents analyze --issue 42
  deepagents status
`.trim();

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  // argv[0] = node, argv[1] = script, argv[2+] = user args
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      flags['dry-run'] = true;
    } else if (arg === '--max-issues' && i + 1 < args.length) {
      flags['max-issues'] = args[++i];
    } else if (arg === '--issue' && i + 1 < args.length) {
      flags['issue'] = args[++i];
    } else {
      console.error(`Unknown option: ${arg}`);
      console.log(USAGE);
      process.exit(1);
    }
  }

  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  // All commands except 'help' need config
  const config = loadConfig();

  switch (command) {
    case 'poll': {
      const dryRun = flags['dry-run'] === true;
      const maxIssuesStr = flags['max-issues'];
      const maxIssues = typeof maxIssuesStr === 'string' ? parseInt(maxIssuesStr, 10) : undefined;

      if (maxIssues !== undefined && (isNaN(maxIssues) || maxIssues < 1)) {
        console.error('--max-issues must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents GitHub Issue Poller\n');
      await runPollCycle(config, { dryRun, maxIssues });
      break;
    }

    case 'analyze': {
      const issueStr = flags['issue'];
      if (!issueStr || typeof issueStr !== 'string') {
        console.error('--issue N is required for the analyze command');
        console.log('\nUsage: deepagents analyze --issue 42');
        process.exit(1);
      }

      const issueNumber = parseInt(issueStr, 10);
      if (isNaN(issueNumber) || issueNumber < 1) {
        console.error('--issue must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents GitHub Issue Analyzer\n');
      await runAnalyzeSingle(config, issueNumber);
      break;
    }

    case 'dry-run': {
      // Shorthand for `poll --dry-run`
      console.log('\u{1F916} Deep Agents GitHub Issue Poller (Dry Run)\n');
      await runPollCycle(config, { dryRun: true });
      break;
    }

    case 'status': {
      showStatus(config);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('\u{274C} Error:', error);
  process.exit(1);
});
