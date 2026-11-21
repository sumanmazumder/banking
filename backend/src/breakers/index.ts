import CircuitBreaker from 'opossum';

/**
 * Circuit breakers protect the API from slow/failing external dependencies
 * (email provider now; payment gateway in Phase 2). After repeated failures the breaker
 * "opens" and calls fail fast instead of piling up, then retries after resetTimeout.
 */
export function createBreaker<A extends unknown[], R>(
  name: string,
  action: (...args: A) => Promise<R>,
  opts: Partial<CircuitBreaker.Options> = {}
): CircuitBreaker<A, R> {
  const breaker = new CircuitBreaker<A, R>(action, {
    name,
    timeout: 8000, // call counts as failed after 8s
    errorThresholdPercentage: 50, // open when >=50% of calls fail...
    volumeThreshold: 5, // ...within the rolling window of at least 5 calls
    resetTimeout: 30_000, // try again (half-open) after 30s
    ...opts,
  });
  breaker.on('open', () => console.warn(`[breaker:${name}] OPEN - failing fast`));
  breaker.on('halfOpen', () => console.warn(`[breaker:${name}] half-open - probing`));
  breaker.on('close', () => console.info(`[breaker:${name}] closed - recovered`));
  return breaker;
}
