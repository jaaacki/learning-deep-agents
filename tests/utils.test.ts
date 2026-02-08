import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isRetryableError } from '../src/utils.js';

// ── isRetryableError ─────────────────────────────────────────────────────────

describe('isRetryableError', () => {
  it('returns true for 5xx status errors', () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
  });

  it('returns true for 429 rate limit errors', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it('returns false for 4xx client errors (except 429)', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 422 })).toBe(false);
  });

  it('returns true for network error codes', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isRetryableError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryableError({ code: 'EAI_AGAIN' })).toBe(true);
  });

  it('returns false for non-retryable error codes', () => {
    expect(isRetryableError({ code: 'ERR_INVALID_ARG_TYPE' })).toBe(false);
  });

  it('returns true for status nested in response', () => {
    expect(isRetryableError({ response: { status: 500 } })).toBe(true);
    expect(isRetryableError({ response: { status: 429 } })).toBe(true);
  });

  it('returns false for null/undefined/non-objects', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('string error')).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });

  it('prefers top-level status over response.status', () => {
    // status: 400 is non-retryable, even if response.status is 500
    expect(isRetryableError({ status: 400, response: { status: 500 } })).toBe(false);
  });
});

// ── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValueOnce('recovered');

    const promise = withRetry(fn, { initialDelayMs: 100 });
    // Advance past the first retry delay
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 rate limit', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce('rate-limit-recovered');

    const promise = withRetry(fn, { initialDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('rate-limit-recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValueOnce('network-recovered');

    const promise = withRetry(fn, { initialDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('network-recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx client errors', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 404 });

    await expect(withRetry(fn)).rejects.toEqual({ status: 404 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const error = { status: 500, message: 'Internal Server Error' };
    const fn = vi.fn().mockRejectedValue(error);

    const promise = withRetry(fn, { maxRetries: 2, initialDelayMs: 100 }).catch((e) => e);
    // Advance through retry 1 (100ms) and retry 2 (200ms)
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toEqual(error);
    // 1 initial + 2 retries = 3 total calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('applies exponential backoff delays', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { maxRetries: 3, initialDelayMs: 1000, backoffMultiplier: 2 });

    // First retry after 1000ms (1000 * 2^0)
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second retry after 2000ms (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects Retry-After header on 429', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({
        status: 429,
        response: { headers: { 'retry-after': '5' } },
      })
      .mockResolvedValueOnce('after-retry');

    const promise = withRetry(fn, { initialDelayMs: 1000 });

    // Should wait 5000ms (from Retry-After), not 1000ms (from initialDelayMs)
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBe('after-retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('defaults to maxRetries=3', async () => {
    const error = { status: 500 };
    const fn = vi.fn().mockRejectedValue(error);

    const promise = withRetry(fn, { initialDelayMs: 10 }).catch((e) => e);
    // Advance through all retries: 10, 20, 40
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(40);

    const result = await promise;
    expect(result).toEqual(error);
    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('works with maxRetries=0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500 });

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toEqual({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
