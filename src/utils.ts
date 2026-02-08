/**
 * Retry utility with exponential backoff for transient failures.
 *
 * Retries on:
 *   - HTTP 5xx (server errors)
 *   - HTTP 429 (rate limit) — respects Retry-After header when present
 *   - Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, etc.)
 *
 * Does NOT retry on:
 *   - HTTP 4xx client errors (except 429) — those are real errors
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Multiplier applied to delay after each retry (default: 2) */
  backoffMultiplier?: number;
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
]);

/**
 * Determine whether an error is transient and worth retrying.
 */
export function isRetryableError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;

  // Check HTTP status codes
  const status =
    (error as { status?: number }).status ??
    (error as { response?: { status?: number } }).response?.status;

  if (typeof status === 'number') {
    if (status === 429) return true;   // Rate limited
    if (status >= 500) return true;    // Server error
    return false;                       // Other 4xx = real error
  }

  // Check network error codes
  const code = (error as { code?: string }).code;
  if (typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }

  return false;
}

/**
 * Extract Retry-After delay from a 429 response, if present.
 * Returns delay in milliseconds, or null if no header found.
 */
function getRetryAfterMs(error: unknown): number | null {
  const headers =
    (error as { response?: { headers?: Record<string, string> } }).response?.headers;

  if (!headers) return null;

  // GitHub uses lowercase 'retry-after'
  const retryAfter = headers['retry-after'];
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  return null;
}

/**
 * Wrap an async function with retry logic and exponential backoff.
 *
 * Usage:
 *   const result = await withRetry(() => octokit.rest.issues.listForRepo(params));
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    backoffMultiplier = 2,
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable = isRetryableError(error);
      const isLastAttempt = attempt === maxRetries;

      if (!retryable || isLastAttempt) {
        throw error;
      }

      // Use Retry-After header if present (429), otherwise exponential backoff
      const backoffDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
      const retryAfterDelay = getRetryAfterMs(error);
      const delay = retryAfterDelay ?? backoffDelay;

      console.log(
        `\u23F3 Retry ${attempt + 1}/${maxRetries} in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // TypeScript: unreachable, but satisfies the compiler
  throw new Error('withRetry: unreachable');
}
