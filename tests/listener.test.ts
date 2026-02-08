import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

// vi.mock is hoisted, so we use vi.hoisted to define the mock function
const { mockRunAnalyzeSingle } = vi.hoisted(() => ({
  mockRunAnalyzeSingle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core.js', () => ({
  runAnalyzeSingle: mockRunAnalyzeSingle,
}));

import { createWebhookApp, verifySignature, handleIssuesEvent, handleWebhookEvent } from '../src/listener.js';
import type { WebhookConfig, WebhookEvent } from '../src/listener.js';

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

// ── handleIssuesEvent ───────────────────────────────────────────────────────

describe('handleIssuesEvent', () => {
  const fakeConfig = {
    github: { owner: 'test-owner', repo: 'test-repo', token: 'fake-token' },
    llm: { provider: 'anthropic', apiKey: 'fake-key', model: 'claude-3' },
  } as any;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRunAnalyzeSingle.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeIssueEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
    return {
      event: 'issues',
      deliveryId: 'test-delivery',
      payload: {
        action: 'opened',
        issue: { number: 42, title: 'Test issue' },
      },
      ...overrides,
    };
  }

  it('triggers analysis for issues.opened event', async () => {
    const result = await handleIssuesEvent(makeIssueEvent(), fakeConfig);

    expect(result.handled).toBe(true);
    expect(result.reason).toBe('Analysis triggered');
    expect(result.issueNumber).toBe(42);
    expect(mockRunAnalyzeSingle).toHaveBeenCalledWith(fakeConfig, 42);
  });

  it('ignores issues.edited action (only opened triggers analysis)', async () => {
    const event = makeIssueEvent({
      payload: { action: 'edited', issue: { number: 42 } },
    });

    const result = await handleIssuesEvent(event, fakeConfig);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain('Ignored action: edited');
    expect(mockRunAnalyzeSingle).not.toHaveBeenCalled();
  });

  it('ignores issues.closed action', async () => {
    const event = makeIssueEvent({
      payload: { action: 'closed', issue: { number: 42 } },
    });

    const result = await handleIssuesEvent(event, fakeConfig);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain('Ignored action: closed');
  });

  it('handles missing issue.number gracefully', async () => {
    const event = makeIssueEvent({
      payload: { action: 'opened', issue: { title: 'No number' } },
    });

    const result = await handleIssuesEvent(event, fakeConfig);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('Missing issue.number in payload');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('missing issue.number'),
    );
  });

  it('handles missing issue object gracefully', async () => {
    const event = makeIssueEvent({
      payload: { action: 'opened' },
    });

    const result = await handleIssuesEvent(event, fakeConfig);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('Missing issue.number in payload');
  });

  it('catches analysis errors without crashing (returns 200 to GitHub)', async () => {
    mockRunAnalyzeSingle.mockRejectedValue(new Error('LLM timeout'));

    const result = await handleIssuesEvent(makeIssueEvent(), fakeConfig);

    expect(result.handled).toBe(true);
    expect(result.issueNumber).toBe(42);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Analysis failed for #42'),
      expect.any(Error),
    );
  });

  it('logs handling start and completion', async () => {
    await handleIssuesEvent(makeIssueEvent(), fakeConfig);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Handling issues.opened for #42'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Analysis complete for #42'),
    );
  });
});

// ── handleWebhookEvent (dispatcher) ─────────────────────────────────────────

describe('handleWebhookEvent', () => {
  const fakeConfig = {
    github: { owner: 'test-owner', repo: 'test-repo', token: 'fake-token' },
    llm: { provider: 'anthropic', apiKey: 'fake-key', model: 'claude-3' },
  } as any;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRunAnalyzeSingle.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches issues event to handleIssuesEvent when config provided', async () => {
    const event: WebhookEvent = {
      event: 'issues',
      deliveryId: 'dispatch-1',
      payload: { action: 'opened', issue: { number: 99 } },
    };

    const result = handleWebhookEvent(event, fakeConfig);
    expect(result).toBeInstanceOf(Promise);

    const resolved = await result;
    expect(resolved!.handled).toBe(true);
    expect(resolved!.issueNumber).toBe(99);
  });

  it('returns null for issues event without config', () => {
    const event: WebhookEvent = {
      event: 'issues',
      deliveryId: 'dispatch-2',
      payload: { action: 'opened', issue: { number: 1 } },
    };

    expect(handleWebhookEvent(event)).toBeNull();
  });

  it('returns null for unhandled event types', () => {
    const event: WebhookEvent = {
      event: 'push',
      deliveryId: 'dispatch-3',
      payload: { ref: 'refs/heads/main' },
    };

    expect(handleWebhookEvent(event, fakeConfig)).toBeNull();
  });
});
