import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { createWebhookApp, verifySignature } from '../src/listener.js';
import type { WebhookConfig } from '../src/listener.js';

// ── verifySignature ──────────────────────────────────────────────────────────

describe('verifySignature', () => {
  const secret = 'test-secret-123';

  function sign(body: string): string {
    const hmac = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${hmac}`;
  }

  it('returns true for a valid signature', () => {
    const body = '{"action":"opened"}';
    const rawBody = Buffer.from(body, 'utf-8');
    const signature = sign(body);

    expect(verifySignature(secret, rawBody, signature)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    const body = '{"action":"opened"}';
    const rawBody = Buffer.from(body, 'utf-8');

    expect(verifySignature(secret, rawBody, 'sha256=badhex0000000000000000000000000000000000000000000000000000000000')).toBe(false);
  });

  it('returns false when signature header is undefined', () => {
    const rawBody = Buffer.from('{}', 'utf-8');
    expect(verifySignature(secret, rawBody, undefined)).toBe(false);
  });

  it('returns false when signature header has wrong prefix', () => {
    const body = '{}';
    const rawBody = Buffer.from(body, 'utf-8');
    const hmac = createHmac('sha256', secret).update(body).digest('hex');

    expect(verifySignature(secret, rawBody, `sha1=${hmac}`)).toBe(false);
  });

  it('returns false when signature header has no = separator', () => {
    const rawBody = Buffer.from('{}', 'utf-8');
    expect(verifySignature(secret, rawBody, 'noseparator')).toBe(false);
  });

  it('returns false for tampered body', () => {
    const original = '{"action":"opened"}';
    const tampered = '{"action":"closed"}';
    const signature = sign(original);

    expect(verifySignature(secret, Buffer.from(tampered, 'utf-8'), signature)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const body = '{"action":"opened"}';
    const rawBody = Buffer.from(body, 'utf-8');
    const signature = sign(body);

    expect(verifySignature('wrong-secret', rawBody, signature)).toBe(false);
  });
});

// ── createWebhookApp ─────────────────────────────────────────────────────────

describe('createWebhookApp', () => {
  const config: WebhookConfig = { port: 3000, secret: 'test-secret-123' };

  function sign(body: string): string {
    const hmac = createHmac('sha256', config.secret).update(body).digest('hex');
    return `sha256=${hmac}`;
  }

  /**
   * Inject a request into the Express app and capture the response.
   * Uses Node's built-in http module to avoid adding supertest as a dep.
   */
  async function inject(
    app: ReturnType<typeof createWebhookApp>,
    method: string,
    path: string,
    opts: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> {
    const { default: http } = await import('http');

    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') { server.close(); reject(new Error('bad addr')); return; }

        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path,
            method,
            headers: {
              ...(opts.body ? { 'content-type': 'application/json' } : {}),
              ...opts.headers,
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              server.close();
              try {
                resolve({ status: res.statusCode!, body: JSON.parse(data) });
              } catch {
                resolve({ status: res.statusCode!, body: data });
              }
            });
          },
        );

        req.on('error', (err) => { server.close(); reject(err); });
        if (opts.body) req.write(opts.body);
        req.end();
      });
    });
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /health returns 200 with status ok', async () => {
    const app = createWebhookApp(config);
    const res = await inject(app, 'GET', '/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('POST /webhook returns 401 for missing signature', async () => {
    const app = createWebhookApp(config);
    const body = '{"action":"opened"}';

    const res = await inject(app, 'POST', '/webhook', {
      body,
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': 'test-delivery-1',
      },
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('POST /webhook returns 401 for invalid signature', async () => {
    const app = createWebhookApp(config);
    const body = '{"action":"opened"}';

    const res = await inject(app, 'POST', '/webhook', {
      body,
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': 'test-delivery-2',
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('POST /webhook returns 400 for missing X-GitHub-Event header', async () => {
    const app = createWebhookApp(config);
    const body = '{"action":"opened"}';

    const res = await inject(app, 'POST', '/webhook', {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-delivery': 'test-delivery-3',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing X-GitHub-Event header');
  });

  it('POST /webhook returns 200 for valid webhook delivery', async () => {
    const app = createWebhookApp(config);
    const payload = { action: 'opened', issue: { number: 42, title: 'Test issue' } };
    const body = JSON.stringify(payload);

    const res = await inject(app, 'POST', '/webhook', {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-abc',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.event).toBe('issues');
    expect(res.body.deliveryId).toBe('delivery-abc');
  });

  it('POST /webhook logs event type and action', async () => {
    const app = createWebhookApp(config);
    const payload = { action: 'labeled' };
    const body = JSON.stringify(payload);

    await inject(app, 'POST', '/webhook', {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-log',
      },
    });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('issues.labeled'),
    );
  });

  it('POST /webhook handles missing delivery ID gracefully', async () => {
    const app = createWebhookApp(config);
    const payload = { action: 'opened' };
    const body = JSON.stringify(payload);

    const res = await inject(app, 'POST', '/webhook', {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'push',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.deliveryId).toBe('unknown');
  });

  it('POST /webhook returns 400 for invalid JSON body', async () => {
    const app = createWebhookApp(config);
    const body = 'not-json{{{';

    const res = await inject(app, 'POST', '/webhook', {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-bad-json',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON payload');
  });
});
