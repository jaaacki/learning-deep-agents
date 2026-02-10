import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import {
  createWebhookApp,
  createDialogApp,
  verifySignature,
  handlePullRequestEvent,
  handleWebhookEvent,
  handleIssuesEvent,
  isBotPr,
  BOT_PR_MARKER,
} from '../src/listener.js';
import type { WebhookConfig, WebhookEvent } from '../src/listener.js';

vi.mock('../src/core.js', () => ({
  runAnalyzeSingle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/reviewer-agent.js', () => ({
  runReviewSingle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/chat-agent.js', () => ({
  chat: vi.fn().mockResolvedValue({ response: 'mock response', sessionId: 'test-session' }),
}));

import { runAnalyzeSingle } from '../src/core.js';
import { runReviewSingle } from '../src/reviewer-agent.js';
import { chat } from '../src/chat-agent.js';

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

// ── isBotPr ─────────────────────────────────────────────────────────────────

describe('isBotPr', () => {
  it('returns true when body contains the bot marker', () => {
    expect(isBotPr(`Some text ${BOT_PR_MARKER} more text`, 'feature-branch')).toBe(true);
  });

  it('returns true when branch matches issue-N-* pattern', () => {
    expect(isBotPr('no marker here', 'issue-42-fix-login')).toBe(true);
  });

  it('returns true when both marker and branch match', () => {
    expect(isBotPr(`Body with ${BOT_PR_MARKER}`, 'issue-7-update')).toBe(true);
  });

  it('returns false for non-bot PR', () => {
    expect(isBotPr('Regular PR body', 'feature/my-change')).toBe(false);
  });

  it('returns false for branch that looks similar but does not match', () => {
    expect(isBotPr('', 'issues-42-wrong-prefix')).toBe(false);
  });
});

// ── handlePullRequestEvent ──────────────────────────────────────────────────

describe('handlePullRequestEvent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runReviewSingle).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEvent(overrides: Partial<WebhookEvent> & { payload: Record<string, unknown> }): WebhookEvent {
    return {
      event: 'pull_request',
      deliveryId: 'test-delivery',
      ...overrides,
    };
  }

  function makePrPayload(opts: {
    action?: string;
    number?: number;
    title?: string;
    body?: string;
    headRef?: string;
    baseRef?: string;
    draft?: boolean;
  } = {}): Record<string, unknown> {
    return {
      action: opts.action ?? 'opened',
      pull_request: {
        number: opts.number ?? 99,
        title: opts.title ?? 'Fix #42: test fix',
        body: opts.body ?? `Some description\n${BOT_PR_MARKER}\nCloses #42`,
        draft: opts.draft ?? true,
        head: { ref: opts.headRef ?? 'issue-42-test-fix' },
        base: { ref: opts.baseRef ?? 'main' },
      },
    };
  }

  it('queues bot-created PR (marker in body) for review', async () => {
    const event = makeEvent({ payload: makePrPayload({ body: `text ${BOT_PR_MARKER} text` }) });
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(true);
    expect(result.reviewQueued).toBe(true);
    expect(result.reason).toContain('Review triggered');
    expect(result.pr?.number).toBe(99);
  });

  it('queues bot-created PR (branch pattern) for review', async () => {
    const event = makeEvent({
      payload: makePrPayload({ body: 'no marker', headRef: 'issue-10-add-tests' }),
    });
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(true);
    expect(result.reviewQueued).toBe(true);
  });

  it('triggers review when config is provided', async () => {
    const config = { github: { owner: 'o', repo: 'r', token: 't' }, llm: { provider: 'anthropic', apiKey: 'k', model: 'm' } } as any;
    const event = makeEvent({ payload: makePrPayload() });
    const result = await handlePullRequestEvent(event, config);

    expect(result.reviewQueued).toBe(true);
    expect(runReviewSingle).toHaveBeenCalledWith(config, 99);
  });

  it('ignores non-bot PR', async () => {
    const event = makeEvent({
      payload: makePrPayload({
        body: 'Regular PR from a human',
        headRef: 'feature/my-change',
      }),
    });
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(true);
    expect(result.reviewQueued).toBe(false);
    expect(result.reason).toBe('PR not created by bot');
    expect(result.pr?.number).toBe(99);
  });

  it('ignores pull_request.closed action', async () => {
    const event = makeEvent({ payload: makePrPayload({ action: 'closed' }) });
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(false);
    expect(result.reviewQueued).toBe(false);
    expect(result.reason).toContain('Ignored action: closed');
  });

  it('ignores pull_request.synchronize action', async () => {
    const event = makeEvent({ payload: makePrPayload({ action: 'synchronize' }) });
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain('Ignored action: synchronize');
  });

  it('handles missing pull_request in payload gracefully', async () => {
    const event = makeEvent({ payload: { action: 'opened' } });
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('Missing PR data in payload');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('missing PR data'),
    );
  });

  it('handles pull_request with missing number gracefully', async () => {
    const event = makeEvent({
      payload: {
        action: 'opened',
        pull_request: { title: 'No number field' },
      },
    });
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('Missing PR data in payload');
  });

  it('extracts PR metadata correctly', async () => {
    const event = makeEvent({
      payload: makePrPayload({
        number: 55,
        title: 'Fix #10: handle edge case',
        body: `Detailed description\n${BOT_PR_MARKER}`,
        headRef: 'issue-10-edge-case',
        baseRef: 'develop',
        draft: false,
      }),
    });
    const result = await handlePullRequestEvent(event);

    expect(result.pr).toEqual({
      number: 55,
      title: 'Fix #10: handle edge case',
      body: `Detailed description\n${BOT_PR_MARKER}`,
      headRef: 'issue-10-edge-case',
      baseRef: 'develop',
      draft: false,
    });
  });

  it('handles review errors without crashing', async () => {
    vi.mocked(runReviewSingle).mockRejectedValueOnce(new Error('LLM down'));
    const config = { github: { owner: 'o', repo: 'r', token: 't' }, llm: { provider: 'anthropic', apiKey: 'k', model: 'm' } } as any;
    const event = makeEvent({ payload: makePrPayload() });

    const result = await handlePullRequestEvent(event, config);

    expect(result.handled).toBe(true);
    expect(result.reviewQueued).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Review failed'),
      expect.any(Error),
    );
  });
});

// ── handleWebhookEvent (dispatcher) ─────────────────────────────────────────

describe('handleWebhookEvent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches pull_request events', () => {
    const event: WebhookEvent = {
      event: 'pull_request',
      deliveryId: 'dispatch-1',
      payload: {
        action: 'opened',
        pull_request: {
          number: 77,
          title: 'Test',
          body: BOT_PR_MARKER,
          draft: true,
          head: { ref: 'issue-77-test' },
          base: { ref: 'main' },
        },
      },
    };

    // Should not throw
    handleWebhookEvent(event);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('queued for review'));
  });

  it('dispatches issues events', () => {
    const event: WebhookEvent = {
      event: 'issues',
      deliveryId: 'dispatch-3',
      payload: { action: 'opened', issue: { number: 1 } },
    };

    // Should not throw — fires and forgets
    handleWebhookEvent(event);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Issue #1'));
  });

  it('ignores unhandled event types without error', () => {
    const event: WebhookEvent = {
      event: 'push',
      deliveryId: 'dispatch-2',
      payload: { ref: 'refs/heads/main' },
    };

    handleWebhookEvent(event);
    // Should not call error
    expect(console.error).not.toHaveBeenCalled();
  });
});

// ── handleIssuesEvent ───────────────────────────────────────────────────────

describe('handleIssuesEvent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runAnalyzeSingle).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEvent(payload: Record<string, unknown>): WebhookEvent {
    return { event: 'issues', deliveryId: 'test-delivery', payload };
  }

  it('triggers analysis for issues.opened event with config', async () => {
    const config = { github: { owner: 'o', repo: 'r', token: 't' }, llm: { provider: 'anthropic', apiKey: 'k', model: 'm' } } as any;
    const event = makeEvent({ action: 'opened', issue: { number: 42, title: 'Bug' } });

    const result = await handleIssuesEvent(event, config);

    expect(result.handled).toBe(true);
    expect(result.issueNumber).toBe(42);
    expect(runAnalyzeSingle).toHaveBeenCalledWith(config, 42);
  });

  it('skips analysis when no config is provided', async () => {
    const event = makeEvent({ action: 'opened', issue: { number: 5 } });

    const result = await handleIssuesEvent(event);

    expect(result.handled).toBe(true);
    expect(result.issueNumber).toBe(5);
    expect(result.reason).toContain('skipped');
    expect(runAnalyzeSingle).not.toHaveBeenCalled();
  });

  it('ignores issues.edited action', async () => {
    const event = makeEvent({ action: 'edited', issue: { number: 3 } });

    const result = await handleIssuesEvent(event);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain('Ignored action: edited');
    expect(runAnalyzeSingle).not.toHaveBeenCalled();
  });

  it('ignores issues.closed action', async () => {
    const event = makeEvent({ action: 'closed', issue: { number: 3 } });

    const result = await handleIssuesEvent(event);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain('Ignored action: closed');
  });

  it('handles missing issue data gracefully', async () => {
    const event = makeEvent({ action: 'opened' });

    const result = await handleIssuesEvent(event);

    expect(result.handled).toBe(false);
    expect(result.reason).toContain('Missing issue data');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('missing issue data'));
  });

  it('handles analysis errors without crashing', async () => {
    const config = { github: { owner: 'o', repo: 'r', token: 't' }, llm: { provider: 'anthropic', apiKey: 'k', model: 'm' } } as any;
    vi.mocked(runAnalyzeSingle).mockRejectedValue(new Error('API down'));

    const event = makeEvent({ action: 'opened', issue: { number: 99 } });

    const result = await handleIssuesEvent(event, config);

    expect(result.handled).toBe(true);
    expect(result.issueNumber).toBe(99);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Analysis failed'),
      expect.any(Error),
    );
  });
});

// ── createDialogApp ─────────────────────────────────────────────────────────

describe('createDialogApp', () => {
  const mockConfig = {
    github: { owner: 'owner', repo: 'repo', token: 'ghp_test' },
    llm: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet' },
  } as any;

  /**
   * Inject a request into the Express app and capture the response.
   */
  async function inject(
    app: ReturnType<typeof createDialogApp>,
    method: string,
    path: string,
    opts: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any; headers: Record<string, string> }> {
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
              const respHeaders: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === 'string') respHeaders[k] = v;
              }
              try {
                resolve({ status: res.statusCode!, body: JSON.parse(data), headers: respHeaders });
              } catch {
                resolve({ status: res.statusCode!, body: data, headers: respHeaders });
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
    vi.mocked(chat).mockReset().mockResolvedValue({ response: 'Hello from agent', sessionId: 'sess-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /health returns 200', async () => {
    const app = createDialogApp(mockConfig);
    const res = await inject(app, 'GET', '/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET / serves dialog.html', async () => {
    const app = createDialogApp(mockConfig);
    const res = await inject(app, 'GET', '/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('POST /chat returns agent response for valid message', async () => {
    const app = createDialogApp(mockConfig);
    const res = await inject(app, 'POST', '/chat', {
      body: JSON.stringify({ message: 'What does this project do?', sessionId: 'test-session' }),
    });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Hello from agent');
    expect(res.body.sessionId).toBe('sess-1');
    expect(chat).toHaveBeenCalledWith(mockConfig, 'What does this project do?', 'test-session');
  });

  it('POST /chat returns 400 when message is missing', async () => {
    const app = createDialogApp(mockConfig);
    const res = await inject(app, 'POST', '/chat', {
      body: JSON.stringify({ sessionId: 'test-session' }),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing');
  });

  it('POST /chat returns 400 when message is empty string', async () => {
    const app = createDialogApp(mockConfig);
    const res = await inject(app, 'POST', '/chat', {
      body: JSON.stringify({ message: '', sessionId: 'test-session' }),
    });

    expect(res.status).toBe(400);
  });

  it('POST /chat generates sessionId when not provided', async () => {
    const app = createDialogApp(mockConfig);
    const res = await inject(app, 'POST', '/chat', {
      body: JSON.stringify({ message: 'Hello' }),
    });

    expect(res.status).toBe(200);
    // chat() should have been called with some generated UUID
    expect(chat).toHaveBeenCalledWith(mockConfig, 'Hello', expect.any(String));
  });

  it('POST /chat returns 500 when chat agent throws', async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error('LLM down'));

    const app = createDialogApp(mockConfig);
    const res = await inject(app, 'POST', '/chat', {
      body: JSON.stringify({ message: 'Hello', sessionId: 's1' }),
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Chat agent failed');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Error for session s1'),
      expect.any(Error),
    );
  });
});
