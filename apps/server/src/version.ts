/**
 * The one version string `/api/health`, `/api/ready` and the OpenAPI document report: the
 * release's, which the server image sets (docs/design/site.md §12), and `0.0.0` from source.
 */
export const VERSION = process.env.PARALLAX_VERSION || '0.0.0';
