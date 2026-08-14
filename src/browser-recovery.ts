/**
 * Playwright leaves a Browser object behind after Chrome exits unexpectedly.
 * Treat the known transport messages as recoverable so callers can replace the
 * worker and retry their idempotent read/render operation once.
 */
export function isRecoverableBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target crashed|target page, context or browser has been closed|browser has been closed|browsercontext\.newpage/i.test(message);
}
