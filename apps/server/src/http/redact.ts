/** Sign-in link tokens must never reach the logs, even single-use ones. */
export const redactUrl = (url: string): string =>
  url.replace(/([?&]token=)[^&#]*/g, '$1[redacted]');
