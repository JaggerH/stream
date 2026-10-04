/** A thrown error that asks callers to try again later rather than treat the failure as
 *  terminal — e.g. a standby container still warming up (loading model weights) when its
 *  wake probe timed out. The marker is a plain `retryable: true` property so any layer can
 *  recognise it by duck-typing, WITHOUT importing the concrete error class or (worse) string-
 *  matching the message. That decoupling is the whole point: the generic Provider executor can
 *  tag a failed member as retryable without knowing anything about standby. */
export interface RetryableError {
  retryable: true
}

/** True when `e` carries the `retryable: true` self-marker. Type-guards to `RetryableError`. */
export function isRetryable(e: unknown): e is RetryableError {
  return !!e && typeof e === 'object' && (e as { retryable?: unknown }).retryable === true
}
