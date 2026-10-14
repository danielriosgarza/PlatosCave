/** Sign-in link tokens and a provider's `code` and `state` must never reach the logs. */
export const redactUrl = (url: string): string =>
  url.replace(/([?&](?:token|code|state)=)[^&#]*/g, '$1[redacted]');
