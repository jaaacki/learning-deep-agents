import { createHmac, timingSafeEqual } from 'crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

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

    // Log the event (actual handling deferred to #13/#14)
    const action = typeof payload.action === 'string' ? payload.action : '';
    console.log(
      `[webhook] Received: ${event}${action ? `.${action}` : ''} ` +
      `(delivery: ${webhookEvent.deliveryId})`,
    );

    res.status(200).json({ received: true, event, deliveryId: webhookEvent.deliveryId });
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
