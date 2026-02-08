import { createHmac, timingSafeEqual } from 'crypto';
import express from 'express';
import type { Request, Response } from 'express';

/**
 * Webhook listener configuration.
 */
export interface WebhookConfig {
  port: number;
  secret: string;
}

/**
 * Parsed webhook event — the data extracted from a GitHub webhook delivery.
 */
export interface WebhookEvent {
  /** GitHub event type from X-GitHub-Event header (e.g. "issues", "pull_request") */
  event: string;
  /** Unique delivery ID from X-GitHub-Delivery header */
  deliveryId: string;
  /** The parsed JSON payload */
  payload: Record<string, unknown>;
}

/** Marker that identifies PRs created by this bot. */
export const BOT_PR_MARKER = '<!-- deep-agent-pr -->';

/** Branch naming pattern used by the bot: issue-N-description */
const BOT_BRANCH_RE = /^issue-\d+-/;

/**
 * Extracted metadata from a pull_request.opened payload.
 */
export interface PrOpenedData {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
}

/**
 * Result of handling a pull_request.opened event.
 * The `reviewQueued` field indicates whether the PR was recognized as
 * bot-created and queued for future review (Issue #15).
 */
export interface PrHandlerResult {
  handled: boolean;
  reviewQueued: boolean;
  reason: string;
  pr?: PrOpenedData;
}

/**
 * Stub interface for the future PR reviewer (Issue #15).
 * When the reviewer bot is implemented, it will satisfy this interface
 * and be wired into handlePullRequestEvent.
 */
export interface PrReviewStub {
  reviewPr(pr: PrOpenedData): Promise<void>;
}

/**
 * Check if a PR was created by this bot.
 * Uses two signals: the HTML marker in the PR body, or the branch naming convention.
 */
export function isBotPr(body: string, headRef: string): boolean {
  return body.includes(BOT_PR_MARKER) || BOT_BRANCH_RE.test(headRef);
}

/**
 * Handle a pull_request.opened webhook event.
 *
 * - If the PR was created by the bot, log it as queued for review and return.
 *   (The actual reviewer bot will be added in Issue #15.)
 * - If the PR was NOT created by the bot, ignore it.
 * - Returns immediately (fire-and-forget pattern for the webhook endpoint).
 */
export function handlePullRequestEvent(event: WebhookEvent): PrHandlerResult {
  const { payload } = event;

  if (payload.action !== 'opened') {
    return { handled: false, reviewQueued: false, reason: `Ignored action: ${payload.action}` };
  }

  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr || typeof pr.number !== 'number') {
    console.error(`[webhook] pull_request.opened missing PR data (delivery: ${event.deliveryId})`);
    return { handled: false, reviewQueued: false, reason: 'Missing PR data in payload' };
  }

  const head = pr.head as Record<string, unknown> | undefined;
  const base = pr.base as Record<string, unknown> | undefined;

  const prData: PrOpenedData = {
    number: pr.number as number,
    title: (pr.title as string) ?? '',
    body: (pr.body as string) ?? '',
    headRef: (head?.ref as string) ?? '',
    baseRef: (base?.ref as string) ?? '',
    draft: (pr.draft as boolean) ?? false,
  };

  if (!isBotPr(prData.body, prData.headRef)) {
    console.log(
      `[webhook] PR #${prData.number} not created by bot, ignoring ` +
      `(delivery: ${event.deliveryId})`,
    );
    return { handled: true, reviewQueued: false, reason: 'PR not created by bot', pr: prData };
  }

  // Bot-created PR — queue for review (stub until Issue #15)
  console.log(
    `[webhook] PR #${prData.number} "${prData.title}" queued for review ` +
    `(delivery: ${event.deliveryId}) [reviewer not implemented yet]`,
  );

  return {
    handled: true,
    reviewQueued: true,
    reason: 'Queued for review (reviewer not implemented yet — see Issue #15)',
    pr: prData,
  };
}

/**
 * Dispatch a parsed webhook event to the appropriate handler.
 * Returns the handler result, or null if no handler matched.
 */
export function handleWebhookEvent(event: WebhookEvent): PrHandlerResult | null {
  if (event.event === 'pull_request') {
    return handlePullRequestEvent(event);
  }

  // Other event types will be added here (e.g. issues.opened from #13)
  return null;
}

/**
 * Verify the HMAC-SHA256 signature on a GitHub webhook payload.
 *
 * GitHub sends the signature in the `X-Hub-Signature-256` header as
 * `sha256=<hex>`. We compute the expected HMAC over the raw body and
 * compare with timing-safe equality to prevent timing attacks.
 *
 * Returns true if the signature is valid, false otherwise.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = parts[1];

  // Compare as UTF-8 strings, not decoded hex, to avoid Buffer.from('hex')
  // silently dropping invalid hex characters and producing different-length buffers.
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(actual, 'utf-8'));
}

/**
 * Create and configure the Express app for receiving GitHub webhooks.
 *
 * The app has two endpoints:
 * - GET  /health  — health check (returns 200 with JSON status)
 * - POST /webhook — receives GitHub webhook payloads
 *
 * The webhook endpoint verifies the HMAC signature, parses the event
 * type and delivery ID from headers, and logs the event. Actual event
 * handling (dispatching to agent workflows) is deferred to Issue #13/#14.
 */
export function createWebhookApp(config: WebhookConfig): express.Express {
  const app = express();

  // Parse raw body for HMAC verification, then JSON
  app.use(
    '/webhook',
    express.raw({ type: 'application/json' }),
  );

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Webhook receiver
  app.post('/webhook', (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;

    // Verify signature
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifySignature(config.secret, rawBody, signature)) {
      console.error('[webhook] Signature verification failed');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Parse event metadata from headers
    const event = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!event) {
      res.status(400).json({ error: 'Missing X-GitHub-Event header' });
      return;
    }

    // Parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    const webhookEvent: WebhookEvent = {
      event,
      deliveryId: deliveryId ?? 'unknown',
      payload,
    };

    // Log the event
    const action = typeof payload.action === 'string' ? payload.action : '';
    console.log(
      `[webhook] Received: ${event}${action ? `.${action}` : ''} ` +
      `(delivery: ${webhookEvent.deliveryId})`,
    );

    // Fire-and-forget: respond 200 immediately, then dispatch
    res.status(200).json({ received: true, event, deliveryId: webhookEvent.deliveryId });

    // Dispatch to event handlers (async, after response is sent)
    try {
      handleWebhookEvent(webhookEvent);
    } catch (err) {
      console.error(`[webhook] Handler error for ${event}.${action}:`, err);
    }
  });

  return app;
}

/**
 * Start the webhook listener HTTP server.
 *
 * Returns the HTTP server instance so callers can close it for graceful
 * shutdown or in tests.
 */
export function startWebhookServer(config: WebhookConfig) {
  const app = createWebhookApp(config);

  const server = app.listen(config.port, () => {
    console.log(`[webhook] Listening on port ${config.port}`);
    console.log(`[webhook] Health check: http://localhost:${config.port}/health`);
    console.log(`[webhook] Webhook URL:  http://localhost:${config.port}/webhook`);
    console.log('[webhook] Waiting for GitHub events...\n');
  });

  return server;
}
