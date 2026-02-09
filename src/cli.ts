#!/usr/bin/env node

import { loadConfig } from './config.js';
import { runPollCycle, runAnalyzeSingle, runTriageSingle, showStatus, retractIssue, requestShutdown } from './core.js';
import { startWebhookServer } from './listener.js';
import { runReviewSingle } from './reviewer-agent.js';

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
 * CLI entry point for the Deep Agents GitHub Issue Poller.
 *
 * Usage:
 *   deepagents poll [--no-save] [--max-issues N]
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
  triage            Run triage on a single issue (classify without side effects)
  review            Review a pull request (fetch diff, analyze, post review comment)
  retract           Undo agent actions on an issue (close PR, delete branch, delete comment)
  webhook           Start the HTTP webhook listener for GitHub events
  status            Show current polling state
  help              Show this help message

Options for 'poll':
  --dry-run           Skip all GitHub writes (comments, branches, PRs) and poll state save
  --no-save           Run without saving poll state (GitHub writes still execute)
  --max-issues N      Override maxIssuesPerRun from config
  --max-tool-calls N  Override maxToolCallsPerRun from config (circuit breaker)

Options for 'analyze':
  --issue N         Issue number to analyze (required)

Options for 'triage':
  --issue N         Issue number to triage (required)

Options for 'review':
  --pr N            Pull request number to review (required)

Options for 'retract':
  --issue N         Issue number to retract (required)

Examples:
  deepagents poll
  deepagents poll --dry-run
  deepagents poll --no-save
  deepagents poll --max-issues 3
  deepagents analyze --issue 42
  deepagents triage --issue 42
  deepagents review --pr 10
  deepagents retract --issue 42
  deepagents webhook
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
    } else if (arg === '--no-save') {
      flags['no-save'] = true;
    } else if (arg === '--max-issues' && i + 1 < args.length) {
      flags['max-issues'] = args[++i];
    } else if (arg === '--max-tool-calls' && i + 1 < args.length) {
      flags['max-tool-calls'] = args[++i];
    } else if (arg === '--issue' && i + 1 < args.length) {
      flags['issue'] = args[++i];
    } else if (arg === '--pr' && i + 1 < args.length) {
      flags['pr'] = args[++i];
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
      const noSave = flags['no-save'] === true;
      const maxIssuesStr = flags['max-issues'];
      const maxIssues = typeof maxIssuesStr === 'string' ? parseInt(maxIssuesStr, 10) : undefined;
      const maxToolCallsStr = flags['max-tool-calls'];
      const maxToolCalls = typeof maxToolCallsStr === 'string' ? parseInt(maxToolCallsStr, 10) : undefined;

      if (maxIssues !== undefined && (isNaN(maxIssues) || maxIssues < 1)) {
        console.error('--max-issues must be a positive integer');
        process.exit(1);
      }

      if (maxToolCalls !== undefined && (isNaN(maxToolCalls) || maxToolCalls < 1)) {
        console.error('--max-tool-calls must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents GitHub Issue Poller\n');
      await runPollCycle(config, { dryRun, noSave, maxIssues, maxToolCalls });
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

    case 'triage': {
      const triageIssueStr = flags['issue'];
      if (!triageIssueStr || typeof triageIssueStr !== 'string') {
        console.error('--issue N is required for the triage command');
        console.log('\nUsage: deepagents triage --issue 42');
        process.exit(1);
      }

      const triageIssueNumber = parseInt(triageIssueStr, 10);
      if (isNaN(triageIssueNumber) || triageIssueNumber < 1) {
        console.error('--issue must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents Triage\n');
      await runTriageSingle(config, triageIssueNumber);
      break;
    }

    case 'review': {
      const prStr = flags['pr'];
      if (!prStr || typeof prStr !== 'string') {
        console.error('--pr N is required for the review command');
        console.log('\nUsage: deepagents review --pr 10');
        process.exit(1);
      }

      const prNumber = parseInt(prStr, 10);
      if (isNaN(prNumber) || prNumber < 1) {
        console.error('--pr must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents PR Reviewer\n');
      await runReviewSingle(config, prNumber);
      break;
    }

    case 'retract': {
      const retractIssueStr = flags['issue'];
      if (!retractIssueStr || typeof retractIssueStr !== 'string') {
        console.error('--issue N is required for the retract command');
        console.log('\nUsage: deepagents retract --issue 42');
        process.exit(1);
      }

      const retractIssueNumber = parseInt(retractIssueStr, 10);
      if (isNaN(retractIssueNumber) || retractIssueNumber < 1) {
        console.error('--issue must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents Retract\n');
      console.log(`Retracting actions for issue #${retractIssueNumber}...\n`);

      const retractResult = await retractIssue(config, retractIssueNumber);

      console.log('\nRetraction summary:');
      console.log(`  PR closed:       ${retractResult.prClosed ? 'yes' : 'no'}`);
      console.log(`  Branch deleted:   ${retractResult.branchDeleted ? 'yes' : 'no'}`);
      console.log(`  Comment deleted:  ${retractResult.commentDeleted ? 'yes' : 'no'}`);
      if (retractResult.errors.length > 0) {
        console.log(`  Errors:          ${retractResult.errors.length}`);
        for (const err of retractResult.errors) {
          console.log(`    - ${err}`);
        }
      }
      break;
    }

    case 'webhook': {
      if (!config.webhook) {
        console.error('Webhook config is required. Set WEBHOOK_PORT and WEBHOOK_SECRET in .env');
        process.exit(1);
      }
      console.log('\u{1F916} Deep Agents Webhook Listener\n');
      startWebhookServer(config.webhook, config);
      // Server runs until process is killed (SIGTERM/SIGINT)
      break;
    }

    case 'no-save': {
      // Shorthand for `poll --no-save`
      console.log('\u{1F916} Deep Agents GitHub Issue Poller (No-Save Mode)\n');
      await runPollCycle(config, { noSave: true });
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
  process.exitCode = 1;
});
